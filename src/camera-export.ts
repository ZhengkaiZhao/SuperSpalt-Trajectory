import { ZipFileSystem } from '@playcanvas/splat-transform';
import { Mat4, PROJECTION_PERSPECTIVE, Quat, Vec3 } from 'playcanvas';

import { Pose } from './camera-poses';
import type { ColmapW2cComponents } from './colmap-pose-presentation';
import { ElementType } from './element';
import { Events } from './events';
import { BrowserFileSystem } from './io';
import { Scene } from './scene';
import { Splat } from './splat';

type MatrixRows = [number[], number[], number[], number[]];

interface WanTrajectoryExportSettings {
    cameraCount: number;
    width: number;
    height: number;
}

type CurrentTrajectoryExportFormat = 'json' | 'csv';

type ColmapW2cPoseRow = ColmapW2cComponents & {
    index: number,
    image_name: string
};

type ColmapPoseValidation = {
    quaternion_norm_error: number,
    rotation_orthonormal_error: number,
    rotation_determinant_error: number,
    inverse_error: number,
    recovered_center_error: number,
    axis_conversion_error: number
};

type CurrentTrajectorySource =
    'recorded-interpolated' |
    'recorded-keyframes' |
    'planner-preview' |
    'timeline' |
    'current-view';

interface CameraExportSelection {
    imageProjection: boolean;
    intrinsics: boolean;
    pose: boolean;
    playcanvasMatrices: boolean;
    opencvMatrices: boolean;
    metadataConventions: boolean;
}

const toRows = (data: ArrayLike<number>): MatrixRows => {
    return [0, 1, 2, 3].map(row => (
        [0, 1, 2, 3].map(column => data[column * 4 + row])
    )) as MatrixRows;
};

const fromRows = (rows: MatrixRows) => new Mat4().set([
    rows[0][0], rows[1][0], rows[2][0], rows[3][0],
    rows[0][1], rows[1][1], rows[2][1], rows[3][1],
    rows[0][2], rows[1][2], rows[2][2], rows[3][2],
    rows[0][3], rows[1][3], rows[2][3], rows[3][3]
]);

// PlayCanvas camera space is X-right, Y-up, -Z-forward. OpenCV camera space
// is X-right, Y-down, Z-forward, so converting between them flips Y and Z.
const worldToCameraOpenCv = (view: MatrixRows): MatrixRows => {
    return view.map((row, index) => (
        index === 1 || index === 2 ? row.map(value => -value) : row.slice()
    )) as MatrixRows;
};

const cameraToWorldOpenCv = (world: MatrixRows): MatrixRows => {
    return world.map(row => [row[0], -row[1], -row[2], row[3]]) as MatrixRows;
};

const finite = (value: number, name: string) => {
    if (!Number.isFinite(value)) {
        throw new Error(`Cannot export camera parameters: ${name} is not finite`);
    }
    return value;
};

const maxMatrixDifference = (left: MatrixRows, right: MatrixRows) => {
    let result = 0;
    for (let row = 0; row < 4; row++) {
        for (let column = 0; column < 4; column++) {
            result = Math.max(result, Math.abs(left[row][column] - right[row][column]));
        }
    }
    return result;
};

const multiplyRows = (left: MatrixRows, right: MatrixRows): MatrixRows => (
    left.map((row, rowIndex) => right[0].map((_, column) => (
        row.reduce((sum, value, inner) => sum + value * right[inner][column], 0)
    ))) as MatrixRows
);

const determinant3 = (matrix: MatrixRows) => (
    matrix[0][0] * (matrix[1][1] * matrix[2][2] - matrix[1][2] * matrix[2][1]) -
    matrix[0][1] * (matrix[1][0] * matrix[2][2] - matrix[1][2] * matrix[2][0]) +
    matrix[0][2] * (matrix[1][0] * matrix[2][1] - matrix[1][1] * matrix[2][0])
);

// Remove only a uniform positive model scale. A reflection or shear cannot be
// represented by a standard COLMAP rotation and is rejected instead of being
// hidden behind an image mirror.
const rigidTransform = (matrix: Mat4, frameIndex: number, label: string) => {
    const data = matrix.data;
    const axes = [
        new Vec3(data[0], data[1], data[2]),
        new Vec3(data[4], data[5], data[6]),
        new Vec3(data[8], data[9], data[10])
    ];
    const lengths = axes.map(axis => axis.length());
    const averageScale = lengths.reduce((sum, value) => sum + value, 0) / 3;
    if (!Number.isFinite(averageScale) || averageScale < 1e-10) {
        throw new Error(`Cannot export frame ${frameIndex + 1}: ${label} has a singular basis`);
    }
    const scaleError = Math.max(...lengths.map(value => Math.abs(value - averageScale))) / averageScale;
    if (scaleError > 1e-5) {
        throw new Error(
            `Cannot export frame ${frameIndex + 1}: ${label} contains non-uniform scale (${scaleError})`
        );
    }
    axes.forEach(axis => axis.mulScalar(1 / averageScale));
    const orthogonalError = Math.max(
        Math.abs(axes[0].dot(axes[1])),
        Math.abs(axes[0].dot(axes[2])),
        Math.abs(axes[1].dot(axes[2]))
    );
    const determinant = axes[0].dot(new Vec3().cross(axes[1], axes[2]));
    if (orthogonalError > 1e-5 || Math.abs(determinant - 1) > 1e-5) {
        throw new Error(
            `Cannot export frame ${frameIndex + 1}: ${label} is not a proper rigid transform ` +
            `(orthogonal error ${orthogonalError}, determinant ${determinant})`
        );
    }
    return new Mat4().set([
        axes[0].x, axes[0].y, axes[0].z, 0,
        axes[1].x, axes[1].y, axes[1].z, 0,
        axes[2].x, axes[2].y, axes[2].z, 0,
        data[12], data[13], data[14], 1
    ]);
};

const validatePose = (pose: Pose, frameIndex: number) => {
    const values = [
        pose.position.x, pose.position.y, pose.position.z,
        pose.target.x, pose.target.y, pose.target.z
    ];
    values.forEach((value, index) => finite(value, `frame ${frameIndex + 1} pose value ${index + 1}`));
    if (pose.position.distance(pose.target) < 1e-8) {
        throw new Error(`Cannot export frame ${frameIndex + 1}: camera position and target are identical`);
    }
};

const quaternionWxyzToWorldToCamera = (qvec: number[], tvec: number[]): MatrixRows => {
    const [w, x, y, z] = qvec;
    return [
        [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w), tvec[0]],
        [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w), tvec[1]],
        [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y), tvec[2]],
        [0, 0, 0, 1]
    ];
};

const validateTransformPair = (
    cameraToWorld: MatrixRows,
    worldToCamera: MatrixRows,
    quaternion: number[],
    frameIndex: number,
    cameraToWorldPlayCanvas: MatrixRows
): ColmapPoseValidation => {
    const values = [...cameraToWorld.flat(), ...worldToCamera.flat(), ...quaternion];
    values.forEach((value, index) => finite(value, `frame ${frameIndex + 1} transform value ${index + 1}`));

    const identity: MatrixRows = [
        [1, 0, 0, 0],
        [0, 1, 0, 0],
        [0, 0, 1, 0],
        [0, 0, 0, 1]
    ];
    const maxIdentityError = maxMatrixDifference(multiplyRows(worldToCamera, cameraToWorld), identity);
    if (maxIdentityError > 1e-4) {
        throw new Error(
            `Cannot export frame ${frameIndex + 1}: c2w/w2c inverse error is ${maxIdentityError}`
        );
    }

    const quaternionLength = Math.hypot(...quaternion);
    const quaternionNormError = Math.abs(quaternionLength - 1);
    if (quaternionNormError > 1e-5) {
        throw new Error(`Cannot export frame ${frameIndex + 1}: COLMAP quaternion is not normalized`);
    }

    const rotationTransposeRotation: MatrixRows = [0, 1, 2, 3].map(row => (
        [0, 1, 2, 3].map((column) => {
            if (row === 3 || column === 3) return row === column ? 1 : 0;
            return worldToCamera[0][row] * worldToCamera[0][column] +
                worldToCamera[1][row] * worldToCamera[1][column] +
                worldToCamera[2][row] * worldToCamera[2][column];
        })
    )) as MatrixRows;
    const orthonormalError = maxMatrixDifference(rotationTransposeRotation, identity);
    const determinantError = Math.abs(determinant3(worldToCamera) - 1);
    if (orthonormalError > 1e-5 || determinantError > 1e-5) {
        throw new Error(
            `Cannot export frame ${frameIndex + 1}: R_w2c is not a proper rotation ` +
            `(R^T R error ${orthonormalError}, determinant error ${determinantError})`
        );
    }

    const translation = [worldToCamera[0][3], worldToCamera[1][3], worldToCamera[2][3]];
    const recoveredCenter = [0, 1, 2].map(column => -(
        worldToCamera[0][column] * translation[0] +
        worldToCamera[1][column] * translation[1] +
        worldToCamera[2][column] * translation[2]
    ));
    const expectedCenter = [cameraToWorld[0][3], cameraToWorld[1][3], cameraToWorld[2][3]];
    const centerError = Math.hypot(...recoveredCenter.map(
        (value, index) => value - expectedCenter[index]
    ));
    if (centerError > 1e-4) {
        throw new Error(`Cannot export frame ${frameIndex + 1}: recovered camera center error is ${centerError}`);
    }

    const expectedCameraToWorld = cameraToWorldOpenCv(cameraToWorldPlayCanvas);
    const expectedWorldToCamera = worldToCameraOpenCv(
        toRows(fromRows(cameraToWorldPlayCanvas).invert().data)
    );
    const axisConversionError = Math.max(
        maxMatrixDifference(cameraToWorld, expectedCameraToWorld),
        maxMatrixDifference(worldToCamera, expectedWorldToCamera)
    );
    if (axisConversionError > 1e-5) {
        throw new Error(
            `Cannot export frame ${frameIndex + 1}: PlayCanvas/OpenCV axis conversion error is ${axisConversionError}`
        );
    }

    const quaternionMatrix = quaternionWxyzToWorldToCamera(quaternion, translation);
    const quaternionMatrixError = maxMatrixDifference(quaternionMatrix, worldToCamera);
    if (quaternionMatrixError > 1e-5) {
        throw new Error(
            `Cannot export frame ${frameIndex + 1}: quaternion does not reproduce R_w2c (${quaternionMatrixError})`
        );
    }

    return {
        quaternion_norm_error: quaternionNormError,
        rotation_orthonormal_error: orthonormalError,
        rotation_determinant_error: determinantError,
        inverse_error: maxIdentityError,
        recovered_center_error: centerError,
        axis_conversion_error: axisConversionError
    };
};

const matrixToQuaternionWxyz = (matrix: MatrixRows) => {
    const m00 = matrix[0][0];
    const m11 = matrix[1][1];
    const m22 = matrix[2][2];
    const trace = m00 + m11 + m22;
    let w: number;
    let x: number;
    let y: number;
    let z: number;
    if (trace > 0) {
        const s = Math.sqrt(trace + 1) * 2;
        w = 0.25 * s;
        x = (matrix[2][1] - matrix[1][2]) / s;
        y = (matrix[0][2] - matrix[2][0]) / s;
        z = (matrix[1][0] - matrix[0][1]) / s;
    } else if (m00 > m11 && m00 > m22) {
        const s = Math.sqrt(1 + m00 - m11 - m22) * 2;
        w = (matrix[2][1] - matrix[1][2]) / s;
        x = 0.25 * s;
        y = (matrix[0][1] + matrix[1][0]) / s;
        z = (matrix[0][2] + matrix[2][0]) / s;
    } else if (m11 > m22) {
        const s = Math.sqrt(1 + m11 - m00 - m22) * 2;
        w = (matrix[0][2] - matrix[2][0]) / s;
        x = (matrix[0][1] + matrix[1][0]) / s;
        y = 0.25 * s;
        z = (matrix[1][2] + matrix[2][1]) / s;
    } else {
        const s = Math.sqrt(1 + m22 - m00 - m11) * 2;
        w = (matrix[1][0] - matrix[0][1]) / s;
        x = (matrix[0][2] + matrix[2][0]) / s;
        y = (matrix[1][2] + matrix[2][1]) / s;
        z = 0.25 * s;
    }
    const length = Math.hypot(w, x, y, z);
    return [w / length, x / length, y / length, z / length];
};

const intrinsicsFromFov = (width: number, height: number, fovDegrees: number) => {
    const focal = (width > height ? width : height) /
        (2 * Math.tan(fovDegrees * Math.PI / 360));
    return {
        model: 'PINHOLE',
        width,
        height,
        fx: focal,
        fy: focal,
        cx: width * 0.5,
        cy: height * 0.5,
        K: [
            [focal, 0, width * 0.5],
            [0, focal, height * 0.5],
            [0, 0, 1]
        ]
    };
};

const poseMatrices = (
    cameraWorldPlayCanvas: Mat4,
    worldToColmap = new Mat4(),
    frameIndex = 0
) => {
    // The input is the camera entity's complete C2W matrix. The reference-model
    // inverse moves it into the original PLY/COLMAP world; rigidTransform strips
    // only a permitted uniform scene scale and rejects any reflection.
    const colmapCameraScaled = new Mat4().mul2(worldToColmap, cameraWorldPlayCanvas);
    const cameraToWorldColmapPlayCanvas = rigidTransform(
        colmapCameraScaled,
        frameIndex,
        'camera C2W in the reference PLY coordinate frame'
    );
    const cameraToWorldPlayCanvas = toRows(cameraToWorldColmapPlayCanvas.data);
    const worldToCameraPlayCanvas = toRows(cameraToWorldColmapPlayCanvas.clone().invert().data);
    const c2w = cameraToWorldOpenCv(cameraToWorldPlayCanvas);
    const w2c = worldToCameraOpenCv(worldToCameraPlayCanvas);
    const qvec = matrixToQuaternionWxyz(w2c);
    const validation = validateTransformPair(
        c2w,
        w2c,
        qvec,
        frameIndex,
        cameraToWorldPlayCanvas
    );
    return {
        c2w,
        w2c,
        qvec,
        tvec: [w2c[0][3], w2c[1][3], w2c[2][3]],
        center: [c2w[0][3], c2w[1][3], c2w[2][3]],
        cameraToWorldPlayCanvas,
        validation
    };
};

const visibleColmapReferenceSplats = (scene: Scene) => (
    (scene.getElementsByType(ElementType.splat) as Splat[])
    .filter(splat => splat.visible && splat.numSplats > 0)
);

const resolveColmapReference = (scene?: Scene, visibleSplats?: Splat[]) => {
    const identity = new Mat4();
    if (!scene) {
        return {
            worldToColmap: identity,
            referenceWorld: identity.clone(),
            splatName: null,
            transformed: false
        };
    }

    const splats = visibleSplats ?? visibleColmapReferenceSplats(scene);
    if (splats.length === 0) {
        return {
            worldToColmap: identity,
            referenceWorld: identity.clone(),
            splatName: null,
            transformed: false
        };
    }

    const reference = splats[0];
    const referenceWorld = reference.worldTransform;
    rigidTransform(referenceWorld, 0, 'reference Gaussian world transform');
    const scale = referenceWorld.getScale(new Vec3());
    const scaleMagnitude = Math.max(Math.abs(scale.x), Math.abs(scale.y), Math.abs(scale.z), 1e-12);
    if (Math.max(
        Math.abs(scale.x - scale.y),
        Math.abs(scale.y - scale.z),
        Math.abs(scale.z - scale.x)
    ) / scaleMagnitude > 1e-5) {
        throw new Error('COLMAP export requires a uniformly scaled reference Gaussian model');
    }

    for (const splat of splats.slice(1)) {
        const candidate = splat.worldTransform.data;
        const referenceData = referenceWorld.data;
        let maxDifference = 0;
        for (let index = 0; index < 16; index++) {
            maxDifference = Math.max(maxDifference, Math.abs(candidate[index] - referenceData[index]));
        }
        if (maxDifference > 1e-5) {
            throw new Error(
                'Visible Gaussian models use different world transforms; a single COLMAP coordinate frame is ambiguous'
            );
        }
    }

    return {
        worldToColmap: referenceWorld.clone().invert(),
        referenceWorld: referenceWorld.clone(),
        splatName: reference.name,
        transformed: true
    };
};

const capturePoseWorldTransforms = (poses: Pose[], scene?: Scene) => {
    if (!scene) {
        throw new Error('COLMAP trajectory export requires the active SuperSplat camera entity');
    }
    const camera = scene.camera;
    const saved = {
        focalPoint: camera.focalPoint,
        azim: camera.azim,
        elevation: camera.elevation,
        distance: camera.distance,
        fov: camera.fov,
        ortho: camera.ortho,
        poseOverride: camera.poseOverride ? {
            position: camera.poseOverride.position.clone(),
            rotation: camera.poseOverride.rotation.clone(),
            fov: camera.poseOverride.fov,
            near: camera.poseOverride.near,
            far: camera.poseOverride.far
        } : null
    };

    try {
        if (camera.poseOverride) camera.setPoseOverride(null);
        return poses.map((pose, index) => {
            validatePose(pose, index);
            camera.setPose(pose.position, pose.target, 0);
            camera.onUpdate(0);
            // Do not use getRotation(): the entity C2W matrix is the authority.
            return camera.mainCamera.getWorldTransform().clone();
        });
    } finally {
        if (camera.poseOverride) camera.setPoseOverride(null);
        camera.setFocalPoint(saved.focalPoint, 0);
        camera.setAzimElev(saved.azim, saved.elevation, 0);
        camera.setDistance(saved.distance, 0);
        camera.fov = saved.fov;
        camera.ortho = saved.ortho;
        camera.onUpdate(0);
        if (saved.poseOverride) camera.setPoseOverride(saved.poseOverride);
    }
};

type ColmapRoundTripResult = {
    poses: Pose[],
    maxPositionError: number,
    maxRotationErrorDegrees: number,
    maxFovErrorDegrees: number,
    valid: boolean
};

/**
 * Export poses through the same OpenCV/COLMAP matrices used by the ZIP writer,
 * then reconstruct them in the editor world for a visible round-trip check.
 */
const roundTripColmapPoses = (poses: Pose[], scene?: Scene): ColmapRoundTripResult => {
    const { worldToColmap } = resolveColmapReference(scene);
    const colmapToWorld = worldToColmap.clone().invert();
    const worldTransforms = capturePoseWorldTransforms(poses, scene);
    let maxPositionError = 0;
    let maxRotationErrorDegrees = 0;
    let maxFovErrorDegrees = 0;

    const restored = poses.map((pose, index) => {
        validatePose(pose, index);
        const matrices = poseMatrices(worldTransforms[index], worldToColmap, index);

        // Rebuild from the qvec/tvec written to COLMAP images.txt, rather than
        // trusting the redundant c2w matrix stored in trajectory.json.
        const worldToCameraOpenCvRows = quaternionWxyzToWorldToCamera(matrices.qvec, matrices.tvec);
        const cameraToWorldOpenCvRows = toRows(fromRows(worldToCameraOpenCvRows).invert().data);
        // cameraToWorldOpenCv flips camera Y/Z columns and is its own inverse.
        const colmapPlayCanvas = fromRows(cameraToWorldOpenCv(cameraToWorldOpenCvRows));
        const worldPlayCanvas = rigidTransform(
            new Mat4().mul2(colmapToWorld, colmapPlayCanvas),
            index,
            'round-trip camera C2W'
        );
        const position = worldPlayCanvas.getTranslation(new Vec3());
        const rotation = new Quat().setFromMat4(worldPlayCanvas).normalize();
        const forward = rotation.transformVector(Vec3.FORWARD.clone()).normalize();
        const sourceForward = pose.target.clone().sub(pose.position).normalize();
        const targetDistance = Math.max(pose.position.distance(pose.target), 1e-6);
        const fov = pose.fov ?? 60;
        const positionError = position.distance(pose.position);
        const rotationError = Math.acos(Math.min(1, Math.max(-1, forward.dot(sourceForward)))) * 180 / Math.PI;

        maxPositionError = Math.max(maxPositionError, positionError);
        maxRotationErrorDegrees = Math.max(maxRotationErrorDegrees, rotationError);
        maxFovErrorDegrees = Math.max(maxFovErrorDegrees, Math.abs(fov - (pose.fov ?? 60)));
        return {
            ...pose,
            name: `colmap_validation_${String(index + 1).padStart(3, '0')}`,
            position,
            target: position.clone().add(forward.mulScalar(targetDistance)),
            fov
        };
    });

    return {
        poses: restored,
        maxPositionError,
        maxRotationErrorDegrees,
        maxFovErrorDegrees,
        valid: maxPositionError <= 1e-4 && maxRotationErrorDegrees <= 1e-3 && maxFovErrorDegrees <= 1e-6
    };
};

const validateWanSettings = (settings: WanTrajectoryExportSettings) => {
    if (!Number.isFinite(settings.cameraCount) || !Number.isFinite(settings.width) ||
        !Number.isFinite(settings.height)) {
        throw new Error('Camera count and resolution must be finite numbers');
    }
    const cameraCount = Math.trunc(settings.cameraCount);
    const width = Math.trunc(settings.width);
    const height = Math.trunc(settings.height);
    if (!Number.isSafeInteger(cameraCount) || cameraCount < 1) {
        throw new Error('Camera trajectory count must be a positive integer');
    }
    if (width < 1 || height < 1 || width > 16384 || height > 16384) {
        throw new Error('Trajectory image width and height must be between 1 and 16384');
    }
    return { cameraCount, width, height };
};

const toVec3 = (value: Vec3 | number[] | { x: number, y: number, z: number }) => {
    if (Array.isArray(value)) return new Vec3(value);
    return new Vec3(value.x, value.y, value.z);
};

const normalizePose = (pose: Pose | any, index: number): Pose => {
    const position = toVec3(pose.position);
    let target = toVec3(pose.target);
    if (position.distance(target) < 1e-8) {
        target = position.clone().add(Vec3.FORWARD);
    }
    return {
        name: pose.name ?? `camera_${String(index + 1).padStart(3, '0')}`,
        frame: Number.isFinite(pose.frame) ? pose.frame : index,
        position,
        target,
        fov: Number.isFinite(pose.fov) ? pose.fov : 60
    };
};

const currentTrajectorySource = (events: Events): {
    source: CurrentTrajectorySource,
    description: string,
    poses: Pose[]
} => {
    const recordedState = events.invoke('recordedView.state') as {
        keyframeCount: number,
        finished: boolean
    } | undefined;
    if (recordedState?.keyframeCount) {
        const targetPoses = ((events.invoke('recordedView.targetPoses') as Pose[] | undefined) ?? []);
        const keyframes = ((events.invoke('recordedView.keyframes') as Pose[] | undefined) ?? []);
        if (recordedState.finished && targetPoses.length > 0) {
            return {
                source: 'recorded-interpolated',
                description: 'Finished manual-view trajectory after position and orientation interpolation',
                poses: targetPoses.map(normalizePose)
            };
        }
        return {
            source: 'recorded-keyframes',
            description: 'Current manually recorded camera keyframes',
            poses: keyframes.map(normalizePose)
        };
    }

    const validation = events.invoke('trajectory.validation') as { stale?: boolean } | undefined;
    const previewPoses = ((events.invoke('trajectory.previewPoses') as Pose[] | undefined) ?? []);
    if (validation?.stale && previewPoses.length > 0) {
        return {
            source: 'planner-preview',
            description: 'Current trajectory planner preview',
            poses: previewPoses.map(normalizePose)
        };
    }

    const timelinePoses = ((events.invoke('camera.poses') as Pose[] | undefined) ?? []);
    if (timelinePoses.length > 0) {
        return {
            source: 'timeline',
            description: 'Generated camera timeline trajectory',
            poses: timelinePoses.map(normalizePose).sort((a, b) => a.frame - b.frame)
        };
    }
    if (previewPoses.length > 0) {
        return {
            source: 'planner-preview',
            description: 'Current trajectory planner preview',
            poses: previewPoses.map(normalizePose)
        };
    }

    const cameraPose = events.invoke('camera.getPose');
    if (!cameraPose) throw new Error('No camera pose is available for trajectory export');
    return {
        source: 'current-view',
        description: 'Current observer camera view',
        poses: [normalizePose(cameraPose, 0)]
    };
};

const resamplePoses = (source: Pose[], count: number, currentIndex: number) => {
    if (count === 1) {
        const pose = source[currentIndex];
        return [{
            pose: {
                ...pose,
                position: pose.position.clone(),
                target: pose.target.clone()
            },
            sourceIndex: currentIndex
        }];
    }

    const lengths = [0];
    for (let index = 1; index < source.length; index++) {
        lengths.push(lengths[index - 1] + source[index - 1].position.distance(source[index].position));
    }
    const totalLength = lengths[lengths.length - 1];
    const rotations = source.map((pose) => {
        const forward = pose.target.clone().sub(pose.position).normalize();
        const up = Math.abs(forward.dot(Vec3.UP)) > 0.999 ? Vec3.BACK : Vec3.UP;
        return new Quat().setFromMat4(
            new Mat4().setLookAt(pose.position, pose.target, up)
        ).normalize();
    });
    let lowerIndex = 0;

    const result = Array.from({ length: count }, (_, index) => {
        const distance = totalLength * index / (count - 1);
        while (lowerIndex + 2 < lengths.length && lengths[lowerIndex + 1] < distance) lowerIndex++;
        const upperIndex = Math.min(source.length - 1, lowerIndex + 1);
        const span = Math.max(lengths[upperIndex] - lengths[lowerIndex], 1e-12);
        const amount = (distance - lengths[lowerIndex]) / span;
        const sourceIndex = lowerIndex + amount;
        const lower = source[lowerIndex];
        const upper = source[upperIndex];
        const position = new Vec3().lerp(lower.position, upper.position, amount);

        const lowerDistance = Math.max(lower.position.distance(lower.target), 1e-6);
        const upperDistance = Math.max(upper.position.distance(upper.target), 1e-6);
        // q and -q are the same rotation, but v and -v are opposite viewing
        // directions. Flipping a direction vector here used to make exports
        // look backwards whenever adjacent poses differed by more than 90°.
        const rotation = new Quat().slerp(
            rotations[lowerIndex], rotations[upperIndex], amount
        ).normalize();
        const direction = rotation.transformVector(Vec3.FORWARD.clone()).normalize();
        const targetDistance = lowerDistance + (upperDistance - lowerDistance) * amount;

        return {
            pose: {
                ...lower,
                name: `export_camera_${String(index + 1).padStart(3, '0')}`,
                frame: lower.frame + (upper.frame - lower.frame) * amount,
                position,
                target: position.clone().add(direction.mulScalar(targetDistance)),
                fov: (lower.fov ?? 60) + ((upper.fov ?? lower.fov ?? 60) - (lower.fov ?? 60)) * amount
            },
            sourceIndex
        };
    });

    // Resampling may redistribute interior cameras, but it must never reverse
    // the recorded sequence or change either endpoint's viewing direction.
    const endpointPairs = [
        [result[0].pose, source[0]],
        [result[result.length - 1].pose, source[source.length - 1]]
    ] as const;
    endpointPairs.forEach(([sample, original], endpoint) => {
        const sampleForward = sample.target.clone().sub(sample.position).normalize();
        const originalForward = original.target.clone().sub(original.position).normalize();
        if (sample.position.distance(original.position) > 1e-6 ||
            sampleForward.dot(originalForward) < 1 - 1e-6) {
            throw new Error(
                `Trajectory resampling changed the ${endpoint === 0 ? 'first' : 'last'} camera pose`
            );
        }
    });
    return result;
};

const buildWanTrajectoryExport = (
    events: Events,
    settings: WanTrajectoryExportSettings,
    scene?: Scene
) => {
    const { cameraCount, width, height } = validateWanSettings(settings);
    const timelineFrames = Math.max(1, Math.trunc(events.invoke('timeline.frames') ?? 1));
    const selectedSource = currentTrajectorySource(events);
    const sourcePoses = selectedSource.poses;

    const currentTimelineIndex = Math.trunc(events.invoke('timeline.frame') ?? 0);
    const nearestCurrentPose = sourcePoses.reduce((best, pose, index) => (
        Math.abs(pose.frame - currentTimelineIndex) < Math.abs(sourcePoses[best].frame - currentTimelineIndex) ?
            index : best
    ), 0);
    // Export samples continuous positions and unit look directions instead of
    // rounding to source camera indices. Rounded downsampling alternates source
    // strides (for example 5, 5, 6), which becomes visible as periodic motion
    // judder when the exported cameras are consumed as video frames.
    const samples = resamplePoses(sourcePoses, cameraCount, nearestCurrentPose);
    const colmapReference = resolveColmapReference(scene);
    const worldTransforms = capturePoseWorldTransforms(samples.map(sample => sample.pose), scene);
    let previousQuaternion: number[] | null = null;

    const cameras = samples.map(({ pose, sourceIndex }, index) => {
        const colmapPose: Pose = {
            ...pose,
            position: colmapReference.worldToColmap.transformPoint(pose.position, new Vec3()),
            target: colmapReference.worldToColmap.transformPoint(pose.target, new Vec3())
        };
        validatePose(colmapPose, index);
        const fov = finite(pose.fov ?? events.invoke('camera.fov') ?? 60, 'fov');
        if (fov <= 0 || fov >= 180) {
            throw new Error(`Cannot export frame ${index + 1}: FOV must be between 0 and 180 degrees`);
        }
        const intrinsics = intrinsicsFromFov(width, height, fov);
        const matrices = poseMatrices(worldTransforms[index], colmapReference.worldToColmap, index);
        // q and -q encode the same rotation, but consumers that interpolate the
        // raw values can take the long arc when signs alternate. Keep every
        // exported quaternion in the same hemisphere as its predecessor.
        if (previousQuaternion && matrices.qvec.reduce(
            (dot, value, component) => dot + value * previousQuaternion[component], 0
        ) < 0) {
            matrices.qvec = matrices.qvec.map(value => -value);
        }
        previousQuaternion = matrices.qvec.slice();
        return {
            index,
            source_camera_index: sourceIndex,
            source_timeline_index: pose.frame,
            image_name: `Wan_Cam_${String(index + 1).padStart(6, '0')}.png`,
            intrinsics,
            camera_center_colmap: matrices.center,
            look_at_target_colmap: [colmapPose.target.x, colmapPose.target.y, colmapPose.target.z],
            qvec_w2c_wxyz: matrices.qvec,
            tvec_w2c: matrices.tvec,
            camera_to_world_opencv: matrices.c2w,
            world_to_camera_colmap: matrices.w2c
        };
    });
    return {
        schema: 'supersplat.wan.camera-trajectory.v1',
        exported_at: new Date().toISOString(),
        source: {
            document: events.invoke('doc.name') ?? null,
            renderer: 'SuperSplat',
            renderer_version: '2.32.7',
            trajectory_type: selectedSource.source,
            trajectory_description: selectedSource.description,
            timeline_camera_indices: timelineFrames,
            timeline_frame_rate: events.invoke('timeline.frameRate')
        },
        constraints: {
            minimum_camera_count: 1,
            selected_camera_count: cameraCount
        },
        coordinate_convention: {
            world: colmapReference.transformed ?
                'Reference Gaussian source PLY / COLMAP world coordinates' :
                'SuperSplat/PlayCanvas world coordinates (no Gaussian reference loaded)',
            camera: 'OpenCV/COLMAP: +X right, +Y down, +Z forward',
            quaternion_order: 'wxyz',
            transform: 'world_to_camera_colmap maps COLMAP world coordinates to camera coordinates',
            reference_splat: colmapReference.splatName,
            supersplat_world_to_colmap: toRows(colmapReference.worldToColmap.data)
        },
        camera_count: cameraCount,
        cameras
    };
};

type WanTrajectoryExportData = ReturnType<typeof buildWanTrajectoryExport>;

const buildCurrentTrajectoryExport = (events: Events, scene?: Scene) => {
    const selected = currentTrajectorySource(events);
    const colmapReference = resolveColmapReference(scene);
    const worldTransforms = selected.source === 'current-view' && scene ?
        [scene.camera.mainCamera.getWorldTransform().clone()] :
        capturePoseWorldTransforms(selected.poses, scene);
    let previousQuaternion: number[] | null = null;
    const validations: ColmapPoseValidation[] = [];
    const digits = Math.max(6, String(selected.poses.length).length);
    const poses: ColmapW2cPoseRow[] = selected.poses.map((pose, index) => {
        validatePose(pose, index);
        const matrices = poseMatrices(worldTransforms[index], colmapReference.worldToColmap, index);
        if (previousQuaternion && matrices.qvec.reduce(
            (dot, value, component) => dot + value * previousQuaternion[component], 0
        ) < 0) {
            matrices.qvec = matrices.qvec.map(value => -value);
        }
        previousQuaternion = matrices.qvec.slice();
        validations.push(matrices.validation);
        return {
            index: index + 1,
            image_name: `Virtual_Cam_${String(index + 1).padStart(digits, '0')}.png`,
            qw_w2c: matrices.qvec[0],
            qx_w2c: matrices.qvec[1],
            qy_w2c: matrices.qvec[2],
            qz_w2c: matrices.qvec[3],
            tx_w2c: matrices.tvec[0],
            ty_w2c: matrices.tvec[1],
            tz_w2c: matrices.tvec[2]
        };
    });
    const validation = validations.reduce<ColmapPoseValidation>((maximum, frame) => ({
        quaternion_norm_error: Math.max(maximum.quaternion_norm_error, frame.quaternion_norm_error),
        rotation_orthonormal_error: Math.max(
            maximum.rotation_orthonormal_error,
            frame.rotation_orthonormal_error
        ),
        rotation_determinant_error: Math.max(
            maximum.rotation_determinant_error,
            frame.rotation_determinant_error
        ),
        inverse_error: Math.max(maximum.inverse_error, frame.inverse_error),
        recovered_center_error: Math.max(maximum.recovered_center_error, frame.recovered_center_error),
        axis_conversion_error: Math.max(maximum.axis_conversion_error, frame.axis_conversion_error)
    }), {
        quaternion_norm_error: 0,
        rotation_orthonormal_error: 0,
        rotation_determinant_error: 0,
        inverse_error: 0,
        recovered_center_error: 0,
        axis_conversion_error: 0
    });
    return {
        schema: 'supersplat.colmap-w2c-trajectory.v1',
        exported_at: new Date().toISOString(),
        source_type: selected.source,
        source_description: selected.description,
        pose_count: poses.length,
        csv_fields: [
            'index', 'image_name',
            'qw_w2c', 'qx_w2c', 'qy_w2c', 'qz_w2c',
            'tx_w2c', 'ty_w2c', 'tz_w2c'
        ],
        coordinate_convention: {
            world: colmapReference.transformed ?
                'Reference Gaussian source PLY / COLMAP world coordinates' :
                'SuperSplat/PlayCanvas world coordinates (no Gaussian reference loaded)',
            camera: 'OpenCV/COLMAP: +X right, +Y down, +Z forward',
            transform: 'X_camera = R_w2c * X_world + t_w2c',
            quaternion_order: 'wxyz',
            reference_splat: colmapReference.splatName,
            supersplat_world_to_colmap: toRows(colmapReference.worldToColmap.data)
        },
        validation,
        poses
    };
};

type CurrentTrajectoryExportData = ReturnType<typeof buildCurrentTrajectoryExport>;

const csvCell = (value: string | number) => {
    const text = String(value);
    return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

const currentTrajectoryToCsv = (data: CurrentTrajectoryExportData) => {
    const header = [
        'index', 'image_name',
        'qw_w2c', 'qx_w2c', 'qy_w2c', 'qz_w2c',
        'tx_w2c', 'ty_w2c', 'tz_w2c'
    ];
    let previousQuaternion: number[] | null = null;
    const rows = data.poses.map((pose) => {
        let quaternion = [pose.qw_w2c, pose.qx_w2c, pose.qy_w2c, pose.qz_w2c];
        if (previousQuaternion && quaternion.reduce(
            (dot, value, component) => dot + value * previousQuaternion[component], 0
        ) < 0) {
            quaternion = quaternion.map(value => -value);
        }
        previousQuaternion = quaternion;
        return [
            pose.index, pose.image_name,
            ...quaternion,
            pose.tx_w2c, pose.ty_w2c, pose.tz_w2c
        ];
    });
    return `${[header, ...rows].map(row => row.map(csvCell).join(',')).join('\n')}\n`;
};

const colmapW2cRowsToCsv = (poses: ColmapW2cPoseRow[]) => currentTrajectoryToCsv({ poses } as CurrentTrajectoryExportData);

const buildCurrentFrameColmapW2c = (
    scene: Scene,
    index: number,
    imageName: string
): ColmapW2cPoseRow => {
    if (!Number.isSafeInteger(index) || index < 1) throw new Error('COLMAP frame index must be a positive integer');
    if (!imageName) throw new Error('COLMAP frame image name is required');
    const colmapReference = resolveColmapReference(scene);
    const matrices = poseMatrices(
        scene.camera.mainCamera.getWorldTransform().clone(),
        colmapReference.worldToColmap,
        index - 1
    );
    return {
        index,
        image_name: imageName,
        qw_w2c: matrices.qvec[0],
        qx_w2c: matrices.qvec[1],
        qy_w2c: matrices.qvec[2],
        qz_w2c: matrices.qvec[3],
        tx_w2c: matrices.tvec[0],
        ty_w2c: matrices.tvec[1],
        tz_w2c: matrices.tvec[2]
    };
};

type ColmapW2cPoseValues = Omit<ColmapW2cPoseRow, 'index' | 'image_name'>;

type ColmapReferenceSnapshot = {
    splats: Splat[];
    matrices: number[][];
    reference: ReturnType<typeof resolveColmapReference>;
};

const matrixMatches = (data: ArrayLike<number>, values: number[]) => {
    if (data.length !== values.length) return false;
    for (let index = 0; index < data.length; index++) {
        if (data[index] !== values[index]) return false;
    }
    return true;
};

const referenceSnapshotMatches = (snapshot: ColmapReferenceSnapshot, splats: Splat[]) => (
    snapshot.splats.length === splats.length && snapshot.splats.every((splat, index) => (
        splat === splats[index] && matrixMatches(splat.worldTransform.data, snapshot.matrices[index])
    ))
);

/**
 * Build current-frame poses with a matrix-aware cache. Polling clients such as
 * the performance HUD reuse a validated result while the camera and reference
 * PLY transforms are unchanged; trajectory export still validates every frame.
 */
const createCurrentFrameColmapW2cBuilder = (scene: Scene) => {
    let referenceSnapshot: ColmapReferenceSnapshot | null = null;
    let referenceRevision = 0;
    let cachedReferenceRevision = -1;
    let cameraMatrix: number[] | null = null;
    let poseValues: ColmapW2cPoseValues | null = null;

    return (index: number, imageName: string): ColmapW2cPoseRow => {
        if (!Number.isSafeInteger(index) || index < 1) {
            throw new Error('COLMAP frame index must be a positive integer');
        }
        if (!imageName) throw new Error('COLMAP frame image name is required');

        const visibleSplats = visibleColmapReferenceSplats(scene);
        if (!referenceSnapshot || !referenceSnapshotMatches(referenceSnapshot, visibleSplats)) {
            referenceSnapshot = {
                splats: visibleSplats,
                matrices: visibleSplats.map(splat => Array.from(splat.worldTransform.data)),
                reference: resolveColmapReference(scene, visibleSplats)
            };
            referenceRevision++;
        }

        const worldTransform = scene.camera.mainCamera.getWorldTransform();
        if (!poseValues || cachedReferenceRevision !== referenceRevision ||
            !cameraMatrix || !matrixMatches(worldTransform.data, cameraMatrix)) {
            const matrices = poseMatrices(
                worldTransform,
                referenceSnapshot.reference.worldToColmap,
                index - 1
            );
            poseValues = {
                qw_w2c: matrices.qvec[0],
                qx_w2c: matrices.qvec[1],
                qy_w2c: matrices.qvec[2],
                qz_w2c: matrices.qvec[3],
                tx_w2c: matrices.tvec[0],
                ty_w2c: matrices.tvec[1],
                tz_w2c: matrices.tvec[2]
            };
            cameraMatrix = Array.from(worldTransform.data);
            cachedReferenceRevision = referenceRevision;
        }

        return { index, image_name: imageName, ...poseValues };
    };
};

const saveCurrentTrajectoryExport = async (
    events: Events,
    format: CurrentTrajectoryExportFormat,
    scene?: Scene
) => {
    if (format !== 'json' && format !== 'csv') throw new Error(`Unsupported trajectory format: ${format}`);
    const data = buildCurrentTrajectoryExport(events, scene);
    const date = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `colmap-w2c-trajectory-${data.pose_count}-poses-${date}.${format}`;
    const writer = new BrowserFileSystem(filename).createWriter(filename);
    const text = format === 'json' ? `${JSON.stringify(data, null, 2)}\n` : currentTrajectoryToCsv(data);
    await writer.write(new TextEncoder().encode(text));
    await writer.close();
    return data;
};

const writeTextFile = async (zip: ZipFileSystem, filename: string, text: string) => {
    const writer = await zip.createWriter(filename);
    await writer.write(new TextEncoder().encode(text));
    await writer.close();
};

const saveWanTrajectoryExport = async (
    events: Events,
    settings: WanTrajectoryExportSettings,
    scene?: Scene
) => {
    type Validation = {
        valid: boolean,
        stale?: boolean,
        collisionCameraIndices: number[],
        collisionSegmentIndices: number[],
        unsupportedCameraIndices: number[],
        minimumClearance: number
    };
    const recordedState = events.invoke('recordedView.state') as { keyframeCount: number } | undefined;
    const recordedActive = (recordedState?.keyframeCount ?? 0) > 0;
    let validation = events.invoke('trajectory.validation') as Validation | undefined;
    if (!recordedActive && validation?.stale) {
        events.invoke('trajectory.generate');
        validation = events.invoke('trajectory.validation') as Validation | undefined;
    }
    if (validation && !validation.valid) {
        if (recordedActive) validation = undefined;
    }
    if (validation && !validation.valid) {
        if (validation.stale) throw new Error('Trajectory changed and automatic regeneration failed');
        if (validation.unsupportedCameraIndices.length > 0) {
            throw new Error(
                `Trajectory support blocked export: ${validation.unsupportedCameraIndices.length} cameras are outside ` +
                'the reference-camera region and may produce blurred Gaussian images'
            );
        }
        throw new Error(
            `Boundary protection blocked export: ${validation.collisionCameraIndices.length} cameras and ` +
            `${validation.collisionSegmentIndices.length} path segments are too close to Gaussian points`
        );
    }
    const data = buildWanTrajectoryExport(events, settings, scene);
    const date = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `wan-camera-trajectory-${data.camera_count}-cameras-${date}.zip`;
    const output = new BrowserFileSystem(filename).createWriter(filename);
    const zip = new ZipFileSystem(output);
    const cameraLines = [
        '# Camera list with one line of data per camera:',
        '# CAMERA_ID, MODEL, WIDTH, HEIGHT, PARAMS[]',
        `# Number of cameras: ${data.camera_count}`,
        ...data.cameras.map(camera => (
            `${camera.index + 1} PINHOLE ${camera.intrinsics.width} ${camera.intrinsics.height} ` +
            `${camera.intrinsics.fx} ${camera.intrinsics.fy} ` +
            `${camera.intrinsics.cx} ${camera.intrinsics.cy}`
        )),
        ''
    ].join('\n');
    const imageLines = [
        '# Image list with two lines of data per image:',
        '# IMAGE_ID, QW, QX, QY, QZ, TX, TY, TZ, CAMERA_ID, NAME',
        `# Number of images: ${data.camera_count}, mean observations per image: 0`,
        ...data.cameras.flatMap(camera => [
            `${camera.index + 1} ${camera.qvec_w2c_wxyz.join(' ')} ${camera.tvec_w2c.join(' ')} ` +
            `${camera.index + 1} ${camera.image_name}`,
            ''
        ])
    ].join('\n');
    const manifest = {
        schema: 'supersplat.wan.camera-trajectory-export.v1',
        status: 'validated',
        camera_count: data.camera_count,
        minimum_camera_count: 1,
        validation: {
            numeric_values_finite: true,
            camera_targets_non_degenerate: true,
            transforms_mutually_inverse: true,
            colmap_quaternions_normalized: true
        },
        files: {
            trajectory: 'trajectory.json',
            cameras: 'sparse/0/cameras.txt',
            images: 'sparse/0/images.txt',
            points3D: 'sparse/0/points3D.txt'
        }
    };
    try {
        await writeTextFile(zip, 'trajectory.json', `${JSON.stringify(data, null, 2)}\n`);
        await writeTextFile(zip, 'manifest.json', `${JSON.stringify(manifest, null, 2)}\n`);
        await writeTextFile(zip, 'sparse/0/cameras.txt', cameraLines);
        await writeTextFile(zip, 'sparse/0/images.txt', imageLines);
        await writeTextFile(
            zip,
            'sparse/0/points3D.txt',
            '# 3D point list with one line of data per point:\n' +
            '# POINT3D_ID, X, Y, Z, R, G, B, ERROR, TRACK[] as (IMAGE_ID, POINT2D_IDX)\n' +
            '# Number of points: 0, mean track length: 0\n'
        );
        await zip.close();
    } catch (error) {
        await output.abort();
        throw error;
    }
    return data;
};

const buildCameraExport = (scene: Scene, events: Events) => {
    const editorCamera = scene.camera;
    const camera = editorCamera.camera;
    const width = editorCamera.targetSize.width;
    const height = editorCamera.targetSize.height;

    if (width <= 0 || height <= 0) {
        throw new Error('Cannot export camera parameters before the first frame is rendered');
    }

    const projectionData = camera.projectionMatrix.data;
    const worldTransform = editorCamera.worldTransform;
    const cameraToWorld = toRows(worldTransform.data);
    const worldToCamera = toRows(worldTransform.clone().invert().data);
    const position = editorCamera.position;
    const rotation = editorCamera.mainCamera.getRotation();
    const forward = editorCamera.forward;
    const target = editorCamera.focalPoint;
    const isPerspective = camera.projection === PROJECTION_PERSPECTIVE;

    let intrinsics = null;
    if (isPerspective) {
        const fx = finite(Math.abs(projectionData[0]) * width * 0.5, 'fx');
        const fy = finite(Math.abs(projectionData[5]) * height * 0.5, 'fy');
        const cx = finite((1 - projectionData[8]) * width * 0.5, 'cx');
        const cy = finite((1 + projectionData[9]) * height * 0.5, 'cy');

        intrinsics = {
            model: 'PINHOLE',
            fx,
            fy,
            cx,
            cy,
            skew: 0,
            distortion: null as null,
            K: [
                [fx, 0, cx],
                [0, fy, cy],
                [0, 0, 1]
            ]
        };
    }

    const radiansToDegrees = 180 / Math.PI;
    const fovX = isPerspective ? 2 * Math.atan(1 / Math.abs(projectionData[0])) * radiansToDegrees : null;
    const fovY = isPerspective ? 2 * Math.atan(1 / Math.abs(projectionData[5])) * radiansToDegrees : null;

    return {
        schema: 'supersplat.camera.v1',
        exported_at: new Date().toISOString(),
        source: {
            document: events.invoke('doc.name') ?? null,
            renderer: 'SuperSplat',
            renderer_version: '2.32.7',
            frame: scene.app.frame
        },
        image: {
            width,
            height,
            canvas_width: scene.canvas.width,
            canvas_height: scene.canvas.height
        },
        projection: {
            type: isPerspective ? 'perspective' : 'orthographic',
            configured_fov_degrees: editorCamera.fov,
            configured_fov_axis: camera.horizontalFov ? 'horizontal' : 'vertical',
            fov_x_degrees: fovX,
            fov_y_degrees: fovY,
            aspect_ratio: camera.aspectRatio,
            near: editorCamera.near,
            far: editorCamera.far,
            orthographic_half_height: isPerspective ? null : camera.orthoHeight,
            projection_matrix_webgl: toRows(projectionData)
        },
        intrinsics,
        pose: {
            position: [position.x, position.y, position.z],
            rotation_xyzw: [rotation.x, rotation.y, rotation.z, rotation.w],
            forward: [forward.x, forward.y, forward.z],
            orbit_target: [target.x, target.y, target.z],
            camera_to_world_playcanvas: cameraToWorld,
            world_to_camera_playcanvas: worldToCamera,
            camera_to_world_opencv: cameraToWorldOpenCv(cameraToWorld),
            world_to_camera_opencv: worldToCameraOpenCv(worldToCamera)
        },
        conventions: {
            matrix_storage: 'row-major JSON rows; matrices multiply column vectors',
            world: 'PlayCanvas right-handed world: +X right, +Y up, -Z camera forward at identity',
            playcanvas_camera: '+X right, +Y up, -Z forward',
            opencv_camera: '+X right, +Y down, +Z forward',
            units: 'scene units'
        }
    };
};

type CameraExportData = ReturnType<typeof buildCameraExport>;

const selectCameraExport = (data: CameraExportData, selection: CameraExportSelection) => {
    const result: Record<string, unknown> = {
        schema: data.schema,
        exported_at: data.exported_at
    };

    if (selection.metadataConventions) {
        result.source = data.source;
        result.conventions = data.conventions;
    }
    if (selection.imageProjection) {
        result.image = data.image;
        result.projection = data.projection;
    }
    if (selection.intrinsics) {
        result.intrinsics = data.intrinsics;
    }
    if (selection.pose) {
        result.pose = {
            position: data.pose.position,
            rotation_xyzw: data.pose.rotation_xyzw,
            forward: data.pose.forward,
            orbit_target: data.pose.orbit_target
        };
    }
    if (selection.playcanvasMatrices || selection.opencvMatrices) {
        const extrinsics: Record<string, MatrixRows> = {};
        if (selection.playcanvasMatrices) {
            extrinsics.camera_to_world_playcanvas = data.pose.camera_to_world_playcanvas;
            extrinsics.world_to_camera_playcanvas = data.pose.world_to_camera_playcanvas;
        }
        if (selection.opencvMatrices) {
            extrinsics.camera_to_world_opencv = data.pose.camera_to_world_opencv;
            extrinsics.world_to_camera_opencv = data.pose.world_to_camera_opencv;
        }
        result.extrinsics = extrinsics;
    }

    return result;
};

const registerCameraExportEvents = (scene: Scene, events: Events) => {
    const buildCurrentFrame = createCurrentFrameColmapW2cBuilder(scene);

    events.function('camera.getParameters', () => buildCameraExport(scene, events));

    events.function('camera.saveParameters', async (selection: CameraExportSelection) => {
        const started = performance.now();
        const data = buildCameraExport(scene, events);
        const json = JSON.stringify({
            ...selectCameraExport(data, selection),
            export_generation_ms: performance.now() - started
        }, null, 2);

        const date = new Date().toISOString().replace(/[:.]/g, '-');
        const filename = `camera-selection-${date}.json`;
        const writer = new BrowserFileSystem(filename).createWriter(filename);
        await writer.write(new TextEncoder().encode(`${json}\n`));
        await writer.close();
    });

    events.function('camera.buildWanTrajectory', (settings: WanTrajectoryExportSettings) => (
        buildWanTrajectoryExport(events, settings, scene)
    ));
    events.function('camera.buildCurrentTrajectory', () => buildCurrentTrajectoryExport(events, scene));
    events.function('camera.buildCurrentTrajectoryCsv', () => (
        currentTrajectoryToCsv(buildCurrentTrajectoryExport(events, scene))
    ));
    events.function('camera.buildCurrentFrameColmapW2c', (index: number, imageName: string) => (
        buildCurrentFrame(index, imageName)
    ));
    events.function('camera.colmapW2cRowsToCsv', (poses: ColmapW2cPoseRow[]) => (
        colmapW2cRowsToCsv(poses)
    ));
    events.function('camera.saveCurrentTrajectory', (format: CurrentTrajectoryExportFormat) => (
        saveCurrentTrajectoryExport(events, format, scene)
    ));
    events.function('camera.roundTripColmapPoses', (poses: Pose[]) => roundTripColmapPoses(poses, scene));
    events.function('camera.saveWanTrajectory', (settings: WanTrajectoryExportSettings) => (
        saveWanTrajectoryExport(events, settings, scene)
    ));
};

export {
    buildCameraExport,
    buildCurrentFrameColmapW2c,
    buildCurrentTrajectoryExport,
    buildWanTrajectoryExport,
    colmapW2cRowsToCsv,
    currentTrajectoryToCsv,
    createCurrentFrameColmapW2cBuilder,
    registerCameraExportEvents,
    roundTripColmapPoses,
    selectCameraExport,
    validateWanSettings
};
export type {
    CameraExportData,
    CameraExportSelection,
    ColmapW2cPoseRow,
    ColmapRoundTripResult,
    CurrentTrajectoryExportData,
    CurrentTrajectoryExportFormat,
    WanTrajectoryExportData,
    WanTrajectoryExportSettings
};
