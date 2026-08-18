import { WebPCodec } from '@playcanvas/splat-transform';
import { BufferTarget, EncodedPacket, EncodedVideoPacketSource, MkvOutputFormat, MovOutputFormat, Mp4OutputFormat, Output, StreamTarget, WebMOutputFormat } from 'mediabunny';
import { Color, path, Quat, Vec3 } from 'playcanvas';

import { cameraPoseTextChunk, CameraPoseImageMetadata } from './camera-pose-image-metadata';
import { ElementType } from './element';
import { EquirectRenderer } from './equirect-renderer';
import { Events } from './events';
import { encodePng } from './png-writer';
import { Scene } from './scene';
import { injectSphericalMetadata } from './spherical-metadata';
import { Splat } from './splat';
import { i18n } from './ui/localization';
import { buildVideoEncoderConfig, getVideoCodecType, VideoSettings } from './video-config';

const nullClr = new Color(0, 0, 0, 0);

// Lookup maps for video output format and codec configuration
const FORMAT_CONFIG: Record<string, { create: (streaming: boolean) => Mp4OutputFormat | MovOutputFormat | MkvOutputFormat | WebMOutputFormat; extension: string }> = {
    mp4: { create: streaming => new Mp4OutputFormat({ fastStart: streaming ? false : 'in-memory' }), extension: 'mp4' },
    webm: { create: () => new WebMOutputFormat(), extension: 'webm' },
    mov: { create: streaming => new MovOutputFormat({ fastStart: streaming ? false : 'in-memory' }), extension: 'mov' },
    mkv: { create: () => new MkvOutputFormat(), extension: 'mkv' }
};

// backpressure high-water mark for the encoder queue and pending muxer writes
const MAX_QUEUE_SIZE = 5;

type ImageSettings = {
    width: number;
    height: number;
    transparentBg: boolean;
    showDebug: boolean;
    format: 'png' | 'jpeg' | 'webp';
    quality?: number;           // 0..1, jpeg only
    projection?: 'standard' | 'equirect';
    levelHorizon?: boolean;
    silent?: boolean;
};

type PoseThumbnail = {
    position: Vec3 | [number, number, number],
    target: Vec3 | [number, number, number],
    fov?: number
};

type TrajectoryImageSettings = {
    width: number;
    height: number;
    trajectoryLabel: string;
    poses: PoseThumbnail[];
};

type TrajectoryImageResult = {
    directoryName: string;
    frameCount: number;
    requestedFrameCount: number;
    width: number;
    height: number;
    cancelled: boolean;
};

const removeExtension = (filename: string) => {
    return filename.substring(0, filename.length - path.getExtension(filename).length);
};

const isInvalidFilenameChar = (char: string) => {
    return /[<>:"/\\|?*]/.test(char) || char.charCodeAt(0) < 32;
};

const sanitizeFilename = (filename: string) => {
    const sanitized = Array.from(filename, char => (isInvalidFilenameChar(char) ? '_' : char)).join('').trim();
    return sanitized.length > 0 ? sanitized : 'supersplat';
};

// extract a plain filename from url-style names (e.g. splats imported via ?load=)
const getImportedFilename = (filename: string) => {
    const trimmed = filename.split(/[?#]/)[0];

    if (trimmed.includes('://') || trimmed.startsWith('blob:')) {
        try {
            return path.getBasename(new URL(trimmed).pathname);
        } catch {
            // fall through to the raw filename below
        }
    }

    return path.getBasename(trimmed);
};

// sort splats and wait for the sort to complete (or a 1s timeout)
const sortSplatsAndWait = (scene: Scene, splats: Splat[]) => {
    if (scene.graphicsDevice.isWebGPU) {
        // GPU sort is encoded in the render frame; there is no worker callback
        // to await. Dirty placements before the caller requests that frame.
        splats.forEach(splat => splat.markRenderDataDirty());
        return Promise.resolve([]);
    }
    return Promise.all(splats.map((splat) => {
        return new Promise<void>((resolve) => {
            const { instance } = splat.entity.gsplat;
            instance.sorter.once('updated', resolve);
            instance.sort(scene.camera.mainCamera);
            setTimeout(resolve, 1000);
        });
    }));
};

const downloadFile = (data: ArrayBuffer | Uint8Array<ArrayBuffer>, filename: string, type = 'application/octet-stream') => {
    const blob = new Blob([data], { type });
    const url = window.URL.createObjectURL(blob);
    const el = document.createElement('a');
    el.download = filename;
    el.href = url;
    el.click();
    window.URL.revokeObjectURL(url);
};

const registerRenderEvents = (scene: Scene, events: Events) => {
    let webpCodec: WebPCodec;

    // default base filename for rendered output: the project document name if
    // set, otherwise the first visible splat's name
    const baseFilename = () => {
        const docName = events.invoke('doc.name');
        const splats = (scene.getElementsByType(ElementType.splat) as Splat[]).filter(splat => splat.visible);
        const source = docName || (splats[0]?.name ?? 'supersplat');
        return sanitizeFilename(removeExtension(getImportedFilename(source)));
    };

    events.function('render.baseFilename', baseFilename);

    // largest render target dimension the device supports; used by the render
    // dialogs to disable resolutions the gpu cannot produce
    events.function('render.maxTextureSize', () => scene.graphicsDevice.maxTextureSize);

    // wait for postrender to fire
    const postRender = (timeoutMs = 0) => {
        return new Promise<boolean>((resolve, reject) => {
            let timeout: number | undefined;
            const handle = scene.events.on('postrender', () => {
                handle.off();
                if (timeout !== undefined) window.clearTimeout(timeout);
                try {
                    resolve(true);
                } catch (error) {
                    reject(error);
                }
            });
            if (timeoutMs > 0) {
                timeout = window.setTimeout(() => {
                    handle.off();
                    reject(new Error(`Camera thumbnail render timed out after ${timeoutMs}ms`));
                }, timeoutMs);
            }
        });
    };

    events.function('render.offscreen', async (width: number, height: number): Promise<Uint8Array> => {
        try {
            // start rendering to offscreen buffer only
            scene.camera.startOffscreenMode(width, height);
            scene.camera.renderOverlays = false;
            scene.gizmoLayer.enabled = false;

            // render the next frame
            scene.forceRender = true;

            // for render to finish
            await postRender();

            // cpu-side buffer to read pixels into
            const data = new Uint8Array(width * height * 4);

            const { mainTarget, workTarget } = scene.camera;

            scene.dataProcessor.copyRt(mainTarget, workTarget);

            // read the rendered frame
            await workTarget.colorBuffer.read(0, 0, width, height, { renderTarget: workTarget, data });

            // flip y positions to have 0,0 at the top
            let line = new Uint8Array(width * 4);
            for (let y = 0; y < height / 2; y++) {
                line = data.slice(y * width * 4, (y + 1) * width * 4);
                data.copyWithin(y * width * 4, (height - y - 1) * width * 4, (height - y) * width * 4);
                data.set(line, (height - y - 1) * width * 4);
            }

            return data;
        } finally {
            scene.camera.endOffscreenMode();
            scene.camera.renderOverlays = true;
            scene.gizmoLayer.enabled = true;
            scene.camera.camera.clearColor.set(0, 0, 0, 0);
        }
    });

    // Render candidate poses through the normal WebGPU presentation path and
    // downsample the canvas. The generic offscreen readback is not reliable for
    // unified GPU splats on every adapter (some return a transparent texture),
    // while the presented canvas is the exact image the user is matching.
    events.function('render.poseThumbnails', async (
        poses: PoseThumbnail[],
        width = 96,
        height = 96,
        progress?: (completed: number, total: number) => void
    ): Promise<Uint8Array[]> => {
        if (poses.length === 0) return [];
        const saved = events.invoke('camera.getPose') as {
            position: { x: number, y: number, z: number },
            target: { x: number, y: number, z: number },
            fov?: number
        };
        const splats = (scene.getElementsByType(ElementType.splat) as Splat[])
        .filter(splat => splat.visible);
        const result: Uint8Array[] = [];
        const savedOverlays = scene.camera.renderOverlays;
        const savedGizmos = scene.gizmoLayer.enabled;
        const captureCanvas = document.createElement('canvas');
        captureCanvas.width = width;
        captureCanvas.height = height;
        const captureContext = captureCanvas.getContext('2d', { willReadFrequently: true });
        if (!captureContext) throw new Error('Unable to create virtual camera capture canvas');
        let presentationCover: HTMLCanvasElement | null = null;
        try {
            const parent = scene.canvas.parentElement;
            if (parent) {
                presentationCover = document.createElement('canvas');
                presentationCover.width = scene.canvas.width;
                presentationCover.height = scene.canvas.height;
                presentationCover.setAttribute('aria-hidden', 'true');
                presentationCover.style.position = 'absolute';
                presentationCover.style.inset = '0';
                presentationCover.style.zIndex = '1';
                presentationCover.style.width = '100%';
                presentationCover.style.height = '100%';
                presentationCover.style.pointerEvents = 'none';
                presentationCover.getContext('2d')?.drawImage(scene.canvas, 0, 0);
                parent.insertBefore(presentationCover, scene.canvas.nextSibling);
            }
        } catch {
            presentationCover?.remove();
            presentationCover = null;
        }
        const toVec3 = (value: Vec3 | [number, number, number]) => (
            Array.isArray(value) ? new Vec3(value) : value.clone()
        );

        try {
            scene.camera.renderOverlays = false;
            scene.gizmoLayer.enabled = false;

            for (let index = 0; index < poses.length; index++) {
                const pose = poses[index];
                events.fire('camera.setPose', {
                    position: toVec3(pose.position),
                    target: toVec3(pose.target),
                    fov: pose.fov ?? saved.fov ?? scene.camera.fov
                }, 0);
                await sortSplatsAndWait(scene, splats);
                // Subscribe before requesting the frame so a fast presentation
                // cannot occur between forceRender and listener registration.
                const rendered = postRender(5000);
                scene.forceRender = true;
                await rendered;
                const sourceAspect = scene.canvas.width / scene.canvas.height;
                const targetAspect = width / height;
                let sourceX = 0;
                let sourceY = 0;
                let sourceWidth = scene.canvas.width;
                let sourceHeight = scene.canvas.height;
                if (sourceAspect > targetAspect) {
                    sourceWidth = scene.canvas.height * targetAspect;
                    sourceX = (scene.canvas.width - sourceWidth) * 0.5;
                } else {
                    sourceHeight = scene.canvas.width / targetAspect;
                    sourceY = (scene.canvas.height - sourceHeight) * 0.5;
                }
                captureContext.drawImage(
                    scene.canvas,
                    sourceX, sourceY, sourceWidth, sourceHeight,
                    0, 0, width, height
                );
                result.push(new Uint8Array(
                    captureContext.getImageData(0, 0, width, height).data
                ));
                progress?.(index + 1, poses.length);
            }
            return result;
        } finally {
            if (saved) {
                events.fire('camera.setPose', {
                    position: new Vec3(saved.position.x, saved.position.y, saved.position.z),
                    target: new Vec3(saved.target.x, saved.target.y, saved.target.z),
                    fov: saved.fov
                }, 0);
            }
            scene.camera.renderOverlays = savedOverlays;
            scene.gizmoLayer.enabled = savedGizmos;
            const restored = presentationCover ? postRender(1000).catch(() => false) : null;
            scene.forceRender = true;
            if (restored) await restored;
            presentationCover?.remove();
        }
    });

    events.function('render.image', async (imageSettings: ImageSettings, fileStream?: FileSystemWritableFileStream) => {
        if (!imageSettings.silent) events.fire('startSpinner');

        let equirect: EquirectRenderer | null = null;
        let savedFov = 0;
        let savedOrtho = false;

        try {
            const { width, height, transparentBg, showDebug, format, quality, projection, levelHorizon } = imageSettings;
            const is360 = projection === 'equirect';
            const currentPose = events.invoke('camera.getPose') as {
                position: { x: number, y: number, z: number },
                target: { x: number, y: number, z: number },
                fov?: number
            };
            const cameraMetadata: CameraPoseImageMetadata = {
                schema: 'supersplat.camera-pose-image.v1',
                position: [currentPose.position.x, currentPose.position.y, currentPose.position.z],
                target: [currentPose.target.x, currentPose.target.y, currentPose.target.z],
                fov: currentPose.fov ?? scene.camera.fov
            };

            // in 360 mode the offscreen target is a square cube face; the
            // equirect target holds the output-sized frame
            const faceSize = Math.min(height, scene.graphicsDevice.maxTextureSize);

            // start rendering to offscreen buffer only
            scene.camera.startOffscreenMode(is360 ? faceSize : width, is360 ? faceSize : height);
            scene.camera.renderOverlays = is360 ? false : showDebug;
            scene.gizmoLayer.enabled = false;
            if (!transparentBg) {
                scene.camera.clearPass.setClearColor(events.invoke('bgClr'));
            }

            // cpu-side buffer to read pixels into
            const data = new Uint8Array(width * height * 4);

            if (is360) {
                savedFov = scene.camera.fov;
                savedOrtho = scene.camera.ortho;
                equirect = new EquirectRenderer(scene.graphicsDevice, faceSize, width, height);
                scene.camera.ortho = false;

                // snapshot the current camera pose. supersplat cameras never
                // roll, so with level horizon the capture frame is the
                // camera yaw, otherwise yaw and pitch
                const camPos = new Vec3().copy(scene.camera.position);
                const qCapture = new Quat();
                if (levelHorizon ?? true) {
                    qCapture.setFromEulerAngles(0, scene.camera.azim, 0);
                } else {
                    qCapture.copy(scene.camera.mainCamera.getRotation());
                }

                // all faces share direction-independent clipping planes so
                // near-plane culling cannot differ across a face boundary
                const boundRadius = scene.bound.halfExtents.length();
                const dist = new Vec3().sub2(scene.bound.center, camPos).length();
                const far = dist + boundRadius;
                const near = Math.max(1e-6, dist < boundRadius ? far / (1024 * 16) : dist - boundRadius);

                const splats = (scene.getElementsByType(ElementType.splat) as Splat[]).filter(splat => splat.visible);
                const qWorld = new Quat();

                for (let face = 0; face < 6; face++) {
                    qWorld.mul2(qCapture, EquirectRenderer.faceRotations[face]);
                    scene.camera.setPoseOverride({ position: camPos, rotation: qWorld, fov: EquirectRenderer.faceFov, near, far });

                    // faces view different directions, so each render must
                    // wait for its own sort
                    await sortSplatsAndWait(scene, splats);

                    // render a frame and wait for it to finish
                    scene.forceRender = true;
                    await postRender();

                    scene.dataProcessor.copyRt(scene.camera.mainTarget, equirect.faceTargets[face]);
                }

                // project the faces to the equirect target and read back
                equirect.project();
                await equirect.read(data);
            } else {
                // render the next frame
                scene.forceRender = true;

                // for render to finish
                await postRender();

                const { mainTarget, workTarget } = scene.camera;

                scene.dataProcessor.copyRt(mainTarget, workTarget);

                // read the rendered frame
                await workTarget.colorBuffer.read(0, 0, width, height, { renderTarget: workTarget, data });
            }

            // flip the buffer vertically: the framebuffer read is bottom-up
            // but webp (and image files generally) expect top-down rows
            const line = new Uint8Array(width * 4);
            for (let y = 0; y < height / 2; y++) {
                const top = y * width * 4;
                const bottom = (height - y - 1) * width * 4;
                line.set(data.subarray(top, top + width * 4));
                data.copyWithin(top, bottom, bottom + width * 4);
                data.set(line, bottom);
            }

            let bytes: Uint8Array<ArrayBuffer>;
            let extension: string;
            let mimeType: string;

            if (format === 'png') {
                bytes = await encodePng(data, width, height, [cameraPoseTextChunk(cameraMetadata)]);
                extension = 'png';
                mimeType = 'image/png';
            } else if (format === 'jpeg') {
                // jpeg has no alpha channel and canvas encoding flattens
                // transparent pixels toward black, so force full opacity
                for (let i = 3; i < data.length; i += 4) {
                    data[i] = 255;
                }

                const imageData = new ImageData(new Uint8ClampedArray(data.buffer, data.byteOffset, data.length), width, height);
                let blob: Blob;
                if (typeof OffscreenCanvas !== 'undefined') {
                    const canvas = new OffscreenCanvas(width, height);
                    const context = canvas.getContext('2d');
                    if (!context) {
                        throw new Error('failed to create 2d context');
                    }
                    context.putImageData(imageData, 0, 0);
                    blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: quality ?? 0.9 });
                } else {
                    // fallback for browsers without OffscreenCanvas
                    const canvas = document.createElement('canvas');
                    canvas.width = width;
                    canvas.height = height;
                    const context = canvas.getContext('2d');
                    if (!context) {
                        throw new Error('failed to create 2d context');
                    }
                    context.putImageData(imageData, 0, 0);
                    blob = await new Promise<Blob>((resolve, reject) => {
                        canvas.toBlob(b => (b ? resolve(b) : reject(new Error('failed to encode jpeg'))), 'image/jpeg', quality ?? 0.9);
                    });
                }
                bytes = new Uint8Array(await blob.arrayBuffer());
                extension = 'jpg';
                mimeType = 'image/jpeg';
            } else {
                // construct the webp codec
                if (!webpCodec) {
                    webpCodec = await WebPCodec.create();
                }

                bytes = webpCodec.encodeLosslessRGBA(data, width, height);
                extension = 'webp';
                mimeType = 'image/webp';
            }

            if (fileStream) {
                await fileStream.write(bytes);
                await fileStream.close();
            } else {
                downloadFile(bytes, `${baseFilename()}.${extension}`, mimeType);
            }

            return true;
        } catch (error) {
            // close the stream even on failure so the caller can remove the
            // empty file
            if (fileStream) {
                try {
                    await fileStream.close();
                } catch {
                    // stream already closed or errored
                }
            }

            if (imageSettings.silent) throw error;

            await events.invoke('showPopup', {
                type: 'error',
                header: i18n.t('panel.render.failed'),
                message: `'${error.message ?? error}'`
            });

            return false;
        } finally {
            if (equirect) {
                scene.camera.setPoseOverride(null);
                scene.camera.fov = savedFov;
                scene.camera.ortho = savedOrtho;
                equirect.destroy();
                equirect = null;
            }

            scene.camera.endOffscreenMode();
            scene.camera.renderOverlays = true;
            scene.gizmoLayer.enabled = true;
            scene.camera.clearPass.setClearColor(nullClr);

            if (!imageSettings.silent) events.fire('stopSpinner');
        }
    });

    events.function('render.trajectoryImages', async (
        settings: TrajectoryImageSettings,
        parentDirectory: FileSystemDirectoryHandle
    ): Promise<TrajectoryImageResult> => {
        const width = Math.trunc(settings.width);
        const height = Math.trunc(settings.height);
        const poses = settings.poses ?? [];
        const maxTextureSize = scene.graphicsDevice.maxTextureSize;
        if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1) {
            throw new Error('轨迹图片宽度和高度必须是正整数');
        }
        if (width > maxTextureSize || height > maxTextureSize) {
            throw new Error(`当前 GPU 最大支持 ${maxTextureSize} x ${maxTextureSize}`);
        }
        if (poses.length === 0) throw new Error('当前轨迹没有可渲染的相机位姿');

        const label = sanitizeFilename(settings.trajectoryLabel || 'A');
        const timestamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
        const directoryName = sanitizeFilename(
            `${baseFilename()}-trajectory-${label}-${poses.length}-${width}x${height}-${timestamp}`
        );
        const outputDirectory = await parentDirectory.getDirectoryHandle(directoryName, { create: true });
        const savedPose = events.invoke('camera.getPose') as {
            position: { x: number, y: number, z: number },
            target: { x: number, y: number, z: number },
            fov?: number
        };
        const wasPlaying = !!events.invoke('timeline.playing');
        const savedCanvasWidth = scene.graphicsDevice.width;
        const savedCanvasHeight = scene.graphicsDevice.height;
        const savedOverlays = scene.camera.renderOverlays;
        const savedGizmos = scene.gizmoLayer.enabled;
        const imageNames: string[] = [];
        const colmapW2cRows: Array<{
            index: number,
            image_name: string,
            qw_w2c: number,
            qx_w2c: number,
            qy_w2c: number,
            qz_w2c: number,
            tx_w2c: number,
            ty_w2c: number,
            tz_w2c: number
        }> = [];
        let cancelled = false;
        const cancelHandler = events.on('progressCancel', () => {
            cancelled = true;
        });
        const toVec3 = (value: Vec3 | [number, number, number]) => (
            Array.isArray(value) ? new Vec3(value) : value.clone()
        );
        const toArray = (value: Vec3 | [number, number, number]) => (
            Array.isArray(value) ? [...value] : [value.x, value.y, value.z]
        );
        const captureCanvas = document.createElement('canvas');
        captureCanvas.width = width;
        captureCanvas.height = height;
        const captureContext = captureCanvas.getContext('2d', { willReadFrequently: true });
        if (!captureContext) throw new Error('无法创建轨迹图片画布');
        const splats = (scene.getElementsByType(ElementType.splat) as Splat[]).filter(splat => splat.visible);

        events.fire('timeline.setPlaying', false);
        events.fire('progressStart', '保存轨迹图片', true);
        try {
            // Unified WebGPU splats can return an empty texture through generic
            // offscreen readback. Render the presentation canvas at the exact
            // requested size and copy only its pixels, excluding all DOM UI.
            scene.camera.setPoseOverride(null);
            scene.canvasResize = null;
            scene.graphicsDevice.setResolution(width, height);
            scene.targetSize.width = width;
            scene.targetSize.height = height;
            scene.camera.rebuildRenderTargets();
            scene.camera.renderOverlays = false;
            scene.gizmoLayer.enabled = false;
            scene.camera.clearPass.setClearColor(events.invoke('bgClr'));
            scene.camera.onUpdate(0);

            const digits = Math.max(6, String(poses.length).length);
            for (let index = 0; index < poses.length; index++) {
                if (cancelled) break;
                const pose = poses[index];
                const imageName = `Virtual_Cam_${String(index + 1).padStart(digits, '0')}.png`;
                events.fire('camera.setPose', {
                    position: toVec3(pose.position),
                    target: toVec3(pose.target),
                    fov: pose.fov ?? scene.camera.fov
                }, 0);
                scene.camera.onUpdate(0);
                // Capture the same entity C2W matrix used for this render. Pixel
                // row orientation is handled only by the image path below.
                const colmapW2c = events.invoke(
                    'camera.buildCurrentFrameColmapW2c',
                    index + 1,
                    imageName
                ) as typeof colmapW2cRows[number];
                await sortSplatsAndWait(scene, splats);
                const rendered = postRender(5000);
                scene.forceRender = true;
                scene.app.update(0);
                scene.app.render();
                await rendered;
                if (scene.canvas.width !== width || scene.canvas.height !== height) {
                    throw new Error(`渲染画布尺寸为 ${scene.canvas.width} x ${scene.canvas.height}，应为 ${width} x ${height}`);
                }
                captureContext.clearRect(0, 0, width, height);
                captureContext.drawImage(scene.canvas, 0, 0, width, height);
                const rgba = new Uint8Array(captureContext.getImageData(0, 0, width, height).data);
                const cameraMetadata: CameraPoseImageMetadata = {
                    schema: 'supersplat.camera-pose-image.v1',
                    position: toArray(pose.position) as [number, number, number],
                    target: toArray(pose.target) as [number, number, number],
                    fov: pose.fov ?? scene.camera.fov
                };
                const bytes = await encodePng(rgba, width, height, [cameraPoseTextChunk(cameraMetadata)]);

                const fileHandle = await outputDirectory.getFileHandle(imageName, { create: true });
                const writable = await fileHandle.createWritable();
                await writable.write(bytes);
                await writable.close();
                imageNames.push(imageName);
                colmapW2cRows.push(colmapW2c);
                events.fire('progressUpdate', {
                    text: `${index + 1} / ${poses.length} - ${imageName}`,
                    progress: (index + 1) / poses.length * 100
                });
            }

            const poseFilename = 'camera_poses_colmap_w2c.csv';
            const poseHandle = await outputDirectory.getFileHandle(poseFilename, { create: true });
            const poseStream = await poseHandle.createWritable();
            await poseStream.write(events.invoke('camera.colmapW2cRowsToCsv', colmapW2cRows) as string);
            await poseStream.close();

            const manifest = {
                schema: 'supersplat.trajectory-images.v1',
                scene: baseFilename(),
                trajectory: settings.trajectoryLabel,
                width,
                height,
                requested_frame_count: poses.length,
                rendered_frame_count: imageNames.length,
                cancelled,
                images: imageNames,
                colmap_w2c_pose_file: poseFilename,
                colmap_w2c_convention: 'X_camera = R_w2c * X_world + t_w2c; quaternion order w,x,y,z',
                cameras: poses.slice(0, imageNames.length).map((pose, index) => ({
                    index: index + 1,
                    image_name: imageNames[index],
                    position: toArray(pose.position),
                    target: toArray(pose.target),
                    fov: pose.fov ?? scene.camera.fov
                }))
            };
            const manifestHandle = await outputDirectory.getFileHandle('render_manifest.json', { create: true });
            const manifestStream = await manifestHandle.createWritable();
            await manifestStream.write(`${JSON.stringify(manifest, null, 2)}\n`);
            await manifestStream.close();

            return {
                directoryName,
                frameCount: imageNames.length,
                requestedFrameCount: poses.length,
                width,
                height,
                cancelled
            };
        } finally {
            cancelHandler.off();
            events.fire('progressEnd');
            scene.graphicsDevice.setResolution(savedCanvasWidth, savedCanvasHeight);
            scene.targetSize.width = savedCanvasWidth;
            scene.targetSize.height = savedCanvasHeight;
            scene.camera.rebuildRenderTargets();
            scene.camera.renderOverlays = savedOverlays;
            scene.gizmoLayer.enabled = savedGizmos;
            scene.camera.clearPass.setClearColor(nullClr);
            if (savedPose) {
                events.fire('camera.setPose', {
                    position: new Vec3(savedPose.position.x, savedPose.position.y, savedPose.position.z),
                    target: new Vec3(savedPose.target.x, savedPose.target.y, savedPose.target.z),
                    fov: savedPose.fov
                }, 0);
            }
            scene.camera.onUpdate(0);
            scene.forceRender = true;
            if (wasPlaying) events.fire('timeline.setPlaying', true);
        }
    });

    events.function('render.video', (videoSettings: VideoSettings, fileStream: FileSystemWritableFileStream) => {
        const renderImpl = async () => {
            events.fire('progressStart', i18n.t('panel.render.render-video'), true);

            let cancelled = false;
            const cancelHandler = events.on('progressCancel', () => {
                cancelled = true;
            });

            let encoder: VideoEncoder | null = null;
            let equirect: EquirectRenderer | null = null;
            let savedFov = 0;
            let savedOrtho = false;
            let output: Output | null = null;
            let muxerWrites = Promise.resolve();

            try {
                const { startFrame, endFrame, frameRate, width, height, bitrate, transparentBg, showDebug, format, codec: codecChoice, projection, levelHorizon } = videoSettings;

                const is360 = projection === 'equirect';

                // 360 mp4/mov exports have spherical metadata patched into the
                // finished buffer, so they render to memory with moov written
                // last (fastStart false) instead of streaming to disk
                const taggable = is360 && (format === 'mp4' || format === 'mov');

                const target = (fileStream && !taggable) ? new StreamTarget(fileStream) : new BufferTarget();

                // Configure output format and codec from lookup maps (default to mp4/h264)
                const formatConfig = FORMAT_CONFIG[format] ?? FORMAT_CONFIG.mp4;
                const outputFormat = formatConfig.create(taggable || !!fileStream);
                const fileExtension = formatConfig.extension;

                const encoderConfig = buildVideoEncoderConfig(videoSettings);
                const codecType = getVideoCodecType(codecChoice);

                output = new Output({
                    format: outputFormat,
                    target
                });

                const videoSource = new EncodedVideoPacketSource(codecType);
                output.addVideoTrack(videoSource, {
                    rotation: 0,
                    frameRate
                });

                await output.start();

                let encoderError: Error | null = null;
                let muxerError: Error | null = null;
                let muxerQueueSize = 0;

                // helper to create and configure a VideoEncoder instance
                const createEncoder = () => {
                    encoderError = null;
                    const enc = new VideoEncoder({
                        output: (chunk, meta) => {
                            const encodedPacket = EncodedPacket.fromEncodedChunk(chunk);
                            muxerQueueSize++;

                            // WebCodecs ignores a Promise returned by its output
                            // callback: awaiting the muxer here provides no
                            // backpressure, and a rejected write becomes an
                            // unhandled rejection that silently drops packets
                            // from the finished file. Chain the writes instead
                            // so failures surface via muxerError, muxerQueueSize
                            // drives backpressure in the encode loop, and every
                            // write has settled before output.finalize().
                            muxerWrites = muxerWrites
                            .then(async () => {
                                if (!muxerError) {
                                    await videoSource.add(encodedPacket, meta);
                                }
                            })
                            .catch((error) => {
                                muxerError = error instanceof Error ? error : new Error(String(error));
                            })
                            .finally(() => {
                                muxerQueueSize--;
                            });
                        },
                        error: (error) => {
                            encoderError = error;
                        }
                    });
                    enc.configure(encoderConfig);
                    return enc;
                };

                // fail fast on unsupported configurations (e.g. encoder
                // dimension limits) instead of erroring mid-render
                const support = await VideoEncoder.isConfigSupported(encoderConfig);
                if (!support.supported) {
                    throw new Error(`Unsupported video configuration (${codecChoice} @ ${width}x${height})`);
                }

                encoder = createEncoder();

                // in 360 mode the offscreen target is a square cube face; the
                // equirect target holds the output-sized frame
                const faceSize = Math.min(height, scene.graphicsDevice.maxTextureSize);

                // start rendering to offscreen buffer only
                scene.camera.startOffscreenMode(is360 ? faceSize : width, is360 ? faceSize : height);
                scene.camera.renderOverlays = is360 ? false : showDebug;
                scene.gizmoLayer.enabled = false;
                if (!transparentBg) {
                    scene.camera.clearPass.setClearColor(events.invoke('bgClr'));
                }
                scene.lockedRenderMode = true;

                if (is360) {
                    savedFov = scene.camera.fov;
                    savedOrtho = scene.camera.ortho;
                    equirect = new EquirectRenderer(scene.graphicsDevice, faceSize, width, height);
                    scene.camera.ortho = false;
                }

                // cpu-side buffer to read pixels into
                const data = new Uint8Array(width * height * 4);
                const line = new Uint8Array(width * 4);

                // remember last camera position so we can skip sorting if the camera didn't move
                const last_pos = new Vec3(0, 0, 0);
                const last_forward = new Vec3(1, 0, 0);

                // helper to sort splats and wait for completion
                const sortAndWait = (splats: Splat[]) => sortSplatsAndWait(scene, splats);

                // prepare the frame for rendering, returns the newly loaded splat if any
                const prepareFrame = async (frameTime: number, skipSort = false): Promise<Splat | null> => {
                    // Fire timeline.time for camera animation interpolation
                    events.fire('timeline.time', frameTime);

                    // Wait for PLY sequence to load the frame if present
                    const newSplat = await events.invoke('plysequence.setFrameAsync', Math.floor(frameTime)) as Splat | null;

                    // manually update the camera so position and rotation are correct
                    scene.camera.onUpdate(0);

                    // 360 capture re-sorts per cube face, so skip sorting here
                    if (skipSort) {
                        return newSplat;
                    }

                    // If a new PLY was loaded, sort and wait for completion
                    if (newSplat) {
                        await sortAndWait([newSplat]);
                    } else {
                        // No new PLY - sort existing splats if camera moved
                        const pos = scene.camera.position;
                        const forward = scene.camera.forward;
                        if (!last_pos.equals(pos) || !last_forward.equals(forward)) {
                            last_pos.copy(pos);
                            last_forward.copy(forward);

                            const splats = (scene.getElementsByType(ElementType.splat) as Splat[]).filter(splat => splat.visible);
                            await sortAndWait(splats);
                        }
                    }

                    return newSplat;
                };

                // flip, wrap and submit the pixels currently in the data buffer
                const encodeFrame = async (frameTime: number) => {
                    // flip the buffer vertically
                    for (let y = 0; y < height / 2; y++) {
                        const top = y * width * 4;
                        const bottom = (height - y - 1) * width * 4;
                        line.set(data.subarray(top, top + width * 4));
                        data.copyWithin(top, bottom, bottom + width * 4);
                        data.set(line, bottom);
                    }

                    // construct the video frame
                    const videoFrame = new VideoFrame(data, {
                        format: 'RGBA',
                        codedWidth: width,
                        codedHeight: height,
                        timestamp: Math.floor(1e6 * frameTime),
                        duration: Math.floor(1e6 / frameRate)
                    });

                    // wait for encoder queue to drain if necessary (backpressure handling)
                    while (encoder.encodeQueueSize > MAX_QUEUE_SIZE) {
                        await new Promise<void>((resolve) => {
                            setTimeout(resolve, 1);
                        });
                    }
                    // muxerQueueSize is decremented by the write chain settling
                    // during the await
                    // eslint-disable-next-line no-unmodified-loop-condition
                    while (muxerQueueSize > MAX_QUEUE_SIZE) {
                        await muxerWrites;
                    }

                    // if the codec was reclaimed (e.g. browser backgrounded the tab),
                    // recreate the encoder and continue
                    let forceKeyFrame = false;
                    if (encoder.state === 'closed' && encoderError?.message?.includes('reclaimed')) {
                        encoder = createEncoder();
                        forceKeyFrame = true;
                    }

                    // check for non-recoverable encoder errors
                    if (encoderError || muxerError) {
                        videoFrame.close();
                        throw encoderError ?? muxerError;
                    }

                    encoder.encode(videoFrame, { keyFrame: forceKeyFrame });
                    videoFrame.close();
                };

                // capture the current video frame
                const captureFrame = async (frameTime: number) => {
                    const { mainTarget, workTarget } = scene.camera;

                    scene.dataProcessor.copyRt(mainTarget, workTarget);

                    // read the rendered frame
                    await workTarget.colorBuffer.read(0, 0, width, height, { renderTarget: workTarget, data });

                    await encodeFrame(frameTime);
                };

                const animFrameRate = events.invoke('timeline.frameRate');
                const duration = (endFrame - startFrame) / animFrameRate;
                const totalFrames = Math.floor(duration * frameRate) + 1;

                // work objects for 360 capture
                const camPos = new Vec3();
                const vec = new Vec3();
                const qCapture = new Quat();
                const qWorld = new Quat();

                // capture a 360 frame: render the six cube faces from the
                // animated camera position, re-sorting splats per face
                // direction, then project to equirect and encode
                const capture360 = async (frameTime: number) => {
                    // snapshot the animated camera pose. supersplat cameras
                    // never roll, so with level horizon the capture frame is
                    // the camera yaw, otherwise yaw and pitch
                    camPos.copy(scene.camera.position);
                    if (levelHorizon ?? true) {
                        qCapture.setFromEulerAngles(0, scene.camera.azim, 0);
                    } else {
                        qCapture.copy(scene.camera.mainCamera.getRotation());
                    }

                    // all faces share direction-independent clipping planes so
                    // near-plane culling cannot differ across a face boundary
                    const boundRadius = scene.bound.halfExtents.length();
                    const dist = vec.sub2(scene.bound.center, camPos).length();
                    const far = dist + boundRadius;
                    const near = Math.max(1e-6, dist < boundRadius ? far / (1024 * 16) : dist - boundRadius);

                    const splats = (scene.getElementsByType(ElementType.splat) as Splat[]).filter(splat => splat.visible);

                    for (let face = 0; face < 6; face++) {
                        // check for cancellation
                        if (cancelled) return;

                        qWorld.mul2(qCapture, EquirectRenderer.faceRotations[face]);
                        scene.camera.setPoseOverride({ position: camPos, rotation: qWorld, fov: EquirectRenderer.faceFov, near, far });

                        // faces view different directions, so each render must
                        // wait for its own sort
                        await sortAndWait(splats);

                        // render a frame
                        scene.lockedRender = true;

                        // wait for render to finish
                        await postRender();

                        scene.dataProcessor.copyRt(scene.camera.mainTarget, equirect.faceTargets[face]);

                        const frameIndex = Math.round(frameTime * frameRate);
                        events.fire('progressUpdate', {
                            text: i18n.t('panel.render.rendering', { ellipsis: true }),
                            progress: 100 * (frameIndex + (face + 1) / 6) / totalFrames
                        });
                    }

                    // project the faces to the equirect target and encode
                    equirect.project();
                    await equirect.read(data);
                    await encodeFrame(frameTime);
                };

                for (let frameTime = 0; frameTime <= duration; frameTime += 1.0 / frameRate) {
                    // check for cancellation
                    if (cancelled) break;

                    if (is360) {
                        // restore animated-pose evaluation before the timeline
                        // advances (fov feeds the tween-to-position mapping)
                        scene.camera.setPoseOverride(null);
                        scene.camera.fov = savedFov;

                        // prepare the frame (loads PLY if needed, updates camera)
                        await prepareFrame(startFrame + frameTime * animFrameRate, true);

                        await capture360(frameTime);
                    } else {
                        // prepare the frame (loads PLY if needed, updates camera, sorts)
                        await prepareFrame(startFrame + frameTime * animFrameRate);

                        // render a frame
                        scene.lockedRender = true;

                        // wait for render to finish
                        await postRender();

                        // wait for capture
                        await captureFrame(frameTime);

                        events.fire('progressUpdate', {
                            text: i18n.t('panel.render.rendering', { ellipsis: true }),
                            progress: 100 * frameTime / duration
                        });
                    }
                }

                // Flush and finalize output
                await encoder.flush();
                await muxerWrites;
                if (muxerError) {
                    throw muxerError;
                }
                await output.finalize();

                const filename = () => `${baseFilename()}.${fileExtension}`;

                if (taggable) {
                    // patch spherical metadata into the finished buffer so
                    // players auto-detect the equirectangular projection
                    if (!cancelled) {
                        let buffer = (target as BufferTarget).buffer;
                        try {
                            buffer = injectSphericalMetadata(buffer);
                        } catch (error) {
                            console.warn(`failed to inject spherical metadata: ${error.message ?? error}`);
                        }

                        if (fileStream) {
                            await fileStream.write(buffer);
                        } else {
                            downloadFile(buffer, filename());
                        }
                    }

                    // close the stream even when cancelled so the caller can
                    // remove the empty file
                    if (fileStream) {
                        await fileStream.close();
                    }
                } else if (!cancelled && !fileStream) {
                    // Download (skip if cancelled -- the caller will delete the file)
                    downloadFile((target as BufferTarget).buffer, filename());
                }

                return !cancelled;
            } catch (error) {
                // stop the encoder so no further packets are queued while
                // cleaning up
                if (encoder && encoder.state !== 'closed') {
                    encoder.close();
                }

                // the output's stream target holds a writer lock on the
                // destination file stream. drain in-flight muxer writes and
                // cancel the output to release it, otherwise the caller
                // cannot remove the partial file
                if (output) {
                    try {
                        await muxerWrites;
                        await output.cancel();
                    } catch {
                        // output already finalized or its target already closed
                    }
                }

                // tagged 360 exports write to the file stream directly, so
                // close it here too (mirrors render.image failure handling)
                if (fileStream) {
                    try {
                        await fileStream.close();
                    } catch {
                        // stream already closed or still locked by the output
                    }
                }

                await events.invoke('showPopup', {
                    type: 'error',
                    header: i18n.t('panel.render.failed'),
                    message: `'${(error as any).message ?? error}'`
                });
                return false;
            } finally {
                if (encoder && encoder.state !== 'closed') {
                    encoder.close();
                }
                cancelHandler.off();

                if (equirect) {
                    scene.camera.setPoseOverride(null);
                    scene.camera.fov = savedFov;
                    scene.camera.ortho = savedOrtho;
                    equirect.destroy();
                    equirect = null;
                }

                scene.camera.endOffscreenMode();
                scene.camera.renderOverlays = true;
                scene.gizmoLayer.enabled = true;
                scene.camera.clearPass.setClearColor(nullClr);
                scene.lockedRenderMode = false;
                scene.forceRender = true;       // camera likely moved, finish with normal render

                events.fire('progressEnd');
            }
        };

        // Acquire a Web Lock during encoding to signal the browser that this tab is
        // actively working, which helps prevent aggressive background throttling and
        // codec reclamation.
        if (navigator.locks) {
            return navigator.locks.request('supersplat-video-render', renderImpl);
        }
        return renderImpl();
    });
};

export { ImageSettings, registerRenderEvents };
export type { VideoSettings } from './video-config';
