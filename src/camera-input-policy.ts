type CameraControlMode = 'orbit' | 'fly';
type CameraDragAction = 'orbit' | 'look' | 'pan' | 'zoom';

type MouseModifiers = {
    shiftKey: boolean;
    ctrlKey: boolean;
    altKey: boolean;
    metaKey: boolean;
};

type MouseGesture = {
    physicalButton: number;
    navigationButton: number;
    buttonMask: number;
    controlClickAsRight: boolean;
};

const mouseButtonMasks = [1, 4, 2];

const beginMouseGesture = (button: number, buttons: number, ctrlKey: boolean, isMacOS: boolean): MouseGesture => {
    // Browsers disagree on whether macOS Control+click is reported as primary
    // or secondary. Normalize both forms while leaving other platforms alone.
    const controlClickAsRight = ctrlKey && (button === 0 || (isMacOS && button === 2));

    return {
        physicalButton: button,
        navigationButton: controlClickAsRight ? 2 : button,
        buttonMask: buttons || mouseButtonMasks[button] || 0,
        controlClickAsRight
    };
};

const orbitAzimuthDelta = (dx: number, isMacOS: boolean) => (isMacOS ? -dx : dx);

const resolveMouseDragAction = (
    mode: CameraControlMode,
    button: number,
    modifiers: MouseModifiers,
    controlClickAsRight: boolean,
    isMacOS: boolean
): CameraDragAction => {
    // On macOS, secondary drag is always pan. This also covers either browser
    // representation of Control+primary drag and avoids modifier ambiguity.
    if (isMacOS && button === 2) {
        return 'pan';
    }

    const { shiftKey, ctrlKey, altKey, metaKey } = modifiers;
    if (mode === 'fly') {
        if (button === 0) return 'look';
        if (button === 1) return 'zoom';
        return shiftKey || (!controlClickAsRight && ctrlKey) ? 'look' :
            (altKey || metaKey ? 'zoom' : 'pan');
    }

    if (button === 2) {
        return shiftKey || (!controlClickAsRight && ctrlKey) ? 'orbit' :
            (altKey || metaKey ? 'zoom' : 'pan');
    }
    if (button === 1) {
        return shiftKey ? 'pan' : (ctrlKey ? 'zoom' : 'orbit');
    }
    return 'orbit';
};

const mouseGestureIsActive = (buttons: number, buttonMask: number, isMacOS: boolean) => (
    // Pointer capture provides the lifecycle on macOS. Some trackpads report
    // buttons=0 during a captured secondary drag, so that field is not a
    // reliable cancellation signal there.
    isMacOS || (buttons & buttonMask) !== 0
);

const cameraFocusEvent = (isMacOS: boolean) => (isMacOS ? 'click' : 'dblclick');

const isCameraFocusActivation = (eventType: string, detail: number, isMacOS: boolean) => (
    isMacOS ? eventType === 'click' && detail === 2 : eventType === 'dblclick'
);

export {
    beginMouseGesture,
    cameraFocusEvent,
    isCameraFocusActivation,
    mouseGestureIsActive,
    orbitAzimuthDelta,
    resolveMouseDragAction
};
