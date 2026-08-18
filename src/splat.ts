import {
    ADDRESS_CLAMP_TO_EDGE,
    FILTER_NEAREST,
    GSPLAT_STREAM_INSTANCE,
    PIXELFORMAT_R8,
    PIXELFORMAT_R16U,
    WORKBUFFER_UPDATE_ONCE,
    Asset,
    BoundingBox,
    Color,
    Entity,
    GSplatData,
    GSplatResource,
    Mat4,
    Quat,
    Texture,
    Vec3
} from 'playcanvas';

import { Element, ElementType } from './element';
import { Serializer } from './serializer';
import { State, SplatState } from './splat-state';
import { Transform } from './transform';
import { TransformPalette } from './transform-palette';

const vec = new Vec3();
const veca = new Vec3();
const vecb = new Vec3();
const quat = new Quat();

// Runs while the unified renderer copies source splats into its GPU work
// buffer. Edit state and local transform indices are instance streams, so the
// compute/raster GPU sort consumes the same edits as export and data tools.
const unifiedSplatModifier = /* wgsl */ `
uniform selectedClr: vec4f;
uniform lockedClr: vec4f;
uniform clrOffset: vec3f;
uniform clrScale: vec4f;
uniform saturation: f32;
var transformPalette: texture_2d<f32>;

fn paletteTransform(index: u32) -> mat4x4f {
    let u = i32(index % 512u) * 3;
    let v = i32(index / 512u);
    let packed = mat4x4f(
        textureLoad(transformPalette, vec2i(u, v), 0),
        textureLoad(transformPalette, vec2i(u + 1, v), 0),
        textureLoad(transformPalette, vec2i(u + 2, v), 0),
        vec4f(0.0, 0.0, 0.0, 1.0)
    );
    return transpose(packed);
}

fn modifySplatCenter(center: ptr<function, vec3f>) {
    let transformIndex = loadSplatTransform().r;
    if (transformIndex > 0u) {
        (*center) = (paletteTransform(transformIndex) * vec4f((*center), 1.0)).xyz;
    }
}

fn modifySplatRotationScale(originalCenter: vec3f, modifiedCenter: vec3f, rotation: ptr<function, vec4f>, scale: ptr<function, vec3f>) {
}

fn modifySplatColor(center: vec3f, color: ptr<function, vec4f>) {
    let state = u32(round(loadSplatState().r * 255.0)) & 7u;
    if ((state & 4u) != 0u) {
        (*color) = vec4f((*color).rgb, 0.0);
        return;
    }

    var result = (*color) * uniform.clrScale + vec4f(uniform.clrOffset, 0.0);
    let grey = vec3f(dot(result.rgb, vec3f(0.299, 0.587, 0.114)));
    let adjustedRgb = grey + (result.rgb - grey) * uniform.saturation;
    result = vec4f(adjustedRgb, clamp(result.a, 0.0, 1.0));

    if ((state & 2u) != 0u) {
        result = result * uniform.lockedClr;
    } else if ((state & 1u) != 0u) {
        result = vec4f(
            mix(result.rgb, uniform.selectedClr.rgb, uniform.selectedClr.a),
            result.a
        );
    }
    (*color) = result;
}
`;

const boundingPoints =
    [-1, 1].map((x) => {
        return [-1, 1].map((y) => {
            return [-1, 1].map((z) => {
                return [
                    new Vec3(x, y, z), new Vec3(x * 0.75, y, z),
                    new Vec3(x, y, z), new Vec3(x, y * 0.75, z),
                    new Vec3(x, y, z), new Vec3(x, y, z * 0.75)
                ];
            });
        });
    }).flat(3);

class Splat extends Element {
    asset: Asset;
    splatData: GSplatData;
    numSplats = 0;
    numDeleted = 0;
    numLocked = 0;
    numSelected = 0;
    entity: Entity;
    changedCounter = 0;
    stateTexture: Texture;
    // encapsulates per-splat state mirror (cpu Uint8Array + gpu Texture).
    // all writes go through state.setBits/clearBits/toggleBits, then flush().
    state: SplatState;
    transformTexture: Texture;
    centers: Float32Array;
    selectionBoundStorage: BoundingBox;
    localBoundStorage: BoundingBox;
    worldBoundStorage: BoundingBox;

    _visible = true;
    transformPalette: TransformPalette;

    selectionAlpha = 1;

    _name = '';
    _tintClr = new Color(1, 1, 1);
    _temperature = 0;
    _saturation = 1;
    _brightness = 0;
    _blackPoint = 0;
    _whitePoint = 1;
    _transparency = 1;

    measurePoints: Vec3[] = [];
    measureSelection = -1;

    orientPoints: Vec3[] = [];
    orientSelection = -1;

    // user-defined local frame (relative to the data frame), set from the
    // orient tool's picked plane: origin at the first picked point, rotation
    // aligning +y with the plane normal. the transform gizmos and panel use
    // it as the model's local coordinate space; the gaussian data is
    // unaffected. the defaults reproduce the entity's own frame
    localFrameOrigin = new Vec3();
    localFrame = new Quat();

    rebuildMaterial: (bands: number) => void;
    private visualSignature = '';

    constructor(asset: Asset, rotation: Quat) {
        super(ElementType.splat);

        const { device } = asset.resource as GSplatResource;

        // create the entity once. its transform persists across frame swaps so
        // an animated sequence can replace its data without losing the user's
        // transform (see replaceData).
        this.entity = new Entity('splatEntity');

        this.selectionBoundStorage = new BoundingBox();

        // create the transform palette (reused across frame swaps; index 0 is identity)
        this.transformPalette = new TransformPalette(device);

        // Unified rendering owns one shared material. Per-placement edit data is
        // configured in bindAsset; a band change only needs a fresh work buffer.
        this.rebuildMaterial = (bands: number) => {
            this.markRenderDataDirty();
        };

        // bind the initial frame's data, applying the file's load rotation
        this.bindAsset(asset, rotation);
    }

    // bind a gsplat asset onto this element's entity: creates the gsplat
    // component, the per-splat state/transform channels and their gpu textures,
    // and caches the instance bounds. When `rotation` is supplied (initial load)
    // the entity rotation is set; on a frame swap it is omitted so the user's
    // transform is preserved.
    private bindAsset(asset: Asset, rotation?: Quat) {
        const splatResource = asset.resource as GSplatResource;
        const splatData = splatResource.gsplatData as GSplatData;
        const { device } = splatResource;

        this.asset = asset;
        this.splatData = splatData;
        this.numSplats = splatData.numSplats;

        // name and orientation are set on the initial bind only; a frame swap
        // (replaceData, no rotation) keeps the element's name and transform
        if (rotation) {
            this._name = (asset.file as any).filename;
            this.entity.setLocalRotation(rotation);
        }

        // added per-splat state channel
        // bit 1: selected
        // bit 2: deleted
        // bit 3: locked
        if (!splatData.getProp('state')) {
            splatData.getElement('vertex').properties.push({
                type: 'uchar',
                name: 'state',
                storage: new Uint8Array(splatData.numSplats),
                byteSize: 1
            });
        }

        // per-splat transform matrix
        if (!splatData.getProp('transform')) {
            splatData.getElement('vertex').properties.push({
                type: 'ushort',
                name: 'transform',
                storage: new Uint16Array(splatData.numSplats),
                byteSize: 2
            });
        }

        // Instance streams keep editing state out of the immutable resource
        // textures while making it directly available to the unified GPU pass.
        splatResource.format.addExtraStreams([
            { name: 'splatState', format: PIXELFORMAT_R8, storage: GSPLAT_STREAM_INSTANCE },
            { name: 'splatTransform', format: PIXELFORMAT_R16U, storage: GSPLAT_STREAM_INSTANCE }
        ]);

        this.entity.addComponent('gsplat', { asset, unified: true });
        // Apply editor state and local transforms while the unified renderer
        // copies source splats into its WebGPU work buffer.
        this.entity.gsplat.setWorkBufferModifier({ wgsl: unifiedSplatModifier });
        this.entity.gsplat.setParameter('transformPalette', this.transformPalette.texture);

        // create the state texture and the SplatState mirror that owns it.
        // splatData.getProp('state') aliases state.data so existing read-only
        // consumers (serialize, status-bar, etc) keep working unchanged.
        this.stateTexture = this.entity.gsplat.getInstanceTexture('splatState');
        this.state = new SplatState(splatData.getProp('state') as Uint8Array, this.stateTexture);
        this.transformTexture = this.entity.gsplat.getInstanceTexture('splatTransform');
        const transforms = this.transformTexture.lock() as Uint16Array;
        transforms.set(splatData.getProp('transform') as Uint16Array);
        this.transformTexture.unlock();

        this.centers = splatResource.centers ?? splatData.getCenters();
        splatResource.centers = this.centers;
        this.localBoundStorage = splatResource.aabb.clone();
        this.worldBoundStorage = new BoundingBox();
        this.updateWorldBound();
        this.visualSignature = '';
    }

    // wait for the next scene render to complete, with a safety timeout so a
    // stalled render loop (e.g. a backgrounded tab where rAF is paused) can't
    // block frame swapping forever. In a live app postrender fires within a
    // frame, so the timeout never matters.
    private waitForRender(): Promise<void> {
        return new Promise((resolve) => {
            // single finish() removes the listener and clears the timeout, so the
            // common case (postrender fires first) doesn't leave a pending timer.
            const handles: { off?: { off: () => void }, timer?: ReturnType<typeof setTimeout> } = {};
            let settled = false;
            const finish = () => {
                if (settled) return;
                settled = true;
                handles.off?.off();
                clearTimeout(handles.timer);
                resolve();
            };
            handles.off = this.scene.events.on('postrender', finish);
            // safety: don't block frame swapping forever if the render loop is stalled
            handles.timer = setTimeout(finish, 200);
        });
    }

    // swap in a new frame's gsplat data while preserving this element's identity,
    // transform and visual properties. used by animated sequence playback so each
    // frame doesn't recreate the whole element.
    //
    // The gsplat lives on this.entity (read in many places), so we can't double
    // buffer on a child. Instead we bind the new frame to a *fresh* entity, sort
    // it, and let it render once alongside the still-present old entity before
    // destroying the old one. This overlap avoids a blank/unsorted frame
    // flickering on screen during the swap (the old frame masks the new one's
    // first sort), matching the previous per-frame load behaviour. The user's
    // transform is carried across so it persists.
    async replaceData(asset: Asset) {
        const oldEntity = this.entity;
        const oldAsset = this.asset;

        // carry the current transform onto the new entity
        const position = oldEntity.getLocalPosition().clone();
        const rotation = oldEntity.getLocalRotation().clone();
        const scale = oldEntity.getLocalScale().clone();

        this.entity = new Entity('splatEntity');
        this.entity.setLocalPosition(position);
        this.entity.setLocalRotation(rotation);
        this.entity.setLocalScale(scale);

        // bind the new frame (no rotation: transform already applied above)
        this.bindAsset(asset);

        // add the new entity to the scene and configure its instance
        this.scene.contentRoot.addChild(this.entity);
        this.entity.gsplat.layers = [this.scene.splatLayer.id];
        this.rebuildMaterial(this.scene.events.invoke('view.bands'));

        // refresh gpu state/counts/bounds, then wait for the new frame to render
        // before removing the old entity, which keeps the previous frame on screen
        // in the meantime. Skip the wait during offline video render
        // (lockedRenderMode): renders are gated on scene.lockedRender there, so
        // blocking on a render would deadlock — and the render loop sorts+captures
        // each frame deterministically anyway.
        await this.updateState(State.deleted);
        if (!this.scene.lockedRenderMode) {
            await this.waitForRender();
        }

        // notify dependents (e.g. the centers overlay, which parents itself under
        // this.entity) to re-bind to the new entity/instance before the old entity
        // is destroyed — otherwise they're torn down with it and never re-attach
        // (no selection.changed fires on a frame swap).
        this.scene.events.fire('splat.replaced', this);

        // tear down the previous frame
        oldEntity.destroy();
        oldAsset.registry?.remove(oldAsset);
        oldAsset.unload();

        this.changedCounter++;
        this.scene.forceRender = true;
    }

    destroy() {
        super.destroy();
        this.entity.destroy();
        this.asset.registry.remove(this.asset);
        this.asset.unload();
    }

    async updateState(changedState = State.selected) {
        // uploads dirty range + refreshes counts in one pass.
        this.state.flush();
        this.numSplats = this.state.data.length - this.state.numDeleted;
        this.numLocked = this.state.numLocked;
        this.numSelected = this.state.numSelected;
        this.numDeleted = this.state.numDeleted;
        this.markRenderDataDirty();

        // handle splats being added or removed
        if (changedState & State.deleted) {
            await this.updateSorting();
        } else {
            await this.updateLocalBounds();
        }

        this.scene.forceRender = true;
        this.scene.events.fire('splat.stateChanged', this);
    }

    async updatePositions() {
        const data = await this.scene.dataProcessor.calcPositions(this);

        // update the splat centers which are used for render-time sorting
        const state = this.splatData.getProp('state') as Uint8Array;
        const { centers } = this;
        for (let i = 0; i < this.splatData.numSplats; ++i) {
            if (state[i] === State.selected) {
                centers[i * 3 + 0] = data[i * 4];
                centers[i * 3 + 1] = data[i * 4 + 1];
                centers[i * 3 + 2] = data[i * 4 + 2];
            }
        }

        await this.updateSorting();

        this.scene.forceRender = true;
        this.scene.events.fire('splat.positionsChanged', this);
    }

    async updateSorting() {
        this.markRenderDataDirty();

        // recalculate bounds after sorting changes
        await this.updateLocalBounds();
    }

    get worldTransform() {
        return this.entity.getWorldTransform();
    }

    set name(newName: string) {
        if (newName !== this.name) {
            this._name = newName;
            this.scene.events.fire('splat.name', this);
        }
    }

    get name() {
        return this._name;
    }

    get filename() {
        return (this.asset.file as any).filename;
    }

    calcSplatWorldPosition(splatId: number, result: Vec3) {
        if (splatId >= this.splatData.numSplats) {
            return false;
        }

        // use centers data, which are updated when edits occur
        const { centers } = this;

        result.set(
            centers[splatId * 3 + 0],
            centers[splatId * 3 + 1],
            centers[splatId * 3 + 2]
        );

        this.worldTransform.transformPoint(result, result);

        return true;
    }

    async add() {
        // add the entity to the scene
        this.scene.contentRoot.addChild(this.entity);

        // assign splat to the dedicated splat layer (rendered by splat camera with MRT)
        this.entity.gsplat.layers = [this.scene.splatLayer.id];

        this.scene.events.on('view.bands', this.rebuildMaterial, this);
        this.rebuildMaterial(this.scene.events.invoke('view.bands'));

        // we must update state in case the state data was loaded from ply
        await this.updateState();
    }

    remove() {
        this.scene.events.off('view.bands', this.rebuildMaterial, this);

        this.scene.contentRoot.removeChild(this.entity);
        this.scene.boundDirty = true;
    }

    serialize(serializer: Serializer) {
        serializer.packa(this.entity.getWorldTransform().data);
        serializer.pack(this.changedCounter);
        serializer.pack(this.visible);
        serializer.pack(this.tintClr.r, this.tintClr.g, this.tintClr.b);
        serializer.pack(this.temperature, this.saturation, this.brightness, this.blackPoint, this.whitePoint, this.transparency);
    }

    onPreRender() {
        const events = this.scene.events;
        const selected = this.scene.camera.renderOverlays && events.invoke('selection') === this;
        const cameraMode = events.invoke('camera.mode');
        const cameraOverlay = events.invoke('camera.overlay');

        // configure colors
        const selectedClr = events.invoke('selectedClr');
        const unselectedClr = events.invoke('unselectedClr');
        const lockedClr = events.invoke('lockedClr');

        // combine black pointer, white point and brightness
        const offset = -this.blackPoint + this.brightness;
        const scale = 1 / (this.whitePoint - this.blackPoint);

        const selectedColor = (!selected || events.invoke('view.outlineSelection')) ? [0, 0, 0, 0] :
            [selectedClr.r, selectedClr.g, selectedClr.b, selectedClr.a * this.selectionAlpha];
        const colorScale = [
            scale * this.tintClr.r * (1 + this.temperature),
            scale * this.tintClr.g,
            scale * this.tintClr.b * (1 - this.temperature),
            this.transparency
        ];
        const signature = [...selectedColor, lockedClr.r, lockedClr.g, lockedClr.b, lockedClr.a,
            offset, ...colorScale, this.saturation].join(',');
        if (signature !== this.visualSignature) {
            this.visualSignature = signature;
            const component = this.entity.gsplat;
            component.setParameter('selectedClr', selectedColor);
            component.setParameter('lockedClr', [lockedClr.r, lockedClr.g, lockedClr.b, lockedClr.a]);
            component.setParameter('clrOffset', [offset, offset, offset]);
            component.setParameter('clrScale', colorScale);
            component.setParameter('saturation', this.saturation);
            this.markRenderDataDirty();
        }

        if (this.visible && selected) {
            // render bounding box
            if (events.invoke('camera.bound')) {
                const bound = this.localBound;
                const scale = new Mat4().setTRS(bound.center, Quat.IDENTITY, bound.halfExtents);
                scale.mul2(this.entity.getWorldTransform(), scale);

                for (let i = 0; i < boundingPoints.length / 2; i++) {
                    const a = boundingPoints[i * 2];
                    const b = boundingPoints[i * 2 + 1];
                    scale.transformPoint(a, veca);
                    scale.transformPoint(b, vecb);

                    this.scene.app.drawLine(veca, vecb, Color.WHITE, true, this.scene.worldLayer);
                }
            }
        }

        this.entity.enabled = this.visible;
    }

    focalPoint() {
        const result = new Vec3();
        this.splatData.calcFocalPoint(result);
        if (!Number.isFinite(result.x) || !Number.isFinite(result.y) || !Number.isFinite(result.z)) {
            return this.worldBound.center.clone();
        }
        this.worldTransform.transformPoint(result, result);
        return result;
    }

    // Radius used when initially framing a model. Full AABBs must include every
    // splat for editing and clipping, but a handful of reconstruction outliers
    // can make that radius thousands of times larger than the actual subject.
    // Sample center distances and frame the dense 95th percentile instead.
    framingRadius(focalPoint = this.focalPoint()) {
        const maxSamples = 32768;
        const sampleStep = Math.max(1, Math.floor(this.numSplats / maxSamples));
        const distances: number[] = [];
        const worldTransform = this.entity.getWorldTransform();
        const state = this.state.data;

        for (let index = 0; index < this.numSplats; index += sampleStep) {
            if ((state[index] & State.deleted) !== 0) continue;
            const offset = index * 3;
            veca.set(this.centers[offset], this.centers[offset + 1], this.centers[offset + 2]);
            if (!Number.isFinite(veca.x) || !Number.isFinite(veca.y) || !Number.isFinite(veca.z)) continue;
            worldTransform.transformPoint(veca, vecb);
            const distance = vecb.sub(focalPoint).length();
            if (Number.isFinite(distance)) distances.push(distance);
        }

        if (distances.length === 0) {
            return Math.max(1e-3, this.worldBound.halfExtents.length());
        }

        distances.sort((a, b) => a - b);
        const percentile = distances[Math.floor((distances.length - 1) * 0.95)];
        return Math.max(1e-3, percentile * 1.15);
    }

    move(position?: Vec3, rotation?: Quat, scale?: Vec3) {
        const entity = this.entity;
        if (position) {
            entity.setLocalPosition(position);
        }
        if (rotation) {
            entity.setLocalRotation(rotation);
        }
        if (scale) {
            entity.setLocalScale(scale);
        }

        this.updateWorldBound();

        this.scene?.events.fire('splat.moved', this);
    }

    // calculate both selection and local bounds (async, callers must await)
    async updateLocalBounds(): Promise<void> {
        await this.scene.dataProcessor.calcBound(this, this.selectionBoundStorage, this.localBoundStorage);

        // The legacy bounds pass samples transformA as an integer texture. On
        // the unified WebGPU path that readback can occasionally resolve to an
        // all-zero box even though the GPU projector has valid splats. A zero
        // scene radius collapses the camera near/far planes and makes every
        // Gaussian disappear, so recover from the source data when necessary.
        const halfExtents = this.localBoundStorage.halfExtents;
        const validGpuBound = Number.isFinite(halfExtents.x) &&
            Number.isFinite(halfExtents.y) &&
            Number.isFinite(halfExtents.z) &&
            halfExtents.lengthSq() > 1e-12;

        if (!validGpuBound) {
            const fallbackBound = new BoundingBox();
            const state = this.state.data;
            const hasSourceBound = this.splatData.calcAabb(
                fallbackBound,
                (index: number) => (state[index] & State.deleted) === 0
            );

            if (hasSourceBound) {
                this.localBoundStorage.copy(fallbackBound);
            } else {
                // Formats without scale properties can still provide centers.
                // Their center-only box is sufficient for stable camera framing.
                let minX = Infinity;
                let minY = Infinity;
                let minZ = Infinity;
                let maxX = -Infinity;
                let maxY = -Infinity;
                let maxZ = -Infinity;
                for (let i = 0; i < this.centers.length; i += 3) {
                    if ((state[i / 3] & State.deleted) !== 0) continue;
                    const x = this.centers[i];
                    const y = this.centers[i + 1];
                    const z = this.centers[i + 2];
                    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue;
                    minX = Math.min(minX, x);
                    minY = Math.min(minY, y);
                    minZ = Math.min(minZ, z);
                    maxX = Math.max(maxX, x);
                    maxY = Math.max(maxY, y);
                    maxZ = Math.max(maxZ, z);
                }
                if (Number.isFinite(minX)) {
                    veca.set(minX, minY, minZ);
                    vecb.set(maxX, maxY, maxZ);
                    this.localBoundStorage.setMinMax(veca, vecb);
                }
            }
        }
        this.updateWorldBound();
    }

    // update world bound from local bound (synchronous)
    private updateWorldBound() {
        this.worldBoundStorage.setFromTransformedAabb(this.localBoundStorage, this.entity.getWorldTransform());
        // bindAsset runs before Scene.add assigns this.scene. The world bound
        // is still valid at that point; defer the scene-wide invalidation until
        // the element is attached.
        if (this.scene) {
            this.scene.boundDirty = true;
        }
    }

    get resource() {
        return this.asset.resource as GSplatResource;
    }

    markRenderDataDirty() {
        if (this.entity?.gsplat) {
            this.entity.gsplat.workBufferUpdate = WORKBUFFER_UPDATE_ONCE;
            this.changedCounter++;
            if (this.scene) this.scene.forceRender = true;
        }
    }

    // get the selection bound
    get selectionBound() {
        return this.selectionBoundStorage;
    }

    // get local space bound
    get localBound() {
        return this.localBoundStorage;
    }

    // get world space bound
    get worldBound() {
        return this.worldBoundStorage;
    }

    set visible(value: boolean) {
        if (value !== this.visible) {
            this._visible = value;
            this.scene?.events.fire('splat.visibility', this);
        }
    }

    get visible() {
        return this._visible;
    }

    set tintClr(value: Color) {
        if (!this._tintClr.equals(value)) {
            this._tintClr.set(value.r, value.g, value.b);
            this.scene?.events.fire('splat.tintClr', this);
        }
    }

    get tintClr() {
        return this._tintClr;
    }

    set temperature(value: number) {
        if (value !== this._temperature) {
            this._temperature = value;
            this.scene?.events.fire('splat.temperature', this);
        }
    }

    get temperature() {
        return this._temperature;
    }

    set saturation(value: number) {
        if (value !== this._saturation) {
            this._saturation = value;
            this.scene?.events.fire('splat.saturation', this);
        }
    }

    get saturation() {
        return this._saturation;
    }

    set brightness(value: number) {
        if (value !== this._brightness) {
            this._brightness = value;
            this.scene?.events.fire('splat.brightness', this);
        }
    }

    get brightness() {
        return this._brightness;
    }

    set blackPoint(value: number) {
        if (value !== this._blackPoint) {
            this._blackPoint = value;
            this.scene?.events.fire('splat.blackPoint', this);
        }
    }

    get blackPoint() {
        return this._blackPoint;
    }

    set whitePoint(value: number) {
        if (value !== this._whitePoint) {
            this._whitePoint = value;
            this.scene?.events.fire('splat.whitePoint', this);
        }
    }

    get whitePoint() {
        return this._whitePoint;
    }

    set transparency(value: number) {
        if (value !== this._transparency) {
            this._transparency = value;
            this.scene?.events.fire('splat.transparency', this);
        }
    }

    get transparency() {
        return this._transparency;
    }

    // get pivot position/rotation/scale (caller should have awaited operation that changed data)
    getPivot(result: Transform) {
        const { entity } = this;
        // the pivot is the model's local frame: the entity's own frame
        // amended by the user-defined local frame (identity by default, so
        // the pivot then lands exactly on the entity transform)
        quat.mul2(entity.getLocalRotation(), this.localFrame);
        entity.getLocalTransform().transformPoint(this.localFrameOrigin, vec);
        result.set(vec, quat, entity.getLocalScale());
    }

    setLocalFrame(origin: Vec3, rotation: Quat) {
        this.localFrameOrigin.copy(origin);
        this.localFrame.copy(rotation);
        this.scene.events.fire('splat.localFrame', this);
    }

    get hasLocalFrame() {
        return !this.localFrameOrigin.equals(Vec3.ZERO) || !this.localFrame.equals(Quat.IDENTITY);
    }

    docSerialize() {
        const pack3 = (v: Vec3) => [v.x, v.y, v.z];
        const pack4 = (q: Quat) => [q.x, q.y, q.z, q.w];
        const packC = (c: Color) => [c.r, c.g, c.b, c.a];
        return {
            name: this.name,
            position: pack3(this.entity.getLocalPosition()),
            rotation: pack4(this.entity.getLocalRotation()),
            scale: pack3(this.entity.getLocalScale()),
            localFrameOrigin: pack3(this.localFrameOrigin),
            localFrame: pack4(this.localFrame),
            visible: this.visible,
            tintClr: packC(this.tintClr),
            temperature: this.temperature,
            saturation: this.saturation,
            brightness: this.brightness,
            blackPoint: this.blackPoint,
            whitePoint: this.whitePoint,
            transparency: this.transparency
        };
    }

    docDeserialize(doc: any) {
        const { name, position, rotation, scale, visible, tintClr, temperature, saturation, brightness, blackPoint, whitePoint, transparency } = doc;

        this.name = name;
        this.move(new Vec3(position), new Quat(rotation), new Vec3(scale));
        // older documents predate the local frame
        this.localFrameOrigin = doc.localFrameOrigin ? new Vec3(doc.localFrameOrigin) : new Vec3();
        this.localFrame = doc.localFrame ? new Quat(doc.localFrame) : new Quat();
        this.visible = visible ?? true;
        this.tintClr = new Color(tintClr[0], tintClr[1], tintClr[2], tintClr[3] ?? 1);
        this.temperature = temperature ?? 0;
        this.saturation = saturation ?? 1;
        this.brightness = brightness ?? 0;
        this.blackPoint = blackPoint ?? 0;
        this.whitePoint = whitePoint ?? 1;
        this.transparency = transparency ?? 1;
    }
}

export { Splat };
