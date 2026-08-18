import { spawn } from 'node:child_process';
import { createReadStream, existsSync, readdirSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const distRoot = path.join(projectRoot, 'dist');
const requestedPort = Number.parseInt(
    process.argv.find(argument => argument.startsWith('--port='))?.split('=')[1] ?? '3011',
    10
);
const rebuild = process.argv.includes('--rebuild');
const strictPort = process.argv.includes('--strict-port');
const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';

const minimumNodeVersion = [20, 19, 0];
const nodeVersion = process.versions.node.split('.').map(Number);
const nodeVersionSupported = minimumNodeVersion.every((value, index) => (
    nodeVersion[index] === value ? true : nodeVersion[index] > value ? true :
        nodeVersion.slice(0, index).some((part, partIndex) => part > minimumNodeVersion[partIndex])
));
if (!nodeVersionSupported) {
    throw new Error(`Node.js 20.19 or newer is required; current version is ${process.versions.node}`);
}
if (!Number.isSafeInteger(requestedPort) || requestedPort < 1024 || requestedPort > 65535) {
    throw new Error(`Invalid local port: ${requestedPort}`);
}

const run = (command, args) => new Promise((resolve, reject) => {
    const child = spawn(command, args, {
        cwd: projectRoot,
        shell: process.platform === 'win32',
        stdio: 'inherit',
        windowsHide: true
    });
    child.once('error', reject);
    child.once('exit', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`${command} ${args.join(' ')} failed with exit code ${code}`));
    });
});

const ensureBuild = async () => {
    const entry = path.join(distRoot, 'index.js');
    const latestModified = (pathname) => {
        if (!existsSync(pathname)) return 0;
        const stat = statSync(pathname);
        if (!stat.isDirectory()) return stat.mtimeMs;
        return readdirSync(pathname, { withFileTypes: true }).reduce((latest, item) => (
            Math.max(latest, latestModified(path.join(pathname, item.name)))
        ), stat.mtimeMs);
    };
    const inputs = [
        'src', 'static', 'package.json', 'package-lock.json',
        'rollup.config.mjs', 'copy-and-watch.mjs', 'tsconfig.json'
    ].map(filename => path.join(projectRoot, filename));
    const buildTime = existsSync(entry) ? statSync(entry).mtimeMs : 0;
    const sourceTime = Math.max(...inputs.map(latestModified));
    if (!rebuild && buildTime >= sourceTime) return;

    const dependencyStamp = path.join(projectRoot, 'node_modules', '.package-lock.json');
    const lockfile = path.join(projectRoot, 'package-lock.json');
    const dependenciesStale = !existsSync(dependencyStamp) ||
        statSync(dependencyStamp).mtimeMs < statSync(lockfile).mtimeMs;
    if (dependenciesStale) {
        console.log('Installing project dependencies...');
        await run(npmCommand, ['ci']);
    }
    console.log('Building SuperSplat and the trajectory tools...');
    await run(npmCommand, ['run', 'build']);
};

const mimeTypes = new Map([
    ['.css', 'text/css; charset=utf-8'],
    ['.html', 'text/html; charset=utf-8'],
    ['.ico', 'image/x-icon'],
    ['.jpeg', 'image/jpeg'],
    ['.jpg', 'image/jpeg'],
    ['.js', 'text/javascript; charset=utf-8'],
    ['.json', 'application/json; charset=utf-8'],
    ['.map', 'application/json; charset=utf-8'],
    ['.png', 'image/png'],
    ['.svg', 'image/svg+xml'],
    ['.wasm', 'application/wasm'],
    ['.webp', 'image/webp']
]);

const requestHandler = (request, response) => {
    try {
        const url = new URL(request.url ?? '/', 'http://localhost');
        const decoded = decodeURIComponent(url.pathname).replaceAll('\\', '/');
        const relative = decoded === '/' ? 'index.html' : decoded.replace(/^\/+/, '');
        const filename = path.resolve(distRoot, relative);
        const insideDist = filename === distRoot || filename.startsWith(`${distRoot}${path.sep}`);
        if (!insideDist || !existsSync(filename) || !statSync(filename).isFile()) {
            response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
            response.end('Not found');
            return;
        }
        const stat = statSync(filename);
        response.writeHead(200, {
            'Cache-Control': 'no-cache',
            'Content-Length': stat.size,
            'Content-Type': mimeTypes.get(path.extname(filename).toLowerCase()) ?? 'application/octet-stream'
        });
        if (request.method === 'HEAD') response.end();
        else createReadStream(filename).pipe(response);
    } catch (error) {
        response.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        response.end(error instanceof Error ? error.message : String(error));
    }
};

const listen = port => new Promise((resolve, reject) => {
    const server = createServer(requestHandler);
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server));
});

const startServer = async (port = requestedPort) => {
    try {
        return { server: await listen(port), port };
    } catch (error) {
        if (error?.code !== 'EADDRINUSE') throw error;
        if (strictPort) throw new Error(`Port ${port} is already in use`);
        if (port >= requestedPort + 19) {
            throw new Error(`No free port was found from ${requestedPort} to ${requestedPort + 19}`);
        }
        return startServer(port + 1);
    }
};

const launchBrowser = (url) => {
    const detached = { detached: true, stdio: 'ignore', windowsHide: true };
    if (process.platform === 'win32') {
        const chromeCandidates = [
            path.join(process.env.PROGRAMFILES ?? '', 'Google/Chrome/Application/chrome.exe'),
            path.join(process.env['PROGRAMFILES(X86)'] ?? '', 'Google/Chrome/Application/chrome.exe'),
            path.join(process.env.LOCALAPPDATA ?? '', 'Google/Chrome/Application/chrome.exe')
        ];
        const chrome = chromeCandidates.find(candidate => candidate && existsSync(candidate));
        if (chrome) {
            spawn(chrome, [
                '--force_high_performance_gpu',
                '--enable-gpu-rasterization',
                '--enable-zero-copy',
                `--app=${url}`
            ], detached).unref();
        } else {
            spawn('cmd.exe', ['/d', '/s', '/c', 'start', '', url], detached).unref();
        }
        return;
    }
    if (process.platform === 'darwin') {
        const result = spawn('open', [
            '-na', 'Google Chrome', '--args',
            '--force_high_performance_gpu',
            '--enable-gpu-rasterization',
            `--app=${url}`
        ], { stdio: 'ignore' });
        result.once('exit', (code) => {
            if (code !== 0) spawn('open', [url], detached).unref();
        });
        return;
    }
    spawn('xdg-open', [url], detached).unref();
};

try {
    await ensureBuild();
    const { server, port } = await startServer();
    const buildStamp = statSync(path.join(distRoot, 'index.js')).mtimeMs.toFixed(0);
    const url = `http://localhost:${port}/?build=${buildStamp}`;
    console.log(`\nSuperSplat is ready: ${url}`);
    console.log('Press Ctrl+C to stop the local server.\n');
    if (!process.argv.includes('--no-open')) launchBrowser(url);

    const shutdown = () => server.close(() => process.exit(0));
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
} catch (error) {
    console.error(`\nUnable to start SuperSplat: ${error instanceof Error ? error.message : error}`);
    process.exitCode = 1;
}
