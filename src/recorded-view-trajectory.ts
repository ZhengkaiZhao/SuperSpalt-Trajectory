import { Mat4, Quat, Vec3 } from 'playcanvas';

import { Pose } from './camera-poses';
import { Events } from './events';

type RecordedViewValidation = {
    valid: boolean,
    maxPositionError: number,
    maxRotationErrorDegrees: number,
    maxFovErrorDegrees: number
};

type RecordedTrajectorySummary = {
    id: string,
    label: string,
    keyframeCount: number,
    targetCount: number,
    finished: boolean
};

type RecordedViewState = {
    trajectoryCount: number,
    activeTrajectoryIndex: number,
    activeTrajectoryId: string,
    activeTrajectoryLabel: string,
    trajectories: RecordedTrajectorySummary[],
    keyframeCount: number,
    targetCount: number,
    selectedIndex: number,
    finished: boolean,
    showTarget: boolean,
    showValidation: boolean,
    validation: RecordedViewValidation | null
};

type RecordedViewTrajectory = {
    id: string,
    label: string,
    keyframes: Pose[],
    targetPoses: Pose[],
    validationPoses: Pose[],
    targetCount: number,
    selectedIndex: number,
    finished: boolean,
    showTarget: boolean,
    showValidation: boolean,
    validation: RecordedViewValidation | null
};

type CurrentCameraPose = {
    position: { x: number, y: number, z: number },
    target: { x: number, y: number, z: number },
    fov?: number
};

const clonePose = (pose: Pose): Pose => ({
    ...pose,
    position: pose.position.clone(),
    target: pose.target.clone()
});

const poseRotation = (pose: Pose) => {
    const forward = pose.target.clone().sub(pose.position).normalize();
    const up = Math.abs(forward.dot(Vec3.UP)) > 0.999 ? Vec3.BACK : Vec3.UP;
    return new Quat().setFromMat4(new Mat4().setLookAt(pose.position, pose.target, up)).normalize();
};

const catmullRom = (previous: Vec3, start: Vec3, end: Vec3, following: Vec3, amount: number) => {
    const amount2 = amount * amount;
    const amount3 = amount2 * amount;
    return start.clone().mulScalar(2)
    .add(previous.clone().mulScalar(-1).add(end).mulScalar(amount))
    .add(previous.clone().mulScalar(2).add(start.clone().mulScalar(-5))
    .add(end.clone().mulScalar(4)).sub(following).mulScalar(amount2))
    .add(previous.clone().mulScalar(-1).add(start.clone().mulScalar(3))
    .add(end.clone().mulScalar(-3)).add(following).mulScalar(amount3))
    .mulScalar(0.5);
};

const catmullRomCentripetalAt = (
    previous: Vec3, start: Vec3, end: Vec3, following: Vec3,
    knots: [number, number, number], amount: number
): Vec3 => {
    const [t1, t2, t3] = knots;
    if (t1 <= 0 || t2 <= t1 || t3 <= t2) {
        return catmullRom(previous, start, end, following, amount);
    }
    const t = t1 + amount * (t2 - t1);
    const a1 = previous.clone().mulScalar((t1 - t) / t1).add(start.clone().mulScalar(t / t1));
    const a2 = start.clone().mulScalar((t2 - t) / (t2 - t1)).add(end.clone().mulScalar((t - t1) / (t2 - t1)));
    const a3 = end.clone().mulScalar((t3 - t) / (t3 - t2)).add(following.clone().mulScalar((t - t2) / (t3 - t2)));
    const b1 = a1.clone().mulScalar((t2 - t) / t2).add(a2.clone().mulScalar(t / t2));
    const b2 = a2.clone().mulScalar((t3 - t) / (t3 - t1)).add(a3.clone().mulScalar((t - t1) / (t3 - t1)));
    return b1.clone().mulScalar((t2 - t) / (t2 - t1)).add(b2.clone().mulScalar((t - t1) / (t2 - t1)));
};

const allocateFrameCounts = (weights: number[], total: number): number[] => {
    if (total <= 0 || weights.length === 0) return weights.map(() => 0);
    const sum = weights.reduce((a, b) => a + b, 0);
    if (sum <= 0) return weights.map(() => 0);
    const scaled = weights.map(weight => weight * total / sum);
    const counts = scaled.map(Math.floor);
    let remainder = total - counts.reduce((a, b) => a + b, 0);
    const order = scaled.map((value, index) => ({
        index,
        fraction: value - Math.floor(value)
    })).sort((a, b) => b.fraction - a.fraction);
    for (const entry of order) {
        if (remainder <= 0) break;
        counts[entry.index]++;
        remainder--;
    }
    return counts;
};

// Arc-length, keyframe-preserving interpolation. The generated cameras are
// spaced uniformly by arc length (constant speed) and the path passes exactly
// through every manually marked keyframe, so the numbered markers stay on the
// trajectory line instead of drifting off it.
const interpolateRecordedViews = (keyframes: Pose[], frameCount: number): Pose[] => {
    if (keyframes.length < 2) throw new Error('至少需要 2 个人工关键视角');
    if (frameCount < keyframes.length) throw new Error('最终相机数量不能少于人工关键点数量');
    if (!Number.isSafeInteger(frameCount)) throw new Error('最终相机数量必须是有效的正整数');

    const positions = keyframes.map(pose => pose.position.clone());
    const rotations = keyframes.map(poseRotation);
    const distances = keyframes.map(pose => Math.max(pose.position.distance(pose.target), 1e-6));
    const segmentCount = keyframes.length - 1;
    const samples = 256;

    // Dense-sample every segment (centripetal Catmull-Rom) and record arc length.
    const segmentPoints: Vec3[][] = [];
    const segmentAmounts: number[][] = [];
    const segmentCumulative: number[][] = [];
    const segmentLengths: number[] = [];
    for (let segment = 0; segment < segmentCount; segment++) {
        const start = positions[segment];
        const end = positions[segment + 1];
        const previous = segment > 0 ? positions[segment - 1] : start.clone().mulScalar(2).sub(end);
        const following = segment + 2 < positions.length ? positions[segment + 2] :
            end.clone().mulScalar(2).sub(start);
        const chord = (a: Vec3, b: Vec3) => Math.sqrt(a.clone().sub(b).lengthSq());
        const knots: [number, number, number] = [
            chord(start, previous),
            chord(start, previous) + chord(end, start),
            chord(start, previous) + chord(end, start) + chord(following, end)
        ];
        const points: Vec3[] = [];
        const amounts: number[] = [];
        const cumulative = [0];
        let previousPoint: Vec3 | null = null;
        for (let step = 0; step < samples; step++) {
            const amount = step / samples;
            const point = catmullRomCentripetalAt(previous, start, end, following, knots, amount);
            points.push(point);
            amounts.push(amount);
            if (previousPoint) cumulative.push(cumulative[cumulative.length - 1] + previousPoint.distance(point));
            previousPoint = point;
        }
        segmentPoints.push(points);
        segmentAmounts.push(amounts);
        segmentCumulative.push(cumulative);
        segmentLengths.push(cumulative[cumulative.length - 1]);
    }

    // Allocate interior frames across segments proportionally to arc length.
    const counts = allocateFrameCounts(segmentLengths, frameCount - keyframes.length);

    const result: Pose[] = [];
    const pushPose = (position: Vec3, segment: number, amount: number): Pose => {
        const rotation = new Quat().slerp(rotations[segment], rotations[segment + 1], amount).normalize();
        const direction = rotation.transformVector(Vec3.FORWARD.clone()).normalize();
        const distance = distances[segment] + (distances[segment + 1] - distances[segment]) * amount;
        const startFov = keyframes[segment].fov ?? 60;
        const endFov = keyframes[segment + 1].fov ?? startFov;
        const index = result.length;
        return {
            name: `recorded_camera_${String(index + 1).padStart(3, '0')}`,
            frame: index,
            position,
            target: position.clone().add(direction.mulScalar(distance)),
            fov: startFov + (endFov - startFov) * amount
        };
    };

    result.push(pushPose(positions[0].clone(), 0, 0));
    for (let segment = 0; segment < segmentCount; segment++) {
        const total = segmentLengths[segment];
        const cumulative = segmentCumulative[segment];
        const points = segmentPoints[segment];
        const amounts = segmentAmounts[segment];
        for (let step = 1; step <= counts[segment]; step++) {
            const distance = total * (step / (counts[segment] + 1));
            let index = 0;
            while (index < cumulative.length - 2 && cumulative[index + 1] < distance) index++;
            const span = Math.max(cumulative[index + 1] - cumulative[index], 1e-15);
            const local = Math.min(Math.max((distance - cumulative[index]) / span, 0), 1);
            const point = points[index].clone().lerp(points[index], points[index + 1], local);
            const amount = amounts[index] + (amounts[index + 1] - amounts[index]) * local;
            result.push(pushPose(point, segment, amount));
        }
        result.push(pushPose(positions[segment + 1].clone(), segment, 1));
    }
    return result;
};

const registerRecordedViewTrajectoryEvents = (events: Events) => {
    let nextTrajectoryNumber = 0;
    let nextTrajectoryId = 1;
    let activeTrajectoryIndex = 0;
    let lastCaptureTime = Number.NEGATIVE_INFINITY;

    const alphabeticLabel = (index: number) => {
        let value = index + 1;
        let label = '';
        while (value > 0) {
            value--;
            label = String.fromCharCode(65 + value % 26) + label;
            value = Math.floor(value / 26);
        }
        return label;
    };
    const createTrajectory = (label = alphabeticLabel(nextTrajectoryNumber++), id?: string): RecordedViewTrajectory => ({
        id: id ?? `manual-trajectory-${nextTrajectoryId++}`,
        label,
        keyframes: [],
        targetPoses: [],
        validationPoses: [],
        targetCount: 81,
        selectedIndex: -1,
        finished: false,
        showTarget: true,
        showValidation: true,
        validation: null
    });
    let trajectories: RecordedViewTrajectory[] = [createTrajectory()];
    const active = () => trajectories[activeTrajectoryIndex];
    const state = (): RecordedViewState => {
        const trajectory = active();
        return {
            trajectoryCount: trajectories.length,
            activeTrajectoryIndex,
            activeTrajectoryId: trajectory.id,
            activeTrajectoryLabel: trajectory.label,
            trajectories: trajectories.map(item => ({
                id: item.id,
                label: item.label,
                keyframeCount: item.keyframes.length,
                targetCount: item.targetCount,
                finished: item.finished
            })),
            keyframeCount: trajectory.keyframes.length,
            targetCount: trajectory.targetCount,
            selectedIndex: trajectory.selectedIndex,
            finished: trajectory.finished,
            showTarget: trajectory.showTarget,
            showValidation: trajectory.showValidation,
            validation: trajectory.validation ? { ...trajectory.validation } : null
        };
    };
    const changed = () => events.fire('recordedView.changed', state());
    const pointName = (trajectory: RecordedViewTrajectory, index: number) => (
        `recorded_${trajectory.label}_key_${String(index + 1).padStart(3, '0')}`
    );
    const renumber = (trajectory: RecordedViewTrajectory) => {
        trajectory.keyframes = trajectory.keyframes.map((pose, index) => ({
            ...pose,
            name: pointName(trajectory, index),
            frame: index
        }));
    };
    const pointFocused = (action: 'recorded' | 'selected' | 'updated') => {
        const trajectory = active();
        const pose = trajectory.keyframes[trajectory.selectedIndex];
        if (!pose) return;
        events.fire('recordedView.pointFocused', {
            action,
            trajectoryLabel: trajectory.label,
            index: trajectory.selectedIndex,
            total: trajectory.keyframes.length,
            position: [pose.position.x, pose.position.y, pose.position.z]
        });
    };
    const clearGenerated = (trajectory: RecordedViewTrajectory) => {
        trajectory.targetPoses = [];
        trajectory.validationPoses = [];
        trajectory.validation = null;
        trajectory.finished = false;
        events.fire('timeline.setPlaying', false);
    };
    const poseFromCurrent = (pose: CurrentCameraPose, trajectory: RecordedViewTrajectory, index: number): Pose => ({
        name: pointName(trajectory, index),
        frame: index,
        position: new Vec3(pose.position.x, pose.position.y, pose.position.z),
        target: new Vec3(pose.target.x, pose.target.y, pose.target.z),
        fov: pose.fov ?? events.invoke('camera.fov') ?? 60
    });
    const capturePose = () => {
        const trajectory = active();
        const pose = events.invoke('camera.getPose') as CurrentCameraPose | null;
        if (!pose || trajectory.finished) return null;
        const now = performance.now();
        if (now - lastCaptureTime < 200) return null;
        const nextPose = poseFromCurrent(pose, trajectory, trajectory.keyframes.length);
        const previous = trajectory.keyframes[trajectory.keyframes.length - 1];
        if (previous) {
            const direction = nextPose.target.clone().sub(nextPose.position).normalize();
            const previousDirection = previous.target.clone().sub(previous.position).normalize();
            if (nextPose.position.distance(previous.position) < 1e-8 &&
                direction.dot(previousDirection) > 1 - 1e-10 &&
                Math.abs((nextPose.fov ?? 60) - (previous.fov ?? 60)) < 1e-8) return null;
        }
        clearGenerated(trajectory);
        trajectory.keyframes.push(nextPose);
        lastCaptureTime = now;
        trajectory.selectedIndex = trajectory.keyframes.length - 1;
        events.fire('camera.setShowPoses', true);
        changed();
        pointFocused('recorded');
        return trajectory.selectedIndex;
    };
    const select = (index: number) => {
        const trajectory = active();
        if (trajectory.keyframes.length === 0) return false;
        trajectory.selectedIndex = Math.max(0, Math.min(trajectory.keyframes.length - 1, Math.trunc(index)));
        events.fire('camera.setPose', clonePose(trajectory.keyframes[trajectory.selectedIndex]), 0);
        changed();
        pointFocused('selected');
        return true;
    };
    const roundTrip = (trajectory: RecordedViewTrajectory) => {
        const result = events.invoke('camera.roundTripColmapPoses', trajectory.targetPoses) as {
            poses: Pose[], valid: boolean, maxPositionError: number,
            maxRotationErrorDegrees: number, maxFovErrorDegrees: number
        };
        trajectory.validationPoses = result.poses.map(clonePose);
        trajectory.validation = {
            valid: result.valid,
            maxPositionError: result.maxPositionError,
            maxRotationErrorDegrees: result.maxRotationErrorDegrees,
            maxFovErrorDegrees: result.maxFovErrorDegrees
        };
    };
    const restoreTrajectory = (data: any): RecordedViewTrajectory => {
        const trajectory = createTrajectory(data.label, data.id);
        trajectory.keyframes = (data.poses ?? []).map((pose: any, index: number) => ({
            name: pointName(trajectory, index),
            frame: index,
            position: new Vec3(pose.position),
            target: new Vec3(pose.target),
            fov: pose.fov ?? events.invoke('camera.fov') ?? 60
        }));
        const restoredTargetCount = Number.isFinite(data.targetCount) ? Math.trunc(data.targetCount) : 81;
        trajectory.targetCount = Math.max(trajectory.keyframes.length, 2, restoredTargetCount);
        trajectory.selectedIndex = trajectory.keyframes.length - 1;
        trajectory.showTarget = data.showTarget !== false;
        trajectory.showValidation = data.showValidation !== false;
        if (data.finished && trajectory.keyframes.length >= 2) {
            trajectory.targetPoses = interpolateRecordedViews(trajectory.keyframes, trajectory.targetCount);
            trajectory.finished = true;
            roundTrip(trajectory);
        }
        return trajectory;
    };

    events.function('recordedView.state', state);
    events.function('recordedView.keyframes', () => active().keyframes.map(clonePose));
    events.function('recordedView.targetPoses', () => active().targetPoses.map(clonePose));
    events.function('recordedView.validationPoses', () => active().validationPoses.map(clonePose));
    events.function('recordedView.trajectories', () => trajectories.map(trajectory => ({
        id: trajectory.id,
        label: trajectory.label,
        targetCount: trajectory.targetCount,
        finished: trajectory.finished,
        showTarget: trajectory.showTarget,
        showValidation: trajectory.showValidation,
        poses: trajectory.keyframes.map(clonePose)
    })));
    // Rendering uses stable pose references; editing replaces arrays rather than mutating pose vectors.
    events.function('recordedView.renderData', () => ({
        trajectories: trajectories.map((trajectory, index) => ({
            id: trajectory.id,
            label: trajectory.label,
            active: index === activeTrajectoryIndex,
            keyframes: trajectory.keyframes,
            targetPoses: trajectory.targetPoses,
            validationPoses: trajectory.validationPoses,
            state: {
                keyframeCount: trajectory.keyframes.length,
                finished: trajectory.finished,
                showTarget: trajectory.showTarget,
                showValidation: trajectory.showValidation
            }
        })),
        keyframes: active().keyframes,
        targetPoses: active().targetPoses,
        validationPoses: active().validationPoses,
        state: state()
    }));
    events.function('recordedView.restoreAll', (data: any[]) => {
        nextTrajectoryNumber = 0;
        nextTrajectoryId = 1;
        trajectories = (data ?? []).map(restoreTrajectory);
        if (trajectories.length === 0) trajectories = [createTrajectory()];
        const labelNumber = (label: string) => Array.from(label.toUpperCase()).reduce(
            (value, character) => value * 26 + character.charCodeAt(0) - 64,
            0
        );
        nextTrajectoryNumber = Math.max(...trajectories.map(item => labelNumber(item.label)), 0);
        nextTrajectoryId = Math.max(...trajectories.map((item) => {
            const match = /^manual-trajectory-(\d+)$/.exec(item.id);
            return match ? Number(match[1]) + 1 : 1;
        }), 1);
        activeTrajectoryIndex = 0;
        lastCaptureTime = Number.NEGATIVE_INFINITY;
        changed();
        return state();
    });
    events.function('recordedView.restore', (data: any) => events.invoke('recordedView.restoreAll', [data]));
    events.function('recordedView.newTrajectory', () => {
        events.fire('timeline.setPlaying', false);
        trajectories.push(createTrajectory());
        activeTrajectoryIndex = trajectories.length - 1;
        lastCaptureTime = Number.NEGATIVE_INFINITY;
        changed();
        return state();
    });
    events.function('recordedView.selectTrajectory', (idOrIndex: string | number) => {
        const index = typeof idOrIndex === 'number' ? Math.trunc(idOrIndex) :
            trajectories.findIndex(trajectory => trajectory.id === idOrIndex);
        if (index < 0 || index >= trajectories.length) return false;
        events.fire('timeline.setPlaying', false);
        activeTrajectoryIndex = index;
        lastCaptureTime = Number.NEGATIVE_INFINITY;
        changed();
        return true;
    });
    events.function('recordedView.deleteTrajectory', () => {
        events.fire('timeline.setPlaying', false);
        if (trajectories.length === 1) {
            const replacement = createTrajectory(active().label, active().id);
            trajectories[0] = replacement;
        } else {
            trajectories.splice(activeTrajectoryIndex, 1);
            activeTrajectoryIndex = Math.min(activeTrajectoryIndex, trajectories.length - 1);
        }
        events.fire('track.replacePoses', [], 'deleteRecordedViewTrajectory');
        changed();
        return state();
    });
    events.function('recordedView.captureCurrent', capturePose);
    events.function('recordedView.setInitialPose', (pose: {
        position: [number, number, number], target: [number, number, number], fov?: number
    }) => {
        const trajectory = active();
        if (trajectory.finished) return false;
        const imported = poseFromCurrent({
            position: { x: pose.position[0], y: pose.position[1], z: pose.position[2] },
            target: { x: pose.target[0], y: pose.target[1], z: pose.target[2] },
            fov: pose.fov
        }, trajectory, 0);
        clearGenerated(trajectory);
        if (trajectory.keyframes.length === 0) trajectory.keyframes.push(imported);
        else trajectory.keyframes[0] = imported;
        renumber(trajectory);
        trajectory.selectedIndex = 0;
        events.fire('camera.setPose', clonePose(imported), 0);
        events.fire('camera.setShowPoses', true);
        changed();
        pointFocused(trajectory.keyframes.length === 1 ? 'recorded' : 'updated');
        return true;
    });
    events.function('recordedView.select', select);
    events.function('recordedView.overwriteSelected', () => {
        const trajectory = active();
        if (trajectory.selectedIndex < 0 || trajectory.selectedIndex >= trajectory.keyframes.length) return false;
        const pose = events.invoke('camera.getPose') as CurrentCameraPose | null;
        if (!pose) return false;
        clearGenerated(trajectory);
        trajectory.keyframes[trajectory.selectedIndex] = poseFromCurrent(pose, trajectory, trajectory.selectedIndex);
        changed();
        pointFocused('updated');
        return true;
    });
    events.function('recordedView.removeSelected', () => {
        const trajectory = active();
        if (trajectory.selectedIndex < 0 || trajectory.selectedIndex >= trajectory.keyframes.length) return false;
        clearGenerated(trajectory);
        trajectory.keyframes.splice(trajectory.selectedIndex, 1);
        renumber(trajectory);
        trajectory.selectedIndex = Math.min(trajectory.selectedIndex, trajectory.keyframes.length - 1);
        changed();
        return true;
    });
    events.function('recordedView.finish', () => {
        const trajectory = active();
        const observer = events.invoke('camera.getPose') as CurrentCameraPose | null;
        trajectory.targetPoses = interpolateRecordedViews(trajectory.keyframes, trajectory.targetCount);
        roundTrip(trajectory);
        trajectory.finished = true;
        events.fire('timeline.setPlaying', false);
        events.fire('track.replacePoses', trajectory.targetPoses.map(clonePose), 'generateRecordedViewTrajectory');
        events.fire('timeline.setFrames', trajectory.targetPoses.length);
        events.fire('timeline.setLoop', false);
        events.fire('timeline.setSmoothness', 0);
        if (observer) {
            events.fire('camera.setPose', {
                position: new Vec3(observer.position.x, observer.position.y, observer.position.z),
                target: new Vec3(observer.target.x, observer.target.y, observer.target.z),
                fov: observer.fov
            }, 0);
        }
        events.fire('camera.setShowPoses', true);
        changed();
        return state();
    });
    events.function('recordedView.preview', () => {
        const trajectory = active();
        if (!trajectory.finished || trajectory.targetPoses.length < 2) return false;
        events.fire('track.replacePoses', trajectory.targetPoses.map(clonePose), 'previewRecordedViewTrajectory');
        events.fire('timeline.setFrames', trajectory.targetPoses.length);
        events.fire('timeline.setPlaying', false);
        events.fire('timeline.setFrame', 0);
        events.fire('camera.setPose', clonePose(trajectory.targetPoses[0]), 0);
        events.fire('timeline.setPlaying', true);
        return true;
    });
    events.function('recordedView.stopPreview', () => {
        events.fire('timeline.setPlaying', false);
        return true;
    });
    events.function('recordedView.continue', () => {
        clearGenerated(active());
        events.fire('track.replacePoses', [], 'continueRecordedViewCapture');
        changed();
        return true;
    });
    events.function('recordedView.clear', () => {
        const trajectory = active();
        trajectory.keyframes = [];
        trajectory.selectedIndex = -1;
        lastCaptureTime = Number.NEGATIVE_INFINITY;
        clearGenerated(trajectory);
        events.fire('track.replacePoses', [], 'clearRecordedViewTrajectory');
        changed();
        return true;
    });
    events.function('recordedView.setTargetCount', (value: number) => {
        const trajectory = active();
        if (trajectory.finished || !Number.isFinite(value)) return false;
        const next = Math.max(2, Math.trunc(value));
        if (next < trajectory.keyframes.length) return false;
        trajectory.targetCount = next;
        changed();
        return true;
    });
    events.function('recordedView.setShowTarget', (value: boolean) => {
        active().showTarget = !!value;
        changed();
    });
    events.function('recordedView.setShowValidation', (value: boolean) => {
        active().showValidation = !!value;
        changed();
    });

    events.on('recordedView.capture', capturePose);
    events.on('scene.clear', () => {
        nextTrajectoryNumber = 0;
        trajectories = [createTrajectory()];
        activeTrajectoryIndex = 0;
        lastCaptureTime = Number.NEGATIVE_INFINITY;
        changed();
    });
};

export { interpolateRecordedViews, registerRecordedViewTrajectoryEvents };
export type { RecordedViewState, RecordedTrajectorySummary };
