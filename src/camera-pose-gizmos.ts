import {
    LINECAP_ROUND,
    LINEJOIN_ROUND,
    CULLFACE_NONE,
    PRIMITIVE_TRIANGLES,
    BLEND_NORMAL,
    FILTER_LINEAR,
    ADDRESS_CLAMP_TO_EDGE,
    PIXELFORMAT_RGBA8,
    Color,
    Entity,
    GraphicsDevice,
    Mesh,
    MeshInstance,
    RotateGizmo,
    ShaderMaterial,
    Texture,
    TransformGizmo,
    TranslateGizmo,
    Quat,
    Vec3,
    WideLine,
    WideLineRenderer
} from 'playcanvas';

import { Element, ElementType } from './element';
import { vertexShader, fragmentShader } from './shaders/debug-shader';
import { Splat } from './splat';
import { pickSplatSurfacePoint } from './splat-pick';

const tmpScreen = new Vec3();
const dragStart = new Vec3();
const dragOffset = new Vec3();

type TransformMode = 'translate' | 'rotate';
type SizeAxis = 'x' | 'z';

type TrajectoryCircle = {
    origin: [number, number, number],
    rotation: [number, number, number],
    radius: number,
    radiusX: number,
    radiusZ: number
};

const LABEL_ATLAS_COLUMNS = 12;

// Sequence-number atlas rendered once so labels can be billboarded in world
// space and stay exactly bound to their markers (no DOM projection mismatch).
const labelVertexShader = `
    attribute vec3 vertex_position;
    attribute vec2 vertex_texCoord0;
    varying vec2 vUv;
    uniform mat4 matrix_model;
    uniform mat4 matrix_viewProjection;
    void main(void) {
        vUv = vertex_texCoord0;
        gl_Position = matrix_viewProjection * matrix_model * vec4(vertex_position, 1.0);
        gl_Position.z = 0.0;
    }
`;

const labelFragmentShader = `
    precision highp float;
    varying vec2 vUv;
    uniform sampler2D labelTexture;
    void main(void) {
        vec4 texel = texture2D(labelTexture, vUv);
        if (texel.a < 0.05) discard;
        gl_FragColor = texel;
    }
`;

const createLabelAtlas = (device: GraphicsDevice, labels: string[], cell = 64): Texture => {
    const columns = LABEL_ATLAS_COLUMNS;
    const rows = Math.max(1, Math.ceil(Math.max(labels.length, 1) / columns));
    const canvas = document.createElement('canvas');
    canvas.width = columns * cell;
    canvas.height = rows * cell;
    const context = canvas.getContext('2d');
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.font = `700 ${Math.floor(cell * 0.48)}px sans-serif`;
    for (let index = 0; index < labels.length; index++) {
        const column = index % columns;
        const row = Math.floor(index / columns);
        context.fillStyle = '#ffe14d';
        context.shadowColor = '#000000';
        context.shadowBlur = 4;
        context.fillText(labels[index], (column + 0.5) * cell, (row + 0.5) * cell);
    }
    const imageData = context.getImageData(0, 0, canvas.width, canvas.height);
    const data = imageData.data;
    // Color fully transparent pixels black so linear edge filtering blends correctly.
    for (let i = 0; i < data.length; i += 4) {
        if (data[i + 3] === 0) {
            data[i] = 0;
            data[i + 1] = 0;
            data[i + 2] = 0;
        }
    }
    return new Texture(device, {
        width: canvas.width,
        height: canvas.height,
        format: PIXELFORMAT_RGBA8,
        magFilter: FILTER_LINEAR,
        minFilter: FILTER_LINEAR,
        mipmaps: false,
        levels: [new Uint8Array(data.buffer)]
    });
};

const labelUv = (index: number, columns: number, rows: number) => {
    const column = index % columns;
    const row = Math.floor(index / columns);
    return {
        u0: column / columns,
        u1: (column + 1) / columns,
        // Raw level uploads place canvas row 0 (top) at texture v=0, so a
        // cell's top edge maps to v = row/rows and bottom to v = (row+1)/rows.
        vTop: row / rows,
        vBottom: (row + 1) / rows
    };
};

class CameraPoseGizmos extends Element {
    entity: Entity;
    material: ShaderMaterial;
    markerMesh: Mesh;
    markerMeshInstance: MeshInstance;
    pathRenderer: WideLineRenderer;
    pathLine: WideLine;
    pathVisible = false;
    referenceRenderer: WideLineRenderer;
    referenceLine: WideLine;
    referenceVisible = false;
    private referencePath: Vec3[] = [];
    private referenceViewSignature = '';
    recordedKeyRenderer: WideLineRenderer;
    recordedKeyLines: WideLine[] = [];
    recordedKeyPaths: Vec3[][] = [];
    recordedKeyVisible = false;
    private recordedKeyViewSignature = '';
    recordedTargetRenderer: WideLineRenderer;
    recordedTargetLines: WideLine[] = [];
    recordedTargetVisible = false;
    recordedValidationRenderer: WideLineRenderer;
    recordedValidationLines: WideLine[] = [];
    recordedValidationVisible = false;
    dirty = true;
    selectedFrame: number | null = null;
    selectedOrigin = false;
    gizmos = new Map<TransformMode, TransformGizmo>();
    sizeGizmos = new Map<SizeAxis, TranslateGizmo>();
    sizePivots = new Map<SizeAxis, Entity>();
    gizmoPivot: Entity;
    dragging = false;
    private sizeDragging: SizeAxis | null = null;
    private selectedOriginOccluded = false;
    private occlusionSignature = '';
    private occlusionTimer: number | null = null;
    private onCanvasPointerDown: (event: PointerEvent) => void;
    private labelMesh: Mesh;
    private labelMeshInstance: MeshInstance;
    private labelEntity: Entity;
    private labelMaterial: ShaderMaterial;
    private labelTexture: Texture;
    private labelCenters: Vec3[] = [];
    private labelIndices: number[] = [];
    private labelAtlasSignature = '';
    private labelAtlasRows = 1;

    constructor() {
        super(ElementType.debug);
    }

    add() {
        const scene = this.scene;
        const device = scene.graphicsDevice;

        this.material = new ShaderMaterial({
            uniqueName: 'cameraPoseGizmoMaterial',
            vertexGLSL: vertexShader,
            fragmentGLSL: fragmentShader
        });
        // Test against scene depth without letting editor guides occlude one
        // another or modify the depth buffer used by later overlays.
        this.material.depthWrite = false;
        this.material.depthTest = true;
        this.material.cull = CULLFACE_NONE;
        this.material.update();

        this.markerMesh = new Mesh(device);
        this.markerMesh.primitive[0] = {
            baseVertex: 0,
            type: PRIMITIVE_TRIANGLES,
            base: 0,
            count: 0
        };
        this.markerMeshInstance = new MeshInstance(this.markerMesh, this.material, null);
        this.markerMeshInstance.cull = false;

        this.entity = new Entity('cameraPoseGizmos');
        this.entity.addComponent('render', {
            meshInstances: [this.markerMeshInstance],
            // Render after the splats without clearing depth. The markers are
            // therefore hidden by nearer scene content instead of always
            // floating on top.
            layers: [scene.overlayLayer.id]
        });

        scene.app.root.addChild(this.entity);

        // Sequence-number labels are billboarded world-space quads so they stay
        // exactly on their markers instead of floating as DOM overlays.
        try {
            this.labelTexture = createLabelAtlas(device, ['A1']);
            this.labelMaterial = new ShaderMaterial({
                uniqueName: 'cameraPoseLabelMaterial',
                vertexGLSL: labelVertexShader,
                fragmentGLSL: labelFragmentShader
            });
            this.labelMaterial.setParameter('labelTexture', this.labelTexture);
            this.labelMaterial.blendType = BLEND_NORMAL;
            this.labelMaterial.depthTest = false;
            this.labelMaterial.depthWrite = false;
            this.labelMaterial.cull = CULLFACE_NONE;
            this.labelMaterial.update();
            this.labelMesh = new Mesh(device);
            this.labelMesh.setPositions([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
            this.labelMesh.setUvs(0, [0, 0, 0, 0, 0, 0, 0, 0]);
            this.labelMesh.setIndices([0, 1, 2, 0, 2, 3]);
            this.labelMesh.update(PRIMITIVE_TRIANGLES);
            this.labelMeshInstance = new MeshInstance(this.labelMesh, this.labelMaterial);
            this.labelMeshInstance.cull = false;
            this.labelMeshInstance.visible = false;
            // RenderComponent binds each MeshInstance to its owning entity only
            // when the instances are supplied during component creation.
            this.labelEntity = new Entity('cameraPoseLabels');
            this.labelEntity.addComponent('render', {
                meshInstances: [this.labelMeshInstance],
                layers: [scene.overlayLayer.id]
            });
            scene.app.root.addChild(this.labelEntity);
        } catch (error) {
            console.warn('camera pose label setup failed', error);
        }

        // The trajectory is a screen-space wide polyline, matching the clear
        // path treatment used by 3D-Viewers. Native GPU lines are fixed at one
        // pixel on WebGPU and become nearly invisible over a dense splat.
        this.pathRenderer = new WideLineRenderer(scene.app);
        this.pathRenderer.layer = scene.overlayLayer;
        // The red path is an editing guide and must remain readable over dense
        // splats. Origin spheres still use scene-depth/CPU occlusion below.
        this.pathRenderer.depthTest = false;
        this.pathRenderer.depthWrite = false;
        this.pathLine = new WideLine();
        this.pathLine.cap = LINECAP_ROUND;
        this.pathLine.join = LINEJOIN_ROUND;
        this.pathLine.set([0, 0, 0, 0, 0, 0], new Color(0.94, 0.12, 0.1), 0);
        this.pathRenderer.add(this.pathLine);
        this.referenceRenderer = new WideLineRenderer(scene.app);
        this.referenceRenderer.layer = scene.overlayLayer;
        this.referenceRenderer.depthTest = false;
        this.referenceRenderer.depthWrite = false;
        this.referenceLine = new WideLine();
        this.referenceLine.cap = LINECAP_ROUND;
        this.referenceLine.join = LINEJOIN_ROUND;
        this.referenceLine.set([0, 0, 0, 0, 0, 0], new Color(0.18, 0.86, 0.4), 0);
        this.referenceRenderer.add(this.referenceLine);
        this.recordedKeyRenderer = new WideLineRenderer(scene.app);
        this.recordedKeyRenderer.layer = scene.overlayLayer;
        this.recordedKeyRenderer.depthTest = false;
        this.recordedKeyRenderer.depthWrite = false;
        this.recordedTargetRenderer = new WideLineRenderer(scene.app);
        this.recordedTargetRenderer.layer = scene.overlayLayer;
        this.recordedTargetRenderer.depthTest = false;
        this.recordedTargetRenderer.depthWrite = false;
        this.recordedValidationRenderer = new WideLineRenderer(scene.app);
        this.recordedValidationRenderer.layer = scene.overlayLayer;
        this.recordedValidationRenderer.depthTest = false;
        this.recordedValidationRenderer.depthWrite = false;
        this.gizmoPivot = new Entity('cameraPoseGizmoPivot');
        scene.app.root.addChild(this.gizmoPivot);
        // 3D-Viewer leaves depth testing enabled for its trajectory-plane
        // control. Render after splats without clearing their depth, so the
        // handles disappear behind scene geometry at their true world position.
        const translate = new TranslateGizmo(scene.camera.camera, scene.overlayLayer);
        translate.coordSpace = 'world';
        translate.axisLineThickness = 0.018;
        translate.axisArrowThickness = 0.075;
        translate.axisPlaneSize = 0.15;
        translate.axisCenterSize = 0.1;
        const rotate = new RotateGizmo(scene.camera.camera, scene.overlayLayer);
        // 'local' keeps the rings attached to the trajectory's own axes so
        // pitch, yaw and roll each map to one visible ring.
        rotate.coordSpace = 'local';
        rotate.rotationMode = 'orbit';
        rotate.enableShape('face', false);
        rotate.enableShape('xyz', false);
        rotate._shapes.f.entity.enabled = false;
        rotate._shapes.xyz.entity.enabled = false;
        this.gizmos.set('translate', translate);
        this.gizmos.set('rotate', rotate);

        (['x', 'z'] as SizeAxis[]).forEach((axis) => {
            const pivot = new Entity(`trajectorySizePivot-${axis}`);
            scene.app.root.addChild(pivot);
            const gizmo = new TranslateGizmo(scene.camera.camera, scene.overlayLayer);
            gizmo.coordSpace = 'local';
            gizmo.axisLineThickness = 0.022;
            gizmo.axisArrowThickness = 0.085;
            gizmo.axisPlaneSize = 0.01;
            gizmo.axisCenterSize = 0.01;
            const shapes = gizmo._shapes as Record<string, {
                visible: boolean,
                entity: Entity
            }>;
            for (const shape of ['x', 'y', 'z', 'xy', 'xz', 'yz', 'xyz']) {
                const enabled = shape === axis;
                gizmo.enableShape(shape as 'x' | 'y' | 'z' | 'xy' | 'xz' | 'yz' | 'xyz', enabled);
                if (!enabled) {
                    shapes[shape].visible = false;
                    shapes[shape].entity.enabled = false;
                }
            }
            gizmo.on('render:update', () => {
                Object.entries(shapes).forEach(([shape, item]) => {
                    if (shape !== axis) item.visible = false;
                });
                scene.forceRender = true;
            });
            gizmo.on('transform:start', () => {
                if (!this.selectedOrigin) return;
                this.dragging = true;
                this.sizeDragging = axis;
            });
            gizmo.on('transform:move', () => {
                if (this.sizeDragging !== axis) return;
                const circle = scene.events.invoke('trajectory.circle') as TrajectoryCircle | null;
                if (!circle) return;
                const rotation = new Quat().setFromEulerAngles(...circle.rotation);
                const direction = rotation.transformVector(
                    axis === 'x' ? Vec3.RIGHT.clone() : Vec3.BACK.clone()
                ).normalize();
                const radius = Math.max(
                    Math.abs(pivot.getPosition().clone().sub(new Vec3(circle.origin)).dot(direction)),
                    1e-4
                );
                scene.events.fire(
                    'trajectory.setRadius',
                    axis === 'x' ? radius : circle.radiusX,
                    axis === 'z' ? radius : circle.radiusZ
                );
                scene.forceRender = true;
            });
            gizmo.on('transform:end', () => {
                if (this.sizeDragging !== axis) return;
                this.sizeDragging = null;
                this.dragging = false;
                this.syncSelectedPose();
            });
            this.sizePivots.set(axis, pivot);
            this.sizeGizmos.set(axis, gizmo);
        });

        const updateGizmoSize = () => {
            const { camera, canvas } = scene;
            const size = camera.ortho ?
                1125 / canvas.clientHeight :
                1200 / Math.max(canvas.clientWidth, canvas.clientHeight);
            this.gizmos.forEach((gizmo) => {
                gizmo.size = size;
            });
            this.sizeGizmos.forEach((gizmo) => {
                gizmo.size = size * 0.82;
            });
        };
        updateGizmoSize();
        scene.events.on('camera.resize', updateGizmoSize);
        scene.events.on('camera.ortho', updateGizmoSize);

        this.gizmos.forEach((gizmo, mode) => {
            gizmo.on('render:update', () => {
                scene.forceRender = true;
            });
            gizmo.on('transform:start', () => {
                if (this.selectedFrame === null && !this.selectedOrigin) return;
                this.dragging = true;
                dragStart.copy(this.gizmoPivot.getPosition());
                if (!this.selectedOrigin) {
                    scene.events.fire('track.poseDragStart', this.selectedFrame);
                }
            });
            gizmo.on('transform:move', () => {
                if (!this.dragging) return;
                dragOffset.sub2(this.gizmoPivot.getPosition(), dragStart);
                if (this.selectedOrigin) {
                    if (mode === 'translate') {
                        scene.events.fire('trajectory.setOriginPosition', this.gizmoPivot.getPosition().clone());
                    } else if (mode === 'rotate') {
                        scene.events.fire('trajectory.setOriginRotation', this.gizmoPivot.getEulerAngles().clone());
                    }
                } else if (this.selectedFrame !== null) {
                    scene.events.fire('track.poseDragMove', this.selectedFrame, dragOffset.clone());
                }
                scene.forceRender = true;
            });
            gizmo.on('transform:end', () => {
                if (!this.dragging) return;
                this.dragging = false;
                if (!this.selectedOrigin && this.selectedFrame !== null) {
                    scene.events.fire('track.poseDragEnd', this.selectedFrame);
                }
                this.gizmoPivot.setLocalScale(1, 1, 1);
                this.syncSelectedPose();
                this.occlusionSignature = '';
                this.scheduleOriginOcclusionCheck();
            });
        });

        this.onCanvasPointerDown = (event: PointerEvent) => {
            if (!event.isPrimary || event.button !== 0) {
                return;
            }
            if (!scene.events.invoke('camera.showPoses')) return;
            const generatedCurrent = scene.events.invoke('trajectory.generatedCurrent');
            const recordedActive = ((scene.events.invoke('recordedView.state') as {
                keyframeCount?: number
            } | undefined)?.keyframeCount ?? 0) > 0;
            const poses = generatedCurrent === false || recordedActive ? [] :
                scene.events.invoke('camera.poses') as { frame: number, position: Vec3 }[];
            const rect = scene.canvas.getBoundingClientRect();
            const cameraPosition = scene.camera.mainCamera.getPosition();
            const cameraForward = scene.camera.mainCamera.forward;
            const inFrontOfCamera = (position: Vec3) => (
                position.clone().sub(cameraPosition).dot(cameraForward) > 0
            );
            let nearest: { frame: number, distance: number } | null = null;
            for (const pose of poses ?? []) {
                scene.camera.worldToScreen(pose.position, tmpScreen);
                if (!inFrontOfCamera(pose.position)) continue;
                const dx = tmpScreen.x * rect.width - (event.clientX - rect.left);
                const dy = tmpScreen.y * rect.height - (event.clientY - rect.top);
                const distance = Math.hypot(dx, dy);
                if (distance <= 14 && (!nearest || distance < nearest.distance)) {
                    nearest = { frame: pose.frame, distance };
                }
            }
            if (!nearest || nearest.frame === this.selectedFrame) return;
            this.selectedOrigin = false;
            this.selectedFrame = nearest.frame;
            scene.events.fire('timeline.setFrame', nearest.frame);
            this.syncSelectedPose();
            this.dirty = true;
            scene.forceRender = true;
            event.preventDefault();
            event.stopImmediatePropagation();
        };
        scene.canvas.addEventListener('pointerdown', this.onCanvasPointerDown, true);

        // mark dirty when poses or scene bound change
        const markDirty = () => {
            this.dirty = true;
            if (!this.dragging) {
                this.syncSelectedPose();
            }
            if (scene.events.invoke('camera.showPoses')) {
                scene.forceRender = true;
            }
        };
        const { events } = scene;
        events.on('track.keyAdded', markDirty);
        events.on('track.keyRemoved', markDirty);
        events.on('track.keyMoved', markDirty);
        events.on('track.keyUpdated', markDirty);
        events.on('track.poseUpdated', markDirty);
        events.on('track.keysCleared', markDirty);
        events.on('track.keysLoaded', markDirty);
        events.on('recordedView.changed', markDirty);
        events.on('realCameraDataset.changed', markDirty);
        events.on('timeline.playing', markDirty);
        events.on('scene.boundChanged', markDirty);
        events.on('trajectory.changed', () => {
            // Timeline poses belong to the last generated plan. Once the plan is
            // edited, detach any selected timeline pose until it is regenerated.
            if (events.invoke('trajectory.generatedCurrent') === false && this.selectedFrame !== null) {
                this.selectedFrame = null;
                this.gizmos.forEach(gizmo => gizmo.detach());
            }
            markDirty();
        });
        events.on('trajectory.segmentSelectionChanged', () => {
            markDirty();
        });
        events.on('timeline.frame', (frame: number) => {
            if (events.invoke('trajectory.generatedCurrent') === false) return;
            if (!this.dragging && (events.invoke('track.keys') as number[]).includes(frame)) {
                this.selectedOrigin = false;
                this.selectedFrame = frame;
                this.syncSelectedPose();
                markDirty();
            }
        });
    }

    destroy() {
        if (this.occlusionTimer !== null) window.clearTimeout(this.occlusionTimer);
        this.scene?.canvas.removeEventListener('pointerdown', this.onCanvasPointerDown, true);
        this.gizmos.forEach((gizmo) => {
            gizmo.detach();
            gizmo.destroy();
        });
        this.sizeGizmos.forEach((gizmo) => {
            gizmo.detach();
            gizmo.destroy();
        });
        this.sizePivots.forEach(pivot => pivot.destroy());
        this.pathRenderer?.destroy();
        this.referenceRenderer?.destroy();
        this.recordedKeyRenderer?.destroy();
        this.recordedTargetRenderer?.destroy();
        this.recordedValidationRenderer?.destroy();
        this.labelEntity?.destroy();
        this.labelMesh?.destroy();
        this.labelMaterial?.destroy();
        this.labelTexture?.destroy();
        this.gizmoPivot?.destroy();
        this.entity?.destroy();
    }

    onPreRender() {
        const { scene } = this;
        const visible = scene.events.invoke('camera.showPoses') && scene.camera.renderOverlays;

        this.entity.enabled = visible;
        if (this.pathRenderer) {
            this.pathRenderer.enabled = visible && this.pathVisible;
        }
        if (this.referenceRenderer) {
            this.referenceRenderer.enabled = visible && this.referenceVisible;
        }
        if (this.recordedKeyRenderer) {
            this.recordedKeyRenderer.enabled = visible && this.recordedKeyVisible;
        }
        if (this.recordedTargetRenderer) {
            this.recordedTargetRenderer.enabled = visible && this.recordedTargetVisible;
        }
        if (this.recordedValidationRenderer) {
            this.recordedValidationRenderer.enabled = visible && this.recordedValidationVisible;
        }
        this.gizmos.forEach((gizmo) => {
            gizmo.enabled = false;
        });
        this.sizeGizmos.forEach((gizmo) => {
            gizmo.enabled = false;
        });

        if (visible && this.dirty) {
            this.dirty = false;
            this.rebuildMesh();
        }
        this.updateRecordedKeyPathForCamera();
        this.updateReferencePathForCamera();
        this.updateLabelBillboards();
    }

    onUpdate() {
        if (!this.selectedOrigin || this.dragging) return;
        const origin = this.scene.events.invoke('trajectory.origin') as {
            position: [number, number, number]
        } | null;
        if (!origin) return;
        const cameraPosition = this.scene.camera.mainCamera.getPosition();
        const cameraForward = this.scene.camera.mainCamera.forward;
        const signature = [
            ...origin.position,
            cameraPosition.x, cameraPosition.y, cameraPosition.z,
            cameraForward.x, cameraForward.y, cameraForward.z
        ].map(value => value.toFixed(5)).join(',');
        if (signature === this.occlusionSignature) return;
        this.occlusionSignature = signature;
        this.scheduleOriginOcclusionCheck();
    }

    private syncLinePool(renderer: WideLineRenderer, lines: WideLine[], count: number) {
        while (lines.length < count) {
            const line = new WideLine();
            line.cap = LINECAP_ROUND;
            line.join = LINEJOIN_ROUND;
            renderer.add(line);
            lines.push(line);
        }
        while (lines.length > count) {
            const line = lines.pop();
            if (line) renderer.remove(line);
        }
    }

    private syncLabelAtlas(labels: string[]) {
        if (!this.labelMaterial || labels.length === 0) return;
        const signature = labels.join('\u0000');
        if (signature === this.labelAtlasSignature) return;
        const texture = createLabelAtlas(this.scene.graphicsDevice, labels);
        const previous = this.labelTexture;
        this.labelTexture = texture;
        this.labelMaterial.setParameter('labelTexture', texture);
        this.labelAtlasSignature = signature;
        this.labelAtlasRows = Math.max(1, Math.ceil(labels.length / LABEL_ATLAS_COLUMNS));
        previous?.destroy();
    }

    private rebuildMesh() {
        const generatedCurrent = this.scene.events.invoke('trajectory.generatedCurrent');
        const timelinePoses = (this.scene.events.invoke('camera.poses') as {
            frame: number,
            position: Vec3,
            target: Vec3
        }[] | undefined) ?? [];
        const previewPoses = (this.scene.events.invoke('trajectory.previewPoses') as {
            frame: number,
            position: Vec3,
            target: Vec3
        }[] | undefined) ?? [];
        const referencePoses = (this.scene.events.invoke('realCameraDataset.renderData') as {
            imageId: number,
            position: Vec3,
            target: Vec3
        }[] | undefined) ?? [];
        // A changed plan is rendered from its authoritative live solution so the
        // path and markers move with the origin. Once generated, use timeline
        // poses so intentional per-camera adjustments remain visible.
        const recordedData = this.scene.events.invoke('recordedView.renderData') as {
            state: { keyframeCount: number, finished: boolean, showTarget: boolean, showValidation: boolean },
            keyframes: typeof timelinePoses,
            targetPoses: typeof timelinePoses,
            validationPoses: typeof timelinePoses,
            trajectories?: {
                id: string,
                label: string,
                active: boolean,
                keyframes: typeof timelinePoses,
                targetPoses: typeof timelinePoses,
                validationPoses: typeof timelinePoses,
                state: { keyframeCount: number, finished: boolean, showTarget: boolean, showValidation: boolean }
            }[]
        } | undefined;
        const recordedTracks = recordedData?.trajectories ?? (recordedData ? [{
            id: 'legacy',
            label: 'A',
            active: true,
            keyframes: recordedData.keyframes,
            targetPoses: recordedData.targetPoses,
            validationPoses: recordedData.validationPoses,
            state: recordedData.state
        }] : []);
        const recordedActive = recordedTracks.some(track => track.keyframes.length > 0);
        const labelEntries = recordedTracks.flatMap(track => track.keyframes.map((keyframe, index) => ({
            center: keyframe.position.clone(),
            text: `${track.label}${index + 1}`
        })));
        this.labelCenters = labelEntries.map(entry => entry.center);
        this.labelIndices = labelEntries.map((_, index) => index);
        this.syncLabelAtlas(labelEntries.map(entry => entry.text));
        this.recordedKeyViewSignature = '';
        // Once a recorded trajectory is finished, the timeline contains the red
        // target poses. Suppress the generic teal copy and draw the target and
        // COLMAP round-trip explicitly below.
        const poses = recordedActive ? [] :
            (generatedCurrent === false ? previewPoses : timelinePoses);

        const circle = this.scene.events.invoke('trajectory.circle') as TrajectoryCircle | null;
        // Scale the guides from the trajectory the user is editing, not from the
        // scene bound. A single stray splat used to inflate the bound and made
        // every marker the wrong size relative to the visible model.
        const referenceSize = circle && circle.radius > 1e-4 ?
            circle.radius : Math.max(this.scene.bound.halfExtents.length() * 0.25, 0.08);
        const arrowLength = Math.max(referenceSize * 0.015, 3e-4);
        const playing = !!this.scene.events.invoke('timeline.playing');
        const markerPositions: number[] = [];
        const markerColors: number[] = [];

        const pushTriangle = (a: Vec3, b: Vec3, c: Vec3, color: [number, number, number, number]) => {
            markerPositions.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
            markerColors.push(...color, ...color, ...color);
        };
        const pushSphere = (center: Vec3, radius: number, color: [number, number, number, number]) => {
            const latitudeBands = 6;
            const longitudeBands = 8;
            const point = (latitude: number, longitude: number) => {
                const phi = latitude / latitudeBands * Math.PI - Math.PI * 0.5;
                const theta = longitude / longitudeBands * Math.PI * 2;
                const ring = Math.cos(phi) * radius;
                return center.clone().add(new Vec3(
                    Math.cos(theta) * ring,
                    Math.sin(phi) * radius,
                    Math.sin(theta) * ring
                ));
            };
            for (let latitude = 0; latitude < latitudeBands; latitude++) {
                for (let longitude = 0; longitude < longitudeBands; longitude++) {
                    const a = point(latitude, longitude);
                    const b = point(latitude, longitude + 1);
                    const c = point(latitude + 1, longitude + 1);
                    const d = point(latitude + 1, longitude);
                    pushTriangle(a, b, c, color);
                    pushTriangle(a, c, d, color);
                }
            }
        };
        const pushArrow = (
            start: Vec3, direction: Vec3, length: number, color: [number, number, number, number]
        ) => {
            const forward = direction.clone();
            if (forward.lengthSq() < 1e-12) forward.copy(Vec3.BACK);
            else forward.normalize();
            const side = new Vec3().cross(
                forward, Math.abs(forward.dot(Vec3.UP)) > 0.98 ? Vec3.RIGHT : Vec3.UP
            ).normalize();
            const up = new Vec3().cross(side, forward).normalize();
            const shaftStart = start.clone();
            const shaftEnd = start.clone().addScaled(forward, length * 0.68);
            const tip = start.clone().addScaled(forward, length);
            const shaftRadius = length * 0.028;
            const headRadius = length * 0.09;
            const sides = 8;
            const ringPoint = (center: Vec3, radius: number, index: number) => {
                const angle = index / sides * Math.PI * 2;
                return center.clone()
                .addScaled(side, Math.cos(angle) * radius)
                .addScaled(up, Math.sin(angle) * radius);
            };
            for (let index = 0; index < sides; index++) {
                const next = index + 1;
                const a = ringPoint(shaftStart, shaftRadius, index);
                const b = ringPoint(shaftStart, shaftRadius, next);
                const c = ringPoint(shaftEnd, shaftRadius, next);
                const d = ringPoint(shaftEnd, shaftRadius, index);
                pushTriangle(a, b, c, color);
                pushTriangle(a, c, d, color);
                pushTriangle(ringPoint(shaftEnd, headRadius, index),
                    ringPoint(shaftEnd, headRadius, next), tip, color);
            }
        };

        // A generated camera is represented only by a solid point and its
        // forward arrow. There is deliberately no camera-frustum wireframe.
        const markerRadius = Math.max(referenceSize * 0.0015, 3e-5);
        for (const pose of poses) {
            const selected = pose.frame === this.selectedFrame;
            const color: [number, number, number, number] = selected ?
                [255, 174, 35, 255] : [0, 190, 155, 255];
            pushSphere(pose.position, markerRadius * (selected ? 1.35 : 1), color);
            if (!playing) {
                pushArrow(
                    pose.position.clone().addScaled(
                        pose.target.clone().sub(pose.position).normalize(), markerRadius * 0.7
                    ),
                    pose.target.clone().sub(pose.position),
                    arrowLength * (selected ? 1.2 : 1),
                    color
                );
            }
        }
        const recordedMarkerSets: {
            poses: { position: Vec3, target: Vec3 }[],
            color: [number, number, number, number],
            radiusScale: number,
            arrowScale: number,
            showArrow: boolean
        }[] = [];
        if (referencePoses.length > 0) {
            recordedMarkerSets.push({
                poses: referencePoses,
                color: [46, 222, 104, 255],
                radiusScale: 0.8,
                arrowScale: 0.82,
                showArrow: true
            });
        }
        for (const track of recordedTracks) {
            if (track.state.showTarget) {
                recordedMarkerSets.push({
                    poses: track.keyframes,
                    color: [255, 200, 0, 255],
                    radiusScale: track.active ? 1.2 : 1,
                    arrowScale: track.active ? 1.2 : 1,
                    showArrow: true
                });
                recordedMarkerSets.push({
                    poses: track.targetPoses,
                    color: [238, 48, 48, 255],
                    radiusScale: 1,
                    arrowScale: 1,
                    showArrow: true
                });
            }
            if (track.state.showValidation) {
                recordedMarkerSets.push({
                    poses: track.validationPoses,
                    color: [45, 112, 255, 255],
                    radiusScale: 0.55,
                    arrowScale: 0.72,
                    showArrow: true
                });
            }
        }
        const observerPosition = this.scene.camera.mainCamera.getPosition();
        for (const markerSet of recordedMarkerSets) {
            for (const pose of markerSet.poses) {
                const direction = pose.target.clone().sub(pose.position);
                const markerSize = this.worldUnitsForPixels(pose.position, 7 * markerSet.radiusScale);
                // A newly captured key is exactly at the observer camera. Do
                // not render solid geometry around the eye or it fills the
                // near plane and turns the entire viewport red/orange.
                if (pose.position.distance(observerPosition) <= markerSize * 1.5) continue;
                pushSphere(pose.position, markerSize, markerSet.color);
                if (markerSet.showArrow && !playing) {
                    pushArrow(
                        pose.position.clone().addScaled(direction.clone().normalize(), markerSize * 0.7),
                        direction,
                        this.worldUnitsForPixels(pose.position, 30 * markerSet.arrowScale),
                        markerSet.color
                    );
                }
            }
        }
        const ordered = poses.slice().sort((a, b) => a.frame - b.frame);
        const preview = this.scene.events.invoke('trajectory.previewPoints') as Vec3[] | undefined;
        const path = !recordedActive && generatedCurrent === false && preview && preview.length > 1 ?
            preview : ordered.map(pose => pose.position);
        this.pathVisible = path.length > 1;
        if (this.pathVisible) {
            this.pathLine.set(
                path.flatMap(point => [point.x, point.y, point.z]),
                new Color(0.94, 0.12, 0.1),
                5
            );
        }
        this.pathRenderer.enabled = this.pathVisible &&
            !!this.scene.events.invoke('camera.showPoses') && this.scene.camera.renderOverlays;

        this.referencePath = referencePoses.map(pose => pose.position.clone());
        this.referenceViewSignature = '';
        this.referenceVisible = this.referencePath.length > 1;
        if (this.referenceVisible) {
            this.referenceLine.set(
                this.referencePath.flatMap(point => [point.x, point.y, point.z]),
                new Color(0.18, 0.86, 0.4),
                7
            );
        }
        this.referenceRenderer.enabled = this.referenceVisible &&
            !!this.scene.events.invoke('camera.showPoses') && this.scene.camera.renderOverlays;

        const setRecordedPath = (
            line: WideLine,
            points: typeof timelinePoses,
            color: Color,
            width: number
        ) => {
            if (points.length < 2) return false;
            const orderedPoints = points.slice().sort((a, b) => a.frame - b.frame);
            line.set(
                orderedPoints.flatMap(pose => [pose.position.x, pose.position.y, pose.position.z]),
                color,
                width
            );
            return true;
        };
        const keyTracks = recordedTracks.filter(track => track.state.showTarget && track.keyframes.length >= 2);
        this.syncLinePool(this.recordedKeyRenderer, this.recordedKeyLines, keyTracks.length);
        this.recordedKeyPaths = keyTracks.map(track => track.keyframes.map(pose => pose.position.clone()));
        keyTracks.forEach((track, index) => setRecordedPath(
            this.recordedKeyLines[index],
            track.keyframes,
            new Color(1.0, 0.78, 0.0),
            track.active ? 7 : 5
        ));
        this.recordedKeyVisible = keyTracks.length > 0;

        const targetTracks = recordedTracks.filter(track => track.state.showTarget && track.targetPoses.length >= 2);
        this.syncLinePool(this.recordedTargetRenderer, this.recordedTargetLines, targetTracks.length);
        targetTracks.forEach((track, index) => setRecordedPath(
            this.recordedTargetLines[index],
            track.targetPoses,
            new Color(0.93, 0.19, 0.19),
            9
        ));
        this.recordedTargetVisible = targetTracks.length > 0;

        const validationTracks = recordedTracks.filter(
            track => track.state.showValidation && track.validationPoses.length >= 2
        );
        this.syncLinePool(this.recordedValidationRenderer, this.recordedValidationLines, validationTracks.length);
        validationTracks.forEach((track, index) => setRecordedPath(
            this.recordedValidationLines[index],
            track.validationPoses,
            new Color(0.18, 0.44, 1),
            4
        ));
        this.recordedValidationVisible = validationTracks.length > 0;
        const overlaysVisible = !!this.scene.events.invoke('camera.showPoses') && this.scene.camera.renderOverlays;
        this.recordedKeyRenderer.enabled = this.recordedKeyVisible && overlaysVisible;
        this.recordedTargetRenderer.enabled = this.recordedTargetVisible && overlaysVisible;
        this.recordedValidationRenderer.enabled = this.recordedValidationVisible && overlaysVisible;

        if (markerPositions.length === 0) {
            this.markerMesh.primitive[0].count = 0;
            this.markerMeshInstance.visible = false;
        } else {
            this.markerMeshInstance.visible = false;
            this.markerMesh.setPositions(markerPositions);
            this.markerMesh.setColors32(new Uint8Array(markerColors));
            this.markerMesh.update(PRIMITIVE_TRIANGLES);
            this.markerMeshInstance.visible = true;
        }

    }

    private syncSelectedPose() {
        this.selectedOrigin = false;
        this.gizmos.forEach(gizmo => gizmo.detach());
        this.sizeGizmos.forEach(gizmo => gizmo.detach());
    }

    private updateLabelBillboards() {
        try {
            if (!this.labelMeshInstance) return;
            const visible = this.labelCenters.length > 0 &&
                !!this.scene.events.invoke('camera.showPoses') && this.scene.camera.renderOverlays;
            if (!visible) {
                this.labelMeshInstance.visible = false;
                return;
            }
            const mainCamera = this.scene.camera.mainCamera;
            const right = mainCamera.right;
            const up = mainCamera.up;
            const rows = this.labelAtlasRows;
            const positions: number[] = [];
            const uvs: number[] = [];
            const indices: number[] = [];
            const cameraPosition = mainCamera.getPosition();
            let visibleLabelCount = 0;
            this.labelCenters.forEach((center, index) => {
                const uv = labelUv(this.labelIndices[index], LABEL_ATLAS_COLUMNS, rows);
                const half = this.worldUnitsForPixels(center, 14);
                // Selecting a recorded point places the observer exactly on that
                // point. A billboard at the eye crosses the near plane and can
                // cover the entire viewport, so the screen-space toast represents
                // the active point while its world label is temporarily omitted.
                if (center.distance(cameraPosition) <= half * 2) return;
                const base = visibleLabelCount * 4;
                visibleLabelCount++;
                positions.push(
                    center.x - right.x * half - up.x * half,
                    center.y - right.y * half - up.y * half,
                    center.z - right.z * half - up.z * half,
                    center.x + right.x * half - up.x * half,
                    center.y + right.y * half - up.y * half,
                    center.z + right.z * half - up.z * half,
                    center.x + right.x * half + up.x * half,
                    center.y + right.y * half + up.y * half,
                    center.z + right.z * half + up.z * half,
                    center.x - right.x * half + up.x * half,
                    center.y - right.y * half + up.y * half,
                    center.z - right.z * half + up.z * half
                );
                uvs.push(uv.u0, uv.vBottom, uv.u1, uv.vBottom, uv.u1, uv.vTop, uv.u0, uv.vTop);
                indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
            });
            if (visibleLabelCount === 0) {
                this.labelMeshInstance.visible = false;
                return;
            }
            this.labelMesh.setPositions(positions);
            this.labelMesh.setUvs(0, uvs);
            this.labelMesh.setIndices(indices);
            this.labelMesh.update(PRIMITIVE_TRIANGLES);
            this.labelMeshInstance.visible = true;
        } catch (error) {
            if (this.labelMeshInstance) this.labelMeshInstance.visible = false;
        }
    }

    private worldUnitsForPixels(position: Vec3, pixels: number) {
        const camera = this.scene.camera;
        const cameraPosition = camera.mainCamera.getPosition();
        const depth = Math.max(
            position.clone().sub(cameraPosition).dot(camera.mainCamera.forward),
            camera.near,
            1e-6
        );
        const viewportSize = camera.camera.horizontalFov ?
            this.scene.canvas.clientWidth : this.scene.canvas.clientHeight;
        const worldHeight = 2 * depth * Math.tan(camera.fov * Math.PI / 360);
        return worldHeight / Math.max(viewportSize, 1) * pixels;
    }

    private updateRecordedKeyPathForCamera() {
        if (!this.recordedKeyVisible || this.recordedKeyPaths.length === 0) {
            this.recordedKeyViewSignature = '';
            return;
        }
        const camera = this.scene.camera;
        const position = camera.mainCamera.getPosition();
        const forward = camera.mainCamera.forward;
        const signature = [
            position.x, position.y, position.z,
            forward.x, forward.y, forward.z,
            camera.near, camera.far
        ].map(value => value.toFixed(6)).join(',');
        if (signature === this.recordedKeyViewSignature) return;
        this.recordedKeyViewSignature = signature;

        // WideLine ignores scene depth when depthTest is false, but its vertices
        // are still clipped by the camera far plane. Pull only the display copy
        // of an over-range point back along the same camera ray. Its screen
        // projection is unchanged and the real trajectory data remains intact.
        const maximumDepth = Math.max(camera.far * 0.98, camera.near * 2);
        this.recordedKeyPaths.forEach((path, index) => {
            const points = path.map((point) => {
                const offset = point.clone().sub(position);
                const depth = offset.dot(forward);
                return Number.isFinite(maximumDepth) && depth > maximumDepth ?
                    position.clone().add(offset.mulScalar(maximumDepth / depth)) : point;
            });
            this.recordedKeyLines[index].set(
                points.flatMap(point => [point.x, point.y, point.z]),
                new Color(1.0, 0.78, 0.0),
                6
            );
        });
    }

    private updateReferencePathForCamera() {
        if (!this.referenceVisible || this.referencePath.length < 2) {
            this.referenceViewSignature = '';
            return;
        }
        const camera = this.scene.camera;
        const position = camera.mainCamera.getPosition();
        const forward = camera.mainCamera.forward;
        const signature = [
            position.x, position.y, position.z,
            forward.x, forward.y, forward.z,
            camera.near, camera.far
        ].map(value => value.toFixed(6)).join(',');
        if (signature === this.referenceViewSignature) return;
        this.referenceViewSignature = signature;
        const maximumDepth = Math.max(camera.far * 0.98, camera.near * 2);
        const points = this.referencePath.map((point) => {
            const offset = point.clone().sub(position);
            const depth = offset.dot(forward);
            return Number.isFinite(maximumDepth) && depth > maximumDepth ?
                position.clone().add(offset.mulScalar(maximumDepth / depth)) : point;
        });
        this.referenceLine.set(
            points.flatMap(point => [point.x, point.y, point.z]),
            new Color(0.18, 0.86, 0.4),
            7
        );
    }

    private scheduleOriginOcclusionCheck() {
        if (!this.selectedOrigin || this.dragging) return;
        if (this.occlusionTimer !== null) window.clearTimeout(this.occlusionTimer);
        this.occlusionTimer = window.setTimeout(() => {
            this.occlusionTimer = null;
            this.updateOriginOcclusion();
        }, 120);
    }

    private updateOriginOcclusion() {
        const origin = this.scene.events.invoke('trajectory.origin') as {
            position: [number, number, number]
        } | null;
        if (!origin) return;

        const position = new Vec3(origin.position);
        this.scene.camera.worldToScreen(position, tmpScreen);
        const cameraPosition = this.scene.camera.mainCamera.getPosition();
        const inFront = position.clone().sub(cameraPosition).dot(this.scene.camera.mainCamera.forward) > 0;
        if (!inFront || tmpScreen.x < 0 || tmpScreen.x > 1 ||
            tmpScreen.y < 0 || tmpScreen.y > 1) {
            if (this.selectedOriginOccluded) {
                this.selectedOriginOccluded = false;
                this.dirty = true;
                this.scene.forceRender = true;
            }
            return;
        }

        const originDistance = position.distance(cameraPosition);
        const offsetX = tmpScreen.x * this.scene.canvas.clientWidth;
        const offsetY = tmpScreen.y * this.scene.canvas.clientHeight;
        const local = new Vec3();
        const world = new Vec3();
        let surfaceDistance = Number.POSITIVE_INFINITY;
        const splats = (this.scene.getElementsByType(ElementType.splat) as Splat[])
        .filter(splat => splat.visible && splat.numSplats > 0);
        for (const splat of splats) {
            if (!pickSplatSurfacePoint(this.scene, splat, offsetX, offsetY, local)) continue;
            splat.worldTransform.transformPoint(local, world);
            surfaceDistance = Math.min(surfaceDistance, world.distance(cameraPosition));
        }
        const tolerance = Math.max(originDistance * 0.01, 1e-3);
        const occluded = surfaceDistance + tolerance < originDistance;
        if (occluded !== this.selectedOriginOccluded) {
            this.selectedOriginOccluded = occluded;
            this.dirty = true;
            this.scene.forceRender = true;
        }
    }
}

export { CameraPoseGizmos };
