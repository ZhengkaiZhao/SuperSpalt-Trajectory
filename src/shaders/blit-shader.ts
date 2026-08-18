const vertexShader = /* glsl*/ `
    attribute vec2 vertex_position;
    varying vec2 texCoord;
    void main(void) {
        gl_Position = vec4(vertex_position, 0.0, 1.0);
        texCoord = vertex_position * 0.5 + 0.5;
    }
`;

const fragmentShader = /* glsl*/ `
    uniform sampler2D srcTexture;
    uniform int flipY;
    varying vec2 texCoord;
    void main(void) {
        vec2 uv = texCoord;
        if (flipY != 0) {
            uv.y = 1.0 - uv.y;
        }
        ivec2 size = textureSize(srcTexture, 0);
        ivec2 texel = clamp(ivec2(uv * vec2(size)), ivec2(0), size - ivec2(1));
        gl_FragColor = texelFetch(srcTexture, texel, 0);
    }
`;

export { vertexShader, fragmentShader };
