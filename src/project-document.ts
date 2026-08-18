type ProjectDocument = {
    splats: Record<string, any>[],
    timeline?: Record<string, any>,
    poseSets?: Record<string, any>[],
    view: Record<string, any>,
    camera: Record<string, any>
};

const isRecord = (value: unknown): value is Record<string, any> => (
    typeof value === 'object' && value !== null && !Array.isArray(value)
);

const isFiniteArray = (value: unknown, length: number) => (
    Array.isArray(value) && value.length >= length &&
    value.slice(0, length).every(entry => typeof entry === 'number' && Number.isFinite(entry))
);

const validateProjectDocument = (value: unknown): ProjectDocument => {
    if (!isRecord(value) || !Array.isArray(value.splats)) {
        throw new Error('Invalid SuperSplat project: missing splat list');
    }
    if (value.splats.length > 10000) {
        throw new Error('Invalid SuperSplat project: too many splats');
    }
    value.splats.forEach((splat, index) => {
        if (!isRecord(splat) || !isFiniteArray(splat.position, 3) ||
            !isFiniteArray(splat.rotation, 4) || !isFiniteArray(splat.scale, 3) ||
            !isFiniteArray(splat.tintClr, 3)) {
            throw new Error(`Invalid SuperSplat project: malformed splat ${index + 1}`);
        }
        const scalarKeys = [
            'temperature', 'saturation', 'brightness', 'blackPoint', 'whitePoint', 'transparency'
        ];
        if (scalarKeys.some(key => splat[key] !== undefined && !Number.isFinite(splat[key])) ||
            (splat.visible !== undefined && typeof splat.visible !== 'boolean') ||
            (splat.localFrameOrigin !== undefined && !isFiniteArray(splat.localFrameOrigin, 3)) ||
            (splat.localFrame !== undefined && !isFiniteArray(splat.localFrame, 4))) {
            throw new Error(`Invalid SuperSplat project: malformed splat settings ${index + 1}`);
        }
    });

    if (!isRecord(value.camera) || !isFiniteArray(value.camera.focalPoint, 3) ||
        !['azim', 'elev', 'distance', 'fov'].every(key => Number.isFinite(value.camera[key])) ||
        value.camera.distance <= 0 || value.camera.fov <= 0 || value.camera.fov >= 180) {
        throw new Error('Invalid SuperSplat project: malformed camera');
    }
    if (!isRecord(value.view) ||
        !['bgColor', 'selectedColor', 'unselectedColor', 'lockedColor']
        .every(key => isFiniteArray(value.view[key], 3))) {
        throw new Error('Invalid SuperSplat project: malformed view settings');
    }
    if (value.timeline !== undefined && !isRecord(value.timeline)) {
        throw new Error('Invalid SuperSplat project: malformed timeline');
    }
    if (value.timeline && (
        (value.timeline.frames !== undefined && (!Number.isSafeInteger(value.timeline.frames) || value.timeline.frames < 1)) ||
        (value.timeline.frameRate !== undefined && (!Number.isFinite(value.timeline.frameRate) || value.timeline.frameRate <= 0)) ||
        (value.timeline.frame !== undefined && !Number.isFinite(value.timeline.frame)) ||
        (value.timeline.smoothness !== undefined && !Number.isFinite(value.timeline.smoothness)) ||
        (value.timeline.loop !== undefined && typeof value.timeline.loop !== 'boolean')
    )) {
        throw new Error('Invalid SuperSplat project: malformed timeline settings');
    }
    if (value.poseSets !== undefined) {
        if (!Array.isArray(value.poseSets) || value.poseSets.length > 10000) {
            throw new Error('Invalid SuperSplat project: malformed camera pose sets');
        }
        value.poseSets.forEach((set, setIndex) => {
            if (!isRecord(set) || !Array.isArray(set.poses) || set.poses.length > 100000 ||
                (set.targetCount !== undefined && (
                    !Number.isSafeInteger(set.targetCount) || set.targetCount < 2 || set.targetCount > 100000
                ))) {
                throw new Error(`Invalid SuperSplat project: malformed camera pose set ${setIndex + 1}`);
            }
            set.poses.forEach((pose: unknown, poseIndex: number) => {
                if (!isRecord(pose) || !isFiniteArray(pose.position, 3) ||
                    !isFiniteArray(pose.target, 3) ||
                    (pose.frame !== undefined && !Number.isFinite(pose.frame)) ||
                    (pose.fov !== undefined && (
                        !Number.isFinite(pose.fov) || pose.fov <= 0 || pose.fov >= 180
                    ))) {
                    throw new Error(
                        `Invalid SuperSplat project: malformed camera pose ${setIndex + 1}.${poseIndex + 1}`
                    );
                }
            });
        });
    }

    return value as ProjectDocument;
};

export { validateProjectDocument };
export type { ProjectDocument };
