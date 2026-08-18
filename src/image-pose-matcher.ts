import { Vec3 } from 'playcanvas';

import type { Pose } from './camera-poses';
import type { Events } from './events';
import { imagePoseMatchStatistics, type ImagePoseSearchMode } from './image-pose-match-ranking';
import { coarseRotationAngles, normalizeRotationDegrees, refinedRotationAngles } from './image-pose-rotation-search';
import type { RealCameraPose } from './real-camera-dataset';

const descriptorSize = 48;
const thumbnailSize = 48;
const maximumCachedRenderedViews = 512;
const maximumConcurrentImageDecodes = 6;
const maximumRenderedBatchSize = 64;

type SerializablePose = {
    position: [number, number, number],
    target: [number, number, number],
    fov: number
};

type MatchCandidate = {
    id: string,
    label: string,
    source: 'real' | 'virtual',
    pose: SerializablePose,
    groupId: string,
    sequenceIndex: number,
    file?: File,
    cacheKey?: string
};

type ScoredCandidate = MatchCandidate & {
    score: number,
    rotationDegrees: number
};

type ImageDescriptor = {
    tone: Float32Array,
    edge: Float32Array,
    valid: boolean
};

type ImagePoseMatchResult = {
    pose: SerializablePose,
    source: 'real' | 'virtual',
    label: string,
    score: number,
    probability: number,
    margin: number,
    confidence: 'high' | 'medium' | 'low',
    rotationDegrees: number,
    candidateCount: number,
    evaluatedCandidateCount: number,
    renderedCandidateCount: number,
    realCandidateCount: number,
    virtualCandidateCount: number,
    searchMode: ImagePoseSearchMode,
    alternatives: { label: string, source: 'real' | 'virtual', score: number, probability: number }[]
};

const maskCoordinates = (() => {
    const result: [number, number][] = [];
    const center = (descriptorSize - 1) * 0.5;
    const radiusSq = (descriptorSize * 0.45) ** 2;
    for (let y = 1; y < descriptorSize - 1; y++) {
        for (let x = 1; x < descriptorSize - 1; x++) {
            if ((x - center) ** 2 + (y - center) ** 2 <= radiusSq) result.push([x, y]);
        }
    }
    return result;
})();

const normalizeValues = (values: number[]) => {
    const mean = values.reduce((sum, value) => sum + value, 0) / Math.max(values.length, 1);
    const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) /
        Math.max(values.length, 1);
    const deviation = Math.sqrt(variance);
    const result = new Float32Array(values.length);
    if (deviation > 1e-6) {
        for (let index = 0; index < values.length; index++) {
            result[index] = (values[index] - mean) / deviation;
        }
    }
    return { values: result, deviation };
};

const describeGray = (gray: Float32Array): ImageDescriptor => {
    const toneValues: number[] = [];
    const edgeValues: number[] = [];
    for (const [x, y] of maskCoordinates) {
        const index = y * descriptorSize + x;
        toneValues.push(gray[index]);
        edgeValues.push(Math.hypot(
            gray[index + 1] - gray[index - 1],
            gray[index + descriptorSize] - gray[index - descriptorSize]
        ));
    }
    const tone = normalizeValues(toneValues);
    const edge = normalizeValues(edgeValues);
    return {
        tone: tone.values,
        edge: edge.values,
        valid: tone.deviation > 0.015 || edge.deviation > 0.01
    };
};

const imageSourceToGray = (source: HTMLCanvasElement | ImageBitmap, width: number, height: number) => {
    const canvas = document.createElement('canvas');
    canvas.width = descriptorSize;
    canvas.height = descriptorSize;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) throw new Error('Unable to create image matching canvas');
    const scale = Math.max(descriptorSize / width, descriptorSize / height);
    const drawWidth = width * scale;
    const drawHeight = height * scale;
    context.fillStyle = '#000000';
    context.fillRect(0, 0, descriptorSize, descriptorSize);
    context.drawImage(
        source,
        (descriptorSize - drawWidth) * 0.5,
        (descriptorSize - drawHeight) * 0.5,
        drawWidth,
        drawHeight
    );
    const pixels = context.getImageData(0, 0, descriptorSize, descriptorSize).data;
    const gray = new Float32Array(descriptorSize * descriptorSize);
    for (let index = 0; index < gray.length; index++) {
        const offset = index * 4;
        gray[index] = (pixels[offset] * 0.2126 + pixels[offset + 1] * 0.7152 +
            pixels[offset + 2] * 0.0722) / 255;
    }
    return gray;
};

const fileToGray = async (file: File) => {
    const bitmap = await createImageBitmap(file);
    try {
        return imageSourceToGray(bitmap, bitmap.width, bitmap.height);
    } finally {
        bitmap.close();
    }
};

const pixelsToGray = (pixels: Uint8Array, width: number, height: number) => {
    const source = document.createElement('canvas');
    source.width = width;
    source.height = height;
    const context = source.getContext('2d');
    if (!context) throw new Error('Unable to create virtual camera matching canvas');
    context.putImageData(new ImageData(new Uint8ClampedArray(pixels), width, height), 0, 0);
    return imageSourceToGray(source, width, height);
};

const rotateGray = (source: Float32Array, degrees: number) => {
    if (degrees === 0) return source;
    const result = new Float32Array(source.length);
    const radians = degrees * Math.PI / 180;
    const cosine = Math.cos(radians);
    const sine = Math.sin(radians);
    const center = (descriptorSize - 1) * 0.5;
    for (let y = 0; y < descriptorSize; y++) {
        for (let x = 0; x < descriptorSize; x++) {
            const dx = x - center;
            const dy = y - center;
            const sourceX = cosine * dx + sine * dy + center;
            const sourceY = -sine * dx + cosine * dy + center;
            const x0 = Math.floor(sourceX);
            const y0 = Math.floor(sourceY);
            if (x0 < 0 || y0 < 0 || x0 >= descriptorSize - 1 || y0 >= descriptorSize - 1) continue;
            const amountX = sourceX - x0;
            const amountY = sourceY - y0;
            const top = source[y0 * descriptorSize + x0] * (1 - amountX) +
                source[y0 * descriptorSize + x0 + 1] * amountX;
            const bottom = source[(y0 + 1) * descriptorSize + x0] * (1 - amountX) +
                source[(y0 + 1) * descriptorSize + x0 + 1] * amountX;
            result[y * descriptorSize + x] = top * (1 - amountY) + bottom * amountY;
        }
    }
    return result;
};

const correlation = (left: Float32Array, right: Float32Array) => {
    let sum = 0;
    for (let index = 0; index < left.length; index++) sum += left[index] * right[index];
    return sum / Math.max(left.length, 1);
};

const descriptorSimilarity = (left: ImageDescriptor, right: ImageDescriptor) => {
    if (!left.valid || !right.valid) return Number.NEGATIVE_INFINITY;
    const tone = Math.max(-1, Math.min(1, correlation(left.tone, right.tone)));
    const edge = Math.max(-1, Math.min(1, correlation(left.edge, right.edge)));
    return (0.65 * tone + 0.35 * edge + 1) * 0.5;
};

const runInBatches = async <T>(values: T[], batchSize: number, action: (value: T) => Promise<void>) => {
    for (let start = 0; start < values.length; start += batchSize) {
        await Promise.all(values.slice(start, start + batchSize).map(action));
    }
};

const toSerializablePose = (pose: Pose | RealCameraPose): SerializablePose => ({
    position: [pose.position.x, pose.position.y, pose.position.z],
    target: [pose.target.x, pose.target.y, pose.target.z],
    fov: pose.fov ?? 60
});

const poseCacheKey = (pose: SerializablePose) => (
    [...pose.position, ...pose.target, pose.fov].map(value => value.toFixed(5)).join(',')
);

const registerImagePoseMatcherEvents = (events: Events) => {
    const realDescriptorCache = new WeakMap<File, ImageDescriptor>();
    const fileDigestCache = new WeakMap<File, Promise<string>>();
    const renderedDescriptorCache = new Map<string, ImageDescriptor>();
    let running = false;

    const fileDigest = (file: File) => {
        let digest = fileDigestCache.get(file);
        if (!digest) {
            digest = file.arrayBuffer().then(async (buffer) => {
                const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', buffer));
                return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
            });
            fileDigestCache.set(file, digest);
        }
        return digest;
    };

    const clearRenderedCache = () => renderedDescriptorCache.clear();
    const cacheRendered = (key: string, descriptor: ImageDescriptor) => {
        if (renderedDescriptorCache.size >= maximumCachedRenderedViews) {
            const oldest = renderedDescriptorCache.keys().next().value;
            if (oldest !== undefined) renderedDescriptorCache.delete(oldest);
        }
        renderedDescriptorCache.set(key, descriptor);
    };

    const candidates = () => {
        const result: MatchCandidate[] = [];
        const canRender = events.invoke('scene.empty') === false;
        const realPoseKeys = new Set<string>();
        const real = (events.invoke('realCameraDataset.renderData') as RealCameraPose[] | undefined) ?? [];
        real.forEach((pose) => {
            const serialized = toSerializablePose(pose);
            const poseKey = poseCacheKey(serialized);
            realPoseKeys.add(poseKey);
            // Prefer the original COLMAP image. If that file was not supplied,
            // render the loaded Gaussian from this real camera instead.
            if (!pose.file && !canRender) return;
            result.push({
                id: `real:${pose.imageId}:${pose.imageName}`,
                label: `真实相机 ${pose.imageName}`,
                source: 'real',
                pose: serialized,
                groupId: 'real-dataset',
                sequenceIndex: pose.imageId,
                file: pose.file,
                cacheKey: pose.file ? undefined : poseKey
            });
        });

        if (!canRender) return result;
        const virtualPoseKeys = new Set<string>();
        const addVirtual = (pose: Pose, label: string, id: string, groupId: string, sequenceIndex: number) => {
            const serialized = toSerializablePose(pose);
            const cacheKey = poseCacheKey(serialized);
            if (virtualPoseKeys.has(cacheKey)) return;
            virtualPoseKeys.add(cacheKey);
            result.push({ id, label, source: 'virtual', pose: serialized, groupId, sequenceIndex, cacheKey });
        };
        const recorded = events.invoke('recordedView.renderData') as {
            trajectories?: { id: string, label: string, keyframes: Pose[], targetPoses: Pose[] }[]
        } | undefined;
        recorded?.trajectories?.forEach((trajectory) => {
            const poses = trajectory.targetPoses.length > 0 ? trajectory.targetPoses : trajectory.keyframes;
            poses.forEach((pose, index) => addVirtual(
                pose,
                `虚拟轨迹 ${trajectory.label}${index + 1}`,
                `recorded:${trajectory.id}:${index}`,
                `recorded:${trajectory.id}`,
                index
            ));
        });
        const preview = (events.invoke('trajectory.previewPoses') as Pose[] | undefined) ?? [];
        preview.forEach((pose, index) => addVirtual(
            pose, `规划轨迹相机 ${index + 1}`, `planner:${index}`, 'planner', index
        ));

        // SuperSplat's regular images.txt importer stores COLMAP cameras on the
        // timeline. Anything already owned by a manual/planner trajectory is
        // virtual; the remaining timeline poses are real reference cameras.
        const timeline = (events.invoke('camera.poses') as Pose[] | undefined) ?? [];
        timeline.slice().sort((a, b) => a.frame - b.frame).forEach((pose, index) => {
            const serialized = toSerializablePose(pose);
            const cacheKey = poseCacheKey(serialized);
            if (virtualPoseKeys.has(cacheKey) || realPoseKeys.has(cacheKey)) return;
            realPoseKeys.add(cacheKey);
            result.push({
                id: `timeline:${pose.frame}:${index}`,
                label: `真实相机 ${pose.name || index + 1}`,
                source: 'real',
                pose: serialized,
                groupId: 'timeline-real',
                sequenceIndex: index,
                cacheKey
            });
        });
        return result;
    };

    events.function('imagePoseMatch.candidateState', () => {
        const allCandidates = candidates();
        const real = allCandidates.filter(candidate => candidate.source === 'real');
        const virtual = allCandidates.filter(candidate => candidate.source === 'virtual');
        return {
            candidateCount: allCandidates.length,
            realCandidateCount: real.length,
            virtualCandidateCount: virtual.length,
            realLabels: real.map(candidate => candidate.label),
            virtualLabels: virtual.map(candidate => candidate.label)
        };
    });

    events.function('imagePoseMatch.find', async (file: File): Promise<ImagePoseMatchResult> => {
        if (running) throw new Error('另一张图片正在匹配，请等待当前匹配完成');
        running = true;
        try {
            const allCandidates = candidates();
            if (allCandidates.length === 0) {
                throw new Error('没有候选相机；请先载入 COLMAP 图片或生成虚拟轨迹');
            }
            const realCandidateCount = allCandidates.filter(candidate => candidate.source === 'real').length;
            const virtualCandidateCount = allCandidates.length - realCandidateCount;
            events.fire('imagePoseMatch.progress', {
                phase: 'query',
                completed: 0,
                total: allCandidates.length,
                realCandidateCount,
                virtualCandidateCount
            });

            // Resolve byte-identical source images before decoding pixels or
            // building rotation descriptors. This is the common real-camera
            // lookup path and should return without entering the visual search.
            const fileCandidates = allCandidates.filter(candidate => !!candidate.file);
            const likelyOriginals = fileCandidates.filter(candidate => (
                candidate.file === file || (
                    candidate.file?.name.toLowerCase() === file.name.toLowerCase() &&
                    candidate.file.size === file.size
                )
            ));
            const exactOriginals: MatchCandidate[] = likelyOriginals.filter(candidate => candidate.file === file);
            const possibleExact = likelyOriginals.filter(candidate => candidate.file !== file);
            if (possibleExact.length > 0) {
                try {
                    const queryDigest = await fileDigest(file);
                    await runInBatches(possibleExact, maximumConcurrentImageDecodes, async (candidate) => {
                        if (await fileDigest(candidate.file) === queryDigest) exactOriginals.push(candidate);
                    });
                } catch (error) {
                    console.warn('Unable to verify an exact source image; continuing with visual matching', error);
                }
            }
            if (exactOriginals.length > 0) {
                const best = exactOriginals[0];
                const statistics = imagePoseMatchStatistics(
                    exactOriginals.map(() => 1),
                    'exact-real',
                    false
                );
                return {
                    pose: best.pose,
                    source: best.source,
                    label: best.label,
                    score: 1,
                    probability: statistics.probability,
                    margin: statistics.margin,
                    confidence: statistics.confidence,
                    rotationDegrees: 0,
                    candidateCount: allCandidates.length,
                    evaluatedCandidateCount: exactOriginals.length,
                    renderedCandidateCount: 0,
                    realCandidateCount,
                    virtualCandidateCount,
                    searchMode: 'exact-real',
                    alternatives: exactOriginals.slice(1, 4).map((candidate, index) => ({
                        label: candidate.label,
                        source: candidate.source,
                        score: 1,
                        probability: Math.min(statistics.probabilities[index + 1], 0.999)
                    }))
                };
            }

            const queryGray = await fileToGray(file);
            const queryDescriptorCache = new Map<number, ImageDescriptor>();
            const queryDescriptor = (angle: number) => {
                const normalized = normalizeRotationDegrees(angle);
                let descriptor = queryDescriptorCache.get(normalized);
                if (!descriptor) {
                    descriptor = describeGray(rotateGray(queryGray, normalized));
                    queryDescriptorCache.set(normalized, descriptor);
                }
                return descriptor;
            };
            if (!queryDescriptor(0).valid) throw new Error('输入图片缺少可用于匹配的画面细节');

            const scored: ScoredCandidate[] = [];
            const scoredIds = new Set<string>();
            let compared = 0;
            let renderedCandidateCount = 0;
            const reportCompared = () => {
                compared++;
                events.fire('imagePoseMatch.progress', {
                    phase: 'compare',
                    completed: compared,
                    total: allCandidates.length,
                    realCandidateCount,
                    virtualCandidateCount
                });
            };
            const scoreCandidate = (candidate: MatchCandidate, reference: ImageDescriptor | undefined) => {
                if (scoredIds.has(candidate.id)) return;
                scoredIds.add(candidate.id);
                if (!reference?.valid) {
                    reportCompared();
                    return;
                }
                let bestScore = Number.NEGATIVE_INFINITY;
                let bestRotation = 0;
                for (const angle of coarseRotationAngles) {
                    const score = descriptorSimilarity(queryDescriptor(angle), reference);
                    if (score > bestScore) {
                        bestScore = score;
                        bestRotation = angle;
                    }
                }
                const coarseBestRotation = bestRotation;
                for (const angle of refinedRotationAngles(coarseBestRotation)) {
                    if (angle === coarseBestRotation) continue;
                    const score = descriptorSimilarity(queryDescriptor(angle), reference);
                    if (score > bestScore) {
                        bestScore = score;
                        bestRotation = angle;
                    }
                }
                scored.push({ ...candidate, score: bestScore, rotationDegrees: bestRotation });
                reportCompared();
            };
            const sortedScores = () => scored.sort((left, right) => right.score - left.score);
            const buildResult = (searchMode: ImagePoseMatchResult['searchMode']): ImagePoseMatchResult => {
                sortedScores();
                const best = scored[0];
                if (!best || !Number.isFinite(best.score)) {
                    throw new Error('真实或虚拟相机候选中没有可比较的有效画面');
                }
                const completeSearch = compared >= allCandidates.length;
                const { probabilities, probability, margin, confidence } = imagePoseMatchStatistics(
                    scored.map(candidate => candidate.score),
                    searchMode,
                    completeSearch
                );
                return {
                    pose: best.pose,
                    source: best.source,
                    label: best.label,
                    score: best.score,
                    probability,
                    margin,
                    confidence,
                    rotationDegrees: best.rotationDegrees,
                    candidateCount: allCandidates.length,
                    evaluatedCandidateCount: compared,
                    renderedCandidateCount,
                    realCandidateCount,
                    virtualCandidateCount,
                    searchMode,
                    alternatives: scored.slice(1, 4).map((candidate, index) => ({
                        label: candidate.label,
                        source: candidate.source,
                        score: candidate.score,
                        probability: Math.min(probabilities[index + 1], 0.999)
                    }))
                };
            };

            const scoreFileCandidates = (values: MatchCandidate[]) => runInBatches(
                values,
                maximumConcurrentImageDecodes,
                async (candidate) => {
                    try {
                        let reference = realDescriptorCache.get(candidate.file);
                        if (!reference) {
                            reference = describeGray(await fileToGray(candidate.file));
                            realDescriptorCache.set(candidate.file, reference);
                        }
                        scoreCandidate(candidate, reference);
                    } catch {
                        scoreCandidate(candidate, undefined);
                    }
                }
            );
            await scoreFileCandidates(fileCandidates);

            const renderedCandidates = allCandidates.filter(candidate => !candidate.file && candidate.cacheKey);
            renderedCandidates.forEach((candidate) => {
                const reference = renderedDescriptorCache.get(candidate.cacheKey);
                if (reference) scoreCandidate(candidate, reference);
            });
            const missingRendered = renderedCandidates.filter(candidate => (
                candidate.cacheKey && !renderedDescriptorCache.has(candidate.cacheKey)
            ));
            const renderAndScore = async (batch: MatchCandidate[], completedBefore: number, total: number) => {
                if (batch.length === 0) return;
                const pixels = await events.invoke(
                    'render.poseThumbnails',
                    batch.map(candidate => candidate.pose),
                    thumbnailSize,
                    thumbnailSize,
                    (completed: number) => events.fire('imagePoseMatch.progress', {
                        phase: 'render',
                        stage: 'full',
                        completed: completedBefore + completed,
                        total,
                        realCandidateCount,
                        virtualCandidateCount
                    })
                ) as Uint8Array[];
                pixels.forEach((data, index) => {
                    const candidate = batch[index];
                    const descriptor = describeGray(pixelsToGray(data, thumbnailSize, thumbnailSize));
                    cacheRendered(candidate.cacheKey!, descriptor);
                    renderedCandidateCount++;
                    scoreCandidate(candidate, descriptor);
                });
                sortedScores();
            };

            for (let start = 0; start < missingRendered.length; start += maximumRenderedBatchSize) {
                const batch = missingRendered.slice(start, start + maximumRenderedBatchSize);
                await renderAndScore(batch, start, missingRendered.length);
            }
            return buildResult('full');
        } finally {
            running = false;
        }
    });

    events.on('scene.clear', clearRenderedCache);
    events.on('updated:splat', clearRenderedCache);
    events.on('bgClr', clearRenderedCache);
    events.on('camera.tonemapping', clearRenderedCache);
};

export { registerImagePoseMatcherEvents };
export type { ImagePoseMatchResult };
