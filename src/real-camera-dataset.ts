import { Quat, Vec3 } from 'playcanvas';

import type { Events } from './events';

type RealCameraPose = {
    imageId: number,
    cameraId: number,
    imageName: string,
    position: Vec3,
    target: Vec3,
    fov: number,
    file?: File
};

type RealCameraDatasetState = {
    loaded: boolean,
    poseCount: number,
    matchedImageCount: number,
    sourcePath: string | null,
    selectedImageName: string | null,
    images: { name: string, matched: boolean }[]
};

type ColmapCamera = {
    id: number,
    width: number,
    height: number,
    fx: number,
    fy: number
};

const imageExtensions = new Set(['jpg', 'jpeg', 'png', 'webp']);
const normalizePath = (value: string) => value.replaceAll('\\', '/').replace(/^\.\//, '').toLowerCase();
const filenameOf = (file: File) => normalizePath(file.webkitRelativePath || file.name);
const basename = (value: string) => normalizePath(value).split('/').pop();
const dirname = (value: string) => {
    const parts = normalizePath(value).split('/');
    parts.pop();
    return parts.join('/');
};
const pathDepth = (value: string) => normalizePath(value).split('/').filter(Boolean).length;

const parseColmapCameras = (text: string): Map<number, ColmapCamera> => {
    const result = new Map<number, ColmapCamera>();
    text.split(/\r?\n/).forEach((rawLine) => {
        const line = rawLine.trim();
        if (!line || line.startsWith('#')) return;
        const parts = line.split(/\s+/);
        if (parts.length < 5) return;
        const id = Number(parts[0]);
        const model = parts[1];
        const width = Number(parts[2]);
        const height = Number(parts[3]);
        const parameters = parts.slice(4).map(Number);
        const singleFocalModels = new Set([
            'SIMPLE_PINHOLE', 'SIMPLE_RADIAL', 'RADIAL', 'SIMPLE_RADIAL_FISHEYE', 'RADIAL_FISHEYE'
        ]);
        const fx = parameters[0];
        const fy = singleFocalModels.has(model) ? fx : parameters[1];
        if ([id, width, height, fx, fy].every(Number.isFinite) && width > 0 && height > 0 && fx > 0 && fy > 0) {
            result.set(id, { id, width, height, fx, fy });
        }
    });
    return result;
};

const cameraFov = (camera: ColmapCamera | undefined, fallback: number) => {
    if (!camera) return fallback;
    const fovX = 2 * Math.atan(camera.width / (2 * camera.fx)) * 180 / Math.PI;
    const fovY = 2 * Math.atan(camera.height / (2 * camera.fy)) * 180 / Math.PI;
    return Math.max(fovX, fovY);
};

const parseColmapImages = (
    text: string,
    cameras: Map<number, ColmapCamera>,
    fallbackFov = 60
): RealCameraPose[] => {
    const lines = text.split(/\r?\n/);
    const result: RealCameraPose[] = [];
    for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
        const line = lines[lineIndex].trim();
        if (!line || line.startsWith('#')) continue;
        const parts = line.split(/\s+/);
        if (parts.length < 10) continue;
        const imageId = Number(parts[0]);
        const qw = Number(parts[1]);
        const qx = Number(parts[2]);
        const qy = Number(parts[3]);
        const qz = Number(parts[4]);
        const tx = Number(parts[5]);
        const ty = Number(parts[6]);
        const tz = Number(parts[7]);
        const cameraId = Number(parts[8]);
        const imageName = parts.slice(9).join(' ');
        if (![imageId, qw, qx, qy, qz, tx, ty, tz, cameraId].every(Number.isFinite) || !imageName) continue;

        // COLMAP stores world-to-camera OpenCV rotation and translation. This
        // matches SuperSplat's existing images.txt conversion for a COLMAP PLY:
        // invert to camera-to-world, then flip world X/Y into editor space.
        const rotation = new Quat(qx, qy, qz, qw).normalize().invert();
        const center = rotation.transformVector(new Vec3(-tx, -ty, -tz));
        const forward = rotation.transformVector(Vec3.BACK.clone()).normalize();
        const target = center.clone().addScaled(forward, 10);
        result.push({
            imageId,
            cameraId,
            imageName,
            position: new Vec3(-center.x, -center.y, center.z),
            target: new Vec3(-target.x, -target.y, target.z),
            fov: cameraFov(cameras.get(cameraId), fallbackFov)
        });
        // Every COLMAP image record is followed by one POINTS2D line. It may
        // legitimately be empty, so skip the physical line instead of first
        // filtering blank lines and assuming the remaining lines form pairs.
        lineIndex++;
    }
    return result.sort((a, b) => a.imageId - b.imageId);
};

const matchImageFile = (imageName: string, files: File[]) => {
    const expected = normalizePath(imageName);
    const exact = files.find(file => filenameOf(file).endsWith(`/${expected}`) || filenameOf(file) === expected);
    if (exact) return exact;
    const expectedBase = basename(expected);
    const matches = files.filter(file => basename(filenameOf(file)) === expectedBase);
    return matches.length === 1 ? matches[0] : undefined;
};

const registerRealCameraDatasetEvents = (events: Events) => {
    let poses: RealCameraPose[] = [];
    let sourcePath: string | null = null;
    let selectedImageName: string | null = null;

    const state = (): RealCameraDatasetState => ({
        loaded: poses.length > 0,
        poseCount: poses.length,
        matchedImageCount: poses.filter(pose => !!pose.file).length,
        sourcePath,
        selectedImageName,
        images: poses.map(pose => ({ name: pose.imageName, matched: !!pose.file }))
    });
    const changed = () => events.fire('realCameraDataset.changed', state());
    const serializablePose = (pose: RealCameraPose) => ({
        imageName: pose.imageName,
        position: [pose.position.x, pose.position.y, pose.position.z] as [number, number, number],
        target: [pose.target.x, pose.target.y, pose.target.z] as [number, number, number],
        fov: pose.fov
    });

    events.function('realCameraDataset.state', state);
    events.function('realCameraDataset.renderData', () => poses);
    events.function('realCameraDataset.imageFile', (imageName: string) => (
        poses.find(pose => pose.imageName === imageName)?.file ?? null
    ));
    events.function('realCameraDataset.select', (imageName: string) => {
        const pose = poses.find(entry => entry.imageName === imageName && entry.file);
        if (!pose) return null;
        selectedImageName = pose.imageName;
        changed();
        return serializablePose(pose);
    });
    events.function('realCameraDataset.poseForFile', (file: File) => {
        const filePath = filenameOf(file);
        const fileBase = basename(filePath);
        const matches = poses.filter((pose) => {
            const expected = normalizePath(pose.imageName);
            return filePath.endsWith(`/${expected}`) || filePath === expected || basename(expected) === fileBase;
        });
        const pose = matches.length === 1 ? matches[0] : null;
        if (!pose) return null;
        selectedImageName = pose.imageName;
        changed();
        return serializablePose(pose);
    });
    events.function('realCameraDataset.load', async (files: File[]) => {
        const imagesTxtFiles = files.filter(file => basename(filenameOf(file)) === 'images.txt');
        const camerasTxtFiles = files.filter(file => basename(filenameOf(file)) === 'cameras.txt');
        if (imagesTxtFiles.length === 0) throw new Error('COLMAP input requires an images.txt file');
        const imageFiles = files.filter((file) => {
            const extension = filenameOf(file).split('.').pop();
            return imageExtensions.has(extension);
        });
        const fallbackFov = (events.invoke('camera.fov') as number | undefined) ?? 60;
        const candidates = await Promise.all(imagesTxtFiles.map(async (imagesTxt) => {
            const imagesPath = filenameOf(imagesTxt);
            const directory = dirname(imagesPath);
            const camerasTxt = camerasTxtFiles.find(file => dirname(filenameOf(file)) === directory) ??
                (camerasTxtFiles.length === 1 ? camerasTxtFiles[0] : undefined);
            const cameras = camerasTxt ? parseColmapCameras(await camerasTxt.text()) : new Map<number, ColmapCamera>();
            const parsed = parseColmapImages(await imagesTxt.text(), cameras, fallbackFov);
            parsed.forEach((pose) => {
                pose.file = matchImageFile(pose.imageName, imageFiles);
            });
            return {
                directory,
                parsed,
                matched: parsed.filter(pose => !!pose.file).length,
                depth: pathDepth(directory)
            };
        }));
        const usable = candidates.filter(candidate => candidate.parsed.length > 0).sort((left, right) => (
            right.matched - left.matched ||
            right.parsed.length - left.parsed.length ||
            left.depth - right.depth ||
            left.directory.localeCompare(right.directory)
        ));
        if (usable.length === 0) throw new Error('No valid registered cameras were found in any images.txt');
        const selected = usable[0];
        poses = selected.parsed;
        sourcePath = selected.directory || dirname(filenameOf(imagesTxtFiles[0])) || 'images.txt';
        selectedImageName = poses.find(pose => !!pose.file)?.imageName ?? null;
        changed();
        return state();
    });
    events.function('realCameraDataset.clear', () => {
        poses = [];
        sourcePath = null;
        selectedImageName = null;
        changed();
    });
    events.on('scene.clear', () => {
        poses = [];
        sourcePath = null;
        selectedImageName = null;
        changed();
    });
};

export { parseColmapCameras, parseColmapImages, registerRealCameraDatasetEvents };
export type { RealCameraDatasetState, RealCameraPose };
