import { Vec3 } from 'playcanvas';

import { AnimTrack } from './anim-track';
import { CameraAnimTrack } from './camera-poses';
import { AnimTrackEditOp } from './edit-ops';
import { Events } from './events';

/**
 * Manages the active animation track and provides undo-wrapped
 * key operations. Resolves which track the user is interacting
 * with and ensures all mutations are undoable.
 *
 * For now, the active track is always the camera track.
 * When selection-based switching is added, getActiveTrack()
 * will inspect the current selection.
 */
const registerTrackManagerEvents = (events: Events) => {
    let poseDrag: {
        frame: number,
        before: unknown,
        startPosition: Vec3,
        startTarget: Vec3,
        changed: boolean
    } | null = null;
    // Get the animation track of the currently active element.
    // For now, always returns the camera animation track.
    const getActiveTrack = (): AnimTrack | null => {
        return events.invoke('camera.animTrack') ?? null;
    };

    // Helper: execute an edit on the active track wrapped in undo.
    // The editFn must return true if it modified the track, false if it was a no-op.
    const trackEdit = (name: string, editFn: (track: AnimTrack) => boolean) => {
        const track = getActiveTrack();
        if (!track) return;
        const before = track.snapshot();
        if (!editFn(track)) return;
        const after = track.snapshot();
        events.fire('edit.add', new AnimTrackEditOp(name, track, before, after), true);
    };
    // Get keys from active track
    events.function('track.keys', () => {
        const track = getActiveTrack();
        return track ? track.keys : [];
    });

    // Add key to active track
    events.on('track.addKey', (frame?: number) => {
        const keyFrame = frame ?? events.invoke('timeline.frame');
        trackEdit('addKey', track => track.addKey(keyFrame));
    });

    // Remove key from active track
    events.on('track.removeKey', (frame?: number) => {
        const keyFrame = frame ?? events.invoke('timeline.frame');
        trackEdit('removeKey', track => track.removeKey(keyFrame));
    });

    // Move key in active track
    events.on('track.moveKey', (fromFrame: number, toFrame: number) => {
        trackEdit('moveKey', track => track.moveKey(fromFrame, toFrame));
    });

    // Copy key in active track
    events.on('track.copyKey', (fromFrame: number, toFrame: number) => {
        trackEdit('copyKey', track => track.copyKey(fromFrame, toFrame));
    });

    // Replace the complete camera path as one undoable operation. The
    // trajectory planner uses this instead of adding up to 81 keys one by one.
    events.on('track.replacePoses', (poses: Parameters<CameraAnimTrack['loadPoses']>[0], name = 'replaceCameraPath') => {
        trackEdit(name, (track) => {
            (track as CameraAnimTrack).loadPoses(poses);
            return true;
        });
    });

    events.on('track.applyViewOrientation', (frame: number, wholeSegment = false) => {
        const track = getActiveTrack() as CameraAnimTrack | null;
        const cameraPose = events.invoke('camera.getPose') as {
            position: { x: number, y: number, z: number },
            target: { x: number, y: number, z: number }
        } | null;
        if (!track || !cameraPose) return;
        const direction = new Vec3(
            cameraPose.target.x - cameraPose.position.x,
            cameraPose.target.y - cameraPose.position.y,
            cameraPose.target.z - cameraPose.position.z
        );
        if (direction.lengthSq() < 1e-12) return;
        direction.normalize();
        const selectedSegment = events.invoke('trajectory.segmentAtFrame', frame);

        trackEdit(wholeSegment ? 'orientCameraSegment' : 'orientCameraPose', (active) => {
            const cameraTrack = active as CameraAnimTrack;
            let changed = false;
            const updated = cameraTrack.getPoses().map((pose) => {
                const matches = wholeSegment ?
                    events.invoke('trajectory.segmentAtFrame', pose.frame) === selectedSegment :
                    pose.frame === frame;
                if (!matches) return pose;
                changed = true;
                const distance = Math.max(pose.position.distance(pose.target), 1);
                return {
                    ...pose,
                    position: pose.position.clone(),
                    target: pose.position.clone().add(direction.clone().mulScalar(distance))
                };
            });
            if (changed) cameraTrack.loadPoses(updated);
            return changed;
        });
    });

    events.on('track.poseDragStart', (frame: number) => {
        const track = getActiveTrack() as CameraAnimTrack | null;
        const pose = track?.getPose(frame);
        if (!track || !pose) return;
        poseDrag = {
            frame,
            before: track.snapshot(),
            startPosition: pose.position.clone(),
            startTarget: pose.target.clone(),
            changed: false
        };
    });

    // Offset is always measured from pointer-down. This preserves cumulative
    // motion and prevents spline rebuilds from pulling the key back mid-drag.
    events.on('track.poseDragMove', (frame: number, offset: Vec3) => {
        const track = getActiveTrack() as CameraAnimTrack | null;
        if (!track || !poseDrag || poseDrag.frame !== frame) return;
        if (offset.lengthSq() <= 1e-12) return;
        poseDrag.changed = true;
        track.setPosePosition(
            frame,
            poseDrag.startPosition.clone().add(offset),
            poseDrag.startTarget.clone().add(offset),
            true
        );
    });

    events.on('track.poseDragEnd', (frame: number) => {
        const track = getActiveTrack();
        if (!track || !poseDrag || poseDrag.frame !== frame) return;
        const before = poseDrag.before;
        const changed = poseDrag.changed;
        poseDrag = null;
        if (!changed) return;
        events.fire('track.keyUpdated', frame);
        events.fire(
            'edit.add',
            new AnimTrackEditOp('moveCameraPose', track, before, track.snapshot()),
            true
        );
    });

    events.on('track.poseDragCancel', () => {
        const track = getActiveTrack();
        if (track && poseDrag) {
            track.restore(poseDrag.before);
        }
        poseDrag = null;
    });
};

export { registerTrackManagerEvents };
