import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packageJson = JSON.parse(readFileSync(path.join(projectRoot, 'package.json'), 'utf8'));
const packageLock = JSON.parse(readFileSync(path.join(projectRoot, 'package-lock.json'), 'utf8'));
const direct = Object.entries({
    ...(packageJson.dependencies ?? {}),
    ...(packageJson.devDependencies ?? {})
}).sort(([left], [right]) => left.localeCompare(right));
const lockedPackageCount = Math.max(0, Object.keys(packageLock.packages ?? {}).length - 1);
const npmExecutable = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const nodeDirectory = path.dirname(process.execPath);
const npmCli = [
    path.join(nodeDirectory, 'node_modules/npm/bin/npm-cli.js'),
    path.resolve(nodeDirectory, '../lib/node_modules/npm/bin/npm-cli.js')
].find(existsSync);

const category = (name) => (
    /^@types\//.test(name) ? '类型定义' :
        /eslint|globals/.test(name) ? '代码质量' :
            /archiver|mediabunny|splat-transform/.test(name) ? '导入与导出' :
                /playcanvas|babylon|webgpu/.test(name) ? '渲染与 3D' :
                    /rollup|typescript|sass|postcss|autoprefixer|tslib/.test(name) ? '构建工具' :
                    /i18next/.test(name) ? '本地化' :
                        '开发运行'
);

const installedVersion = (name) => {
    const filename = path.join(projectRoot, 'node_modules', ...name.split('/'), 'package.json');
    if (!existsSync(filename)) return null;
    return JSON.parse(readFileSync(filename, 'utf8')).version;
};

const verify = process.argv.includes('--verify');
const compact = process.argv.includes('--compact');
const outdated = process.argv.includes('--outdated');
const rows = direct.map(([name, declared]) => ({
    name,
    category: category(name),
    declared,
    locked: packageLock.packages?.[`node_modules/${name}`]?.version ?? 'missing',
    installed: installedVersion(name)
}));

console.log('\nDependency inventory');
console.log('--------------------');
console.log(`Project              : ${packageJson.name} v${packageJson.version}`);
console.log(`Node.js              : v${process.versions.node}`);
console.log(`Direct dependencies  : ${rows.length}`);
console.log(`Locked packages      : ${lockedPackageCount}`);
console.log(`Lockfile version     : ${packageLock.lockfileVersion}`);

if (compact) {
    const groups = Map.groupBy(rows, row => row.category);
    for (const [name, values] of groups) {
        console.log(`${name.padEnd(16)}: ${values.length} (${values.map(value => value.name).join(', ')})`);
    }
} else {
    console.log('\nPackage                                      Declared       Locked         Installed');
    console.log('--------------------------------------------------------------------------------------');
    rows.forEach((row) => {
        console.log(
            `${row.name.padEnd(44)}${String(row.declared).padEnd(15)}` +
            `${String(row.locked).padEnd(15)}${row.installed ?? '-'}`
        );
    });
}

if (verify) {
    const invalid = rows.filter(row => !row.installed || row.installed !== row.locked);
    if (invalid.length > 0) {
        console.error(`\nDependency verification failed for: ${invalid.map(row => row.name).join(', ')}`);
        process.exitCode = 1;
    } else {
        console.log('\nDependency verification: all direct packages match package-lock.json.');
    }
}

if (outdated) {
    console.log('\nChecking the npm registry for newer versions...');
    const command = npmCli ? process.execPath : npmExecutable;
    const args = npmCli ? [npmCli, 'outdated', '--json'] : ['outdated', '--json'];
    const result = spawnSync(command, args, {
        cwd: projectRoot,
        encoding: 'utf8',
        shell: !npmCli && process.platform === 'win32'
    });
    if (result.error || (result.status !== 0 && !result.stdout.trim())) {
        console.error(result.error?.message || result.stderr.trim() || `npm outdated failed with status ${result.status}`);
        process.exitCode = 1;
    }
    let data = {};
    try {
        data = result.stdout.trim() ? JSON.parse(result.stdout) : {};
    } catch {
        console.error(result.stderr || result.stdout || 'Unable to parse npm outdated output.');
        process.exitCode = 1;
    }
    const updates = Object.entries(data);
    if (!process.exitCode && updates.length === 0) {
        console.log('All direct dependencies are current within the configured registry metadata.');
    } else if (!process.exitCode) {
        console.log('Package                                      Current        Wanted         Latest');
        console.log('--------------------------------------------------------------------------------');
        updates.forEach(([name, versions]) => console.log(
            `${name.padEnd(44)}${String(versions.current ?? '-').padEnd(15)}` +
            `${String(versions.wanted ?? '-').padEnd(15)}${versions.latest ?? '-'}`
        ));
    }
}
