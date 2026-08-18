import { BooleanInput, Button, Container, Label, NumericInput } from '@playcanvas/pcui';

import type {
    CameraExportData,
    CameraExportSelection,
    CurrentTrajectoryExportData,
    CurrentTrajectoryExportFormat,
    WanTrajectoryExportData,
    WanTrajectoryExportSettings
} from '../camera-export';
import type { Pose } from '../camera-poses';
import { Events } from '../events';
import type { RecordedViewState } from '../recorded-view-trajectory';
import { i18n } from './localization';

type SelectionKey = keyof CameraExportSelection;

const selectionConfig: {
    key: SelectionKey;
    localeKey: string;
    defaultValue: boolean;
}[] = [{
    key: 'imageProjection',
    localeKey: 'panel.camera-parameters.image-projection',
    defaultValue: true
}, {
    key: 'intrinsics',
    localeKey: 'panel.camera-parameters.intrinsics',
    defaultValue: true
}, {
    key: 'pose',
    localeKey: 'panel.camera-parameters.pose',
    defaultValue: true
}, {
    key: 'playcanvasMatrices',
    localeKey: 'panel.camera-parameters.playcanvas',
    defaultValue: false
}, {
    key: 'opencvMatrices',
    localeKey: 'panel.camera-parameters.opencv',
    defaultValue: true
}, {
    key: 'metadataConventions',
    localeKey: 'panel.camera-parameters.metadata-conventions',
    defaultValue: false
}];

const formatNumber = (value: number) => {
    const absolute = Math.abs(value);
    if (absolute !== 0 && (absolute < 1e-4 || absolute >= 1e6)) {
        return value.toExponential(6);
    }
    return value.toFixed(6);
};

const formatVector = (values: number[]) => `[${values.map(formatNumber).join(', ')}]`;

const formatMatrix = (rows: number[][]) => rows.map(row => formatVector(row)).join('\n');

const formatPreview = (data: CameraExportData) => {
    const intrinsics = data.intrinsics;
    const k = intrinsics ? formatMatrix(intrinsics.K) : 'N/A (orthographic)';

    return [
        `IMAGE  ${data.image.width} x ${data.image.height}`,
        `PROJECTION  ${data.projection.type}`,
        `FOV X/Y  ${data.projection.fov_x_degrees?.toFixed(4) ?? 'N/A'} / ${data.projection.fov_y_degrees?.toFixed(4) ?? 'N/A'} deg`,
        '',
        'INTRINSICS K',
        k,
        '',
        'POSITION',
        formatVector(data.pose.position),
        'ROTATION XYZW',
        formatVector(data.pose.rotation_xyzw),
        '',
        'WORLD TO CAMERA - OPENCV',
        formatMatrix(data.pose.world_to_camera_opencv),
        '',
        'CAMERA TO WORLD - OPENCV',
        formatMatrix(data.pose.camera_to_world_opencv),
        '',
        'WORLD TO CAMERA - PLAYCANVAS',
        formatMatrix(data.pose.world_to_camera_playcanvas),
        '',
        'CAMERA TO WORLD - PLAYCANVAS',
        formatMatrix(data.pose.camera_to_world_playcanvas)
    ].join('\n');
};

class CameraParametersPanel extends Container {
    constructor(events: Events, args = {}) {
        args = {
            ...args,
            id: 'camera-parameters-panel',
            hidden: true
        };
        super(args);

        ['pointerdown', 'pointerup', 'pointermove', 'wheel', 'dblclick'].forEach((eventName) => {
            this.dom.addEventListener(eventName, (event: Event) => event.stopPropagation());
        });

        const header = new Container({ id: 'camera-parameters-header' });
        const title = new Label({ id: 'camera-parameters-title' });
        i18n.bindText(title, 'panel.camera-parameters.title');

        const closeButton = new Button({
            id: 'camera-parameters-close',
            text: '\u00d7'
        });
        closeButton.dom.setAttribute('aria-label', i18n.t('panel.render.cancel'));
        closeButton.on('click', () => {
            this.hidden = true;
        });

        header.append(title);
        header.append(closeButton);

        const preview = document.createElement('pre');
        preview.id = 'camera-parameters-preview';
        preview.textContent = '...';

        const selectionHeader = new Label({ id: 'camera-parameters-selection-title' });
        i18n.bindText(selectionHeader, 'panel.camera-parameters.save-groups');

        const selectionContainer = new Container({ id: 'camera-parameters-selection' });
        const inputs = {} as Record<SelectionKey, BooleanInput>;

        selectionConfig.forEach((config) => {
            const row = new Container({ class: 'camera-parameters-option' });
            const label = new Label({ class: 'camera-parameters-option-label' });
            i18n.bindText(label, config.localeKey);

            const input = new BooleanInput({
                class: 'camera-parameters-option-input',
                value: config.defaultValue
            });
            inputs[config.key] = input;
            row.append(label);
            row.append(input);
            selectionContainer.append(row);
        });

        const selectAllButton = new Button({ class: 'camera-parameters-secondary-button' });
        i18n.bindText(selectAllButton, 'panel.camera-parameters.select-all');

        const clearButton = new Button({ class: 'camera-parameters-secondary-button' });
        i18n.bindText(clearButton, 'panel.camera-parameters.clear');

        const saveButton = new Button({ id: 'camera-parameters-save' });
        i18n.bindText(saveButton, 'panel.camera-parameters.save');

        const secondaryActions = new Container({ id: 'camera-parameters-secondary-actions' });
        secondaryActions.append(selectAllButton);
        secondaryActions.append(clearButton);

        const footer = new Container({ id: 'camera-parameters-footer' });
        footer.append(secondaryActions);
        footer.append(saveButton);

        const wanTitle = new Label({
            id: 'wan-trajectory-title',
            text: 'WAN CAMERA TRAJECTORY'
        });
        const wanControls = new Container({ id: 'wan-trajectory-controls' });
        const wanFramesLabel = new Label({ text: '* 相机数量' });
        const wanFrames = new NumericInput({
            value: 81,
            min: 1,
            precision: 0
        });
        const wanWidthLabel = new Label({ text: '* 宽度' });
        const wanWidth = new NumericInput({
            value: 1280,
            min: 1,
            max: 16384,
            precision: 0
        });
        const wanHeightLabel = new Label({ text: '* 高度' });
        const wanHeight = new NumericInput({
            value: 720,
            min: 1,
            max: 16384,
            precision: 0
        });
        const wanExportButton = new Button({
            id: 'wan-trajectory-export',
            text: '导出 WAN K/T + COLMAP'
        });
        const wanStatus = new Label({
            id: 'wan-trajectory-status',
            text: '输出任意数量的连续相机位置与姿态'
        });
        const requiredNote = new Label({
            id: 'wan-trajectory-required-note',
            text: '* 必填参数'
        });
        wanControls.append(wanFramesLabel);
        wanControls.append(wanFrames);
        wanControls.append(wanWidthLabel);
        wanControls.append(wanWidth);
        wanControls.append(wanHeightLabel);
        wanControls.append(wanHeight);
        wanControls.append(wanExportButton);

        const trajectoryFileTitle = new Label({
            id: 'trajectory-file-title',
            text: 'COLMAP / OpenCV 外参'
        });
        const trajectoryFileActions = new Container({ id: 'trajectory-file-actions' });
        const trajectoryJsonButton = new Button({ text: '导出外参 JSON' });
        const trajectoryCsvButton = new Button({ text: '导出 W2C CSV' });
        const trajectoryFileStatus = new Label({
            id: 'trajectory-file-status',
            text: '世界坐标使用首个可见高斯的原始 PLY；仅导出可写入 images.txt 的 W2C 外参'
        });
        trajectoryFileActions.append(trajectoryJsonButton);
        trajectoryFileActions.append(trajectoryCsvButton);

        const trajectoryImageTitle = new Label({
            id: 'trajectory-image-title',
            text: '轨迹渲染图片'
        });
        const trajectoryImageActions = new Container({ id: 'trajectory-image-actions' });
        const trajectoryPreviewButton = new Button({ text: '预览轨迹' });
        const trajectoryImageSaveButton = new Button({
            id: 'trajectory-image-save',
            text: '选择目录并保存 PNG'
        });
        const trajectoryImageStatus = new Label({
            id: 'trajectory-image-status',
            text: '使用上方宽度和高度，按完成后的插值轨迹逐帧渲染'
        });
        trajectoryImageActions.append(trajectoryPreviewButton);
        trajectoryImageActions.append(trajectoryImageSaveButton);

        this.append(header);
        this.dom.appendChild(preview);
        this.append(selectionHeader);
        this.append(selectionContainer);
        this.append(wanTitle);
        this.append(wanControls);
        this.append(requiredNote);
        this.append(wanStatus);
        this.append(trajectoryFileTitle);
        this.append(trajectoryFileActions);
        this.append(trajectoryFileStatus);
        this.append(trajectoryImageTitle);
        this.append(trajectoryImageActions);
        this.append(trajectoryImageStatus);
        this.append(footer);

        const getSelection = (): CameraExportSelection => ({
            imageProjection: inputs.imageProjection.value,
            intrinsics: inputs.intrinsics.value,
            pose: inputs.pose.value,
            playcanvasMatrices: inputs.playcanvasMatrices.value,
            opencvMatrices: inputs.opencvMatrices.value,
            metadataConventions: inputs.metadataConventions.value
        });

        const updateSaveState = () => {
            saveButton.enabled = Object.values(getSelection()).some(Boolean);
        };

        Object.values(inputs).forEach(input => input.on('change', updateSaveState));

        selectAllButton.on('click', () => {
            Object.values(inputs).forEach((input) => {
                input.value = true;
            });
            updateSaveState();
        });

        clearButton.on('click', () => {
            Object.values(inputs).forEach((input) => {
                input.value = false;
            });
            updateSaveState();
        });

        saveButton.on('click', async () => {
            saveButton.enabled = false;
            try {
                await events.invoke('camera.saveParameters', getSelection());
            } finally {
                updateSaveState();
            }
        });

        const getWanSettings = (): WanTrajectoryExportSettings => ({
            cameraCount: Math.max(1, Math.trunc(wanFrames.value)),
            width: Math.max(1, Math.trunc(wanWidth.value)),
            height: Math.max(1, Math.trunc(wanHeight.value))
        });

        wanExportButton.on('click', async () => {
            wanExportButton.enabled = false;
            try {
                const settings = getWanSettings();
                wanFrames.value = settings.cameraCount;
                const data = await events.invoke(
                    'camera.saveWanTrajectory',
                    settings
                ) as WanTrajectoryExportData;
                wanStatus.text = `已验证并导出 ${data.camera_count} 个离散相机机位`;
            } catch (error) {
                wanStatus.text = `导出失败：${error instanceof Error ? error.message : error}`;
            } finally {
                wanExportButton.enabled = true;
            }
        });

        const exportCurrentTrajectory = async (
            format: CurrentTrajectoryExportFormat,
            button: Button
        ) => {
            button.enabled = false;
            try {
                const data = await events.invoke(
                    'camera.saveCurrentTrajectory',
                    format
                ) as CurrentTrajectoryExportData;
                trajectoryFileStatus.text = `已校验并导出 ${data.pose_count} 个标准 W2C 外参 (${data.source_type})`;
            } catch (error) {
                trajectoryFileStatus.text = `导出失败: ${error instanceof Error ? error.message : error}`;
            } finally {
                button.enabled = true;
            }
        };
        trajectoryJsonButton.on('click', () => exportCurrentTrajectory('json', trajectoryJsonButton));
        trajectoryCsvButton.on('click', () => exportCurrentTrajectory('csv', trajectoryCsvButton));

        const refreshTrajectoryImageState = () => {
            const state = events.invoke('recordedView.state') as RecordedViewState | undefined;
            trajectoryPreviewButton.enabled = !!state?.finished;
            trajectoryImageSaveButton.enabled = !!state?.finished && !!window.showDirectoryPicker;
        };

        trajectoryPreviewButton.on('click', () => {
            if (!events.invoke('trajectoryPlanner.startPreview')) {
                trajectoryImageStatus.text = '请先结束打点并生成插值轨迹';
            }
        });

        trajectoryImageSaveButton.on('click', async () => {
            const state = events.invoke('recordedView.state') as RecordedViewState | undefined;
            const poses = events.invoke('recordedView.targetPoses') as Pose[] | undefined;
            if (!state?.finished || !poses?.length) {
                trajectoryImageStatus.text = '请先结束打点并生成插值轨迹';
                return;
            }
            if (!window.showDirectoryPicker) {
                trajectoryImageStatus.text = '当前浏览器不支持选择输出目录，请使用 Chrome 或 Edge';
                return;
            }

            try {
                const parentDirectory = await window.showDirectoryPicker({
                    id: 'SuperSplatTrajectoryImageExport',
                    mode: 'readwrite'
                });
                trajectoryImageSaveButton.enabled = false;
                trajectoryPreviewButton.enabled = false;
                const settings = getWanSettings();
                trajectoryImageStatus.text = `正在渲染 ${poses.length} 张 ${settings.width} x ${settings.height} PNG...`;
                const result = await events.invoke('render.trajectoryImages', {
                    width: settings.width,
                    height: settings.height,
                    trajectoryLabel: state.activeTrajectoryLabel,
                    poses
                }, parentDirectory) as {
                    directoryName: string,
                    frameCount: number,
                    requestedFrameCount: number,
                    width: number,
                    height: number,
                    cancelled: boolean
                };
                trajectoryImageStatus.text = result.cancelled ?
                    `已停止，${result.frameCount}/${result.requestedFrameCount} 张保存在 ${result.directoryName}` :
                    `已保存 ${result.frameCount} 张 ${result.width} x ${result.height} PNG 到 ${result.directoryName}`;
            } catch (error) {
                if (!(error instanceof DOMException && error.name === 'AbortError')) {
                    trajectoryImageStatus.text = `保存失败：${error instanceof Error ? error.message : error}`;
                }
            } finally {
                refreshTrajectoryImageState();
            }
        });

        const refresh = () => {
            const data = events.invoke('camera.getParameters') as CameraExportData | undefined;
            if (data) {
                preview.textContent = formatPreview(data);
            }
            refreshTrajectoryImageState();
        };

        let lastRefresh = 0;
        events.on('update', () => {
            if (this.hidden) return;
            const now = performance.now();
            if (now - lastRefresh >= 100) {
                lastRefresh = now;
                refresh();
            }
        });

        events.on('camera.parametersPanel.toggle', () => {
            this.hidden = !this.hidden;
            if (!this.hidden) {
                events.fire('trajectoryPlanner.hide');
                lastRefresh = performance.now();
                refresh();
            }
        });

        events.on('camera.parametersPanel.show', () => {
            events.fire('trajectoryPlanner.hide');
            this.hidden = false;
            lastRefresh = performance.now();
            refresh();
        });

        events.on('camera.parametersPanel.hide', () => {
            this.hidden = true;
        });
        events.on('recordedView.changed', refreshTrajectoryImageState);

        window.addEventListener('resize', () => {
            if (window.matchMedia('(max-width: 600px)').matches) {
                this.dom.style.removeProperty('left');
                this.dom.style.removeProperty('right');
                this.dom.style.removeProperty('top');
                return;
            }

            if (this.dom.style.left) {
                const parent = this.dom.parentElement;
                const left = Math.max(8, Math.min(
                    parent.clientWidth - this.dom.offsetWidth - 8,
                    Number.parseFloat(this.dom.style.left)
                ));
                const top = Math.max(8, Math.min(
                    parent.clientHeight - this.dom.offsetHeight - 8,
                    Number.parseFloat(this.dom.style.top)
                ));
                this.dom.style.left = `${left}px`;
                this.dom.style.top = `${top}px`;
            }
        });

        let dragging = false;
        let dragStartX = 0;
        let dragStartY = 0;
        let panelStartLeft = 0;
        let panelStartTop = 0;

        header.dom.addEventListener('pointerdown', (event: PointerEvent) => {
            if (!event.isPrimary || event.button !== 0 || closeButton.dom.contains(event.target as Node)) return;
            const rect = this.dom.getBoundingClientRect();
            const parentRect = this.dom.parentElement.getBoundingClientRect();
            dragging = true;
            dragStartX = event.clientX;
            dragStartY = event.clientY;
            panelStartLeft = rect.left - parentRect.left;
            panelStartTop = rect.top - parentRect.top;
            this.dom.style.right = 'auto';
            this.dom.style.left = `${panelStartLeft}px`;
            header.dom.setPointerCapture(event.pointerId);
            event.preventDefault();
        });

        header.dom.addEventListener('pointermove', (event: PointerEvent) => {
            if (!dragging) return;
            const parent = this.dom.parentElement;
            const left = Math.max(8, Math.min(
                parent.clientWidth - this.dom.offsetWidth - 8,
                panelStartLeft + event.clientX - dragStartX
            ));
            const top = Math.max(8, Math.min(
                parent.clientHeight - this.dom.offsetHeight - 8,
                panelStartTop + event.clientY - dragStartY
            ));
            this.dom.style.left = `${left}px`;
            this.dom.style.top = `${top}px`;
        });

        header.dom.addEventListener('pointerup', (event: PointerEvent) => {
            if (dragging && event.isPrimary) {
                dragging = false;
                header.dom.releasePointerCapture(event.pointerId);
            }
        });

        header.dom.addEventListener('lostpointercapture', () => {
            dragging = false;
        });

        updateSaveState();
    }
}

export { CameraParametersPanel };
