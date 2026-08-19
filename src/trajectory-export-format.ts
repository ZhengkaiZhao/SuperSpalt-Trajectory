type ColmapW2cTextRow = {
    index: number,
    image_name: string,
    qw_w2c: number,
    qx_w2c: number,
    qy_w2c: number,
    qz_w2c: number,
    tx_w2c: number,
    ty_w2c: number,
    tz_w2c: number
};

type ContinuousColmapW2cRow = ColmapW2cTextRow & {
    quaternion: number[]
};

const continuousQuaternionRows = (poses: ColmapW2cTextRow[]): ContinuousColmapW2cRow[] => {
    let previousQuaternion: number[] | null = null;
    return poses.map((pose) => {
        let quaternion = [pose.qw_w2c, pose.qx_w2c, pose.qy_w2c, pose.qz_w2c];
        if (previousQuaternion && quaternion.reduce(
            (dot, value, component) => dot + value * previousQuaternion[component], 0
        ) < 0) {
            quaternion = quaternion.map(value => -value);
        }
        previousQuaternion = quaternion;
        return { ...pose, quaternion };
    });
};

const csvCell = (value: string | number) => {
    const text = String(value);
    return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

const colmapW2cRowsToCsv = (poses: ColmapW2cTextRow[]) => {
    const header = [
        'index', 'image_name',
        'qw_w2c', 'qx_w2c', 'qy_w2c', 'qz_w2c',
        'tx_w2c', 'ty_w2c', 'tz_w2c'
    ];
    const rows = continuousQuaternionRows(poses).map(pose => [
        pose.index, pose.image_name,
        ...pose.quaternion,
        pose.tx_w2c, pose.ty_w2c, pose.tz_w2c
    ]);
    return `${[header, ...rows].map(row => row.map(csvCell).join(',')).join('\n')}\n`;
};

const colmapW2cRowsToImagesText = (poses: ColmapW2cTextRow[], cameraId = 1) => {
    if (!Number.isSafeInteger(cameraId) || cameraId < 1) {
        throw new Error('COLMAP camera ID must be a positive integer');
    }

    return [
        '# Image list with two lines of data per image:',
        '# IMAGE_ID, QW, QX, QY, QZ, TX, TY, TZ, CAMERA_ID, NAME',
        `# Number of images: ${poses.length}, mean observations per image: 0`,
        ...continuousQuaternionRows(poses).flatMap(pose => [
            `${pose.index} ${pose.quaternion.join(' ')} ` +
                `${pose.tx_w2c} ${pose.ty_w2c} ${pose.tz_w2c} ${cameraId} ${pose.image_name}`,
            ''
        ])
    ].join('\n');
};

export { colmapW2cRowsToCsv, colmapW2cRowsToImagesText };
export type { ColmapW2cTextRow };
