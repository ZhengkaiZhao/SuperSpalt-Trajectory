import { BooleanInput, Button, Container, Label, NumericInput, SelectInput } from '@playcanvas/pcui';

import { readCameraPoseFromPng } from '../camera-pose-image-metadata';
import { Events } from '../events';
import type { ImagePoseMatchResult } from '../image-pose-matcher';
import type { RealCameraDatasetState } from '../real-camera-dataset';
import type { RecordedViewState } from '../recorded-view-trajectory';

const filesFromEntry = (entry: FileSystemEntry): Promise<File[]> => {
    if (entry.isFile) {
        return new Promise((resolve, reject) => {
            (entry as FileSystemFileEntry).file((file) => {
                // FileSystemEntry drops do not populate webkitRelativePath.
                // Preserve fullPath so multiple sparse/0 reconstructions in one
                // selected tree can be paired and ranked correctly.
                try {
                    Object.defineProperty(file, 'webkitRelativePath', {
                        configurable: true,
                        value: entry.fullPath.replace(/^\/+/, '')
                    });
                } catch {
                    // The loader can still fall back to basename matching.
                }
                resolve([file]);
            }, reject);
        });
    }
    if (!entry.isDirectory) return Promise.resolve([]);
    const reader = (entry as FileSystemDirectoryEntry).createReader();
    return new Promise((resolve, reject) => {
        const children: FileSystemEntry[] = [];
        const readBatch = () => reader.readEntries((entries) => {
            if (entries.length > 0) {
                children.push(...entries);
                readBatch();
            } else {
                Promise.all(children.map(filesFromEntry)).then(result => resolve(result.flat()), reject);
            }
        }, reject);
        readBatch();
    });
};

const filesFromDrop = async (dataTransfer: DataTransfer): Promise<File[]> => {
    const entries = Array.from(dataTransfer.items)
    .map(item => item.webkitGetAsEntry?.())
    .filter((entry): entry is FileSystemEntry => !!entry);
    return entries.length > 0 ? (await Promise.all(entries.map(filesFromEntry))).flat() :
        Array.from(dataTransfer.files);
};

class TrajectoryPlannerPanel extends Container {
    constructor(events: Events, args = {}) {
        super({ ...args, id: 'trajectory-planner-panel', hidden: true });

        ['pointerdown', 'pointerup', 'pointermove', 'wheel', 'dblclick'].forEach((eventName) => {
            this.dom.addEventListener(eventName, event => event.stopPropagation());
        });

        const addField = (container: Container, text: string, input: any) => {
            container.append(new Label({ text }));
            container.append(input);
        };

        const header = new Container({ id: 'trajectory-planner-header' });
        header.append(new Label({ id: 'trajectory-planner-title', text: '人工打点轨迹' }));
        const close = new Button({ id: 'trajectory-planner-close', text: '\u00d7' });
        close.dom.setAttribute('aria-label', '关闭人工打点轨迹');
        header.append(close);
        this.append(header);

        const pointStatus = new Label({
            id: 'trajectory-point-status',
            text: '轨迹 A · 人工关键点 0 · 最终相机 81'
        });
        this.append(pointStatus);

        const trajectorySwitcher = new Container({ id: 'trajectory-switcher' });
        const trajectorySelect = new SelectInput({
            defaultValue: 'manual-trajectory-1',
            options: [{ v: 'manual-trajectory-1', t: '轨迹 A · 0 点' }]
        });
        const newTrajectory = new Button({ text: '新建轨迹' });
        const deleteTrajectory = new Button({ text: '删除轨迹' });
        trajectorySwitcher.append(trajectorySelect);
        trajectorySwitcher.append(newTrajectory);
        trajectorySwitcher.append(deleteTrajectory);
        this.append(trajectorySwitcher);

        const recordedGrid = new Container({ id: 'trajectory-recorded-grid', class: 'trajectory-grid' });
        const targetCount = new NumericInput({ value: 81, min: 2, precision: 0 });
        const showTarget = new BooleanInput({ value: true });
        const showValidation = new BooleanInput({ value: true });
        addField(recordedGrid, '最终相机数量（无上限）', targetCount);
        addField(recordedGrid, '显示目标轨迹（红）', showTarget);
        addField(recordedGrid, '显示验证轨迹（蓝）', showValidation);
        this.append(recordedGrid);

        const poseDrop = new Container({ id: 'trajectory-pose-drop' });
        poseDrop.dom.dataset.localFileDrop = 'camera-pose';
        poseDrop.append(new Label({ text: '拖入任意参考图，自动匹配真实或虚拟轨迹相机' }));
        const choosePoseImage = new Button({ text: '选择图片' });
        poseDrop.append(choosePoseImage);
        this.append(poseDrop);
        const poseFileInput = document.createElement('input');
        poseFileInput.type = 'file';
        poseFileInput.accept = 'image/png,image/jpeg,image/webp,.png,.jpg,.jpeg,.webp';
        poseFileInput.hidden = true;
        poseDrop.dom.appendChild(poseFileInput);

        const datasetPanel = new Container({ id: 'real-camera-dataset', class: 'trajectory-dataset' });
        datasetPanel.dom.dataset.localFileDrop = 'colmap-dataset';
        const datasetHeader = new Container({ id: 'real-camera-dataset-header' });
        datasetHeader.append(new Label({ text: '真实相机参考（绿色）' }));
        const chooseDataset = new Button({ id: 'real-camera-choose-dataset', text: '选择 COLMAP 文件夹' });
        const clearDataset = new Button({ id: 'real-camera-clear-dataset', text: '清除' });
        datasetHeader.append(chooseDataset);
        datasetHeader.append(clearDataset);
        datasetPanel.append(datasetHeader);
        const datasetStatus = new Label({
            id: 'real-camera-dataset-status',
            text: '选择包含 sparse/0/images.txt 的 COLMAP 文件夹；原图和 cameras.txt 可选'
        });
        datasetPanel.append(datasetStatus);
        const datasetImageRow = new Container({ id: 'real-camera-image-row', hidden: true });
        const datasetImageSelect = new SelectInput({ allowNull: true, options: [] });
        const useDatasetImage = new Button({ id: 'real-camera-use-image', text: '设为首点' });
        datasetImageRow.append(datasetImageSelect);
        datasetImageRow.append(useDatasetImage);
        datasetPanel.append(datasetImageRow);
        const datasetPreview = document.createElement('img');
        datasetPreview.id = 'real-camera-image-preview';
        datasetPreview.alt = '真实相机输入图片预览';
        datasetPreview.hidden = true;
        datasetPanel.dom.appendChild(datasetPreview);
        this.append(datasetPanel);
        const datasetFileInput = document.createElement('input');
        datasetFileInput.type = 'file';
        datasetFileInput.multiple = true;
        datasetFileInput.setAttribute('webkitdirectory', '');
        datasetFileInput.setAttribute('directory', '');
        datasetFileInput.hidden = true;
        datasetPanel.dom.appendChild(datasetFileInput);

        const pointActions = new Container({ id: 'trajectory-point-actions' });
        const addPoint = new Button({ text: '记录当前视角' });
        const overwritePoint = new Button({ text: '覆盖当前点' });
        const removePoint = new Button({ text: '删除当前点' });
        const previousPoint = new Button({ id: 'trajectory-previous-point', text: '上一个点' });
        const nextPoint = new Button({ id: 'trajectory-next-point', text: '下一个点' });
        const finishPoints = new Button({ text: '结束打点并检验' });
        const continuePoints = new Button({ text: '继续打点' });
        const previewPoints = new Button({ id: 'trajectory-preview', text: '预览插值轨迹' });
        const clearPoints = new Button({ text: '清空轨迹' });
        [
            addPoint, overwritePoint, removePoint, previousPoint, nextPoint,
            finishPoints, continuePoints, previewPoints, clearPoints
        ].forEach(button => pointActions.append(button));
        this.append(pointActions);

        const status = new Label({
            id: 'trajectory-planner-status',
            text: '移动观察相机后记录视角，点将按记录顺序连接'
        });
        this.append(status);

        const actions = new Container({ id: 'trajectory-planner-actions' });
        const openExport = new Button({ id: 'trajectory-open-export', text: '打开轨迹导出' });
        const showTimeline = new Button({ text: '打开时间轴' });
        actions.append(openExport);
        actions.append(showTimeline);
        this.append(actions);

        const previewControls = document.createElement('div');
        previewControls.id = 'trajectory-preview-controls';
        previewControls.hidden = true;
        const previewLabel = document.createElement('span');
        previewLabel.textContent = '轨迹预览';
        const previewStop = document.createElement('button');
        previewStop.type = 'button';
        previewStop.textContent = '停止';
        previewControls.append(previewLabel, previewStop);
        document.body.appendChild(previewControls);

        let previewUiActive = false;
        let restorePanelAfterPreview = false;
        let syncingTrajectorySelect = false;
        let syncingDatasetSelect = false;
        let datasetPreviewUrl: string | null = null;
        let matchingPoseImage = false;

        const recordedState = () => events.invoke('recordedView.state') as RecordedViewState | undefined;
        const realDatasetState = () => events.invoke('realCameraDataset.state') as RealCameraDatasetState | undefined;
        const updateDatasetPreview = (imageName: string | null) => {
            if (datasetPreviewUrl) URL.revokeObjectURL(datasetPreviewUrl);
            datasetPreviewUrl = null;
            const file = imageName ? events.invoke('realCameraDataset.imageFile', imageName) as File | null : null;
            if (file) {
                datasetPreviewUrl = URL.createObjectURL(file);
                datasetPreview.src = datasetPreviewUrl;
                datasetPreview.hidden = false;
            } else {
                datasetPreview.removeAttribute('src');
                datasetPreview.hidden = true;
            }
        };
        const syncRealDataset = () => {
            const state = realDatasetState();
            if (!state?.loaded) {
                datasetStatus.text = '选择包含 sparse/0/images.txt 的 COLMAP 文件夹；原图和 cameras.txt 可选';
                datasetImageRow.hidden = true;
                clearDataset.enabled = false;
                updateDatasetPreview(null);
                return;
            }
            datasetStatus.text = state.matchedImageCount > 0 ?
                `已读取 ${state.poseCount} 个真实位姿，匹配 ${state.matchedImageCount} 张原图 · ${state.sourcePath}` :
                `已读取 ${state.poseCount} 个真实位姿；无匹配原图，将从高斯场景渲染 · ${state.sourcePath}`;
            const matched = state.images.filter(image => image.matched);
            syncingDatasetSelect = true;
            datasetImageSelect.options = matched.map(image => ({ v: image.name, t: image.name }));
            datasetImageSelect.value = state.selectedImageName ?? matched[0]?.name ?? null;
            syncingDatasetSelect = false;
            datasetImageRow.hidden = matched.length === 0;
            clearDataset.enabled = true;
            useDatasetImage.enabled = matched.length > 0;
            updateDatasetPreview(state.selectedImageName ?? matched[0]?.name ?? null);
        };
        const syncPointStatus = () => {
            const state = recordedState();
            if (!state) return;
            targetCount.value = state.targetCount;
            showTarget.value = state.showTarget;
            showValidation.value = state.showValidation;
            syncingTrajectorySelect = true;
            trajectorySelect.options = state.trajectories.map(trajectory => ({
                v: trajectory.id,
                t: `轨迹 ${trajectory.label} · ${trajectory.keyframeCount} 点${trajectory.finished ? ' · 已完成' : ''}`
            }));
            trajectorySelect.value = state.activeTrajectoryId;
            syncingTrajectorySelect = false;
            const selection = state.selectedIndex >= 0 ?
                ` · 当前 ${state.activeTrajectoryLabel}${state.selectedIndex + 1}/${state.keyframeCount}` : '';
            const check = state.validation ?
                ` · COLMAP ${state.validation.valid ? '通过' : '失败'}` : '';
            pointStatus.text = `轨迹 ${state.activeTrajectoryLabel} · 人工关键点 ${state.keyframeCount} · ` +
                `最终相机 ${state.targetCount}${selection}${check}`;
            addPoint.enabled = !state.finished;
            overwritePoint.enabled = !state.finished && state.selectedIndex >= 0;
            removePoint.enabled = !state.finished && state.selectedIndex >= 0;
            previousPoint.enabled = state.selectedIndex > 0;
            nextPoint.enabled = state.selectedIndex >= 0 && state.selectedIndex < state.keyframeCount - 1;
            finishPoints.enabled = !state.finished && state.keyframeCount >= 2 &&
                state.targetCount >= state.keyframeCount;
            continuePoints.enabled = state.finished;
            previewPoints.enabled = state.finished;
            clearPoints.enabled = state.keyframeCount > 0;
            targetCount.enabled = !state.finished;
        };

        const setPreviewUi = (active: boolean) => {
            if (active === previewUiActive) return;
            previewUiActive = active;
            document.body.classList.toggle('trajectory-preview-active', active);
            previewControls.hidden = !active;
            if (active) {
                restorePanelAfterPreview = !this.hidden;
                this.hidden = true;
                events.fire('trajectoryPlanner.visible', false);
                events.fire('statusBar.closePanels');
                events.fire('camera.parametersPanel.hide');
                events.fire('settingsPanel.setVisible', false);
                events.fire('colorPanel.setVisible', false);
            } else if (restorePanelAfterPreview) {
                this.hidden = false;
                events.fire('trajectoryPlanner.visible', true);
                restorePanelAfterPreview = false;
                syncPointStatus();
            }
        };

        const stopPreview = () => events.invoke('recordedView.stopPreview');
        const importPoseImage = async (file?: File) => {
            if (!file) return;
            poseDrop.class.add('reading');
            matchingPoseImage = true;
            status.text = `正在读取 ${file.name} 的相机位姿...`;
            try {
                let pose: { position: [number, number, number], target: [number, number, number], fov: number } | null = null;
                let visualMatch: ImagePoseMatchResult | null = null;
                if (file.type === 'image/png' || file.name.toLowerCase().endsWith('.png')) {
                    try {
                        pose = await readCameraPoseFromPng(file);
                    } catch {
                        // A normal PNG can still be resolved by its COLMAP image NAME below.
                    }
                }
                if (!pose) {
                    // A matching filename only prioritizes a real source image;
                    // the matcher still verifies its pixels before accepting it.
                    visualMatch = await events.invoke('imagePoseMatch.find', file) as ImagePoseMatchResult;
                    pose = visualMatch.pose;
                }
                if (!events.invoke('recordedView.setInitialPose', pose)) {
                    throw new Error('当前轨迹已完成，请先继续打点或新建轨迹');
                }
                const state = recordedState();
                const position = pose.position.map(value => value.toFixed(3)).join(', ');
                if (visualMatch) {
                    const confidence = { high: '高', medium: '中', low: '低' }[visualMatch.confidence];
                    const search = visualMatch.searchMode === 'exact-real' ? '真实原文件命中' : '全候选检索';
                    status.text = `最高候选：${visualMatch.label}（${confidence}置信度），` +
                        `相对概率 ${(visualMatch.probability * 100).toFixed(1)}%，` +
                        `相似度 ${(visualMatch.score * 100).toFixed(1)}%，${search} ` +
                        `${visualMatch.evaluatedCandidateCount}/${visualMatch.candidateCount}，` +
                        `位置 [${position}]，已设为 ${state?.activeTrajectoryLabel ?? ''}1`;
                } else {
                    status.text = `已从 ${file.name} 精确读取位姿，位置 [${position}]，` +
                        `已设为 ${state?.activeTrajectoryLabel ?? ''}1`;
                }
                syncPointStatus();
            } catch (error) {
                status.text = `读取图片位姿失败：${error instanceof Error ? error.message : error}`;
            } finally {
                matchingPoseImage = false;
                poseDrop.class.remove('reading');
                poseFileInput.value = '';
            }
        };
        const loadRealDataset = async (files: File[]) => {
            if (files.length === 0) return;
            datasetPanel.class.add('reading');
            datasetStatus.text = `正在读取 ${files.length} 个 COLMAP 数据集文件...`;
            try {
                const result = await events.invoke('realCameraDataset.load', files) as RealCameraDatasetState;
                status.text = `真实相机轨迹已加载：${result.poseCount} 个位姿，${result.matchedImageCount} 张原图`;
                syncRealDataset();
            } catch (error) {
                datasetStatus.text = `数据集读取失败：${error instanceof Error ? error.message : error}`;
            } finally {
                datasetPanel.class.remove('reading');
                datasetFileInput.value = '';
            }
        };

        trajectorySelect.on('change', (value: string) => {
            if (syncingTrajectorySelect) return;
            events.invoke('recordedView.selectTrajectory', value);
            syncPointStatus();
        });
        newTrajectory.on('click', () => {
            const result = events.invoke('recordedView.newTrajectory') as RecordedViewState;
            status.text = `已新建轨迹 ${result.activeTrajectoryLabel}，可开始打点`;
            syncPointStatus();
        });
        deleteTrajectory.on('click', () => {
            const previous = recordedState()?.activeTrajectoryLabel ?? '';
            const result = events.invoke('recordedView.deleteTrajectory') as RecordedViewState;
            status.text = `已删除轨迹 ${previous}，当前为轨迹 ${result.activeTrajectoryLabel}`;
            syncPointStatus();
        });
        choosePoseImage.on('click', () => poseFileInput.click());
        poseFileInput.addEventListener('change', () => {
            importPoseImage(poseFileInput.files?.[0]).catch(console.error);
        });
        poseDrop.dom.addEventListener('dragenter', (event: DragEvent) => {
            event.preventDefault();
            event.stopPropagation();
            poseDrop.class.add('drag-over');
        });
        poseDrop.dom.addEventListener('dragover', (event: DragEvent) => {
            event.preventDefault();
            event.stopPropagation();
            if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
        });
        poseDrop.dom.addEventListener('dragleave', () => poseDrop.class.remove('drag-over'));
        poseDrop.dom.addEventListener('drop', (event: DragEvent) => {
            event.preventDefault();
            event.stopPropagation();
            poseDrop.class.remove('drag-over');
            importPoseImage(event.dataTransfer?.files[0]).catch(console.error);
        });
        chooseDataset.on('click', () => datasetFileInput.click());
        datasetFileInput.addEventListener('change', () => {
            loadRealDataset(Array.from(datasetFileInput.files ?? [])).catch(console.error);
        });
        datasetImageSelect.on('change', (imageName: string) => {
            if (syncingDatasetSelect) return;
            events.invoke('realCameraDataset.select', imageName);
            updateDatasetPreview(imageName);
        });
        useDatasetImage.on('click', () => {
            const imageName = datasetImageSelect.value as string;
            const pose = events.invoke('realCameraDataset.select', imageName);
            if (!pose || !events.invoke('recordedView.setInitialPose', pose)) {
                status.text = '无法设置首点：请确认真实图片已匹配且当前轨迹尚未完成';
                return;
            }
            status.text = `已用真实图片 ${imageName} 的相机位姿设置首点`;
            syncPointStatus();
        });
        clearDataset.on('click', () => {
            events.invoke('realCameraDataset.clear');
            status.text = '已清除真实相机参考数据集';
            syncRealDataset();
        });
        datasetPanel.dom.addEventListener('dragover', (event: DragEvent) => {
            event.preventDefault();
            event.stopPropagation();
            datasetPanel.class.add('drag-over');
            if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
        });
        datasetPanel.dom.addEventListener('dragleave', () => datasetPanel.class.remove('drag-over'));
        datasetPanel.dom.addEventListener('drop', (event: DragEvent) => {
            event.preventDefault();
            event.stopPropagation();
            datasetPanel.class.remove('drag-over');
            if (event.dataTransfer) {
                filesFromDrop(event.dataTransfer).then(loadRealDataset).catch(console.error);
            }
        });

        addPoint.on('click', () => {
            const index = events.invoke('recordedView.captureCurrent') as number | null;
            if (index === null) {
                status.text = '当前视角未记录：请移动相机后重试';
            }
            syncPointStatus();
        });
        overwritePoint.on('click', () => {
            if (!events.invoke('recordedView.overwriteSelected')) status.text = '没有可覆盖的当前点';
            syncPointStatus();
        });
        removePoint.on('click', () => {
            events.invoke('recordedView.removeSelected');
            status.text = '已删除当前人工关键点';
            syncPointStatus();
        });
        const stepPoint = (direction: number) => {
            const state = recordedState();
            if (!state || state.selectedIndex < 0) return;
            events.invoke('recordedView.select', state.selectedIndex + direction);
            syncPointStatus();
        };
        previousPoint.on('click', () => stepPoint(-1));
        nextPoint.on('click', () => stepPoint(1));
        targetCount.on('change', (value: number) => {
            if (!events.invoke('recordedView.setTargetCount', value)) {
                const state = recordedState();
                if (state) targetCount.value = state.targetCount;
                status.text = '最终相机数量必须是不小于人工关键点数量的正整数';
            }
        });
        showTarget.on('change', (value: boolean) => events.invoke('recordedView.setShowTarget', value));
        showValidation.on('change', (value: boolean) => events.invoke('recordedView.setShowValidation', value));
        finishPoints.on('click', () => {
            try {
                const result = events.invoke('recordedView.finish') as RecordedViewState;
                status.text = result.validation?.valid ?
                    `已生成 ${result.targetCount} 个相机，COLMAP 回读检验通过` :
                    'COLMAP 回读轨迹与目标轨迹存在偏差';
            } catch (error) {
                status.text = `人工轨迹生成失败：${error instanceof Error ? error.message : error}`;
            }
            syncPointStatus();
        });
        continuePoints.on('click', () => {
            events.invoke('recordedView.continue');
            status.text = '已恢复人工打点';
            syncPointStatus();
        });
        const startPreview = () => {
            if (events.invoke('recordedView.preview')) {
                setPreviewUi(true);
                return true;
            }
            status.text = '请先结束打点并生成插值轨迹';
            return false;
        };
        events.function('trajectoryPlanner.startPreview', startPreview);
        previewPoints.on('click', startPreview);
        clearPoints.on('click', () => {
            events.invoke('recordedView.clear');
            status.text = '已清空人工关键点和验证轨迹';
            syncPointStatus();
        });
        previewStop.addEventListener('click', stopPreview);
        window.addEventListener('keydown', (event) => {
            if (previewUiActive && event.key === 'Escape') stopPreview();
        });

        openExport.on('click', () => events.fire('camera.parametersPanel.show'));
        showTimeline.on('click', () => events.fire('timelinePanel.show'));
        close.on('click', () => {
            this.hidden = true;
            events.fire('trajectoryPlanner.visible', false);
        });

        events.on('recordedView.changed', syncPointStatus);
        events.on('realCameraDataset.changed', syncRealDataset);
        events.on('imagePoseMatch.progress', (progress: {
            phase: 'query' | 'render' | 'compare',
            stage?: 'full',
            completed: number,
            total: number,
            realCandidateCount: number,
            virtualCandidateCount: number
        }) => {
            if (!matchingPoseImage) return;
            if (progress.phase === 'query') {
                status.text = `正在分析图片：真实 ${progress.realCandidateCount} 个，` +
                    `虚拟 ${progress.virtualCandidateCount} 个候选...`;
            } else if (progress.phase === 'render') {
                status.text = `全候选画面检索 ${progress.completed}/${progress.total}...`;
            } else {
                status.text = `正在比较真实与虚拟候选 ${progress.completed}/${progress.total}...`;
            }
        });
        events.on('timeline.playing', (playing: boolean) => {
            if (previewUiActive && !playing) setPreviewUi(false);
        });

        const show = () => {
            events.fire('camera.setShowPoses', true);
            this.hidden = false;
            syncPointStatus();
            events.fire('trajectoryPlanner.visible', true);
        };
        events.on('trajectoryPlanner.show', show);
        events.on('trajectoryPlanner.hide', () => {
            this.hidden = true;
            events.fire('trajectoryPlanner.visible', false);
        });
        events.on('trajectoryPlanner.toggle', () => {
            if (this.hidden) show();
            else {
                this.hidden = true;
                events.fire('trajectoryPlanner.visible', false);
            }
        });

        const positionStorageKey = 'supersplat.trajectory-panel-position';
        let dragging = false;
        let dragStartX = 0;
        let dragStartY = 0;
        let panelStartLeft = 0;
        let panelStartTop = 0;
        const clampPosition = (left: number, top: number) => {
            const parent = this.dom.parentElement;
            if (!parent || window.matchMedia('(max-width: 700px)').matches) return;
            const nextLeft = Math.max(8, Math.min(parent.clientWidth - this.dom.offsetWidth - 8, left));
            const nextTop = Math.max(8, Math.min(parent.clientHeight - this.dom.offsetHeight - 8, top));
            this.dom.style.right = 'auto';
            this.dom.style.left = `${nextLeft}px`;
            this.dom.style.top = `${nextTop}px`;
        };
        const restorePosition = () => {
            try {
                const saved = JSON.parse(window.localStorage.getItem(positionStorageKey) ?? 'null');
                if (Number.isFinite(saved?.left) && Number.isFinite(saved?.top)) clampPosition(saved.left, saved.top);
            } catch {
                // Ignore invalid or unavailable local storage.
            }
        };
        const savePosition = () => {
            if (!this.dom.style.left) return;
            try {
                window.localStorage.setItem(positionStorageKey, JSON.stringify({
                    left: Number.parseFloat(this.dom.style.left),
                    top: Number.parseFloat(this.dom.style.top)
                }));
            } catch {
                // A blocked local storage must not affect dragging.
            }
        };
        header.dom.addEventListener('pointerdown', (event: PointerEvent) => {
            if (!event.isPrimary || event.button !== 0 || close.dom.contains(event.target as Node)) return;
            const parent = this.dom.parentElement;
            if (!parent || window.matchMedia('(max-width: 700px)').matches) return;
            const rect = this.dom.getBoundingClientRect();
            const parentRect = parent.getBoundingClientRect();
            dragging = true;
            dragStartX = event.clientX;
            dragStartY = event.clientY;
            panelStartLeft = rect.left - parentRect.left;
            panelStartTop = rect.top - parentRect.top;
            this.class.add('dragging');
            header.dom.setPointerCapture(event.pointerId);
            event.preventDefault();
        });
        header.dom.addEventListener('pointermove', (event: PointerEvent) => {
            if (!dragging) return;
            clampPosition(
                panelStartLeft + event.clientX - dragStartX,
                panelStartTop + event.clientY - dragStartY
            );
        });
        const stopDragging = (event?: PointerEvent) => {
            if (!dragging) return;
            dragging = false;
            this.class.remove('dragging');
            if (event && header.dom.hasPointerCapture(event.pointerId)) header.dom.releasePointerCapture(event.pointerId);
            savePosition();
        };
        header.dom.addEventListener('pointerup', stopDragging);
        header.dom.addEventListener('lostpointercapture', () => stopDragging());
        window.addEventListener('resize', () => {
            if (window.matchMedia('(max-width: 700px)').matches) {
                this.dom.style.removeProperty('left');
                this.dom.style.removeProperty('right');
                this.dom.style.removeProperty('top');
            } else if (this.dom.style.left) {
                clampPosition(Number.parseFloat(this.dom.style.left), Number.parseFloat(this.dom.style.top));
            } else {
                restorePosition();
            }
        });

        window.setTimeout(restorePosition, 0);
        syncPointStatus();
        syncRealDataset();
    }
}

export { TrajectoryPlannerPanel };
