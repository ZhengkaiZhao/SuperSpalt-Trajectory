import {
    SEMANTIC_POSITION,
    drawQuadWithShader,
    BoundingBox,
    GraphicsDevice,
    RenderTarget,
    ScopeSpace,
    Shader,
    ShaderUtils,
    BlendState
} from 'playcanvas';

import { BufferPool } from './buffer-pool';
import { CalcBound } from './calc-bound';
import { CalcHistogram, CalcHistogramOptions } from './calc-histogram';
import { CalcPositions } from './calc-positions';
import { Intersect, IntersectOptions } from './intersect';
import type { SelectByRangeOptions } from './select-by-range';
import { Splat } from '../splat';

const resolve = (scope: ScopeSpace, values: any) => {
    for (const key in values) {
        scope.resolve(key).setValue(values[key]);
    }
};

// gpu processor for splat data. methods are plain (no internal serialisation):
// callers that need ordering relative to other async work must run them inside
// a shared CommandQueue task. see src/command-queue.ts.
class DataProcessor {
    private device: GraphicsDevice;
    private copyShader: Shader;

    // shared pool of readback buffers used by GPU passes that hand bytes back
    // to the caller. Callers receive ownership and must call releaseMask() when
    // done.
    private bufferPool = new BufferPool();

    // instances
    private intersectImpl: Intersect;
    private calcBoundImpl: CalcBound;
    private calcPositionsImpl: CalcPositions;
    private calcHistogramImpl: CalcHistogram;

    constructor(device: GraphicsDevice) {
        this.device = device;

        this.copyShader = ShaderUtils.createShader(device, {
            uniqueName: 'copyShader',
            attributes: {
                vertex_position: SEMANTIC_POSITION
            },
            vertexGLSL: `
                attribute vec2 vertex_position;
                void main(void) {
                    gl_Position = vec4(vertex_position, 0.0, 1.0);
                }
            `,
            fragmentGLSL: `
                uniform sampler2D colorTex;
                void main(void) {
                    ivec2 texel = ivec2(gl_FragCoord.xy);
                    gl_FragColor = texelFetch(colorTex, texel, 0);
                }
            `
        });

        // create instances
        this.intersectImpl = new Intersect(device);
        this.calcBoundImpl = new CalcBound(device);
        this.calcPositionsImpl = new CalcPositions(device);
        this.calcHistogramImpl = new CalcHistogram(device);
    }

    // calculate the intersection of a mask canvas with splat centers.
    // returns an owned mask buffer the caller must release via releaseMask().
    intersect(options: IntersectOptions, splat: Splat) {
        return this.intersectImpl.run(options, splat, this.bufferPool);
    }

    // use gpu to calculate both selected and visible bounds in a single pass
    calcBound(splat: Splat, selectionBound: BoundingBox, localBound: BoundingBox): Promise<void> {
        return this.calcBoundImpl.run(splat, selectionBound, localBound);
    }

    // calculate world-space splat positions
    calcPositions(splat: Splat) {
        return this.calcPositionsImpl.run(splat);
    }

    // calculate exact values on GPU, then aggregate min/max and bins on CPU
    calcHistogram(splat: Splat, mode: number, options?: CalcHistogramOptions) {
        return this.calcHistogramImpl.run(splat, mode, options);
    }

    // compute exact per-splat values on GPU, then build a byte mask on CPU
    // (255 = in range and visible, 0 = not). mode matches the propMode dispatch
    // in src/shaders/splat-value-shader.ts (0..20 = built-ins, 21+N = f_rest_N).
    // returns an owned mask buffer the caller must release via releaseMask().
    selectByRange(splat: Splat, mode: number, options: SelectByRangeOptions) {
        return this.calcHistogramImpl.selectByRange(splat, mode, options, this.bufferPool);
    }

    // release a mask buffer returned by intersect() or selectByRange() back to
    // the pool so subsequent calls can reuse it without re-allocating.
    releaseMask(mask: Uint8Array) {
        this.bufferPool.release(mask);
    }

    copyRt(source: RenderTarget, dest: RenderTarget) {
        const { device } = this;

        resolve(device.scope, {
            colorTex: source.colorBuffer
        });

        device.setBlendState(BlendState.NOBLEND);
        drawQuadWithShader(device, dest, this.copyShader);
    }
}

export { DataProcessor };
export type { IntersectOptions, CalcHistogramOptions, SelectByRangeOptions };
export { MaskOptions, RectOptions, SphereOptions, BoxOptions } from './intersect';
