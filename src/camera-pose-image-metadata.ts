type CameraPoseImageMetadata = {
    schema: 'supersplat.camera-pose-image.v1',
    position: [number, number, number],
    target: [number, number, number],
    fov: number
};

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const PNG_KEYWORD = 'SuperSplatCameraPose';

const isFiniteVector = (value: unknown): value is [number, number, number] => (
    Array.isArray(value) && value.length === 3 && value.every(Number.isFinite)
);

const validateCameraPoseMetadata = (value: unknown): CameraPoseImageMetadata => {
    const data = value as Partial<CameraPoseImageMetadata> | null;
    if (!data || data.schema !== 'supersplat.camera-pose-image.v1' ||
        !isFiniteVector(data.position) || !isFiniteVector(data.target) ||
        !Number.isFinite(data.fov) || data.position.every((entry, index) => entry === data.target[index])) {
        throw new Error('PNG does not contain valid SuperSplat camera pose metadata');
    }
    return {
        schema: data.schema,
        position: [...data.position],
        target: [...data.target],
        fov: data.fov
    };
};

const cameraPoseTextChunk = (metadata: CameraPoseImageMetadata): Uint8Array => {
    const keyword = new TextEncoder().encode(PNG_KEYWORD);
    const json = new TextEncoder().encode(JSON.stringify(validateCameraPoseMetadata(metadata)));
    const result = new Uint8Array(keyword.length + 1 + json.length);
    result.set(keyword);
    result.set(json, keyword.length + 1);
    return result;
};

const readCameraPoseFromPng = async (file: Blob): Promise<CameraPoseImageMetadata> => {
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (bytes.length < PNG_SIGNATURE.length || PNG_SIGNATURE.some((value, index) => bytes[index] !== value)) {
        throw new Error('Only PNG images exported by SuperSplat can provide an exact camera pose');
    }

    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let offset = PNG_SIGNATURE.length;
    while (offset + 12 <= bytes.length) {
        const length = view.getUint32(offset);
        const typeOffset = offset + 4;
        const dataOffset = offset + 8;
        const end = dataOffset + length;
        if (end + 4 > bytes.length) break;
        const type = String.fromCharCode(...bytes.subarray(typeOffset, typeOffset + 4));
        if (type === 'tEXt') {
            const payload = bytes.subarray(dataOffset, end);
            const separator = payload.indexOf(0);
            if (separator >= 0) {
                const keyword = new TextDecoder().decode(payload.subarray(0, separator));
                if (keyword === PNG_KEYWORD) {
                    const json = new TextDecoder().decode(payload.subarray(separator + 1));
                    return validateCameraPoseMetadata(JSON.parse(json));
                }
            }
        }
        if (type === 'IEND') break;
        offset = end + 4;
    }
    throw new Error('This PNG has no SuperSplat camera pose metadata; export a new PNG from this version first');
};

export { cameraPoseTextChunk, readCameraPoseFromPng, validateCameraPoseMetadata };
export type { CameraPoseImageMetadata };
