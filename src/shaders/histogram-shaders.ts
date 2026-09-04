import { computeSplatValueGLSL } from './splat-value-shader';

const fullscreenVS = /* glsl */ `
    attribute vec2 vertex_position;
    void main(void) {
        gl_Position = vec4(vertex_position, 0.0, 1.0);
    }
`;

// One RGBA32F texel per splat: value, selected, included, unused.
// Binning this compact GPU result on the CPU avoids WebGPU point-list and
// float-blending portability problems while preserving the shader's exact
// transformed / camera-dependent property semantics.
const valueMapFS = /* glsl */ `
    ${computeSplatValueGLSL}

    void main(void) {
        ivec2 uv = ivec2(gl_FragCoord);
        int idx = uv.y * splat_params.x + uv.x;
        float value;
        bool selected;
        bool visible;
        bool valid = computeSplatValue(idx, value, selected, visible);
        bool included = valid && visible;
        gl_FragColor = vec4(
            included ? value : 0.0,
            selected ? 1.0 : 0.0,
            included ? 1.0 : 0.0,
            0.0
        );
    }
`;

export {
    fullscreenVS,
    valueMapFS
};
