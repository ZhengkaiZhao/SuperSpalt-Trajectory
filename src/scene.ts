import {
    EVENT_POSTRENDER_LAYER,
    EVENT_PRERENDER_LAYER,
    LAYERID_DEPTH,
    SORTMODE_CUSTOM,
    GSPLAT_RENDERER_RASTER_GPU_SORT,
    BoundingBox,
    CameraComponent,
    Color,
    Entity,
    Layer,
    GraphicsDevice,
    MeshInstance,
    Vec3
} from 'playcanvas';

import { AssetLoader } from './asset-loader';
import { Camera } from './camera';
import { CameraPoseGizmos } from './camera-pose-gizmos';
import { CommandQueue } from './command-queue';
import { DataProcessor } from './data-processor';
import { Element, ElementType, ElementTypeList } from './element';
import { Events } from './events';
import { InfiniteGrid as Grid } from './infinite-grid';
import { Outline } from './outline';
import { PCApp } from './pc-app';
import { SceneConfig } from './scene-config';
import { SceneState } from './scene-state';
import { Splat } from './splat';
import { SplatOverlay } from './splat-overlay';
import { Underlay } from './underlay';

// sort meshInstances by the aabb corner furthest from the camera
const corner = new Vec3();
const specialSort = (instances: MeshInstance[], numInstances: number, cameraPos: Vec3, cameraDir: Vec3) => {
    const distances = new Map<MeshInstance, number>();

    for (let i = 0; i < numInstances; i++) {
        const instance = instances[i];
        const { aabb } = instance;
        const { center, halfExtents } = aabb;

        // loop over all 8 aabb corners and find the furthest distance along the camera view direction
        let maxDist = -Infinity;
        for (let cx = -1; cx <= 1; cx += 2) {
            for (let cy = -1; cy <= 1; cy += 2) {
                for (let cz = -1; cz <= 1; cz += 2) {
                    corner.set(
                        center.x + cx * halfExtents.x,
                        center.y + cy * halfExtents.y,
                        center.z + cz * halfExtents.z
                    );
                    // project camera-to-corner vector onto camera direction
                    const dist = (corner.x - cameraPos.x) * cameraDir.x +
                                    (corner.y - cameraPos.y) * cameraDir.y +
                                    (corner.z - cameraPos.z) * cameraDir.z;
                    if (dist > maxDist) {
                        maxDist = dist;
                    }
                }
            }
        }

        // store in map for reuse during sort
        distances.set(instance, maxDist);
    }

    // sort instances back-to-front by calculated distance (furthest first)
    instances.sort((a, b) => distances.get(b) - distances.get(a));
};

class Scene {
    events: Events;
    config: SceneConfig;
    canvas: HTMLCanvasElement;
    app: PCApp;
    worldLayer: Layer;
    splatLayer: Layer;
    overlayLayer: Layer;
    gizmoLayer: Layer;
    sceneState = [new SceneState(), new SceneState()];
    elements: Element[] = [];
    boundStorage = new BoundingBox();
    boundDirty = true;
    forceRender = false;
    visibleGaussianCount = 0;
    renderedFps = 0;
    lastRenderTime = 0;

    lockedRenderMode = false;
    lockedRender = false;

    canvasResize: {width: number; height: number} | null = null;
    targetSize = {
        width: 0,
        height: 0
    };

    dataProcessor: DataProcessor;
    assetLoader: AssetLoader;
    camera: Camera;
    cameraPoseGizmos: CameraPoseGizmos;
    splatOverlay: SplatOverlay;
    grid: Grid;
    outline: Outline;
    underlay: Underlay;

    // shared queue for serialising async splat work. exposed so subsystems that
    // need to order their async work alongside edit-history operations can do so
    // without going through edit-history directly.
    commandQueue: CommandQueue;

    contentRoot: Entity;
    cameraRoot: Entity;

    constructor(
        events: Events,
        config: SceneConfig,
        canvas: HTMLCanvasElement,
        graphicsDevice: GraphicsDevice,
        commandQueue: CommandQueue
    ) {
        this.events = events;
        this.config = config;
        this.canvas = canvas;
        this.commandQueue = commandQueue;

        // configure the playcanvas application. we render to an offscreen buffer so require
        // only the simplest of backbuffers.
        this.app = new PCApp(canvas, { graphicsDevice });

        // Unified Gaussian rendering is the only path that uses the WebGPU
        // radix/project pipeline. Keep this explicit so engine defaults cannot
        // switch the editor back to the legacy worker/CPU sorter.
        this.app.scene.gsplat.renderer = GSPLAT_RENDERER_RASTER_GPU_SORT;
        if (this.app.scene.gsplat.currentRenderer !== GSPLAT_RENDERER_RASTER_GPU_SORT) {
            throw new Error('WebGPU 已创建，但 GPU Gaussian Sort 初始化失败。');
        }

        // only render the scene when instructed
        this.app.autoRender = false;
        // @ts-ignore
        this.app._allowResize = false;
        this.app.scene.clusteredLightingEnabled = false;

        // hack: disable lightmapper first bake until we expose option for this
        // @ts-ignore
        this.app.off('prerender', this.app._firstBake, this.app);

        // @ts-ignore
        this.app.loader.getHandler('texture').imgParser.crossOrigin = 'anonymous';

        // this is required to get full res AR mode backbuffer
        // Gaussian rendering is fill-rate heavy. Cap the interactive canvas DPR
        // while keeping explicit image/video export resolutions unchanged.
        this.app.graphicsDevice.maxPixelRatio = Math.min(window.devicePixelRatio, 1.5);

        // configure application canvas
        const observer = new ResizeObserver((entries: ResizeObserverEntry[]) => {
            if (entries.length > 0) {
                const entry = entries[0];
                if (entry) {
                    // devicePixelContentBoxSize always uses the native display DPR and would
                    // bypass our performance cap. Start from CSS pixels on every browser.
                    const pixelRatio = Math.min(window.devicePixelRatio, 1.5);
                    const contentSize = entry.contentBoxSize?.[0];
                    const width = contentSize?.inlineSize ?? entry.contentRect.width;
                    const height = contentSize?.blockSize ?? entry.contentRect.height;
                    this.canvasResize = {
                        width: Math.max(1, Math.ceil(width * pixelRatio)),
                        height: Math.max(1, Math.ceil(height * pixelRatio))
                    };
                }
                this.forceRender = true;
            }
        });

        observer.observe(window.document.getElementById('canvas-container'));

        // configure depth layers to handle dynamic refraction
        const depthLayer = this.app.scene.layers.getLayerById(LAYERID_DEPTH);
        this.app.scene.layers.remove(depthLayer);
        this.app.scene.layers.insertOpaque(depthLayer, 2);

        // register application callbacks
        this.app.on('update', (deltaTime: number) => this.onUpdate(deltaTime));
        this.app.on('prerender', () => this.onPreRender());
        this.app.on('postrender', () => this.onPostRender());

        // force render on device restored
        this.app.graphicsDevice.on('devicerestored', () => {
            this.forceRender = true;
        });

        // fire pre and post render events on the camera
        this.app.scene.on(EVENT_PRERENDER_LAYER, (camera: CameraComponent, layer: Layer, transparent: boolean) => {
            camera.fire('preRenderLayer', layer, transparent);
        });

        this.app.scene.on(EVENT_POSTRENDER_LAYER, (camera: CameraComponent, layer: Layer, transparent: boolean) => {
            camera.fire('postRenderLayer', layer, transparent);
        });

        // get the world layer
        this.worldLayer = this.app.scene.layers.getLayerByName('World');

        // splat layer - dedicated layer for splat rendering with MRT
        this.splatLayer = new Layer({
            name: 'Splat',
            opaqueSortMode: SORTMODE_CUSTOM,
            transparentSortMode: SORTMODE_CUSTOM
        });
        this.splatLayer.customCalculateSortValues = specialSort;

        // tool overlay layer - drawn after the splats (e.g. ghost passes of the
        // measure/orient tool overlays, which show through occluding gaussians)
        this.overlayLayer = new Layer({ name: 'ToolOverlay' });

        // gizmo layer - clear scene depth before drawing gizmos so they remain visible
        this.gizmoLayer = new Layer({
            name: 'Gizmo',
            clearDepthBuffer: true,
            clearStencilBuffer: true
        });

        const layers = this.app.scene.layers;
        layers.push(this.splatLayer);
        layers.push(this.overlayLayer);
        layers.push(this.gizmoLayer);

        this.dataProcessor = new DataProcessor(this.app.graphicsDevice);
        this.assetLoader = new AssetLoader(this.app, events);

        // create root entities
        this.contentRoot = new Entity('contentRoot');
        this.app.root.addChild(this.contentRoot);

        this.cameraRoot = new Entity('cameraRoot');
        this.app.root.addChild(this.cameraRoot);

        // create elements
        this.camera = new Camera();
        this.add(this.camera);

        this.cameraPoseGizmos = new CameraPoseGizmos();
        this.add(this.cameraPoseGizmos);

        this.splatOverlay = new SplatOverlay();
        this.add(this.splatOverlay);

        this.grid = new Grid();
        this.add(this.grid);

        this.outline = new Outline();
        this.add(this.outline);
        this.underlay = new Underlay();
        this.add(this.underlay);
    }

    start() {
        // autoRender is disabled, so explicitly request the initial frame.
        // Without this an empty editor never creates the camera targets and the
        // grid remains black until some later interaction happens to dirty state.
        this.forceRender = true;
        // start the app
        this.app.start();
    }

    clear() {
        const splats = this.getElementsByType(ElementType.splat);
        splats.forEach((splat) => {
            this.remove(splat);
            (splat as Splat).destroy();
        });
    }

    // add a scene element
    async add(element: Element) {
        if (!element.scene) {
            // add the new element
            element.scene = this;
            await element.add();
            this.elements.push(element);

            // Recompute the aggregate bound before elementAdded listeners run.
            // The editor auto-focus handler relies on camera.sceneRadius; if the
            // new splat bound is still treated as the empty scene (radius .001),
            // focus clamps the camera inside the model and near/far clipping
            // removes the otherwise correctly projected GPU splats.
            const elementBound = element.worldBound;
            if (elementBound) {
                // Camera, grid and overlays are registered before the first
                // splat, so `elements.length === 1` does not identify the first
                // renderable bound. Rebuild synchronously before elementAdded;
                // its auto-focus listener needs the new scene radius immediately.
                let valid = false;
                this.forEachElement((entry) => {
                    const bound = entry.worldBound;
                    if (!bound) return;
                    if (valid) {
                        this.boundStorage.add(bound);
                    } else {
                        this.boundStorage.copy(bound);
                        valid = true;
                    }
                });
                this.boundDirty = false;
                if (valid) {
                    this.events.fire('scene.boundChanged', this.boundStorage);
                }
            }

            // notify all elements of scene addition
            this.forEachElement(e => e !== element && e.onAdded(element));

            // notify listeners
            this.events.fire('scene.elementAdded', element);
        }
    }

    // remove an element from the scene
    remove(element: Element) {
        if (element.scene === this) {
            // remove from list. guard the index: if add() hasn't completed its
            // await yet the element isn't registered, and splice(-1) would
            // evict an unrelated element
            const index = this.elements.indexOf(element);
            if (index !== -1) {
                this.elements.splice(index, 1);
            }

            // notify listeners
            this.events.fire('scene.elementRemoved', element);

            // notify all elements of scene removal
            this.forEachElement(e => e.onRemoved(element));

            element.remove();
            element.scene = null;
        }
    }

    // get the scene bound
    get bound() {
        if (this.boundDirty) {
            let valid = false;
            this.forEachElement((e) => {
                const bound = e.worldBound;
                if (bound) {
                    if (!valid) {
                        valid = true;
                        this.boundStorage.copy(bound);
                    } else {
                        this.boundStorage.add(bound);
                    }
                }
            });

            this.boundDirty = false;
            this.events.fire('scene.boundChanged', this.boundStorage);
        }

        return this.boundStorage;
    }

    getElementsByType(elementType: ElementType) {
        return this.elements.filter(e => e.type === elementType);
    }

    get graphicsDevice() {
        return this.app.graphicsDevice;
    }

    get rendererInfo() {
        const device = this.graphicsDevice as GraphicsDevice & {
            isWebGPU?: boolean,
            unmaskedRenderer?: string,
            gpuAdapter?: { info?: { vendor?: string, architecture?: string, device?: string, description?: string } }
        };
        const adapter = device.gpuAdapter?.info;
        const gpu = adapter ?
            [adapter.description, adapter.vendor, adapter.architecture, adapter.device].find(value => value && value !== 'unknown') :
            device.unmaskedRenderer;
        return {
            backend: device.isWebGPU && this.app.scene.gsplat.currentRenderer === GSPLAT_RENDERER_RASTER_GPU_SORT ?
                'WebGPU | GPU sort' : 'INVALID RENDER PATH',
            gpu: gpu || 'WebGPU adapter'
        };
    }

    private forEachElement(action: (e: Element) => void) {
        this.elements.forEach(action);
    }

    private onUpdate(deltaTime: number) {
        // Apply the pending DOM canvas size before AppBase.render() enters
        // graphicsDevice.frameStart(). Resizing during prerender invalidates the
        // WebGPU swap-chain texture already acquired for the current frame and
        // discards the Gaussian compute/draw command buffer.
        if (this.canvasResize) {
            const { width, height } = this.canvasResize;
            // Do not assign canvas.width/height directly. WebGPU keeps swap-chain
            // state behind GraphicsDevice and only setResolution emits the resize
            // event used to refresh that state and dependent viewport caches.
            if (this.graphicsDevice.width !== width || this.graphicsDevice.height !== height) {
                this.graphicsDevice.setResolution(width, height);
            }
            this.canvasResize = null;
        }

        // allow elements to update
        this.forEachElement(e => e.onUpdate(deltaTime));

        // fire global update
        this.events.fire('update', deltaTime);

        // fire a 'serialize' event which listers will use to store their state. we'll use
        // this to decide if the view has changed and so requires rendering.
        const i = this.app.frame % 2;
        const state = this.sceneState[i];
        state.reset();
        this.forEachElement(e => state.pack(e));

        // diff with previous state
        const result = state.compare(this.sceneState[1 - i]);

        // generate the set of all element types that changed
        const all = new Set([...result.added, ...result.removed, ...result.moved, ...result.changed]);

        // compare with previously serialized
        if (this.lockedRenderMode) {
            this.app.renderNextFrame = this.lockedRender;
            this.lockedRender = false;
        } else if (!this.app.renderNextFrame) {
            this.app.renderNextFrame = this.forceRender || all.size > 0;
        }
        this.forceRender = false;

        // raise per-type update events
        ElementTypeList.forEach((type) => {
            if (all.has(type)) {
                this.events.fire(`updated:${type}`);
            }
        });

        // allow elements to postupdate
        this.forEachElement(e => e.onPostUpdate());
    }

    private onPreRender() {
        // The offscreen camera targets must exactly match the drawing buffer.
        // Scaling only these targets leaves the composite in the top-left
        // quarter and rebuilding them during camera motion causes visible
        // stalls. Keep preview rendering at a stable full-canvas size.
        this.targetSize.width = this.app.graphicsDevice.width;
        this.targetSize.height = this.app.graphicsDevice.height;

        this.forEachElement(e => e.onPreRender());

        this.events.fire('prerender', this.camera.displayTransform);

        // debug - display scene bound
        if (this.config.debug.showBound) {
            // draw element bounds
            this.forEachElement((e: Element) => {
                if (e.type === ElementType.splat) {
                    const splat = e as Splat;

                    const local = splat.localBound;
                    this.app.drawWireAlignedBox(
                        local.getMin(),
                        local.getMax(),
                        Color.RED,
                        true,
                        undefined,
                        splat.entity.getWorldTransform());

                    const world = splat.worldBound;
                    this.app.drawWireAlignedBox(
                        world.getMin(),
                        world.getMax(),
                        Color.GREEN);
                }
            });

            // draw scene bound
            this.app.drawWireAlignedBox(this.bound.getMin(), this.bound.getMax(), Color.BLUE);
        }
    }

    private onPostRender() {
        this.forEachElement(e => e.onPostRender());

        const gaussians = (this.getElementsByType(ElementType.splat) as Splat[])
        .reduce((sum, splat) => sum + (splat.visible ? splat.numSplats : 0), 0);
        this.visibleGaussianCount = gaussians;

        const now = performance.now();
        if (this.lastRenderTime > 0) {
            const instantFps = 1000 / Math.max(now - this.lastRenderTime, 0.1);
            this.renderedFps = this.renderedFps === 0 ? instantFps : this.renderedFps * 0.8 + instantFps * 0.2;
        }
        this.lastRenderTime = now;

        this.events.fire('renderer.metrics', {
            fps: this.renderedFps,
            sortMs: this.app.stats.frame.gsplatSort,
            gaussians,
            interactive: false
        });
        this.events.fire('postrender');
    }
}

export { SceneConfig, Scene };
