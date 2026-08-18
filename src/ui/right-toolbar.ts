import { Button, Container, Element, Label } from '@playcanvas/pcui';

import { Events } from '../events';
import { ShortcutManager } from '../shortcut-manager';
import { i18n } from './localization';
import cameraFlipYSvg from './svg/camera-flip-y.svg';
import cameraFrameSelectionSvg from './svg/camera-frame-selection.svg';
import cameraFrontSvg from './svg/camera-front.svg';
import cameraPanelSvg from './svg/camera-panel.svg';
import cameraQuickFocusSvg from './svg/camera-quick-focus.svg';
import cameraResetSvg from './svg/camera-reset.svg';
import centersSvg from './svg/centers.svg';
import colorPanelSvg from './svg/color-panel.svg';
import flyCameraSvg from './svg/fly-camera.svg';
import orbitCameraSvg from './svg/orbit-camera.svg';
import ringsSvg from './svg/rings.svg';
import showHideSplatsSvg from './svg/show-hide-splats.svg';
import { Tooltips } from './tooltips';

const createSvg = (svgString: string) => {
    const decodedStr = decodeURIComponent(svgString.substring('data:image/svg+xml,'.length));
    return new DOMParser().parseFromString(decodedStr, 'image/svg+xml').documentElement;
};

class RightToolbar extends Container {
    constructor(events: Events, tooltips: Tooltips, args = {}) {
        args = {
            ...args,
            id: 'right-toolbar'
        };

        super(args);

        this.dom.addEventListener('pointerdown', (event) => {
            event.stopPropagation();
        });

        const ringsModeToggle = new Button({
            id: 'right-toolbar-mode-toggle',
            class: 'right-toolbar-toggle'
        });

        const showHideSplats = new Button({
            id: 'right-toolbar-show-hide',
            class: ['right-toolbar-toggle', 'active']
        });

        const orbitMode = new Button({
            id: 'right-toolbar-orbit-mode',
            class: ['right-toolbar-toggle', 'active']
        });

        const flyMode = new Button({
            id: 'right-toolbar-fly-mode',
            class: 'right-toolbar-toggle'
        });

        const cameraFrameSelection = new Button({
            id: 'right-toolbar-frame-selection',
            class: 'right-toolbar-button'
        });

        const cameraQuickFocus = new Button({
            id: 'right-toolbar-quick-focus',
            class: 'right-toolbar-tool'
        });
        cameraQuickFocus.dom.setAttribute('aria-pressed', 'false');

        const cameraReset = new Button({
            id: 'right-toolbar-camera-origin',
            class: 'right-toolbar-button'
        });

        const cameraFront = new Button({
            id: 'right-toolbar-camera-front',
            class: 'right-toolbar-button'
        });

        const cameraFlipY = new Button({
            id: 'right-toolbar-camera-flip-y',
            class: 'right-toolbar-toggle'
        });
        cameraFlipY.dom.setAttribute('aria-pressed', 'false');

        const trajectoryPlanner = new Button({
            id: 'right-toolbar-trajectory-planner',
            class: 'right-toolbar-toggle'
        });
        trajectoryPlanner.dom.setAttribute('aria-label', '人工打点轨迹');

        const colorPanel = new Button({
            id: 'right-toolbar-color-panel',
            class: 'right-toolbar-toggle'
        });

        const options = new Button({
            id: 'right-toolbar-options',
            class: 'right-toolbar-toggle',
            icon: 'E283'
        });

        const centersDom = createSvg(centersSvg);
        const ringsDom = createSvg(ringsSvg);
        ringsDom.style.display = 'none';

        ringsModeToggle.dom.appendChild(centersDom);
        ringsModeToggle.dom.appendChild(ringsDom);
        showHideSplats.dom.appendChild(createSvg(showHideSplatsSvg));
        orbitMode.dom.appendChild(createSvg(orbitCameraSvg));
        flyMode.dom.appendChild(createSvg(flyCameraSvg));
        cameraQuickFocus.dom.appendChild(createSvg(cameraQuickFocusSvg));
        cameraFrameSelection.dom.appendChild(createSvg(cameraFrameSelectionSvg));
        cameraReset.dom.appendChild(createSvg(cameraResetSvg));
        cameraFront.dom.appendChild(createSvg(cameraFrontSvg));
        cameraFlipY.dom.appendChild(createSvg(cameraFlipYSvg));
        trajectoryPlanner.dom.appendChild(createSvg(cameraPanelSvg));
        colorPanel.dom.appendChild(createSvg(colorPanelSvg));

        this.append(ringsModeToggle);
        this.append(showHideSplats);
        this.append(new Element({ class: 'right-toolbar-separator' }));
        this.append(orbitMode);
        this.append(flyMode);
        this.append(new Element({ class: 'right-toolbar-separator' }));
        this.append(cameraQuickFocus);
        this.append(cameraFrameSelection);
        this.append(cameraReset);
        this.append(cameraFront);
        this.append(cameraFlipY);
        this.append(trajectoryPlanner);
        this.append(new Element({ class: 'right-toolbar-separator' }));
        this.append(colorPanel);
        this.append(options);

        // Helper to compose localized tooltip text with shortcut
        const shortcutManager: ShortcutManager = events.invoke('shortcutManager');
        const tooltip = (localeKey: string, shortcutId?: string) => () => {
            const text = i18n.t(localeKey);
            if (shortcutId) {
                const shortcut = shortcutManager.formatShortcut(shortcutId);
                if (shortcut) {
                    return i18n.formatTooltipWithShortcut(text, shortcut);
                }
            }
            return text;
        };

        tooltips.register(ringsModeToggle, tooltip('tooltip.right-toolbar.splat-mode', 'camera.toggleMode'), 'left');
        tooltips.register(showHideSplats, tooltip('tooltip.right-toolbar.show-hide', 'camera.toggleOverlay'), 'left');
        tooltips.register(orbitMode, tooltip('tooltip.right-toolbar.orbit-camera', 'camera.toggleControlMode'), 'left');
        tooltips.register(flyMode, tooltip('tooltip.right-toolbar.fly-camera', 'camera.toggleControlMode'), 'left');
        tooltips.register(cameraQuickFocus, tooltip('tooltip.right-toolbar.quick-focus'), 'left');
        tooltips.register(cameraFrameSelection, tooltip('tooltip.right-toolbar.frame-selection', 'camera.focus'), 'left');
        tooltips.register(cameraReset, tooltip('tooltip.right-toolbar.reset-camera', 'camera.reset'), 'left');
        tooltips.register(cameraFront, tooltip('tooltip.right-toolbar.front-camera'), 'left');
        tooltips.register(cameraFlipY, tooltip('tooltip.right-toolbar.flip-y'), 'left');
        tooltips.register(trajectoryPlanner, () => '人工打点轨迹', 'left');
        tooltips.register(colorPanel, tooltip('tooltip.right-toolbar.colors'), 'left');
        tooltips.register(options, tooltip('tooltip.right-toolbar.settings'), 'left');

        // add event handlers

        ringsModeToggle.on('click', () => {
            events.fire('camera.toggleMode');
            events.fire('camera.setOverlay', true);
        });
        showHideSplats.on('click', () => events.fire('camera.toggleOverlay'));
        orbitMode.on('click', () => events.fire('camera.setControlMode', 'orbit'));
        flyMode.on('click', () => events.fire('camera.setControlMode', 'fly'));
        cameraQuickFocus.on('click', () => events.fire('camera.quickFocus.toggle'));
        cameraFrameSelection.on('click', () => events.fire('camera.focus'));
        cameraReset.on('click', () => events.fire('camera.reset'));
        cameraFront.on('click', () => events.fire('camera.front'));
        cameraFlipY.on('click', () => events.fire('camera.toggleFlipY'));
        trajectoryPlanner.on('click', () => events.fire('trajectoryPlanner.toggle'));
        colorPanel.on('click', () => events.fire('colorPanel.toggleVisible'));
        options.on('click', () => events.fire('settingsPanel.toggleVisible'));

        events.on('camera.mode', (mode: string) => {
            ringsModeToggle.class[mode === 'rings' ? 'add' : 'remove']('active');
            centersDom.style.display = mode === 'rings' ? 'none' : 'block';
            ringsDom.style.display = mode === 'rings' ? 'block' : 'none';
        });

        events.on('camera.overlay', (value: boolean) => {
            showHideSplats.class[value ? 'add' : 'remove']('active');
        });

        events.on('camera.controlMode', (mode: 'orbit' | 'fly') => {
            orbitMode.class[mode === 'orbit' ? 'add' : 'remove']('active');
            flyMode.class[mode === 'fly' ? 'add' : 'remove']('active');
        });

        events.on('camera.quickFocus.active', (active: boolean) => {
            cameraQuickFocus.class[active ? 'add' : 'remove']('active');
            cameraQuickFocus.dom.setAttribute('aria-pressed', String(active));
        });

        events.on('camera.flipY', (value: boolean) => {
            const inverted = !value;
            cameraFlipY.class[inverted ? 'add' : 'remove']('active');
            cameraFlipY.dom.setAttribute('aria-pressed', String(inverted));
        });

        events.on('trajectoryPlanner.visible', (visible: boolean) => {
            trajectoryPlanner.class[visible ? 'add' : 'remove']('active');
        });

        events.on('colorPanel.visible', (visible: boolean) => {
            colorPanel.class[visible ? 'add' : 'remove']('active');
        });

        events.on('settingsPanel.visible', (visible: boolean) => {
            options.class[visible ? 'add' : 'remove']('active');
        });
    }
}

export { RightToolbar };
