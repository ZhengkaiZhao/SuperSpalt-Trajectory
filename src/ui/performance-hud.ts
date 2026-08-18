import { Button, Container, Label } from '@playcanvas/pcui';

import { version } from '../../package.json';
import {
    describeColmapW2cPose,
    formatColmapPoseClipboard,
    formatColmapPoseSummary,
    type ColmapW2cComponents
} from '../colmap-pose-presentation';
import { Events } from '../events';

type RendererInfo = {
    backend: string;
    gpu: string;
};

type RendererMetrics = {
    fps: number;
    sortMs: number;
    gaussians: number;
    interactive: boolean;
};

const copyText = async (text: string) => {
    if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        return;
    }
    const input = document.createElement('textarea');
    input.value = text;
    input.style.position = 'fixed';
    input.style.opacity = '0';
    document.body.appendChild(input);
    input.select();
    const copied = document.execCommand('copy');
    input.remove();
    if (!copied) throw new Error('Clipboard copy is unavailable');
};

class PerformanceHud extends Container {
    constructor(events: Events) {
        super({ id: 'performance-hud' });

        ['pointerdown', 'pointerup', 'click', 'dblclick'].forEach((eventName) => {
            this.dom.addEventListener(eventName, event => event.stopPropagation());
        });

        const primaryRow = new Container({ id: 'performance-primary' });
        const fpsLabel = new Label({ id: 'performance-fps', text: '-- FPS' });
        const primaryMiddle = new Container({ id: 'performance-primary-middle' });
        const adapterLabel = new Label({ id: 'performance-adapter', text: 'GPU' });
        const trajectoryLabel = new Label({ id: 'performance-trajectory', text: '轨迹 A · 0 点' });
        const poseToggle = new Button({ id: 'performance-pose-toggle', text: 'POSE' });
        poseToggle.dom.setAttribute('aria-label', '切换实时 COLMAP W2C 相机位姿');
        poseToggle.dom.setAttribute('aria-pressed', 'false');
        poseToggle.dom.setAttribute('title', '实时显示当前相机的 COLMAP/OpenCV W2C 位姿');
        const pointLabel = new Label({ id: 'performance-point', text: '', hidden: true });
        const detailLabel = new Label({ id: 'performance-detail', text: 'GPU initializing' });
        const poseRow = new Container({ id: 'performance-pose', hidden: true });
        const poseValue = new Label({ id: 'performance-pose-value', text: '' });
        const poseCopy = new Button({ id: 'performance-pose-copy', icon: 'E351' });
        poseCopy.dom.setAttribute('aria-label', '复制当前相机位姿');
        poseCopy.dom.setAttribute('title', '复制 C_world、forward、q_w2c 和 t_w2c');
        primaryRow.append(fpsLabel);
        primaryMiddle.append(adapterLabel);
        primaryMiddle.append(trajectoryLabel);
        primaryRow.append(primaryMiddle);
        primaryRow.append(poseToggle);
        poseRow.append(poseValue);
        poseRow.append(poseCopy);
        this.append(primaryRow);
        this.append(pointLabel);
        this.append(detailLabel);
        this.append(poseRow);

        let lastFps = 0;
        let renderer: RendererInfo = { backend: 'GPU', gpu: '' };
        let width = 0;
        let height = 0;
        let sortMs = 0;
        let gaussians = 0;
        let interactive = false;
        let pointTimer: number | null = null;
        let poseEnabled = false;
        let poseClipboardText = '';
        let copyTimer: number | null = null;
        let lastDetailText = '';
        let lastFpsText = '';
        let lastPoseValues: number[] | null = null;
        let lastPoseError = '';

        const compactInteger = (value: number) => {
            return value >= 1e6 ? `${(value / 1e6).toFixed(2)}M` :
                value >= 1e3 ? `${Math.round(value / 1e3)}K` : `${Math.round(value)}`;
        };

        const updateText = () => {
            const fpsText = `${Math.round(lastFps)} FPS`;
            const detailText = [
                renderer.backend,
                `v${version}`,
                width > 0 && height > 0 ? `${width}x${height}` : '',
                gaussians > 0 ? `${compactInteger(gaussians)} G` : '',
                sortMs > 0 ? `sort ${sortMs.toFixed(1)}ms` : '',
                interactive ? 'dynamic res' : ''
            ].filter(Boolean).join(' | ');
            if (fpsText !== lastFpsText) {
                fpsLabel.text = fpsText;
                lastFpsText = fpsText;
            }
            if (detailText !== lastDetailText) {
                detailLabel.text = detailText;
                lastDetailText = detailText;
            }
        };

        const updatePose = () => {
            if (!poseEnabled) return;
            try {
                const pose = events.invoke(
                    'camera.buildCurrentFrameColmapW2c',
                    1,
                    'Current_View.png'
                ) as ColmapW2cComponents | undefined;
                if (!pose) throw new Error('Camera pose is unavailable');
                const values = [
                    pose.qw_w2c, pose.qx_w2c, pose.qy_w2c, pose.qz_w2c,
                    pose.tx_w2c, pose.ty_w2c, pose.tz_w2c
                ];
                if (lastPoseValues?.every((value, index) => value === values[index])) return;
                const presentation = describeColmapW2cPose(pose);
                poseValue.text = formatColmapPoseSummary(presentation);
                poseClipboardText = formatColmapPoseClipboard(presentation);
                if (!poseCopy.enabled) poseCopy.enabled = true;
                lastPoseValues = values;
                lastPoseError = '';
            } catch (error) {
                const message = `Pose unavailable: ${error instanceof Error ? error.message : error}`;
                if (message !== lastPoseError) poseValue.text = message;
                poseClipboardText = '';
                if (poseCopy.enabled) poseCopy.enabled = false;
                lastPoseValues = null;
                lastPoseError = message;
            }
        };

        poseToggle.on('click', () => {
            poseEnabled = !poseEnabled;
            poseToggle.class[poseEnabled ? 'add' : 'remove']('active');
            poseToggle.dom.setAttribute('aria-pressed', String(poseEnabled));
            poseRow.hidden = !poseEnabled;
            if (poseEnabled) {
                lastPoseValues = null;
                updatePose();
            }
        });
        poseCopy.on('click', async () => {
            if (!poseClipboardText) return;
            try {
                await copyText(poseClipboardText);
                poseCopy.class.add('copied');
                poseCopy.dom.setAttribute('title', '已复制当前相机位姿');
                if (copyTimer !== null) window.clearTimeout(copyTimer);
                copyTimer = window.setTimeout(() => {
                    poseCopy.class.remove('copied');
                    poseCopy.dom.setAttribute('title', '复制 C_world、forward、q_w2c 和 t_w2c');
                    copyTimer = null;
                }, 1200);
            } catch (error) {
                poseCopy.dom.setAttribute('title', `复制失败：${error instanceof Error ? error.message : error}`);
            }
        });

        events.on('renderer.info', (info: RendererInfo) => {
            renderer = info;
            const integrated = /intel|uhd|integrated/i.test(renderer.gpu);
            adapterLabel.text = /nvidia|rtx/i.test(renderer.gpu) ? 'RTX 独立显卡' :
                integrated ? '集成显卡' : renderer.gpu || 'GPU';
            updateText();
        });

        events.on('renderer.metrics', (metrics: RendererMetrics) => {
            if (metrics.fps > 0) lastFps = metrics.fps;
            if (metrics.sortMs > 0) {
                sortMs = metrics.sortMs;
            }
            gaussians = metrics.gaussians;
            interactive = metrics.interactive;
        });

        events.on('recordedView.changed', (state: {
            activeTrajectoryLabel: string,
            trajectoryCount: number,
            keyframeCount: number,
            selectedIndex: number,
            finished: boolean
        }) => {
            const selected = state.selectedIndex >= 0 ? ` · ${state.activeTrajectoryLabel}${state.selectedIndex + 1}` : '';
            trajectoryLabel.text = `轨迹 ${state.activeTrajectoryLabel} · ${state.keyframeCount} 点${selected}` +
                `${state.trajectoryCount > 1 ? ` · 共 ${state.trajectoryCount} 条` : ''}${state.finished ? ' · 已完成' : ''}`;
        });
        events.on('recordedView.pointFocused', (detail: {
            action: 'recorded' | 'selected' | 'updated',
            trajectoryLabel: string,
            index: number,
            position: [number, number, number]
        }) => {
            const action = detail.action === 'recorded' ? '记录' : detail.action === 'updated' ? '更新' : '选择';
            const coordinates = detail.position
            .map((value, index) => `${'XYZ'[index]} ${value.toFixed(3)}`).join('  ');
            pointLabel.text = `${action} ${detail.trajectoryLabel}${detail.index + 1} · ${coordinates}`;
            pointLabel.hidden = false;
            if (pointTimer !== null) window.clearTimeout(pointTimer);
            pointTimer = window.setTimeout(() => {
                pointLabel.hidden = true;
                pointTimer = null;
            }, 2800);
        });

        let elapsed = 0;
        let poseElapsed = 0;
        events.on('update', (deltaTime: number) => {
            elapsed += deltaTime;
            if (elapsed >= 0.5) {
                elapsed %= 0.5;
                const target = events.invoke('targetSize') as { width: number, height: number } | undefined;
                width = target?.width ?? 0;
                height = target?.height ?? 0;
                updateText();
            }
            if (poseEnabled && !document.hidden) {
                poseElapsed += deltaTime;
                if (poseElapsed >= 0.1) {
                    poseElapsed %= 0.1;
                    updatePose();
                }
            }
        });
    }
}

export { PerformanceHud };
