type ColmapW2cComponents = {
    qw_w2c: number;
    qx_w2c: number;
    qy_w2c: number;
    qz_w2c: number;
    tx_w2c: number;
    ty_w2c: number;
    tz_w2c: number;
};

type ColmapPosePresentation = {
    quaternion: [number, number, number, number];
    translation: [number, number, number];
    center: [number, number, number];
    forward: [number, number, number];
};

const describeColmapW2cPose = (pose: ColmapW2cComponents): ColmapPosePresentation => {
    const quaternion: [number, number, number, number] = [
        pose.qw_w2c, pose.qx_w2c, pose.qy_w2c, pose.qz_w2c
    ];
    const translation: [number, number, number] = [pose.tx_w2c, pose.ty_w2c, pose.tz_w2c];
    const values = [...quaternion, ...translation];
    if (values.some(value => !Number.isFinite(value))) {
        throw new Error('COLMAP W2C pose contains a non-finite value');
    }

    const length = Math.hypot(...quaternion);
    if (length < 1e-12) throw new Error('COLMAP W2C quaternion has zero length');
    const [w, x, y, z] = quaternion.map(value => value / length);
    const rotation = [
        [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
        [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
        [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)]
    ];
    const center = [0, 1, 2].map(column => -(
        rotation[0][column] * translation[0] +
        rotation[1][column] * translation[1] +
        rotation[2][column] * translation[2]
    )) as [number, number, number];

    return {
        quaternion,
        translation,
        center,
        forward: rotation[2] as [number, number, number]
    };
};

const formatColmapPoseSummary = (pose: ColmapPosePresentation) => (
    `C ${pose.center.map(value => value.toFixed(3)).join(' ')}  |  ` +
    `Qwxyz ${pose.quaternion.map(value => value.toFixed(4)).join(' ')}`
);

const formatColmapPoseClipboard = (pose: ColmapPosePresentation) => [
    'coordinate_system=COLMAP/OpenCV W2C; world=reference source PLY',
    `C_world=${pose.center.join(',')}`,
    `forward_world=${pose.forward.join(',')}`,
    `q_w2c_wxyz=${pose.quaternion.join(',')}`,
    `t_w2c=${pose.translation.join(',')}`
].join('\n');

export { describeColmapW2cPose, formatColmapPoseClipboard, formatColmapPoseSummary };
export type { ColmapPosePresentation, ColmapW2cComponents };
