# SuperSplat Trajectory - Distribution

This package contains SuperSplat, the manual trajectory tools, the compiled web application and its source code.

For the complete Chinese workflow, see `docs/USER_GUIDE.zh-CN.md`.

## Run on Windows

1. Install Node.js 20.19 or newer.
2. Double-click `start-windows.cmd`.
3. Keep the command window open while using SuperSplat.

NVIDIA users can double-click `SuperSplat RTX.cmd` to launch an isolated Chrome app profile with high-performance GPU flags.

## Run on macOS

1. Install Node.js 20.19 or newer.
2. Double-click `start-macos.command`.
3. If macOS blocks the first launch, right-click the file and choose Open.
4. Keep Terminal open while using SuperSplat.

The launchers validate Node.js, install stale or missing dependencies when a rebuild is needed, rebuild stale sources, serve localhost and open Chrome. No fixed user path is used.

## Command-line Alternative

```sh
npm run app:start
```

To force a clean rebuild before starting:

```sh
npm ci
npm run app:start:rebuild
```

## Create a New Release ZIP

Windows: double-click `package-release.cmd`.

macOS: double-click `package-release.command`.

Command-line alternative:

```sh
npm ci
npm run release:zip
```

The ZIP is written to `release/`. It excludes `node_modules`, logs, test output, source maps and machine-local data.
