import { spawn, spawnSync } from 'node:child_process';
import {
    createReadStream,
    existsSync,
    readFileSync,
    readdirSync,
    statSync,
    writeFileSync
} from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const distRoot = path.join(projectRoot, 'dist');
const packageJson = JSON.parse(readFileSync(path.join(projectRoot, 'package.json'), 'utf8'));
const packageLock = JSON.parse(readFileSync(path.join(projectRoot, 'package-lock.json'), 'utf8'));
const recommendedNodeVersion = readFileSync(path.join(projectRoot, '.nvmrc'), 'utf8').trim();
const requestedPort = Number.parseInt(
    process.argv.find(argument => argument.startsWith('--port='))?.split('=')[1] ?? '3011',
    10
);
const rebuild = process.argv.includes('--rebuild') || process.argv.includes('--repair');
const repair = process.argv.includes('--repair');
const forceInstall = process.argv.includes('--install') || repair;
const forceCheck = process.argv.includes('--check') || repair;
const skipCheck = process.argv.includes('--no-check');
const setupOnly = process.argv.includes('--setup-only');
const strictPort = process.argv.includes('--strict-port');

const nodeDirectory = path.dirname(process.execPath);
process.env.PATH = `${nodeDirectory}${path.delimiter}${process.env.PATH ?? ''}`;
const bundledNpm = path.join(nodeDirectory, process.platform === 'win32' ? 'npm.cmd' : 'npm');
const npmCommand = existsSync(bundledNpm) ? bundledNpm : process.platform === 'win32' ? 'npm.cmd' : 'npm';
const npmCli = [
    path.join(nodeDirectory, 'node_modules/npm/bin/npm-cli.js'),
    path.resolve(nodeDirectory, '../lib/node_modules/npm/bin/npm-cli.js')
].find(existsSync);
const npmRunner = npmCli ? {
    command: process.execPath,
    prefix: [npmCli],
    shell: false
} : {
    command: npmCommand,
    prefix: [],
    shell: process.platform === 'win32'
};
const minimumNodeVersion = [22, 0, 0];

const printHelp = () => {
    console.log(`SuperSpalt Trajectory local launcher

Usage:
  node scripts/start-local.mjs [options]

Options:
  --port=<1024-65535>  Preferred port (default: 3011; tries 19 more ports)
  --strict-port        Fail instead of selecting the next available port
  --no-open            Start the server without opening a browser
  --install            Reinstall exactly from package-lock.json with npm ci
  --check              Force all project validation checks
  --no-check           Skip project validation for this launch
  --rebuild            Force a new dist build
  --repair             Force install, validation, and rebuild
  --setup-only         Prepare and validate without starting the server
  --help               Show this help

The default launch installs only when dependencies are missing/stale, validates
changed source, builds changed source, and reuses successful validation results.`);
};

if (process.argv.includes('--help')) {
    printHelp();
    process.exit(0);
}

const compareVersions = (left, right) => {
    for (let index = 0; index < Math.max(left.length, right.length); index++) {
        const difference = (left[index] ?? 0) - (right[index] ?? 0);
        if (difference !== 0) return Math.sign(difference);
    }
    return 0;
};

const nodeVersion = process.versions.node.split('.').map(Number);
const startupProblems = [];
if (compareVersions(nodeVersion, minimumNodeVersion) < 0) {
    startupProblems.push(`Node.js 22 or newer is required; current version is ${process.versions.node}`);
}
if (!Number.isSafeInteger(requestedPort) || requestedPort < 1024 || requestedPort > 65535) {
    startupProblems.push(`invalid local port: ${requestedPort}`);
}
if (skipCheck && forceCheck) startupProblems.push('--check/--repair cannot be combined with --no-check');

const latestModified = (pathname) => {
    if (!existsSync(pathname)) return 0;
    const stat = statSync(pathname);
    if (!stat.isDirectory()) return stat.mtimeMs;
    return readdirSync(pathname, { withFileTypes: true }).reduce((latest, item) => (
        Math.max(latest, latestModified(path.join(pathname, item.name)))
    ), stat.mtimeMs);
};

const run = (command, args, shell = false) => new Promise((resolve, reject) => {
    const child = spawn(command, args, {
        cwd: projectRoot,
        env: process.env,
        shell,
        stdio: 'inherit',
        windowsHide: true
    });
    child.once('error', reject);
    child.once('exit', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`${path.basename(command)} ${args.join(' ')} failed with exit code ${code}`));
    });
});

const runNpm = args => run(npmRunner.command, [...npmRunner.prefix, ...args], npmRunner.shell);

const npmVersion = () => {
    const result = spawnSync(npmRunner.command, [...npmRunner.prefix, '--version'], {
        cwd: projectRoot,
        env: process.env,
        encoding: 'utf8',
        shell: npmRunner.shell,
        windowsHide: true
    });
    return result.status === 0 ? result.stdout.trim() : 'unavailable';
};

const section = title => console.log(`\n[${title}]${'-'.repeat(Math.max(1, 58 - title.length))}`);
const line = (label, value) => console.log(`${label.padEnd(20)}: ${value}`);

const buildInputs = [
    'src', 'static', 'package.json', 'package-lock.json',
    'rollup.config.mjs', 'copy-and-watch.mjs', 'tsconfig.json'
].map(filename => path.join(projectRoot, filename));
const checkInputs = [
    'src', 'static/locales', 'package.json', 'package-lock.json',
    'eslint.config.mjs', 'tsconfig.json',
    'scripts/check-locales.mjs', 'scripts/test-core-logic.mjs',
    'scripts/dependency-report.mjs'
].map(filename => path.join(projectRoot, filename));

const prepareProject = async () => {
    const entry = path.join(distRoot, 'index.js');
    const lockfile = path.join(projectRoot, 'package-lock.json');
    const dependencyRoot = path.join(projectRoot, 'node_modules');
    const dependencyStamp = path.join(dependencyRoot, '.package-lock.json');
    const checkStamp = path.join(dependencyRoot, '.superspalt-check.json');
    const buildTime = existsSync(entry) ? statSync(entry).mtimeMs : 0;
    const sourceTime = Math.max(...buildInputs.map(latestModified));
    const checkSourceTime = Math.max(...checkInputs.map(latestModified));
    const buildNeeded = rebuild || buildTime < sourceTime;
    const dependenciesPresent = existsSync(dependencyRoot) && existsSync(dependencyStamp);
    const dependenciesStale = !dependenciesPresent || statSync(dependencyStamp).mtimeMs < statSync(lockfile).mtimeMs;
    const bundledBuildMode = !buildNeeded && !dependenciesPresent && !forceInstall && !forceCheck && !setupOnly;
    const directCount = Object.keys({
        ...(packageJson.dependencies ?? {}),
        ...(packageJson.devDependencies ?? {})
    }).length;
    const lockedCount = Math.max(0, Object.keys(packageLock.packages ?? {}).length - 1);

    section('Environment preflight');
    line('Project', `${packageJson.name} v${packageJson.version}`);
    line('Platform', `${process.platform} ${process.arch}`);
    line('Node.js', `v${process.versions.node} (${process.execPath})`);
    line('npm', `v${npmVersion()}`);
    line('Required Node.js', packageJson.engines?.node ?? 'not specified');
    line('Recommended Node.js', `v${recommendedNodeVersion} LTS (.nvmrc)`);
    line('Direct dependencies', directCount);
    line('Locked packages', lockedCount);
    line('Dependencies', dependenciesPresent ? dependenciesStale ? 'stale' : 'ready' : 'missing');
    line('Build', buildTime === 0 ? 'missing' : buildNeeded ? 'stale' : 'ready');
    line('Validation', skipCheck ? 'disabled by --no-check' : 'enabled (cached when unchanged)');

    if (bundledBuildMode) {
        console.log('\nUsing the bundled release build. Dependency installation and source checks are not required.');
        return { installed: false, checked: false, built: false, bundled: true };
    }

    let installed = false;
    if (forceInstall || dependenciesStale) {
        section('Deterministic dependency installation');
        line('Reason', forceInstall ? 'forced by --install/--repair' : dependenciesPresent ?
            'package-lock.json changed' : 'node_modules is missing');
        line('Command', 'npm ci --no-fund');
        line('Policy', 'package-lock.json is authoritative; package ranges are not upgraded');
        await runNpm(['ci', '--no-fund']);
        installed = true;
        await run(process.execPath, ['scripts/dependency-report.mjs', '--compact']);
    } else {
        section('Dependency installation');
        console.log('All locked dependencies are present; npm ci is not required.');
    }

    let checked = false;
    if (!skipCheck) {
        const previousCheckTime = existsSync(checkStamp) ? statSync(checkStamp).mtimeMs : 0;
        let previousCheck = {};
        try {
            previousCheck = existsSync(checkStamp) ? JSON.parse(readFileSync(checkStamp, 'utf8')) : {};
        } catch {
            // An invalid cache is treated as a cache miss.
        }
        const runtimeChanged = previousCheck.node !== process.versions.node ||
            previousCheck.platform !== `${process.platform}-${process.arch}`;
        const checkNeeded = forceCheck || installed || runtimeChanged || previousCheckTime < checkSourceTime;
        section('Default project validation');
        if (checkNeeded) {
            line('Reason', forceCheck ? 'forced by --check/--repair' : installed ?
                'dependencies were installed' : runtimeChanged ?
                    'Node.js version or platform changed' : 'source or configuration changed');
            line('Checks', 'dependency integrity, ESLint, locales, core tests, TypeScript');
            await runNpm(['run', 'check']);
            writeFileSync(checkStamp, `${JSON.stringify({
                checkedAt: new Date().toISOString(),
                node: process.versions.node,
                platform: `${process.platform}-${process.arch}`,
                sourceTime: checkSourceTime
            }, null, 2)}\n`);
            checked = true;
        } else {
            console.log('The current source and lockfile already passed validation; cached result reused.');
        }
    }

    let built = false;
    if (buildNeeded) {
        section('Application build');
        line('Reason', rebuild ? 'forced by --rebuild/--repair' : buildTime === 0 ?
            'dist/index.js is missing' : 'source is newer than dist/index.js');
        line('Output', path.join(projectRoot, 'dist'));
        await runNpm(['run', 'build']);
        built = true;
    } else {
        section('Application build');
        console.log('dist/index.js is current; rebuild is not required.');
    }

    return { installed, checked, built, bundled: false };
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
        console.log(`Port ${port} is busy; trying ${port + 1}...`);
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

const main = async () => {
    if (startupProblems.length > 0) throw new Error(startupProblems.join('; '));
    const result = await prepareProject();
    if (setupOnly) {
        section('Setup complete');
        line('Dependencies installed', result.installed ? 'yes' : 'already current');
        line('Validation executed', result.checked ? 'yes' : skipCheck ? 'skipped' : 'cached');
        line('Application built', result.built ? 'yes' : 'already current');
        console.log('\nRun start-windows.cmd, start-macos.command, or npm run app:start to launch.\n');
        return;
    }

    const { server, port } = await startServer();
    const buildStamp = statSync(path.join(distRoot, 'index.js')).mtimeMs.toFixed(0);
    const url = `http://localhost:${port}/?build=${buildStamp}`;
    section('Ready');
    console.log(`SuperSpalt Trajectory: ${url}`);
    console.log('Press Ctrl+C to stop the local server.');
    if (!process.argv.includes('--no-open')) launchBrowser(url);

    const shutdown = () => server.close(() => process.exit(0));
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
};

main().catch((error) => {
    console.error(`\nUnable to prepare or start SuperSpalt: ${error instanceof Error ? error.message : error}`);
    console.error('Recovery: run with --repair, or review docs/DEPENDENCIES.zh-CN.md.');
    process.exitCode = 1;
});
