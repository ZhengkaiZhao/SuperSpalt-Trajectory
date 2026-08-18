import { Quat, Vec3 } from 'playcanvas';

import { ElementType } from './element';
import { Events } from './events';
import { Scene } from './scene';
import { Splat } from './splat';
import { State } from './splat-state';

type TrajectoryShape = 'arc' | 'rounded-rectangle' | 'spiral' | 's-curve' | 'line';
type OrientationMode = 'density' | 'fixed' | 'tangent';

type TrajectoryOrigin = {
    position: [number, number, number],
    rotation: [number, number, number]
};

type TrajectorySegment = {
    id: number,
    shape: TrajectoryShape,
    origin: TrajectoryOrigin,
    radius: [number, number],
    start: number,
    end: number,
    reverse: boolean,
    cornerRadius: number,
    turns: number
};

type TrajectoryPlan = {
    cameraCount: number,
    fovDegrees: number,
    orientation: OrientationMode,
    fixedDirection: [number, number, number],
    maxAngleDegrees: number,
    clearance: number,
    connectorTension: number,
    width: number,
    height: number,
    segments: TrajectorySegment[]
};

type TrajectoryPose = {
    name: string,
    frame: number,
    position: Vec3,
    target: Vec3,
    fov: number
};

type TrajectoryPlanResult = {
    poses: TrajectoryPose[],
    segmentIds: number[],
    focus: [number, number, number],
    minimumClearance: number,
    collisionCameraIndices: number[],
    collisionSegmentIndices: number[],
    unsupportedCameraIndices: number[]
};

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

const finite = (value: number, fallback: number) => (Number.isFinite(value) ? value : fallback);

const normalizePlan = (plan: TrajectoryPlan): TrajectoryPlan => {
    const legacyOrigin = (plan as TrajectoryPlan & { origin?: TrajectoryOrigin }).origin;
    return ({
        cameraCount: Math.round(clamp(finite(plan.cameraCount ?? (plan as any).frameCount, 81), 1, 81)),
        fovDegrees: clamp(finite(plan.fovDegrees, 60), 1, 179),
        orientation: ['density', 'fixed', 'tangent'].includes(plan.orientation) ? plan.orientation : 'density',
        fixedDirection: (plan.fixedDirection ?? [0, 0, -1])
        .map(value => finite(value, 0)) as [number, number, number],
        maxAngleDegrees: clamp(finite(plan.maxAngleDegrees, 12), 1, 90),
        clearance: Math.max(0, finite(plan.clearance, 0)),
        connectorTension: clamp(finite(plan.connectorTension, 0.45), 0, 1.5),
        width: Math.round(clamp(finite(plan.width, 1280), 1, 16384)),
        height: Math.round(clamp(finite(plan.height, 720), 1, 16384)),
        segments: (plan.segments ?? []).map((segment, index) => {
            const legacySegment = segment as TrajectorySegment & {
            center?: [number, number, number],
            rotation?: [number, number, number]
        };
            const sourceOrigin = segment.origin ?? legacyOrigin ?? { position: [0, 0, 0], rotation: [0, 0, 0] };
            const originPosition = sourceOrigin.position.map(value => finite(value, 0)) as [number, number, number];
            const originEuler = sourceOrigin.rotation.map(value => finite(value, 0)) as [number, number, number];
            // Migrate the former two-stage transform into one plane pose:
            // Qorigin * (Qlocal * point + center) + position.
            const originRotation = new Quat().setFromEulerAngles(...originEuler);
            const localEuler = (legacySegment.rotation ?? [0, 0, 0])
            .map(value => finite(value, 0)) as [number, number, number];
            const combinedRotation = new Quat().mul2(
                originRotation,
                new Quat().setFromEulerAngles(...localEuler)
            ).getEulerAngles();
            const combinedPosition = new Vec3(originPosition).add(
                originRotation.transformVector(new Vec3(legacySegment.center ?? [0, 0, 0]))
            );
            return {
                id: Number.isFinite(segment.id) ? Math.trunc(segment.id) : index + 1,
                shape: ['arc', 'rounded-rectangle', 'spiral', 's-curve', 'line'].includes(segment.shape) ?
                    segment.shape : 'arc',
                origin: {
                    position: [combinedPosition.x, combinedPosition.y, combinedPosition.z],
                    rotation: [combinedRotation.x, combinedRotation.y, combinedRotation.z]
                },
                radius: ((segment.radius ?? (segment as any).size ?? [1, 1]) as number[])
                .map((value: number) => Math.max(1e-4, finite(value, 1))) as [number, number],
                start: clamp(finite(segment.start, 0), 0, 1),
                end: clamp(finite(segment.end, 0.75), 0, 1),
                reverse: !!segment.reverse,
                cornerRadius: clamp(finite(segment.cornerRadius, 0.35), 0, 1),
                turns: clamp(finite(segment.turns, 1.5), 0.25, 8)
            };
        })
    });
};

const shapePoint = (segment: TrajectorySegment, amount: number) => {
    const radiusX = segment.radius[0];
    const radiusZ = segment.radius[1];
    let x = 0;
    let z = 0;

    if (segment.shape === 'arc' || segment.shape === 'rounded-rectangle') {
        let travel = segment.end - segment.start;
        if (Math.abs(travel) < 1e-5) travel = 1;
        if (segment.reverse) travel *= -1;
        const angle = (segment.start + travel * amount) * Math.PI * 2;
        if (segment.shape === 'arc') {
            x = Math.cos(angle) * radiusX;
            z = Math.sin(angle) * radiusZ;
        } else {
            // A superellipse gives a stable rounded rectangle with no corner
            // discontinuities. Higher powers produce sharper corners.
            const power = 2 + (1 - segment.cornerRadius) * 10;
            const exponent = 2 / power;
            const cosine = Math.cos(angle);
            const sine = Math.sin(angle);
            x = Math.sign(cosine) * Math.abs(cosine) ** exponent * radiusX;
            z = Math.sign(sine) * Math.abs(sine) ** exponent * radiusZ;
        }
    } else {
        const start = Math.min(segment.start, segment.end);
        const end = Math.max(segment.start, segment.end);
        const progress = (segment.reverse ? 1 - amount : amount) * (end - start) + start;
        if (segment.shape === 'spiral') {
            const angle = progress * segment.turns * Math.PI * 2;
            const radius = 0.1 + progress * 0.9;
            x = Math.cos(angle) * radiusX * radius;
            z = Math.sin(angle) * radiusZ * radius;
        } else if (segment.shape === 's-curve') {
            x = (progress - 0.5) * radiusX * 2;
            z = Math.sin((progress - 0.5) * Math.PI * 2) * radiusZ;
        } else {
            x = (progress - 0.5) * radiusX * 2;
        }
    }

    const local = new Vec3(x, 0, z);
    const originRotation = new Quat().setFromEulerAngles(
        segment.origin.rotation[0],
        segment.origin.rotation[1],
        segment.origin.rotation[2]
    );
    return originRotation.transformVector(local).add(new Vec3(segment.origin.position));
};

const buildSegment = (segment: TrajectorySegment, count = 192) => (
    Array.from({ length: count }, (_, index) => shapePoint(segment, index / (count - 1)))
);

const connector = (previous: Vec3[], following: Vec3[], count: number, tension: number) => {
    const p0 = previous[previous.length - 1];
    const p1 = following[0];
    const distance = p0.distance(p1);
    if (distance < 1e-8) return [p0.clone(), p1.clone()];
    const direct = p1.clone().sub(p0).normalize();
    const tangent = (value: Vec3, fallback: Vec3) => (value.lengthSq() > 1e-10 ? value.normalize() : fallback);
    const m0 = tangent(p0.clone().sub(previous[previous.length - 2]), direct).mulScalar(distance * tension);
    const m1 = tangent(following[1].clone().sub(p1), direct).mulScalar(distance * tension);

    return Array.from({ length: count }, (_, index) => {
        const t = index / (count - 1);
        const t2 = t * t;
        const t3 = t2 * t;
        const t4 = t3 * t;
        const t5 = t4 * t;
        const h00 = 1 - 10 * t3 + 15 * t4 - 6 * t5;
        const h10 = t - 6 * t3 + 8 * t4 - 3 * t5;
        const h01 = 10 * t3 - 15 * t4 + 6 * t5;
        const h11 = -4 * t3 + 7 * t4 - 3 * t5;
        return p0.clone().mulScalar(h00)
        .add(m0.clone().mulScalar(h10))
        .add(p1.clone().mulScalar(h01))
        .add(m1.clone().mulScalar(h11));
    });
};

const resample = (points: Vec3[], owners: number[], count: number) => {
    if (count === 1) {
        return { points: [points[0].clone()], owners: [owners[0]] };
    }
    const lengths: number[] = [0];
    for (let index = 1; index < points.length; index++) {
        lengths.push(lengths[index - 1] + points[index - 1].distance(points[index]));
    }
    const total = lengths[lengths.length - 1];
    if (total < 1e-8) throw new Error('轨迹没有有效长度，请调整轨迹段的位置或尺寸');

    const sampled: Vec3[] = [];
    const sampledOwners: number[] = [];
    let source = 0;
    for (let index = 0; index < count; index++) {
        const distance = total * index / (count - 1);
        while (source + 2 < lengths.length && lengths[source + 1] < distance) source++;
        const span = Math.max(lengths[source + 1] - lengths[source], 1e-12);
        const amount = (distance - lengths[source]) / span;
        sampled.push(new Vec3().lerp(points[source], points[source + 1], amount));
        sampledOwners.push(amount < 0.5 ? owners[source] : owners[source + 1]);
    }
    return { points: sampled, owners: sampledOwners };
};

const compose = (plan: TrajectoryPlan) => {
    const segmentPaths = plan.segments.map(segment => buildSegment(segment));
    const points = segmentPaths[0].map(point => point.clone());
    const owners = segmentPaths[0].map(() => plan.segments[0].id);

    for (let index = 1; index < segmentPaths.length; index++) {
        const bridge = connector(segmentPaths[index - 1], segmentPaths[index], 48, plan.connectorTension);
        for (let j = 1; j < bridge.length; j++) {
            points.push(bridge[j]);
            owners.push(j < bridge.length / 2 ? plan.segments[index - 1].id : plan.segments[index].id);
        }
        for (let j = 1; j < segmentPaths[index].length; j++) {
            points.push(segmentPaths[index][j]);
            owners.push(plan.segments[index].id);
        }
    }
    return resample(points, owners, plan.cameraCount);
};

const worldSamples = (scene: Scene, limit = 80000) => {
    const splats = (scene.getElementsByType(ElementType.splat) as Splat[]).filter(splat => splat.visible);
    const total = splats.reduce((sum, splat) => sum + splat.numSplats, 0);
    const step = Math.max(1, Math.ceil(total / limit));
    const output: number[] = [];
    const local = new Vec3();
    const world = new Vec3();
    let globalIndex = 0;
    for (const splat of splats) {
        const centers = splat.centers;
        for (let index = 0; index < splat.numSplats; index++, globalIndex++) {
            if (globalIndex % step !== 0) continue;
            if ((splat.state.data[index] & State.deleted) !== 0) continue;
            local.set(centers[index * 3], centers[index * 3 + 1], centers[index * 3 + 2]);
            splat.worldTransform.transformPoint(local, world);
            output.push(world.x, world.y, world.z);
        }
    }
    return output;
};

const nearestDistance = (position: Vec3, samples: number[]) => {
    let nearestSq = Number.POSITIVE_INFINITY;
    for (let index = 0; index < samples.length; index += 3) {
        const dx = position.x - samples[index];
        const dy = position.y - samples[index + 1];
        const dz = position.z - samples[index + 2];
        nearestSq = Math.min(nearestSq, dx * dx + dy * dy + dz * dz);
    }
    return Math.sqrt(nearestSq);
};

const nearestSegmentDistance = (start: Vec3, end: Vec3, samples: number[]) => {
    const ab = end.clone().sub(start);
    const lengthSq = Math.max(ab.lengthSq(), 1e-20);
    let nearestSq = Number.POSITIVE_INFINITY;
    for (let index = 0; index < samples.length; index += 3) {
        const apX = samples[index] - start.x;
        const apY = samples[index + 1] - start.y;
        const apZ = samples[index + 2] - start.z;
        const amount = clamp((apX * ab.x + apY * ab.y + apZ * ab.z) / lengthSq, 0, 1);
        const dx = start.x + ab.x * amount - samples[index];
        const dy = start.y + ab.y * amount - samples[index + 1];
        const dz = start.z + ab.z * amount - samples[index + 2];
        nearestSq = Math.min(nearestSq, dx * dx + dy * dy + dz * dz);
    }
    return Math.sqrt(nearestSq);
};

const subjectFrame = (scene: Scene) => {
    const splats = (scene.getElementsByType(ElementType.splat) as Splat[])
    .filter(splat => splat.visible && splat.numSplats > 0);
    if (splats.length === 0) {
        return {
            focus: scene.bound.center.clone(),
            radius: Math.max(scene.bound.halfExtents.length(), 1e-3)
        };
    }

    const focus = new Vec3();
    let weight = 0;
    for (const splat of splats) {
        const splatFocus = splat.focalPoint();
        const splatWeight = Math.max(splat.numSplats, 1);
        focus.addScaled(splatFocus, splatWeight);
        weight += splatWeight;
    }
    focus.mulScalar(1 / weight);

    // Splat.framingRadius uses the dense 95th percentile and already ignores
    // reconstruction outliers. Measuring each visible splat from the shared
    // focus also handles scenes made from several separate splat elements.
    const radius = Math.max(...splats.map(splat => splat.framingRadius(focus)), 1e-3);
    return { focus, radius };
};

const median = (values: number[]) => {
    if (values.length === 0) return 0;
    const ordered = values.slice().sort((a, b) => a - b);
    return ordered[Math.floor((ordered.length - 1) * 0.5)];
};

const referenceArc = (positions: Vec3[], focus: Vec3) => {
    let first = positions[0];
    let second = positions[1];
    let farthestSq = 0;
    for (let i = 0; i < positions.length; i++) {
        for (let j = i + 1; j < positions.length; j++) {
            const distanceSq = positions[i].clone().sub(positions[j]).lengthSq();
            if (distanceSq > farthestSq) {
                farthestSq = distanceSq;
                first = positions[i];
                second = positions[j];
            }
        }
    }
    const axis = second.clone().sub(first).normalize();
    let planePoint = positions[0];
    let planeDistanceSq = 0;
    for (const position of positions) {
        const offset = position.clone().sub(first);
        const perpendicular = offset.sub(axis.clone().mulScalar(offset.dot(axis)));
        if (perpendicular.lengthSq() > planeDistanceSq) {
            planeDistanceSq = perpendicular.lengthSq();
            planePoint = position;
        }
    }
    const normal = new Vec3().cross(axis, planePoint.clone().sub(first));
    if (normal.lengthSq() < 1e-10) normal.copy(Vec3.UP);
    else normal.normalize();
    if (normal.dot(Vec3.UP) < 0) normal.mulScalar(-1);

    const radial = positions[0].clone().sub(focus);
    radial.sub(normal.clone().mulScalar(radial.dot(normal)));
    if (radial.lengthSq() < 1e-10) radial.copy(Vec3.RIGHT);
    else radial.normalize();
    const planeRotation = new Quat().setFromDirections(Vec3.UP, normal);
    const currentX = planeRotation.transformVector(Vec3.RIGHT.clone());
    const alignX = new Quat().setFromDirections(currentX, radial);
    const rotation = new Quat().mul2(alignX, planeRotation);
    const inverse = rotation.clone().invert();
    const local = positions.map(position => inverse.transformVector(position.clone().sub(focus)));
    const angles = local.map(position => Math.atan2(position.z, position.x));
    for (let index = 1; index < angles.length; index++) {
        while (angles[index] - angles[index - 1] > Math.PI) angles[index] -= Math.PI * 2;
        while (angles[index] - angles[index - 1] < -Math.PI) angles[index] += Math.PI * 2;
    }
    const travel = angles[angles.length - 1] - angles[0];
    const radius = Math.max(1e-3, median(local.map(position => Math.hypot(position.x, position.z))));
    const height = median(local.map(position => position.y));
    const spacing = median(positions.slice(1).map((position, index) => position.distance(positions[index])));
    return {
        rotation: rotation.getEulerAngles(),
        center: [0, height, 0] as [number, number, number],
        radius,
        end: clamp(Math.abs(travel) / (Math.PI * 2), 0.02, 1),
        reverse: travel < 0,
        supportDistance: Math.max(spacing * 3, radius * 0.12)
    };
};

const constrainDirections = (directions: Vec3[], maxDegrees: number) => {
    const maximum = maxDegrees * Math.PI / 180;
    for (let index = 1; index < directions.length; index++) {
        const previous = directions[index - 1];
        const current = directions[index];
        const dot = clamp(previous.dot(current), -1, 1);
        const angle = Math.acos(dot);
        if (angle <= maximum || angle < 1e-7) continue;
        const amount = maximum / angle;
        const sine = Math.sin(angle);
        if (Math.abs(sine) < 1e-6) {
            current.lerp(previous, current, amount).normalize();
        } else {
            current.copy(previous.clone().mulScalar(Math.sin((1 - amount) * angle) / sine)
            .add(current.clone().mulScalar(Math.sin(amount * angle) / sine))).normalize();
        }
    }
};

const solvePlan = (
    plan: TrajectoryPlan,
    focus: Vec3,
    fallbackDirection: Vec3
): TrajectoryPlanResult => {
    if (plan.segments.length === 0) throw new Error('至少需要一个轨迹段');
    const generated = compose(plan);
    const fixedDirection = new Vec3(plan.fixedDirection);
    if (fixedDirection.lengthSq() < 1e-12) fixedDirection.copy(fallbackDirection);
    if (fixedDirection.lengthSq() < 1e-12) fixedDirection.copy(Vec3.BACK);
    fixedDirection.normalize();

    const directions = generated.points.map((position, index) => {
        if (plan.orientation === 'fixed') return fixedDirection.clone();
        if (plan.orientation === 'tangent') {
            const previous = generated.points[Math.max(0, index - 1)];
            const following = generated.points[Math.min(generated.points.length - 1, index + 1)];
            const direction = following.clone().sub(previous);
            return direction.lengthSq() > 1e-10 ? direction.normalize() : fixedDirection.clone();
        }
        const direction = focus.clone().sub(position);
        return direction.lengthSq() > 1e-10 ? direction.normalize() : fixedDirection.clone();
    });
    // Subject-facing cameras must keep the subject centered. Applying a strict
    // per-frame angular cap here made the orientation lag behind wide arcs and
    // eventually point far away from the Gaussian. Tangent mode has no fixed
    // subject target, so it can still use the smoothing constraint safely.
    if (plan.orientation === 'tangent') {
        constrainDirections(directions, plan.maxAngleDegrees);
    }

    const poses = generated.points.map((position, index): TrajectoryPose => {
        const targetDistance = Math.max(position.distance(focus), 1);
        return {
            name: `virtual_camera_${String(index + 1).padStart(3, '0')}`,
            frame: index,
            position: position.clone(),
            target: position.clone().add(directions[index].clone().mulScalar(targetDistance)),
            fov: plan.fovDegrees
        };
    });

    return {
        poses,
        segmentIds: generated.owners,
        focus: [focus.x, focus.y, focus.z],
        minimumClearance: Number.POSITIVE_INFINITY,
        collisionCameraIndices: [],
        collisionSegmentIndices: [],
        unsupportedCameraIndices: []
    };
};

const clonePlan = (plan: TrajectoryPlan): TrajectoryPlan => JSON.parse(JSON.stringify(plan));

const registerTrajectoryPlannerEvents = (scene: Scene, events: Events) => {
    let activePlan: TrajectoryPlan | null = null;
    let activeSegmentIds: number[] = [];
    let selectedSegmentId: number | null = null;
    let cachedSubject: { focus: Vec3, radius: number } | null = null;
    let generatedPlanFingerprint: string | null = null;
    let referenceCameraPositions: Vec3[] = [];
    let referenceSupportDistance = 0;

    const viewDirection = () => {
        const pose = events.invoke('camera.getPose') as {
            position: { x: number, y: number, z: number },
            target: { x: number, y: number, z: number }
        } | null;
        if (!pose) return Vec3.BACK.clone();
        const direction = new Vec3(
            pose.target.x - pose.position.x,
            pose.target.y - pose.position.y,
            pose.target.z - pose.position.z
        );
        return direction.lengthSq() > 1e-12 ? direction.normalize() : Vec3.BACK.clone();
    };
    const sceneSubject = () => {
        if (!cachedSubject) cachedSubject = subjectFrame(scene);
        return {
            focus: cachedSubject.focus.clone(),
            radius: cachedSubject.radius
        };
    };
    events.on('scene.boundChanged', () => {
        cachedSubject = null;
    });
    events.on('scene.clear', () => {
        activePlan = null;
        activeSegmentIds = [];
        selectedSegmentId = null;
        cachedSubject = null;
        generatedPlanFingerprint = null;
        referenceCameraPositions = [];
        referenceSupportDistance = 0;
        events.fire('trajectory.changed');
    });
    const selectedSegment = () => {
        if (!activePlan || activePlan.segments.length === 0) return null;
        return activePlan.segments.find(segment => segment.id === selectedSegmentId) ?? activePlan.segments[0];
    };
    const solveActive = (cameraCount?: number) => {
        if (!activePlan) return null;
        const plan = cameraCount === undefined ? activePlan : { ...activePlan, cameraCount };
        return solvePlan(plan, sceneSubject().focus, viewDirection());
    };

    events.function('trajectory.segmentAtFrame', (frame: number) => activeSegmentIds[frame]);
    events.function('trajectory.maxAngleDegrees', () => activePlan?.maxAngleDegrees ?? 12);
    events.function('trajectory.origin', () => {
        const segment = selectedSegment();
        return segment ? JSON.parse(JSON.stringify(segment.origin)) as TrajectoryOrigin : null;
    });
    events.function('trajectory.selectedSegmentId', () => selectedSegment()?.id ?? null);
    events.function('trajectory.origins', () => activePlan?.segments.map(segment => ({
        id: segment.id,
        position: segment.origin.position.slice() as [number, number, number],
        rotation: segment.origin.rotation.slice() as [number, number, number],
        selected: segment.id === selectedSegment()?.id
    })) ?? []);
    events.function('trajectory.plan', () => (activePlan ? clonePlan(activePlan) : null));
    events.function('trajectory.generatedCurrent', () => (
        activePlan ? generatedPlanFingerprint === JSON.stringify(activePlan) : null
    ));
    // Geometry of the selected segment, used by the scene handles so the
    // edited curve is exactly the curve the planner will generate from.
    events.function('trajectory.circle', () => {
        const segment = selectedSegment();
        if (!segment) return null;
        return {
            origin: segment.origin.position.slice() as [number, number, number],
            rotation: segment.origin.rotation.slice() as [number, number, number],
            radius: (segment.radius[0] + segment.radius[1]) * 0.5,
            radiusX: segment.radius[0],
            radiusZ: segment.radius[1]
        };
    });
    events.function('trajectory.previewPoints', () => solveActive(256)?.poses.map(pose => pose.position) ?? []);
    events.function('trajectory.previewPoses', () => solveActive()?.poses ?? []);
    events.on('trajectory.previewPlan', (rawPlan: TrajectoryPlan) => {
        activePlan = normalizePlan(rawPlan);
        if (!activePlan.segments.some(segment => segment.id === selectedSegmentId)) {
            selectedSegmentId = activePlan.segments[0]?.id ?? null;
        }
        events.fire('trajectory.changed');
        scene.forceRender = true;
    });
    events.on('trajectory.selectSegment', (segmentId: number) => {
        if (!activePlan?.segments.some(segment => segment.id === segmentId)) return;
        selectedSegmentId = segmentId;
        events.fire('trajectory.segmentSelectionChanged', segmentId);
        events.fire('trajectory.changed');
        scene.forceRender = true;
    });
    events.on('trajectory.setOriginPosition', (position: Vec3) => {
        const segment = selectedSegment();
        if (!segment) return;
        segment.origin.position = [position.x, position.y, position.z];
        events.fire('trajectory.changed');
        scene.forceRender = true;
    });
    events.on('trajectory.setOriginRotation', (rotation: Vec3) => {
        const segment = selectedSegment();
        if (!segment) return;
        segment.origin.rotation = [rotation.x, rotation.y, rotation.z];
        events.fire('trajectory.changed');
        scene.forceRender = true;
    });
    events.on('trajectory.setRadius', (radiusX: number, radiusZ: number) => {
        const segment = selectedSegment();
        if (!segment || !Number.isFinite(radiusX) || !Number.isFinite(radiusZ)) return;
        segment.radius = [Math.max(radiusX, 1e-4), Math.max(radiusZ, 1e-4)];
        events.fire('trajectory.radiusChanged', (segment.radius[0] + segment.radius[1]) * 0.5, segment.radius.slice());
        events.fire('trajectory.changed');
        scene.forceRender = true;
    });
    events.function('trajectory.originPoseFromView', () => {
        const pose = events.invoke('camera.getPose') as {
            position: { x: number, y: number, z: number },
            target: { x: number, y: number, z: number }
        };
        // The trajectory lives in local XZ (normal +Y), while the camera image
        // plane lives in local XY (normal +Z). Compose that fixed conversion
        // with the actual camera quaternion so roll is preserved as well.
        const cameraRotation = scene.camera.mainCamera.getRotation();
        const planeToCamera = new Quat().setFromDirections(Vec3.UP, Vec3.BACK);
        const rotation = new Quat().mul2(cameraRotation, planeToCamera).getEulerAngles();
        return {
            position: [pose.target.x, pose.target.y, pose.target.z] as [number, number, number],
            rotation: [rotation.x, rotation.y, rotation.z] as [number, number, number]
        };
    });
    events.on('trajectory.focusOrigin', () => {
        const segment = selectedSegment();
        if (!segment) return;
        const pose = events.invoke('camera.getPose') as {
            position: { x: number, y: number, z: number },
            target: { x: number, y: number, z: number },
            fov?: number
        };
        const target = new Vec3(segment.origin.position);
        const position = new Vec3(pose.position.x, pose.position.y, pose.position.z);
        const offset = position.clone().sub(new Vec3(pose.target.x, pose.target.y, pose.target.z));
        if (offset.lengthSq() < 1e-10) offset.set(0, 0, 1);
        const halfFov = clamp(finite(pose.fov, 60), 1, 179) * Math.PI / 360;
        const fitDistance = Math.max(...segment.radius) / Math.max(Math.tan(halfFov), 1e-3) * 1.35;
        position.copy(target).add(offset.normalize().mulScalar(Math.max(fitDistance, 1e-3)));
        events.fire('camera.setPose', { position, target, fov: pose.fov }, 0);
        scene.forceRender = true;
    });

    events.function('trajectory.validation', () => {
        const stale = !!activePlan && generatedPlanFingerprint !== JSON.stringify(activePlan);
        if (stale) {
            return {
                valid: false,
                stale: true,
                collisionCameraIndices: [],
                collisionSegmentIndices: [],
                unsupportedCameraIndices: [],
                minimumClearance: Number.POSITIVE_INFINITY
            };
        }
        if (!activePlan) {
            return {
                valid: true,
                stale: false,
                collisionCameraIndices: [],
                collisionSegmentIndices: [],
                unsupportedCameraIndices: [],
                minimumClearance: Number.POSITIVE_INFINITY
            };
        }
        // Validate the actual timeline poses because these are what export uses.
        // They may contain intentional per-camera adjustments made after generation.
        const poses = (events.invoke('camera.poses') as {
            position: Vec3,
            target: Vec3
        }[] | undefined) ?? [];
        const samples = activePlan.clearance > 0 ? worldSamples(scene) : [];
        let minimumClearance = Number.POSITIVE_INFINITY;
        const collisionCameraIndices: number[] = [];
        poses.forEach((pose, cameraIndex) => {
            if (activePlan.clearance <= 0) return;
            const distance = nearestDistance(pose.position, samples);
            minimumClearance = Math.min(minimumClearance, distance);
            if (distance < activePlan.clearance * 0.98) collisionCameraIndices.push(cameraIndex);
        });
        const collisionSegmentIndices: number[] = [];
        for (let index = 1; activePlan.clearance > 0 && index < poses.length; index++) {
            const distance = nearestSegmentDistance(poses[index - 1].position, poses[index].position, samples);
            minimumClearance = Math.min(minimumClearance, distance);
            if (distance < activePlan.clearance * 0.98) collisionSegmentIndices.push(index - 1);
        }
        const unsupportedCameraIndices = referenceCameraPositions.length > 0 ? poses
        .map((pose, index) => (Math.min(...referenceCameraPositions.map(
            reference => pose.position.distance(reference)
        )) > referenceSupportDistance ? index : -1))
        .filter(index => index !== -1) : [];
        return {
            valid: collisionCameraIndices.length === 0 && collisionSegmentIndices.length === 0 &&
                unsupportedCameraIndices.length === 0,
            stale: false,
            collisionCameraIndices,
            collisionSegmentIndices,
            unsupportedCameraIndices,
            minimumClearance
        };
    });

    events.function('trajectory.defaults', (): TrajectoryPlan => {
        const subject = sceneSubject();
        const center = subject.focus;
        const cameraPose = events.invoke('camera.getPose') as {
            position: { x: number, y: number, z: number },
            target: { x: number, y: number, z: number },
            fov?: number
        } | null;
        const timelinePoses = ((events.invoke('camera.poses') as {
            position: Vec3,
            fov?: number
        }[] | undefined) ?? []);
        const colmapPoses = ((events.invoke('realCameraDataset.renderData') as {
            position: Vec3,
            fov?: number
        }[] | undefined) ?? []);
        // The original COLMAP sequence is authoritative for the path's travel
        // direction. Image preview orientation (including camera.flipY) is only
        // a display concern and must not choose or reverse the virtual path.
        const trackPoses = colmapPoses.length >= 2 ? colmapPoses : timelinePoses;
        if (trackPoses.length >= 2 && generatedPlanFingerprint === null) {
            referenceCameraPositions = trackPoses.map(pose => pose.position.clone());
        }
        const reference = referenceCameraPositions.length >= 2 ? referenceArc(referenceCameraPositions, center) : null;
        if (reference) referenceSupportDistance = reference.supportDistance;
        const fovDegrees = clamp(finite(
            median(trackPoses.map(pose => pose.fov).filter((value): value is number => Number.isFinite(value))) ||
                cameraPose?.fov || events.invoke('camera.fov'),
            60
        ), 1, 179);
        // 3DGS is sharp near its training cameras and degrades rapidly under
        // large viewpoint extrapolation. Match 3D-Viewers by using the median
        // reference-camera radius; without references, start from the user's
        // current clear view and keep the default arc deliberately local.
        const currentPosition = cameraPose ? new Vec3(
            cameraPose.position.x, cameraPose.position.y, cameraPose.position.z
        ) : center.clone().add(Vec3.BACK.clone().mulScalar(subject.radius));
        const horizontal = currentPosition.clone().sub(center);
        const verticalOffset = 0;
        horizontal.y = 0;
        const fallbackRadius = Math.max(horizontal.length(), subject.radius * 0.35, 1e-3);
        const fallbackRotation = horizontal.lengthSq() > 1e-10 ?
            new Quat().setFromDirections(Vec3.RIGHT, horizontal.normalize()).getEulerAngles() : new Vec3();
        const defaultRadius = reference?.radius ?? fallbackRadius;
        const planeEuler = reference?.rotation ?? fallbackRotation;
        const planeRotation = new Quat().setFromEulerAngles(planeEuler.x, planeEuler.y, planeEuler.z);
        const planePosition = center.clone().add(
            planeRotation.transformVector(new Vec3(reference?.center ?? [0, verticalOffset, 0]))
        );
        return {
            cameraCount: 81,
            fovDegrees,
            orientation: 'density',
            fixedDirection: (() => {
                const direction = viewDirection();
                return [direction.x, direction.y, direction.z] as [number, number, number];
            })(),
            maxAngleDegrees: 12,
            // Preserve the requested curve by default. Per-camera collision
            // pushes deform a smooth arc into a locally jagged path and show up
            // as speed judder in exported sequences. Clearance remains an
            // explicit opt-in control and export validation still enforces it.
            clearance: 0,
            connectorTension: 0.45,
            width: 1280,
            height: 720,
            segments: [{
                id: 1,
                shape: 'arc',
                origin: {
                    position: [planePosition.x, planePosition.y, planePosition.z],
                    rotation: [planeEuler.x, planeEuler.y, planeEuler.z]
                },
                radius: [defaultRadius, defaultRadius],
                start: 0,
                end: reference?.end ?? 0.12,
                reverse: reference?.reverse ?? false,
                cornerRadius: 0.35,
                turns: 1.5
            }]
        };
    });

    // Generation always runs on the authoritative plan. Passing a separate plan
    // object here previously allowed the exported path to differ from the curve
    // drawn in the viewport.
    events.function('trajectory.generate', (): TrajectoryPlanResult => {
        if (!activePlan) throw new Error('尚未初始化轨迹计划');
        const plan = clonePlan(activePlan);
        if (plan.segments.length === 0) throw new Error('至少需要一个轨迹段');
        const samples = worldSamples(scene);
        const subject = sceneSubject();
        const focus = subject.focus;
        const currentPose = events.invoke('camera.getPose') as {
            position: { x: number, y: number, z: number },
            target: { x: number, y: number, z: number },
            fov?: number
        };
        const currentPosition = new Vec3(currentPose.position.x, currentPose.position.y, currentPose.position.z);
        const solved = solvePlan(plan, focus, viewDirection());

        let minimumClearance = Number.POSITIVE_INFINITY;
        const collisionCameraIndices: number[] = [];
        const collisionSegmentIndices: number[] = [];
        const unsupportedCameraIndices = referenceCameraPositions.length > 0 ? solved.poses
        .map((pose, index) => (Math.min(...referenceCameraPositions.map(
            reference => pose.position.distance(reference)
        )) > referenceSupportDistance ? index : -1))
        .filter(index => index !== -1) : [];
        if (samples.length > 0) {
            solved.poses.forEach((pose, index) => {
                const distance = nearestDistance(pose.position, samples);
                minimumClearance = Math.min(minimumClearance, distance);
                if (plan.clearance > 0 && distance < plan.clearance * 0.98) collisionCameraIndices.push(index);
            });
            for (let index = 1; index < solved.poses.length; index++) {
                const distance = nearestSegmentDistance(
                    solved.poses[index - 1].position, solved.poses[index].position, samples
                );
                minimumClearance = Math.min(minimumClearance, distance);
                if (plan.clearance > 0 && distance < plan.clearance * 0.98) {
                    collisionSegmentIndices.push(index - 1);
                }
            }
        }

        activePlan = clonePlan(plan);
        generatedPlanFingerprint = JSON.stringify(activePlan);
        activeSegmentIds = solved.segmentIds.slice();
        events.fire('trajectory.changed');

        // Timeline indices are a one-to-one preview of camera positions. They
        // are not video frames and are never used to add intermediate poses.
        events.fire('timeline.setFrames', plan.cameraCount);
        events.fire('timeline.setLoop', false);
        events.fire('timeline.setSmoothness', 0);
        events.fire('track.replacePoses', solved.poses, 'generateTrajectory');
        events.fire('camera.setShowPoses', true);
        events.fire('timeline.setFrame', 0);

        // Generating a path must not replace the editor view with camera zero.
        // A newly generated camera can be inside the capture or face away from
        // the subject; switching to it here made a successful operation appear
        // as a completely black renderer. Timeline interaction remains the
        // explicit way to preview a virtual camera.
        events.fire('camera.setPose', {
            position: currentPosition,
            target: new Vec3(currentPose.target.x, currentPose.target.y, currentPose.target.z),
            fov: currentPose.fov
        }, 0);
        return {
            poses: solved.poses,
            segmentIds: solved.segmentIds,
            focus: [focus.x, focus.y, focus.z],
            minimumClearance,
            collisionCameraIndices,
            collisionSegmentIndices,
            unsupportedCameraIndices
        };
    });
};

export {
    registerTrajectoryPlannerEvents,
    OrientationMode,
    TrajectoryPlan,
    TrajectoryPlanResult,
    TrajectoryOrigin,
    TrajectorySegment,
    TrajectoryShape
};
