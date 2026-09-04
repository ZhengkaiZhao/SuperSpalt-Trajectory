import {
    ADDRESS_CLAMP_TO_EDGE,
    PIXELFORMAT_RGBA32F,
    SEMANTIC_POSITION,
    drawQuadWithShader,
    BlendState,
    GraphicsDevice,
    Mat4,
    RenderTarget,
    ScopeSpace,
    Shader,
    ShaderUtils,
    Texture,
    Vec3
} from 'playcanvas';

import { BufferPool } from './buffer-pool';
import { NUM_BINS } from './histogram-config';
import type { SelectByRangeOptions } from './select-by-range';
import {
    fullscreenVS,
    valueMapFS
} from '../shaders/histogram-shaders';
import { Splat } from '../splat';

const identity = new Mat4();
const zeroVec3 = new Vec3();

// number of SH coefficients per RGB band, indexed by GSplatResource.shBands.
const SH_NUM_COEFFS: { [k: number]: number } = { 0: 0, 1: 3, 2: 8, 3: 15 };

type CalcHistogramOptions = {
    entityMatrix?: Mat4;
    viewMatrix?: Mat4;
    viewProjection?: Mat4;
    cameraPos?: Vec3;
    onScreenOnly?: boolean;
};

type CalcHistogramResult = {
    selected: Float32Array;     // length numBins
    unselected: Float32Array;   // length numBins
    min: number;
    max: number;
    numValues: number;
};

const resolve = (scope: ScopeSpace, values: any) => {
    for (const key in values) {
        scope.resolve(key).setValue(values[key]);
    }
};

const getShBands = (splat: Splat): number => {
    return (splat.resource as any).shBands ?? 0;
};

class CalcHistogram {
    private device: GraphicsDevice;

    // Compile per SH_BANDS so each variant declares only the SH samplers it reads.
    private valueShaders: Map<number, Shader> = new Map();

    private valueTex: Texture = null;
    private valueRT: RenderTarget = null;

    private valueData = new Float32Array(0);

    constructor(device: GraphicsDevice) {
        this.device = device;
    }

    private ensureValueResources(width: number, height: number) {
        if (this.valueTex?.width === width && this.valueTex.height === height) return;

        this.valueRT?.destroy();
        this.valueTex?.destroy();

        this.valueTex = new Texture(this.device, {
            name: 'histValues',
            width,
            height,
            format: PIXELFORMAT_RGBA32F,
            mipmaps: false,
            addressU: ADDRESS_CLAMP_TO_EDGE,
            addressV: ADDRESS_CLAMP_TO_EDGE
        });
        this.valueRT = new RenderTarget({ colorBuffer: this.valueTex, depth: false });
        this.valueData = new Float32Array(width * height * 4);
    }

    private getValueShader(shBands: number): Shader {
        let shader = this.valueShaders.get(shBands);
        if (!shader) {
            const defines = new Map<string, string>();
            defines.set('SH_BANDS', `${shBands}`);
            defines.set('HISTOGRAM_VALUE_MAP', '');
            shader = ShaderUtils.createShader(this.device, {
                uniqueName: `histValues_SH${shBands}`,
                attributes: { vertex_position: SEMANTIC_POSITION },
                vertexGLSL: fullscreenVS,
                fragmentGLSL: valueMapFS,
                fragmentDefines: defines
            });
            this.valueShaders.set(shBands, shader);
        }
        return shader;
    }

    private setSplatUniforms(splat: Splat, mode: number, options?: CalcHistogramOptions) {
        const { scope } = this.device;
        const numSplats = splat.splatData.numSplats;
        const resource = splat.resource as any;
        const transformA = resource.getTexture('transformA');
        const transformB = resource.getTexture('transformB');
        const splatColor = resource.getTexture('splatColor');
        const splatTransform = splat.transformTexture;
        const transformPalette = splat.transformPalette.texture;
        const splatState = splat.stateTexture;

        const shBands = getShBands(splat);
        const numCoeffs = SH_NUM_COEFFS[shBands] ?? 0;

        const entityMatrix = options?.entityMatrix ?? identity;
        const viewMatrix = options?.viewMatrix ?? identity;
        const viewProjection = options?.viewProjection ?? identity;
        const cameraPos = options?.cameraPos ?? zeroVec3;
        const onScreenOnly = options?.onScreenOnly ? 1 : 0;

        // ColorGrade math, kept in sync with ColorGrade in src/color-grade.ts.
        const { tintClr, temperature, saturation, brightness, blackPoint, whitePoint, transparency } = splat;
        const cgInvRange = 1 / (whitePoint - blackPoint);

        const values: any = {
            transformA,
            transformB,
            splatColor,
            splatTransform,
            transformPalette,
            splatState,
            splat_params: [transformA.width, numSplats],
            propMode: mode,
            entityMatrix: entityMatrix.data,
            viewMatrix: viewMatrix.data,
            viewProjection: viewProjection.data,
            cameraWorldPos: [cameraPos.x, cameraPos.y, cameraPos.z],
            onScreenOnly,
            cgScale: [
                cgInvRange * tintClr.r * (1 + temperature),
                cgInvRange * tintClr.g,
                cgInvRange * tintClr.b * (1 - temperature)
            ],
            cgOffset: -blackPoint + brightness,
            cgSaturation: saturation,
            transparency
        };

        if (shBands > 0) {
            values.splatSH_1to3 = resource.getTexture('splatSH_1to3');
            values.shNumCoeffs = numCoeffs;
        }
        if (shBands > 1) {
            values.splatSH_4to7 = resource.getTexture('splatSH_4to7');
            values.splatSH_8to11 = resource.getTexture('splatSH_8to11');
        }
        if (shBands > 2) {
            values.splatSH_12to15 = resource.getTexture('splatSH_12to15');
        }

        resolve(scope, values);

        return numSplats;
    }

    // Release resources on context loss, scene reload or processor teardown.
    destroy() {
        this.valueRT?.destroy();
        this.valueTex?.destroy();
        this.valueRT = null;
        this.valueTex = null;
        this.valueShaders.clear();
    }

    async run(splat: Splat, mode: number, options?: CalcHistogramOptions): Promise<CalcHistogramResult> {
        const { device } = this;

        const shBands = getShBands(splat);
        const valueShader = this.getValueShader(shBands);

        const numSplats = this.setSplatUniforms(splat, mode, options);
        const transformA = (splat.resource as any).getTexture('transformA');
        this.ensureValueResources(transformA.width, transformA.height);

        // Calculate one exact scalar value and visibility flag per splat on GPU.
        device.setBlendState(BlendState.NOBLEND);
        drawQuadWithShader(device, this.valueRT, valueShader);

        // Histogram refreshes run outside the regular frame pass. Immediate
        // submission prevents mapAsync waiting for a later on-demand frame.
        await this.valueTex.read(0, 0, this.valueTex.width, this.valueTex.height, {
            renderTarget: this.valueRT,
            data: this.valueData,
            immediate: true
        });

        const state = splat.splatData.getProp('state') as Uint8Array;
        let min = Infinity;
        let max = -Infinity;

        // CPU state is authoritative. The GPU state texture is optimized for
        // rendering and its encoding differs across backends.
        for (let i = 0; i < numSplats; i++) {
            const base = i * 4;
            if ((state[i] & 6) || this.valueData[base + 2] < 0.5) continue;
            const value = this.valueData[base];
            if (!Number.isFinite(value)) continue;
            min = Math.min(min, value);
            max = Math.max(max, value);
        }

        if (min > max) {
            min = 0;
            max = 0;
        }

        const selected = new Float32Array(NUM_BINS);
        const unselected = new Float32Array(NUM_BINS);
        let numValues = 0;
        const range = max - min;
        for (let i = 0; i < numSplats; i++) {
            const base = i * 4;
            if (state[i] & 6) continue;
            if (this.valueData[base + 2] < 0.5) continue;

            const value = this.valueData[base];
            if (!Number.isFinite(value)) continue;

            const normalized = range === 0 ? 0 : (value - min) / range;
            const bin = Math.max(0, Math.min(NUM_BINS - 1, Math.floor(normalized * NUM_BINS)));
            if (state[i] & 1) {
                selected[bin]++;
            } else {
                unselected[bin]++;
            }
            numValues++;
        }

        return { selected, unselected, min, max, numValues };
    }

    async selectByRange(
        splat: Splat,
        mode: number,
        options: SelectByRangeOptions,
        bufferPool: BufferPool
    ): Promise<Uint8Array> {
        // Reuse the exact value-map path used to draw the histogram. The old
        // RGBA8 mask shader produced an all-zero readback on WebGPU, while this
        // RGBA32F path is already required and verified for histogram display.
        await this.run(splat, mode, options);

        const numSplats = splat.splatData.numSplats;
        const state = splat.splatData.getProp('state') as Uint8Array;
        const mask = bufferPool.acquire(numSplats);
        mask.fill(0);

        const valueRange = options.max - options.min;
        for (let i = 0; i < numSplats; i++) {
            const base = i * 4;
            if ((state[i] & 6) || this.valueData[base + 2] < 0.5) continue;

            const value = this.valueData[base];
            if (!Number.isFinite(value)) continue;

            const normalized = valueRange === 0 ? 0 : (value - options.min) / valueRange;
            const bin = Math.max(0, Math.min(options.numBins - 1, Math.floor(normalized * options.numBins)));
            if (bin >= options.rangeStart && bin <= options.rangeEnd) {
                mask[i] = 255;
            }
        }

        return mask;
    }
}

export { CalcHistogram };
export type { CalcHistogramOptions, CalcHistogramResult };
