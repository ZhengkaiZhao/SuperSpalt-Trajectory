# SuperSplat Trajectory - Distribution

This package contains SuperSplat, the manual trajectory tools, the compiled web application and its source code.

For the complete Chinese workflow, see `docs/USER_GUIDE.zh-CN.md`.

## Run on Windows

1. Install Node.js 22 or newer. Node.js 24.19.0 LTS is the recommended project target.
2. Double-click `start-windows.cmd`.
3. Keep the command window open while using SuperSplat.

NVIDIA users can double-click `SuperSplat RTX.cmd` to launch an isolated Chrome app profile with high-performance GPU flags.

## Run on macOS

1. Install Node.js 22 or newer. Node.js 24.19.0 LTS is the recommended project target.
2. Double-click `start-macos.command`.
3. If macOS blocks the first launch, right-click the file and choose Open.
4. Keep Terminal open while using SuperSplat.

The launchers check Node.js/npm, install missing or stale dependencies exactly from `package-lock.json`, validate changed source, rebuild stale output, serve localhost and open Chrome. Windows can upgrade Node LTS through winget; macOS can install `node@24` through Homebrew. No fixed user path is used and normal startup never silently upgrades package versions.

## Command-line Alternative

```sh
npm run app:start
```

To force a clean rebuild before starting:

```sh
node scripts/start-local.mjs --repair
```

Use `npm run setup` to prepare without serving, `npm run doctor` for the complete dependency inventory, and `node scripts/start-local.mjs --help` for all recovery options.

## Create a New Release ZIP

Windows: double-click `package-release.cmd`.

macOS: double-click `package-release.command`.

Command-line alternative:

```sh
npm ci
npm run release:zip
```

The ZIP is written to `release/`. It excludes `node_modules`, logs, test output, source maps and machine-local data.
