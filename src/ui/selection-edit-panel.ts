import { Button, Container, Label, NumericInput, SliderInput } from '@playcanvas/pcui';
import { Vec3 } from 'playcanvas';

import { Events } from '../events';
import { Splat } from '../splat';
import { i18n } from './localization';
import { Tooltips } from './tooltips';
import {
    ApplyPositionOffsetOp,
    ApplyScaleMultiplierOp,
    ApplyOpacityMultiplierOp,
    ApplyColorTintOp
} from '../edit-ops-advanced';

/**
 * Panel for editing selected gaussian splats
 * Allows batch modification of position, scale, rotation, color, and opacity
 * Optimized for performance with large selections
 */
class SelectionEditPanel extends Container {
    private events: Events;
    private splat: Splat = null;
    private numSelectedLabel: Label;
    private editControls: Container;
    private updateTimeout: number = null;
    private isUpdating = false;

    constructor(events: Events, tooltips: Tooltips, args = {}) {
        args = {
            ...args,
            id: 'selection-edit-panel',
            class: 'panel',
            hidden: true
        };

        super(args);
        this.events = events;

        // Stop pointer events bubbling
        ['pointerdown', 'pointerup', 'pointermove', 'wheel', 'dblclick'].forEach((eventName) => {
            this.dom.addEventListener(eventName, (event: Event) => event.stopPropagation());
        });

        // Header
        const header = new Container({
            class: 'panel-header'
        });

        const headerIcon = new Label({
            text: '',
            class: 'panel-header-icon'
        });

        const headerLabel = new Label({
            class: 'panel-header-label'
        });
        i18n.bindText(headerLabel, 'panel.selection-edit.title');

        header.append(headerIcon);
        header.append(headerLabel);

        // Selection info
        const selectionInfo = new Container({
            class: 'selection-info'
        });

        this.numSelectedLabel = new Label({
            class: 'selection-count',
            text: '0'
        });

        const selectionLabel = new Label({
            class: 'selection-label'
        });
        i18n.bindText(selectionLabel, 'panel.selection-edit.selected');

        selectionInfo.append(selectionLabel);
        selectionInfo.append(this.numSelectedLabel);

        // Edit controls container
        this.editControls = new Container({
            class: 'selection-edit-controls',
            hidden: true
        });

        // Position offset controls
        const positionSection = this.createSection('panel.selection-edit.position-offset');
        const positionX = this.createNumericControl('X', -100, 100, 0.01);
        const positionY = this.createNumericControl('Y', -100, 100, 0.01);
        const positionZ = this.createNumericControl('Z', -100, 100, 0.01);

        positionSection.append(positionX.container);
        positionSection.append(positionY.container);
        positionSection.append(positionZ.container);

        const applyPositionBtn = new Button({
            text: '应用位置偏移',
            class: 'selection-edit-button'
        });
        applyPositionBtn.on('click', () => {
            if (this.splat && this.splat.numSelected > 0) {
                this.applyPositionOffset(
                    positionX.input.value,
                    positionY.input.value,
                    positionZ.input.value
                );
                // Reset inputs
                positionX.input.value = 0;
                positionY.input.value = 0;
                positionZ.input.value = 0;
            }
        });
        positionSection.append(applyPositionBtn);

        // Scale multiplier controls
        const scaleSection = this.createSection('panel.selection-edit.scale-multiplier');
        const scaleX = this.createNumericControl('X', 0.01, 10, 0.01, 1);
        const scaleY = this.createNumericControl('Y', 0.01, 10, 0.01, 1);
        const scaleZ = this.createNumericControl('Z', 0.01, 10, 0.01, 1);
        const scaleUniform = this.createNumericControl('统一', 0.01, 10, 0.01, 1);

        scaleSection.append(scaleUniform.container);
        scaleSection.append(scaleX.container);
        scaleSection.append(scaleY.container);
        scaleSection.append(scaleZ.container);

        const applyScaleBtn = new Button({
            text: '应用缩放',
            class: 'selection-edit-button'
        });
        applyScaleBtn.on('click', () => {
            if (this.splat && this.splat.numSelected > 0) {
                this.applyScaleMultiplier(
                    scaleX.input.value,
                    scaleY.input.value,
                    scaleZ.input.value
                );
                // Reset inputs
                scaleX.input.value = 1;
                scaleY.input.value = 1;
                scaleZ.input.value = 1;
                scaleUniform.input.value = 1;
            }
        });
        scaleSection.append(applyScaleBtn);

        // Uniform scale binding
        scaleUniform.input.on('change', (value: number) => {
            scaleX.input.value = value;
            scaleY.input.value = value;
            scaleZ.input.value = value;
        });

        // Opacity adjustment
        const opacitySection = this.createSection('panel.selection-edit.opacity');
        const opacitySlider = new SliderInput({
            class: 'selection-edit-slider',
            min: 0,
            max: 1,
            step: 0.01,
            value: 1,
            precision: 2
        });

        const opacityLabel = new Label({
            class: 'slider-value-label',
            text: '1.00'
        });

        opacitySlider.on('change', (value: number) => {
            opacityLabel.text = value.toFixed(2);
        });

        const opacityRow = new Container({
            class: 'control-row',
            flex: true,
            flexDirection: 'row'
        });
        opacityRow.append(opacitySlider);
        opacityRow.append(opacityLabel);
        opacitySection.append(opacityRow);

        const applyOpacityBtn = new Button({
            text: '设置不透明度',
            class: 'selection-edit-button'
        });
        applyOpacityBtn.on('click', () => {
            if (this.splat && this.splat.numSelected > 0) {
                this.applyOpacityMultiplier(opacitySlider.value);
                opacitySlider.value = 1;
                opacityLabel.text = '1.00';
            }
        });
        opacitySection.append(applyOpacityBtn);

        // Color tint controls
        const colorSection = this.createSection('panel.selection-edit.color-tint');
        const colorTintR = this.createNumericControl('R', 0, 2, 0.01, 1);
        const colorTintG = this.createNumericControl('G', 0, 2, 0.01, 1);
        const colorTintB = this.createNumericControl('B', 0, 2, 0.01, 1);

        colorSection.append(colorTintR.container);
        colorSection.append(colorTintG.container);
        colorSection.append(colorTintB.container);

        const applyColorBtn = new Button({
            text: '应用颜色调整',
            class: 'selection-edit-button'
        });
        applyColorBtn.on('click', () => {
            if (this.splat && this.splat.numSelected > 0) {
                this.applyColorTint(
                    colorTintR.input.value,
                    colorTintG.input.value,
                    colorTintB.input.value
                );
                colorTintR.input.value = 1;
                colorTintG.input.value = 1;
                colorTintB.input.value = 1;
            }
        });
        colorSection.append(applyColorBtn);

        // Quick actions
        const actionsSection = this.createSection('panel.selection-edit.quick-actions');

        const deleteBtn = new Button({
            text: '删除选中',
            class: ['selection-edit-button', 'danger']
        });
        deleteBtn.on('click', () => {
            if (this.splat && this.splat.numSelected > 0) {
                events.fire('select.delete');
            }
        });

        const hideBtn = new Button({
            text: '隐藏选中',
            class: 'selection-edit-button'
        });
        hideBtn.on('click', () => {
            if (this.splat && this.splat.numSelected > 0) {
                events.fire('select.hide');
            }
        });

        const invertBtn = new Button({
            text: '反选',
            class: 'selection-edit-button'
        });
        invertBtn.on('click', () => {
            events.fire('select.invert');
        });

        const selectAllBtn = new Button({
            text: '全选',
            class: 'selection-edit-button'
        });
        selectAllBtn.on('click', () => {
            events.fire('select.all');
        });

        const selectNoneBtn = new Button({
            text: '取消选择',
            class: 'selection-edit-button'
        });
        selectNoneBtn.on('click', () => {
            events.fire('select.none');
        });

        actionsSection.append(selectAllBtn);
        actionsSection.append(selectNoneBtn);
        actionsSection.append(invertBtn);
        actionsSection.append(hideBtn);
        actionsSection.append(deleteBtn);

        // Add all sections to edit controls
        this.editControls.append(positionSection);
        this.editControls.append(scaleSection);
        this.editControls.append(opacitySection);
        this.editControls.append(colorSection);
        this.editControls.append(actionsSection);

        // Assemble panel
        this.append(header);
        this.append(selectionInfo);
        this.append(this.editControls);

        // Register tooltips
        tooltips.register(applyPositionBtn, () => '平移选中的高斯点', 'top');
        tooltips.register(applyScaleBtn, () => '缩放选中的高斯点', 'top');
        tooltips.register(applyOpacityBtn, () => '调整选中高斯点的不透明度', 'top');
        tooltips.register(applyColorBtn, () => '调整选中高斯点的颜色', 'top');
        tooltips.register(deleteBtn, () => '删除选中的高斯点', 'top');
        tooltips.register(hideBtn, () => '隐藏选中的高斯点', 'top');
        tooltips.register(invertBtn, () => '反转选择', 'top');
        tooltips.register(selectAllBtn, () => '选择所有可见的高斯点', 'top');
        tooltips.register(selectNoneBtn, () => '取消所有选择', 'top');

        // Listen for selection changes with throttling for performance
        events.on('splat.stateChanged', (splat: Splat) => {
            if (splat === this.splat) {
                this.throttledUpdate();
            }
        });

        events.on('selection.changed', (selection: unknown) => {
            if (selection instanceof Splat) {
                this.splat = selection;
                this.updateSelectionCount();
            } else {
                this.splat = null;
                this.updateSelectionCount();
            }
        });
    }

    private createSection(titleKey: string): Container {
        const section = new Container({
            class: 'selection-edit-section'
        });

        const title = new Label({
            class: 'section-title'
        });
        i18n.bindText(title, titleKey);

        section.append(title);
        return section;
    }

    private createNumericControl(label: string, min: number, max: number, step: number, defaultValue = 0) {
        const container = new Container({
            class: 'numeric-control-row',
            flex: true,
            flexDirection: 'row'
        });

        const labelElement = new Label({
            class: 'numeric-control-label',
            text: label
        });

        const input = new NumericInput({
            class: 'numeric-control-input',
            min,
            max,
            step,
            value: defaultValue,
            precision: 2
        });

        container.append(labelElement);
        container.append(input);

        return { container, input, label: labelElement };
    }

    private throttledUpdate() {
        // Throttle updates to avoid excessive redraws during rapid selection changes
        if (this.updateTimeout) {
            clearTimeout(this.updateTimeout);
        }
        this.updateTimeout = window.setTimeout(() => {
            this.updateSelectionCount();
            this.updateTimeout = null;
        }, 100);
    }

    private updateSelectionCount() {
        const count = this.splat?.numSelected ?? 0;
        this.numSelectedLabel.text = i18n.formatInteger(count);
        this.editControls.hidden = count === 0;
        this.hidden = count === 0;
    }

    private applyPositionOffset(x: number, y: number, z: number) {
        if (!this.splat || this.splat.numSelected === 0 || this.isUpdating) return;
        if (x === 0 && y === 0 && z === 0) return;

        this.isUpdating = true;
        try {
            const offset = new Vec3(x, y, z);
            const op = new ApplyPositionOffsetOp(this.splat, offset);
            this.events.fire('edit.add', op);
        } finally {
            this.isUpdating = false;
        }
    }

    private applyScaleMultiplier(x: number, y: number, z: number) {
        if (!this.splat || this.splat.numSelected === 0 || this.isUpdating) return;
        if (x === 1 && y === 1 && z === 1) return;

        this.isUpdating = true;
        try {
            const scale = new Vec3(x, y, z);
            const op = new ApplyScaleMultiplierOp(this.splat, scale);
            this.events.fire('edit.add', op);
        } finally {
            this.isUpdating = false;
        }
    }

    private applyOpacityMultiplier(multiplier: number) {
        if (!this.splat || this.splat.numSelected === 0 || this.isUpdating) return;
        if (multiplier === 1) return;

        this.isUpdating = true;
        try {
            const op = new ApplyOpacityMultiplierOp(this.splat, multiplier);
            this.events.fire('edit.add', op);
        } finally {
            this.isUpdating = false;
        }
    }

    private applyColorTint(r: number, g: number, b: number) {
        if (!this.splat || this.splat.numSelected === 0 || this.isUpdating) return;
        if (r === 1 && g === 1 && b === 1) return;

        this.isUpdating = true;
        try {
            const tint = new Vec3(r, g, b);
            const op = new ApplyColorTintOp(this.splat, tint);
            this.events.fire('edit.add', op);
        } finally {
            this.isUpdating = false;
        }
    }
}

export { SelectionEditPanel };
