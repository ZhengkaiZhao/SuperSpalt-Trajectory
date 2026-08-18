import { createReadStream } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

const parseArgs = (argv) => {
    const result = {};
    for (let index = 0; index < argv.length; index++) {
        const token = argv[index];
        if (!token.startsWith('--')) throw new Error(`Unexpected argument: ${token}`);
        const key = token.slice(2);
        const value = argv[++index];
        if (!value || value.startsWith('--')) throw new Error(`Missing value for --${key}`);
        result[key] = value;
    }
    for (const key of ['ply', 'csv', 'output']) {
        if (!result[key]) throw new Error(`Missing required argument --${key}`);
    }
    return result;
};

const parseCsv = (text) => {
    const records = [];
    let record = [];
    let field = '';
    let quoted = false;
    for (let index = 0; index < text.length; index++) {
        const char = text[index];
        if (quoted) {
            if (char === '"' && text[index + 1] === '"') {
                field += '"';
                index++;
            } else if (char === '"') {
                quoted = false;
            } else {
                field += char;
            }
        } else if (char === '"') {
            quoted = true;
        } else if (char === ',') {
            record.push(field);
            field = '';
        } else if (char === '\n') {
            record.push(field.replace(/\r$/, ''));
            if (record.some(value => value.length > 0)) records.push(record);
            record = [];
            field = '';
        } else {
            field += char;
        }
    }
    if (field.length > 0 || record.length > 0) {
        record.push(field.replace(/\r$/, ''));
        records.push(record);
    }
    if (quoted) throw new Error('CSV ends inside a quoted field');
    if (records.length < 2) throw new Error('CSV has no camera rows');
    const headers = records[0];
    return records.slice(1).map((values, rowIndex) => {
        if (values.length !== headers.length) {
            throw new Error(`CSV row ${rowIndex + 2} has ${values.length} fields; expected ${headers.length}`);
        }
        return Object.fromEntries(headers.map((header, index) => [header, values[index]]));
    });
};

const numeric = (row, key, rowIndex) => {
    const value = Number(row[key]);
    if (!Number.isFinite(value)) throw new Error(`CSV row ${rowIndex + 2}: ${key} is not finite`);
    return value;
};

const rotationFromWxyz = ([w, x, y, z]) => [
    [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
    [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
    [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)]
];

const transpose3 = matrix => matrix[0].map((_, column) => matrix.map(row => row[column]));

const multiply3 = (left, right) => left.map(row => right[0].map((_, column) => (
    row.reduce((sum, value, inner) => sum + value * right[inner][column], 0)
)));

const transformPoint = (matrix, point) => matrix.slice(0, 3).map((row, rowIndex) => (
    row.slice(0, 3).reduce((sum, value, column) => sum + value * point[column], 0) + matrix[rowIndex][3]
));

const quaternionXyzwFromRotation = (matrix) => {
    const [m00, m11, m22] = [matrix[0][0], matrix[1][1], matrix[2][2]];
    const trace = m00 + m11 + m22;
    let x;
    let y;
    let z;
    let w;
    if (trace > 0) {
        const scale = Math.sqrt(trace + 1) * 2;
        w = 0.25 * scale;
        x = (matrix[2][1] - matrix[1][2]) / scale;
        y = (matrix[0][2] - matrix[2][0]) / scale;
        z = (matrix[1][0] - matrix[0][1]) / scale;
    } else if (m00 > m11 && m00 > m22) {
        const scale = Math.sqrt(1 + m00 - m11 - m22) * 2;
        w = (matrix[2][1] - matrix[1][2]) / scale;
        x = 0.25 * scale;
        y = (matrix[0][1] + matrix[1][0]) / scale;
        z = (matrix[0][2] + matrix[2][0]) / scale;
    } else if (m11 > m22) {
        const scale = Math.sqrt(1 + m11 - m00 - m22) * 2;
        w = (matrix[0][2] - matrix[2][0]) / scale;
        x = (matrix[0][1] + matrix[1][0]) / scale;
        y = 0.25 * scale;
        z = (matrix[1][2] + matrix[2][1]) / scale;
    } else {
        const scale = Math.sqrt(1 + m22 - m00 - m11) * 2;
        w = (matrix[1][0] - matrix[0][1]) / scale;
        x = (matrix[0][2] + matrix[2][0]) / scale;
        y = (matrix[1][2] + matrix[2][1]) / scale;
        z = 0.25 * scale;
    }
    const length = Math.hypot(x, y, z, w);
    return [x / length, y / length, z / length, w / length];
};

const validateRows = (rows) => rows.map((row, rowIndex) => {
    const width = Math.trunc(numeric(row, 'width', rowIndex));
    const height = Math.trunc(numeric(row, 'height', rowIndex));
    const fx = numeric(row, 'fx', rowIndex);
    const fy = numeric(row, 'fy', rowIndex);
    const cx = numeric(row, 'cx', rowIndex);
    const cy = numeric(row, 'cy', rowIndex);
    if (width < 1 || height < 1 || fx <= 0 || fy <= 0) throw new Error(`CSV row ${rowIndex + 2}: invalid intrinsics`);
    if (Math.abs(cx - width / 2) > 1e-5 || Math.abs(cy - height / 2) > 1e-5) {
        throw new Error(`CSV row ${rowIndex + 2}: off-center principal points are not supported by this renderer`);
    }
    if (Math.abs(fx - fy) / Math.max(fx, fy) > 1e-5) {
        throw new Error(`CSV row ${rowIndex + 2}: non-square pixels are not supported by this renderer`);
    }

    const q = ['qw_w2c', 'qx_w2c', 'qy_w2c', 'qz_w2c'].map(key => numeric(row, key, rowIndex));
    const qLength = Math.hypot(...q);
    if (Math.abs(qLength - 1) > 1e-4) throw new Error(`CSV row ${rowIndex + 2}: w2c quaternion is not normalized`);
    const normalizedQ = q.map(value => value / qLength);
    const rotationW2c = rotationFromWxyz(normalizedQ);
    const rotationC2wCv = transpose3(rotationW2c);
    const translation = ['tx_w2c', 'ty_w2c', 'tz_w2c'].map(key => numeric(row, key, rowIndex));
    const derivedCenter = rotationC2wCv.map(rotationRow => -rotationRow.reduce(
        (sum, value, column) => sum + value * translation[column], 0
    ));
    const center = ['center_x', 'center_y', 'center_z'].map(key => numeric(row, key, rowIndex));
    const centerError = Math.hypot(...center.map((value, index) => value - derivedCenter[index]));
    if (centerError > 1e-4) throw new Error(`CSV row ${rowIndex + 2}: center and w2c disagree by ${centerError}`);

    const imageName = path.basename(row.image_name || `frame_${String(rowIndex + 1).padStart(6, '0')}.png`);
    if (!/^[^<>:"/\\|?*]+\.png$/i.test(imageName)) throw new Error(`CSV row ${rowIndex + 2}: invalid PNG image_name`);
    return { width, height, fx, fy, center, rotationC2wCv, imageName };
});

const buildPoses = (cameras, modelMatrixColumnMajor) => {
    const model = [0, 1, 2, 3].map(row => [0, 1, 2, 3].map(column => modelMatrixColumnMajor[column * 4 + row]));
    const modelRotation = model.slice(0, 3).map(row => row.slice(0, 3));
    return cameras.map(camera => {
        // OpenCV camera axes are +X right, +Y down, +Z forward. PlayCanvas uses
        // +X right, +Y up, -Z forward, so negate the c2w Y and Z columns.
        const rotationPcColmap = camera.rotationC2wCv.map(row => row.map(
            (value, column) => column === 0 ? value : -value
        ));
        const rotation = multiply3(modelRotation, rotationPcColmap);
        const position = transformPoint(model, camera.center);
        const fov = 2 * Math.atan(
            (camera.width > camera.height ? camera.width / camera.fx : camera.height / camera.fy) / 2
        ) * 180 / Math.PI;
        return {
            ...camera,
            position,
            rotation: quaternionXyzwFromRotation(rotation),
            fov
        };
    });
};

const contentTypes = {
    '.css': 'text/css; charset=utf-8',
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.png': 'image/png',
    '.svg': 'image/svg+xml',
    '.wasm': 'application/wasm',
    '.webp': 'image/webp',
    '.woff2': 'font/woff2'
};

const sendFile = async (request, response, filename, type) => {
    const fileStat = await stat(filename);
    const range = request.headers.range?.match(/^bytes=(\d*)-(\d*)$/);
    let start = 0;
    let end = fileStat.size - 1;
    let status = 200;
    if (range) {
        start = range[1] ? Number(range[1]) : 0;
        end = range[2] ? Number(range[2]) : end;
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || end >= fileStat.size) {
            response.writeHead(416, { 'Content-Range': `bytes */${fileStat.size}` });
            response.end();
            return;
        }
        status = 206;
    }
    const headers = {
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'no-store',
        'Content-Length': end - start + 1,
        'Content-Type': type
    };
    if (status === 206) headers['Content-Range'] = `bytes ${start}-${end}/${fileStat.size}`;
    response.writeHead(status, headers);
    if (request.method === 'HEAD') response.end();
    else createReadStream(filename, { start, end }).pipe(response);
};

const startServer = async (distDirectory, plyPath) => {
    const modelPath = `/model${path.extname(plyPath).toLowerCase()}`;
    const server = createServer(async (request, response) => {
        try {
            const url = new URL(request.url, 'http://127.0.0.1');
            if ((request.method === 'GET' || request.method === 'HEAD') && url.pathname === modelPath) {
                console.log(`[model] ${request.method} ${request.headers.range || 'full'}`);
                await sendFile(request, response, plyPath, 'application/octet-stream');
                return;
            }
            if (request.method !== 'GET' && request.method !== 'HEAD') {
                response.writeHead(405);
                response.end();
                return;
            }
            const relative = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1));
            const filename = path.resolve(distDirectory, relative);
            const root = `${path.resolve(distDirectory)}${path.sep}`;
            if (!filename.startsWith(root)) {
                response.writeHead(403);
                response.end();
                return;
            }
            await sendFile(request, response, filename, contentTypes[path.extname(filename).toLowerCase()] || 'application/octet-stream');
        } catch (error) {
            response.writeHead(error.code === 'ENOENT' ? 404 : 500);
            response.end(String(error.message || error));
        }
    });
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });
    return { server, port: server.address().port, modelPath };
};

const freePort = async () => {
    const server = createServer();
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });
    const port = server.address().port;
    await new Promise(resolve => server.close(resolve));
    return port;
};

class CdpClient {
    constructor(url) {
        this.nextId = 1;
        this.pending = new Map();
        this.socket = new WebSocket(url);
    }

    async connect() {
        await new Promise((resolve, reject) => {
            this.socket.addEventListener('open', resolve, { once: true });
            this.socket.addEventListener('error', reject, { once: true });
        });
        this.socket.addEventListener('message', event => {
            const message = JSON.parse(event.data);
            if (!message.id) return;
            const pending = this.pending.get(message.id);
            if (!pending) return;
            this.pending.delete(message.id);
            if (message.error) pending.reject(new Error(message.error.message));
            else pending.resolve(message.result);
        });
    }

    send(method, params = {}) {
        const id = this.nextId++;
        return new Promise((resolve, reject) => {
            this.pending.set(id, { resolve, reject });
            this.socket.send(JSON.stringify({ id, method, params }));
        });
    }

    close() {
        this.socket.close();
    }
}

const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

const waitForPage = async (debugPort, pagePort, timeoutMs = 30000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        try {
            const pages = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
            const page = pages.find(item => item.type === 'page' && item.url.includes(`127.0.0.1:${pagePort}`));
            if (page) return page;
        } catch {
            // Chrome is still starting.
        }
        await delay(250);
    }
    throw new Error('Timed out waiting for the Chrome DevTools page');
};

const evaluate = async (client, expression) => {
    const result = await client.send('Runtime.evaluate', {
        expression,
        awaitPromise: true,
        returnByValue: true
    });
    if (result.exceptionDetails) {
        throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    }
    return result.result.value;
};

const waitForModel = async (client, timeoutMs = 300000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const state = await evaluate(client, `(() => {
            const scene = window.scene;
            const splat = scene?.elements?.find(element => Number.isFinite(element.numSplats) && element.numSplats > 0);
            const pageError = Array.from(document.querySelectorAll('*')).find(element =>
                element.textContent?.includes("network error while loading")
            );
            return splat ? {
                count: splat.numSplats,
                matrix: Array.from(splat.worldTransform.data),
                renderer: scene.rendererInfo,
                width: scene.canvas.width,
                height: scene.canvas.height
            } : pageError ? { error: document.body.innerText.slice(-1000) } : null;
        })()`);
        if (state?.error) throw new Error(`Gaussian model load failed: ${state.error}`);
        if (state) return state;
        await delay(500);
    }
    const bodyText = await evaluate(client, 'document.body?.innerText?.slice(0, 2000)');
    throw new Error(`Timed out loading the Gaussian model. Page text: ${bodyText}`);
};

const preparePresentation = async (client, width, height) => {
    await client.send('Emulation.setDeviceMetricsOverride', {
        width,
        height,
        deviceScaleFactor: 1,
        mobile: false,
        screenWidth: width,
        screenHeight: height
    });
    await evaluate(client, `(async () => {
        const scene = window.scene;
        document.body.appendChild(scene.canvas);
        Array.from(document.body.children).forEach(element => {
            if (element !== scene.canvas) element.style.setProperty('visibility', 'hidden', 'important');
        });
        scene.canvas.style.setProperty('position', 'fixed', 'important');
        scene.canvas.style.setProperty('inset', '0', 'important');
        scene.canvas.style.setProperty('z-index', '2147483647', 'important');
        scene.canvas.style.setProperty('display', 'block', 'important');
        scene.canvas.style.setProperty('visibility', 'visible', 'important');
        scene.canvas.style.setProperty('width', '${width}px', 'important');
        scene.canvas.style.setProperty('height', '${height}px', 'important');
        scene.camera.renderOverlays = false;
        scene.gizmoLayer.enabled = false;
        scene.graphicsDevice.setResolution(${width}, ${height});
        scene.targetSize.width = ${width};
        scene.targetSize.height = ${height};
        scene.camera.rebuildRenderTargets();
        scene.camera.onUpdate(0);
        scene.forceRender = true;
        scene.app.renderNextFrame = true;
        scene.app.update(0);
        scene.app.render();
        return { width: scene.canvas.width, height: scene.canvas.height };
    })()`);
};

const renderPose = async (client, pose) => {
    const serialized = JSON.stringify({ position: pose.position, rotation: pose.rotation, fov: pose.fov });
    return evaluate(client, `(async () => {
        const pose = ${serialized};
        const scene = window.scene;
        const camera = scene.camera;
        const position = camera.position.clone().set(...pose.position);
        const rotation = camera.mainCamera.getRotation().clone().set(...pose.rotation);
        camera.setPoseOverride({ position, rotation, fov: pose.fov, near: 0.0001, far: 1000 });
        scene.elements.filter(element => Number.isFinite(element.numSplats) && element.numSplats > 0)
            .forEach(splat => splat.markRenderDataDirty());
        scene.forceRender = true;
        scene.app.renderNextFrame = true;
        scene.app.update(0);
        scene.app.render();
        await new Promise(resolve => setTimeout(resolve, 50));
        return { width: scene.canvas.width, height: scene.canvas.height };
    })()`);
};

const verifyInAppTrajectoryExport = async (client) => evaluate(client, `(async () => {
    const scene = window.scene;
    scene.camera.setPoseOverride(null);
    scene.camera.onUpdate(0);
    const current = scene.events.invoke('camera.getPose');
    const pose = {
        position: [current.position.x, current.position.y, current.position.z],
        target: [current.target.x, current.target.y, current.target.z],
        fov: current.fov
    };
    const root = await navigator.storage.getDirectory();
    const result = await scene.events.invoke('render.trajectoryImages', {
        width: 320,
        height: 180,
        trajectoryLabel: 'Verification',
        poses: [pose, pose]
    }, root);
    const directory = await root.getDirectoryHandle(result.directoryName);
    const manifestFile = await (await directory.getFileHandle('render_manifest.json')).getFile();
    const manifest = JSON.parse(await manifestFile.text());
    const images = [];
    for (const imageName of manifest.images) {
        const file = await (await directory.getFileHandle(imageName)).getFile();
        const bitmap = await createImageBitmap(file);
        images.push({ name: imageName, width: bitmap.width, height: bitmap.height, bytes: file.size });
        bitmap.close();
    }
    return { result, manifestFrames: manifest.rendered_frame_count, images };
})()`);

const verifyColmapW2cTrajectory = async (client) => evaluate(client, `(async () => {
    const scene = window.scene;
    const events = scene.events;
    scene.camera.setPoseOverride(null);
    scene.camera.onUpdate(0);
    const current = events.invoke('camera.getPose');
    const position = [current.position.x, current.position.y, current.position.z];
    const target = [current.target.x, current.target.y, current.target.z];
    const poses = [
        { p: [0.00, 0.00, 0.00], t: [0.00, 0.00, 0.00] },
        { p: [0.16, 0.05, -0.04], t: [-0.03, 0.02, 0.01] },
        { p: [-0.11, 0.12, 0.08], t: [0.04, -0.03, 0.00] },
        { p: [0.21, -0.07, 0.13], t: [-0.05, 0.04, -0.02] },
        { p: [-0.18, 0.09, -0.10], t: [0.02, -0.05, 0.03] }
    ].map((offset, index) => ({
        name: 'asymmetric-' + (index + 1),
        frame: index,
        position: position.map((value, axis) => value + offset.p[axis]),
        target: target.map((value, axis) => value + offset.t[axis]),
        fov: current.fov
    }));
    events.invoke('recordedView.restore', {
        id: 'w2c-verification',
        label: 'W2C Verification',
        poses,
        targetCount: poses.length,
        finished: true
    });
    const trajectory = events.invoke('recordedView.targetPoses');
    const exported = events.invoke('camera.buildCurrentTrajectory');
    const csv = events.invoke('camera.buildCurrentTrajectoryCsv');

    const root = await navigator.storage.getDirectory();
    const renderResult = await events.invoke('render.trajectoryImages', {
        width: 320,
        height: 180,
        trajectoryLabel: 'W2C-Verification',
        poses: trajectory
    }, root);
    const directory = await root.getDirectoryHandle(renderResult.directoryName);
    const poseFile = await (await directory.getFileHandle('camera_poses_colmap_w2c.csv')).getFile();
    const renderedCsv = await poseFile.text();
    const renderedImages = [];
    for (const row of exported.poses) {
        const file = await (await directory.getFileHandle(row.image_name)).getFile();
        const bytes = new Uint8Array(await file.arrayBuffer());
        let binary = '';
        for (let offset = 0; offset < bytes.length; offset += 0x8000) {
            binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
        }
        renderedImages.push({ name: row.image_name, base64: btoa(binary) });
    }

    const splat = scene.elements.find(element => Number.isFinite(element.numSplats) && element.numSplats > 0);
    const model = Array.from(splat.worldTransform.data);
    const transformPoint = point => [0, 1, 2].map(row =>
        model[0 * 4 + row] * point[0] +
        model[1 * 4 + row] * point[1] +
        model[2 * 4 + row] * point[2] +
        model[3 * 4 + row]
    );
    const rotationFromWxyz = ([w, x, y, z]) => [
        [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
        [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
        [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)]
    ];
    let maxPositionError = 0;
    let maxForwardError = 0;
    const reconstructed = exported.poses.map((row, index) => {
        const rotation = rotationFromWxyz([row.qw_w2c, row.qx_w2c, row.qy_w2c, row.qz_w2c]);
        const translation = [row.tx_w2c, row.ty_w2c, row.tz_w2c];
        const center = [0, 1, 2].map(column => -(
            rotation[0][column] * translation[0] +
            rotation[1][column] * translation[1] +
            rotation[2][column] * translation[2]
        ));
        // OpenCV +Z is the optical forward direction in world coordinates.
        const forward = rotation[2].slice();
        const editorPosition = transformPoint(center);
        const editorTarget = transformPoint(center.map((value, axis) => value + forward[axis]));
        const source = trajectory[index];
        const sourcePosition = [source.position.x, source.position.y, source.position.z];
        const sourceForward = [
            source.target.x - source.position.x,
            source.target.y - source.position.y,
            source.target.z - source.position.z
        ];
        const restoredForward = editorTarget.map((value, axis) => value - editorPosition[axis]);
        const normalize = vector => {
            const length = Math.hypot(...vector);
            return vector.map(value => value / length);
        };
        const a = normalize(sourceForward);
        const b = normalize(restoredForward);
        maxPositionError = Math.max(maxPositionError, Math.hypot(
            ...editorPosition.map((value, axis) => value - sourcePosition[axis])
        ));
        maxForwardError = Math.max(maxForwardError, Math.hypot(
            ...a.map((value, axis) => value - b[axis])
        ));
        return {
            name: 'csv-roundtrip-' + (index + 1),
            frame: index,
            position: editorPosition,
            target: editorTarget,
            fov: source.fov
        };
    });

    const comparison = await events.invoke('render.poseThumbnails', [trajectory[0], reconstructed[0]], 320, 180);
    const original = comparison[0];
    const restored = comparison[1];
    let pixelAbsoluteError = 0;
    let horizontalAsymmetry = 0;
    let verticalAsymmetry = 0;
    const width = 320;
    const height = 180;
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const offset = (y * width + x) * 4;
            const mirrorX = (y * width + (width - x - 1)) * 4;
            const mirrorY = ((height - y - 1) * width + x) * 4;
            for (let channel = 0; channel < 3; channel++) {
                pixelAbsoluteError += Math.abs(original[offset + channel] - restored[offset + channel]);
                horizontalAsymmetry += Math.abs(original[offset + channel] - original[mirrorX + channel]);
                verticalAsymmetry += Math.abs(original[offset + channel] - original[mirrorY + channel]);
            }
        }
    }
    const samples = width * height * 3;
    return {
        exported,
        csv,
        renderedCsv,
        renderResult,
        maxPositionError,
        maxForwardError,
        pixelMeanAbsoluteError: pixelAbsoluteError / samples,
        horizontalAsymmetry: horizontalAsymmetry / samples,
        verticalAsymmetry: verticalAsymmetry / samples,
        renderedImages
    };
})()`);

const colmapImageNames = (text) => {
    const lines = text.split(/\r?\n/);
    const result = [];
    for (let index = 0; index < lines.length; index++) {
        const line = lines[index].trim();
        if (!line || line.startsWith('#')) continue;
        const parts = line.split(/\s+/);
        if (parts.length < 10 || parts.slice(0, 9).some(value => !Number.isFinite(Number(value)))) continue;
        result.push(parts.slice(9).join(' '));
        index++;
    }
    return result;
};

const verifyRealCameraDataset = async (client, fixture) => evaluate(client, `(async () => {
    const fixture = ${JSON.stringify(fixture)};
    const events = window.scene.events;
    const makeFile = (contents, name, relativePath, type = 'text/plain') => {
        const file = new File([contents], name, { type });
        Object.defineProperty(file, 'webkitRelativePath', { value: relativePath });
        return file;
    };
    const decoyImages = [
        '# Image list with two lines of data per image:',
        '1 1 0 0 0 0 0 0 1 Virtual_Cam_000001.png',
        ''
    ].join('\\n');
    const decoyCameras = '1 PINHOLE 640 480 500 500 320 240\\n';
    const files = [
        makeFile(decoyImages, 'images.txt', 'colmap_real/virtual_trajectories/decoy/sparse/0/images.txt'),
        makeFile(decoyCameras, 'cameras.txt', 'colmap_real/virtual_trajectories/decoy/sparse/0/cameras.txt'),
        makeFile('', 'Virtual_Cam_000001.png', 'colmap_real/virtual_trajectories/decoy/images/Virtual_Cam_000001.png', 'image/png'),
        makeFile(fixture.imagesText, 'images.txt', 'colmap_real/sparse/0/images.txt'),
        makeFile(fixture.camerasText, 'cameras.txt', 'colmap_real/sparse/0/cameras.txt'),
        ...fixture.imageNames.map(name => makeFile('', name.split('/').pop(), 'colmap_real/images/' + name, 'image/jpeg'))
    ];
    const selected = await events.invoke('realCameraDataset.load', files);
    const candidates = events.invoke('imagePoseMatch.candidateState');
    events.invoke('realCameraDataset.clear');
    const poseOnly = await events.invoke('realCameraDataset.load', [
        makeFile(fixture.imagesText, 'images.txt', 'colmap_real/sparse/0/images.txt')
    ]);
    await events.invoke('realCameraDataset.load', files);
    return { selected, candidates, poseOnly };
})()`);

const verifyPerformanceHud = async (client, restoreWidth, restoreHeight) => {
    const desktop = await evaluate(client, `(async () => {
        const toggle = document.getElementById('performance-pose-toggle');
        toggle.click();
        await new Promise(resolve => setTimeout(resolve, 250));
        const ids = ['performance-hud', 'performance-primary', 'performance-adapter', 'performance-pose', 'performance-pose-value',
            'performance-pose-copy', 'right-toolbar'];
        const layout = Object.fromEntries(ids.map(id => {
            const element = document.getElementById(id);
            const rect = element?.getBoundingClientRect();
            return [id, element && rect ? {
                left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom,
                width: rect.width, height: rect.height,
                text: element.textContent?.trim(), hidden: element.hidden
            } : null];
        }));
        document.getElementById('performance-pose-copy').click();
        await new Promise(resolve => setTimeout(resolve, 100));
        let clipboard = '';
        try { clipboard = await navigator.clipboard.readText(); } catch {}
        return {
            layout,
            pressed: toggle.getAttribute('aria-pressed'),
            copyTitle: document.getElementById('performance-pose-copy').getAttribute('title'),
            clipboard
        };
    })()`);
    await client.send('Emulation.setDeviceMetricsOverride', {
        width: 390, height: 844, deviceScaleFactor: 1, mobile: true, screenWidth: 390, screenHeight: 844
    });
    const mobile = await evaluate(client, `(() => {
        const hud = document.getElementById('performance-hud').getBoundingClientRect();
        const toolbar = document.getElementById('right-toolbar').getBoundingClientRect();
        return {
            viewport: { width: innerWidth, height: innerHeight },
            hud: { left: hud.left, top: hud.top, right: hud.right, bottom: hud.bottom, width: hud.width, height: hud.height },
            toolbar: { left: toolbar.left, top: toolbar.top, right: toolbar.right, bottom: toolbar.bottom },
            overlaps: !(hud.right <= toolbar.left || hud.left >= toolbar.right || hud.bottom <= toolbar.top || hud.top >= toolbar.bottom)
        };
    })()`);
    await client.send('Emulation.clearDeviceMetricsOverride');
    await client.send('Emulation.setDeviceMetricsOverride', {
        width: restoreWidth,
        height: restoreHeight,
        deviceScaleFactor: 1,
        mobile: false,
        screenWidth: restoreWidth,
        screenHeight: restoreHeight
    });
    await evaluate(client, `(async () => {
        dispatchEvent(new Event('resize'));
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    })()`);
    return { desktop, mobile };
};

const verifyImagePoseMatcher = async (client) => evaluate(client, `(async () => {
    const events = window.scene.events;
    const current = events.invoke('camera.getPose');
    const center = [current.target.x, current.target.y, current.target.z];
    const offset = [
        current.position.x - center[0],
        current.position.y - center[1],
        current.position.z - center[2]
    ];
    const virtualPoses = Array.from({ length: 40 }, (_, index) => {
        const angle = (index - 20) * 0.0125;
        const cosine = Math.cos(angle);
        const sine = Math.sin(angle);
        return {
            name: 'virtual-' + index,
            frame: index,
            position: [
                center[0] + offset[0] * cosine + offset[2] * sine,
                center[1] + offset[1],
                center[2] - offset[0] * sine + offset[2] * cosine
            ],
            target: center,
            fov: current.fov
        };
    });
    const realPose = {
        name: 'real-smoke',
        frame: 0,
        position: [current.position.x, current.position.y + 0.25, current.position.z],
        target: center,
        fov: current.fov
    };
    events.invoke('docDeserialize.poseSets', [{
        role: 'camera-track',
        poses: [realPose]
    }, {
        role: 'recorded-view-trajectory',
        id: 'matcher-smoke',
        label: 'Matcher smoke',
        poses: virtualPoses
    }], current.fov);

    const queryPose = virtualPoses[31];
    const pixels = (await events.invoke('render.poseThumbnails', [queryPose], 48, 48))[0];
    const canvas = document.createElement('canvas');
    canvas.width = 48;
    canvas.height = 48;
    const context = canvas.getContext('2d');
    context.putImageData(new ImageData(new Uint8ClampedArray(pixels), 48, 48), 0, 0);
    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
    const result = await events.invoke('imagePoseMatch.find', new File([blob], 'matcher-smoke.png', {
        type: 'image/png'
    }));
    return {
        source: result.source,
        score: result.score,
        probability: result.probability,
        candidateCount: result.candidateCount,
        evaluatedCandidateCount: result.evaluatedCandidateCount,
        realCandidateCount: result.realCandidateCount,
        virtualCandidateCount: result.virtualCandidateCount,
        searchMode: result.searchMode
    };
})()`);

const main = async () => {
    const args = parseArgs(process.argv.slice(2));
    const plyPath = path.resolve(args.ply);
    const csvPath = path.resolve(args.csv);
    const outputDirectory = path.resolve(args.output);
    const repoRoot = path.resolve(import.meta.dirname, '..');
    const distDirectory = path.join(repoRoot, 'dist');
    let realCameraFixture = null;
    if (args['verify-real-dataset'] !== undefined) {
        if (!args['colmap-dir']) throw new Error('--colmap-dir is required with --verify-real-dataset');
        const colmapDirectory = path.resolve(args['colmap-dir']);
        const [imagesText, camerasText] = await Promise.all([
            readFile(path.join(colmapDirectory, 'sparse', '0', 'images.txt'), 'utf8'),
            readFile(path.join(colmapDirectory, 'sparse', '0', 'cameras.txt'), 'utf8')
        ]);
        realCameraFixture = { imagesText, camerasText, imageNames: colmapImageNames(imagesText) };
    }
    await Promise.all([stat(plyPath), stat(csvPath), stat(path.join(distDirectory, 'index.html')), stat(CHROME)]);
    await mkdir(outputDirectory, { recursive: true });

    let cameras = validateRows(parseCsv(await readFile(csvPath, 'utf8')));
    if (args.limit !== undefined) {
        const limit = Number(args.limit);
        if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('--limit must be a positive integer');
        cameras = cameras.slice(0, limit);
    }
    const dimensions = new Set(cameras.map(camera => `${camera.width}x${camera.height}`));
    if (dimensions.size !== 1) throw new Error(`All cameras must use one resolution; got ${[...dimensions].join(', ')}`);
    const width = cameras[0].width;
    const height = cameras[0].height;
    console.log(`Validated ${cameras.length} cameras at ${width}x${height}.`);

    const { server, port, modelPath } = await startServer(distDirectory, plyPath);
    const debugPort = await freePort();
    const profileDirectory = await mkdtemp(path.join(tmpdir(), 'supersplat-csv-render-'));
    const appUrl = `http://127.0.0.1:${port}/?load=${encodeURIComponent(modelPath)}&filename=${encodeURIComponent(path.basename(plyPath))}`;
    const chrome = spawn(CHROME, [
        `--user-data-dir=${profileDirectory}`,
        `--remote-debugging-port=${debugPort}`,
        '--remote-debugging-address=127.0.0.1',
        '--force_high_performance_gpu',
        '--enable-gpu-rasterization',
        '--enable-zero-copy',
        '--disable-renderer-backgrounding',
        '--disable-background-timer-throttling',
        '--no-first-run',
        `--window-size=${width},${height}`,
        `--app=${appUrl}`
    ], { stdio: 'ignore' });

    let client;
    try {
        const page = await waitForPage(debugPort, port);
        client = new CdpClient(page.webSocketDebuggerUrl);
        await client.connect();
        await client.send('Runtime.enable');
        await client.send('Page.enable');
        await client.send('Emulation.setDeviceMetricsOverride', {
            width, height, deviceScaleFactor: 1, mobile: false, screenWidth: width, screenHeight: height
        });

        console.log(`Loading ${path.basename(plyPath)}...`);
        const model = await waitForModel(client);
        console.log(`Loaded ${model.count.toLocaleString()} splats with ${model.renderer || 'WebGPU renderer'}.`);
        const poses = buildPoses(cameras, model.matrix);
        console.log(`Model world transform: ${JSON.stringify(model.matrix)}`);
        console.log(`First render pose: ${JSON.stringify({ position: poses[0].position, rotation: poses[0].rotation, fov: poses[0].fov })}`);
        if (args['verify-real-dataset'] !== undefined) {
            const verification = await verifyRealCameraDataset(client, realCameraFixture);
            const expected = realCameraFixture.imageNames.length;
            const valid = expected > 0 && verification.selected.poseCount === expected &&
                verification.selected.matchedImageCount === expected &&
                verification.selected.sourcePath === 'colmap_real/sparse/0' &&
                verification.candidates.realCandidateCount === expected &&
                verification.poseOnly.loaded === true && verification.poseOnly.poseCount === expected &&
                verification.poseOnly.matchedImageCount === 0;
            if (!valid) throw new Error(`Real camera dataset verification failed: ${JSON.stringify(verification)}`);
            await writeFile(path.join(outputDirectory, 'real-camera-dataset-validation.json'), `${JSON.stringify({
                expected_pose_count: expected,
                selected: verification.selected,
                candidate_count: verification.candidates,
                pose_only: verification.poseOnly
            }, null, 2)}\n`);
            console.log(`Verified real camera dataset selection: ${JSON.stringify({
                poses: verification.selected.poseCount,
                matched: verification.selected.matchedImageCount,
                source: verification.selected.sourcePath,
                poseOnly: verification.poseOnly.poseCount
            })}`);
        }
        if (args['verify-hud'] !== undefined) {
            try {
                await client.send('Browser.grantPermissions', {
                    origin: `http://127.0.0.1:${port}`,
                    permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite']
                });
            } catch {
                // Layout and pose output remain verifiable when clipboard permission is unavailable.
            }
            const verification = await verifyPerformanceHud(client, width, height);
            const hud = verification.desktop.layout['performance-hud'];
            const toolbar = verification.desktop.layout['right-toolbar'];
            const desktopOverlap = !(hud.right <= toolbar.left || hud.left >= toolbar.right ||
                hud.bottom <= toolbar.top || hud.top >= toolbar.bottom);
            const poseText = verification.desktop.layout['performance-pose-value']?.text ?? '';
            const adapterText = verification.desktop.layout['performance-adapter']?.text ?? '';
            const copied = verification.desktop.clipboard.includes('q_w2c_wxyz=') ||
                verification.desktop.copyTitle === '已复制当前相机位姿';
            const mobileFits = verification.mobile.hud.left >= 0 && verification.mobile.hud.top >= 0 &&
                verification.mobile.hud.right <= verification.mobile.viewport.width &&
                verification.mobile.hud.bottom <= verification.mobile.viewport.height;
            const valid = verification.desktop.pressed === 'true' && adapterText === 'RTX 独立显卡' &&
                /C .+Qwxyz/.test(poseText) &&
                !desktopOverlap && !verification.mobile.overlaps && mobileFits && copied;
            if (!valid) throw new Error(`Performance HUD verification failed: ${JSON.stringify(verification)}`);
            const screenshot = await client.send('Page.captureScreenshot', {
                format: 'png', fromSurface: true, captureBeyondViewport: false
            });
            await Promise.all([
                writeFile(path.join(outputDirectory, 'live-pose-hud-mobile.png'), Buffer.from(screenshot.data, 'base64')),
                writeFile(path.join(outputDirectory, 'live-pose-hud-validation.json'), `${JSON.stringify({
                    ...verification,
                    desktopOverlap,
                    mobileFits,
                    clipboard: verification.desktop.clipboard ? 'verified' : 'copy action verified'
                }, null, 2)}\n`)
            ]);
            console.log(`Verified live pose HUD: ${JSON.stringify({
                poseText,
                adapterText,
                desktopOverlap,
                mobileOverlap: verification.mobile.overlaps,
                mobileFits,
                copied
            })}`);
        }
        if (args['verify-ui'] !== undefined) {
            const layout = await evaluate(client, `(async () => {
                window.scene.forceRender = true;
                window.scene.app.update(0);
                window.scene.app.render();
                await new Promise(resolve => setTimeout(resolve, 100));
                window.scene.events.fire('camera.parametersPanel.show');
                await new Promise(resolve => setTimeout(resolve, 200));
                const panel = document.getElementById('camera-parameters-panel');
                if (panel) panel.scrollTop = panel.scrollHeight;
                const ids = ['camera-parameters-panel', 'trajectory-image-title', 'trajectory-image-actions', 'trajectory-image-save', 'trajectory-image-status'];
                const layout = Object.fromEntries(ids.map(id => {
                    const element = document.getElementById(id);
                    const rect = element?.getBoundingClientRect();
                    return [id, element && rect ? {
                        visible: getComputedStyle(element).display !== 'none',
                        left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom,
                        width: rect.width, height: rect.height,
                        text: element.textContent?.trim()
                    } : null];
                }));
                const flipButton = document.getElementById('right-toolbar-camera-flip-y');
                const flipState = () => ({
                    camera: window.scene.camera.flipY,
                    active: flipButton?.classList.contains('active') ?? false,
                    pressed: flipButton?.getAttribute('aria-pressed')
                });
                const initial = flipState();
                window.scene.events.fire('camera.toggleFlipY');
                const inverted = flipState();
                window.scene.events.fire('camera.toggleFlipY');
                return { ...layout, flipY: { initial, inverted, restored: flipState() } };
            })()`);
            const expectedFlipStates = layout.flipY?.initial?.camera === true &&
                layout.flipY.initial.active === false && layout.flipY.initial.pressed === 'false' &&
                layout.flipY.inverted.camera === false && layout.flipY.inverted.active === true &&
                layout.flipY.inverted.pressed === 'true' && layout.flipY.restored.camera === true;
            if (!expectedFlipStates) throw new Error(`Camera Y-axis toggle verification failed: ${JSON.stringify(layout.flipY)}`);
            const screenshot = await client.send('Page.captureScreenshot', {
                format: 'png', fromSurface: true, captureBeyondViewport: false
            });
            await writeFile(path.join(outputDirectory, 'trajectory-export-ui.png'), Buffer.from(screenshot.data, 'base64'));
            console.log(`Verified trajectory export UI layout: ${JSON.stringify(layout)}`);
        }
        await preparePresentation(client, width, height);

        for (let index = 0; index < poses.length; index++) {
            const pose = poses[index];
            const size = await renderPose(client, pose);
            if (size.width !== width || size.height !== height) {
                throw new Error(`Frame ${index + 1}: canvas is ${size.width}x${size.height}, expected ${width}x${height}`);
            }
            const screenshot = await client.send('Page.captureScreenshot', {
                format: 'png',
                fromSurface: true,
                captureBeyondViewport: false,
                clip: { x: 0, y: 0, width, height, scale: 1 }
            });
            const bytes = Buffer.from(screenshot.data, 'base64');
            if (bytes.length < 10000) throw new Error(`Frame ${index + 1}: screenshot is unexpectedly small (${bytes.length} bytes)`);
            await writeFile(path.join(outputDirectory, pose.imageName), bytes);
            console.log(`[${String(index + 1).padStart(String(poses.length).length, '0')}/${poses.length}] ${pose.imageName} (${(bytes.length / 1048576).toFixed(2)} MiB)`);
        }
        if (args['verify-app-export'] !== undefined) {
            const verification = await verifyInAppTrajectoryExport(client);
            const valid = verification.manifestFrames === 2 && verification.images.length === 2 &&
                verification.images.every(image => image.width === 320 && image.height === 180 && image.bytes > 10000);
            if (!valid) throw new Error(`In-app trajectory image verification failed: ${JSON.stringify(verification)}`);
            console.log(`Verified in-app trajectory export: ${JSON.stringify(verification)}`);
        }
        if (args['verify-w2c'] !== undefined) {
            const verification = await verifyColmapW2cTrajectory(client);
            const expectedHeader = 'index,image_name,qw_w2c,qx_w2c,qy_w2c,qz_w2c,tx_w2c,ty_w2c,tz_w2c';
            const validation = verification.exported.validation;
            const valid = verification.exported.pose_count === 5 &&
                verification.csv.trimStart().startsWith(expectedHeader) &&
                verification.renderedCsv === verification.csv &&
                verification.renderResult.frameCount === 5 &&
                verification.maxPositionError < 1e-4 && verification.maxForwardError < 1e-4 &&
                verification.pixelMeanAbsoluteError < 0.5 &&
                verification.horizontalAsymmetry > 1 && verification.verticalAsymmetry > 1 &&
                Object.values(validation).every(value => value < 1e-4);
            if (!valid) {
                throw new Error(`COLMAP W2C trajectory verification failed: ${JSON.stringify({
                    poseCount: verification.exported.pose_count,
                    renderResult: verification.renderResult,
                    maxPositionError: verification.maxPositionError,
                    maxForwardError: verification.maxForwardError,
                    pixelMeanAbsoluteError: verification.pixelMeanAbsoluteError,
                    horizontalAsymmetry: verification.horizontalAsymmetry,
                    verticalAsymmetry: verification.verticalAsymmetry,
                    validation
                })}`);
            }
            await writeFile(path.join(outputDirectory, 'camera_poses_colmap_w2c.csv'), verification.csv);
            await writeFile(path.join(outputDirectory, 'colmap_w2c_validation.json'), `${JSON.stringify({
                pose_count: verification.exported.pose_count,
                source_type: verification.exported.source_type,
                matrix_validation: validation,
                reconstructed_position_max_error: verification.maxPositionError,
                reconstructed_forward_max_error: verification.maxForwardError,
                reconstructed_image_mean_absolute_error: verification.pixelMeanAbsoluteError,
                horizontal_asymmetry: verification.horizontalAsymmetry,
                vertical_asymmetry: verification.verticalAsymmetry,
                png_pose_csv_matches_standalone_csv: verification.renderedCsv === verification.csv,
                images: verification.renderedImages.map(image => image.name)
            }, null, 2)}\n`);
            await Promise.all(verification.renderedImages.map(image => writeFile(
                path.join(outputDirectory, image.name),
                Buffer.from(image.base64, 'base64')
            )));
            console.log(`Verified COLMAP W2C trajectory: ${JSON.stringify({
                poseCount: verification.exported.pose_count,
                maxPositionError: verification.maxPositionError,
                maxForwardError: verification.maxForwardError,
                pixelMeanAbsoluteError: verification.pixelMeanAbsoluteError,
                horizontalAsymmetry: verification.horizontalAsymmetry,
                verticalAsymmetry: verification.verticalAsymmetry,
                validation
            })}`);
        }
        if (args['verify-matcher'] !== undefined) {
            const verification = await verifyImagePoseMatcher(client);
            const valid = verification.candidateCount > 36 &&
                verification.evaluatedCandidateCount === verification.candidateCount &&
                verification.realCandidateCount >= 1 && verification.virtualCandidateCount >= 40 &&
                verification.searchMode === 'full' && verification.source === 'virtual' &&
                verification.score > 0.99 && verification.probability < 1;
            if (!valid) throw new Error(`Image pose matcher verification failed: ${JSON.stringify(verification)}`);
            console.log(`Verified exhaustive image pose matching: ${JSON.stringify(verification)}`);
        }
        await writeFile(path.join(outputDirectory, 'render_manifest.json'), `${JSON.stringify({
            source_ply: plyPath,
            source_trajectory: csvPath,
            renderer: model.renderer,
            splat_count: model.count,
            frame_count: poses.length,
            width,
            height,
            model_world_transform_column_major: model.matrix,
            images: poses.map(pose => pose.imageName)
        }, null, 2)}\n`);
        console.log(`Completed ${poses.length} frames in ${outputDirectory}`);
    } finally {
        try {
            await client?.send('Browser.close');
        } catch {
            // The page may already be closed after a renderer failure.
        }
        client?.close();
        if (chrome.exitCode === null) {
            await Promise.race([
                new Promise(resolve => chrome.once('exit', resolve)),
                delay(3000)
            ]);
        }
        if (chrome.exitCode === null && !chrome.killed) chrome.kill();
        await new Promise(resolve => server.close(resolve));
        try {
            await rm(profileDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
        } catch (error) {
            console.warn(`Could not remove temporary Chrome profile: ${error.message || error}`);
        }
    }
};

main().catch(error => {
    console.error(error.stack || error);
    process.exitCode = 1;
});
