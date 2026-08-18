import { spawn } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outputRoot = path.join(projectRoot, 'release');
const packageJson = JSON.parse(readFileSync(path.join(projectRoot, 'package.json'), 'utf8'));
const date = new Date();
const stamp = [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
    '-',
    String(date.getHours()).padStart(2, '0'),
    String(date.getMinutes()).padStart(2, '0')
].join('');
const archiveName = `SuperSplat-Trajectory-${packageJson.version}-${stamp}.zip`;
const archivePath = path.join(outputRoot, archiveName);
const archivePrefix = 'SuperSplat-Trajectory';

const run = (command, args) => new Promise((resolve, reject) => {
    const child = spawn(command, args, {
        cwd: projectRoot,
        shell: false,
        stdio: 'inherit',
        windowsHide: true
    });
    child.once('error', reject);
    child.once('exit', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`${command} ${args.join(' ')} failed with exit code ${code}`));
    });
});

const addGlob = (archive, directory, ignore = []) => {
    archive.glob('**/*', {
        cwd: path.join(projectRoot, directory),
        dot: true,
        follow: false,
        ignore
    }, {
        prefix: `${archivePrefix}/${directory}`
    });
};

try {
    console.log('Preparing dependencies, checks, and the latest application build...');
    await run(process.execPath, ['scripts/start-local.mjs', '--setup-only', '--check']);
    const { ZipArchive } = await import('archiver');

    mkdirSync(outputRoot, { recursive: true });
    const output = createWriteStream(archivePath);
    const archive = new ZipArchive({ zlib: { level: 9 } });
    const completed = new Promise((resolve, reject) => {
        output.once('close', resolve);
        output.once('error', reject);
        archive.once('error', reject);
    });
    archive.pipe(output);

    addGlob(archive, 'src');
    addGlob(archive, 'static');
    addGlob(archive, 'scripts');
    addGlob(archive, 'docs');
    addGlob(archive, 'dist', ['**/*.map', 'current-data', 'current-data/**']);

    const rootFiles = [
        '.gitignore',
        '.node-version',
        '.nvmrc',
        'copy-and-watch.mjs',
        'DISTRIBUTION.md',
        'eslint.config.mjs',
        'global.d.ts',
        'LICENSE',
        'package-lock.json',
        'package.json',
        'README.md',
        'rollup.config.mjs',
        'SuperSplat RTX.cmd',
        'start-macos.command',
        'start-windows.cmd',
        'package-release.command',
        'package-release.cmd',
        'tsconfig.json'
    ];
    rootFiles.forEach((filename) => {
        const source = path.join(projectRoot, filename);
        if (!existsSync(source)) return;
        archive.file(source, {
            name: `${archivePrefix}/${filename}`,
            mode: filename.endsWith('.command') ? 0o755 : statSync(source).mode
        });
    });

    await archive.finalize();
    await completed;
    const sizeMb = statSync(archivePath).size / (1024 * 1024);
    console.log(`\nRelease package created:\n${archivePath}\n${sizeMb.toFixed(1)} MB`);
} catch (error) {
    console.error(`\nPackaging failed: ${error instanceof Error ? error.message : error}`);
    process.exitCode = 1;
}
