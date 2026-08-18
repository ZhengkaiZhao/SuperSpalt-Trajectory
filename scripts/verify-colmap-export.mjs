import fs from 'node:fs/promises';
import path from 'node:path';

const inputPath = process.argv[2];
const outputDirectory = process.argv[3];
if (!inputPath || !outputDirectory) {
    throw new Error('Usage: node verify-colmap-export.mjs trajectory.json output-directory');
}

const data = JSON.parse(await fs.readFile(inputPath, 'utf8'));
if (data.camera_count < 1 || data.camera_count > 81 || data.cameras.length !== data.camera_count) {
    throw new Error('Camera count is outside 1-81 or does not match the camera array');
}

const sparseDirectory = path.join(outputDirectory, 'sparse', '0');
await fs.mkdir(sparseDirectory, { recursive: true });
const cameraLines = [
    '# Camera list with one line of data per camera:',
    '# CAMERA_ID, MODEL, WIDTH, HEIGHT, PARAMS[]',
    `# Number of cameras: ${data.camera_count}`,
    ...data.cameras.map(camera => (
        `${camera.index + 1} PINHOLE ${camera.intrinsics.width} ${camera.intrinsics.height} ` +
        `${camera.intrinsics.fx} ${camera.intrinsics.fy} ${camera.intrinsics.cx} ${camera.intrinsics.cy}`
    )),
    ''
];
const imageLines = [
    '# Image list with two lines of data per image:',
    '# IMAGE_ID, QW, QX, QY, QZ, TX, TY, TZ, CAMERA_ID, NAME',
    `# Number of images: ${data.camera_count}, mean observations per image: 0`,
    ...data.cameras.flatMap(camera => [
        `${camera.index + 1} ${camera.qvec_w2c_wxyz.join(' ')} ${camera.tvec_w2c.join(' ')} ` +
        `${camera.index + 1} ${camera.image_name}`,
        ''
    ])
];
await Promise.all([
    fs.writeFile(path.join(sparseDirectory, 'cameras.txt'), cameraLines.join('\n')),
    fs.writeFile(path.join(sparseDirectory, 'images.txt'), imageLines.join('\n')),
    fs.writeFile(path.join(sparseDirectory, 'points3D.txt'), '# Number of points: 0, mean track length: 0\n'),
    fs.writeFile(path.join(outputDirectory, 'trajectory.json'), `${JSON.stringify(data, null, 2)}\n`)
]);

let maxCenterError = 0;
let maxQuaternionError = 0;
for (const camera of data.cameras) {
    const w2c = camera.world_to_camera_colmap;
    const rotation = w2c.slice(0, 3).map(row => row.slice(0, 3));
    const translation = camera.tvec_w2c;
    const recoveredCenter = [0, 1, 2].map(column => -(
        rotation[0][column] * translation[0] +
        rotation[1][column] * translation[1] +
        rotation[2][column] * translation[2]
    ));
    maxCenterError = Math.max(maxCenterError, Math.hypot(
        ...recoveredCenter.map((value, index) => value - camera.camera_center_colmap[index])
    ));
    maxQuaternionError = Math.max(
        maxQuaternionError,
        Math.abs(Math.hypot(...camera.qvec_w2c_wxyz) - 1)
    );
}
if (maxCenterError > 1e-5 || maxQuaternionError > 1e-5) {
    throw new Error(`COLMAP verification failed: center=${maxCenterError}, quaternion=${maxQuaternionError}`);
}
console.log(JSON.stringify({
    cameraCount: data.camera_count,
    maxCenterError,
    maxQuaternionError,
    outputDirectory
}));
