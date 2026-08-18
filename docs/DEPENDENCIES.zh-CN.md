# Node.js、依赖安装与升级说明

本文说明 SuperSpalt Trajectory 的 Node.js 版本策略、启动器安装流程、诊断命令和直接依赖用途。依赖版本以 `package-lock.json` 为最终依据。

## 1. Node.js 版本策略

| 项目 | 版本 | 含义 |
| --- | --- | --- |
| 最低支持 | Node.js 22.0.0 | `package.json` 的 `engines` 下限，低于此版本拒绝构建 |
| 推荐测试 | Node.js 24.19.0 LTS | `.nvmrc` 与 `.node-version` 固定版本 |
| npm | 随 Node.js 安装 | 启动器优先调用当前 Node 安装目录内配套的 npm |

Node.js 20 已结束生命周期，因此不再作为项目最低版本。Node.js 22 和 24 均由 CI 构建；完整质量检查在 Node.js 24 上执行。

Windows 启动时，`scripts/ensure-node-windows.ps1` 会检查常见安装位置和 `PATH`，优先选择推荐 LTS 主版本中的最高版本；没有该主版本时再选择发现的最高版本：

1. 未安装或低于 22.0.0：必须安装或升级。
2. 已达到 22.0.0 但低于 24.19.0：提示升级，也可继续使用现有受支持版本。
3. 达到推荐版本：直接继续。
4. 确认升级后，使用 `winget` 的 `OpenJS.NodeJS.LTS` 官方包。

macOS 启动器执行相同的版本判断，并可通过 Homebrew 安装或升级 `node@24`。使用 nvm、fnm、Volta 或 asdf 时，可直接读取 `.nvmrc` 或 `.node-version`。

## 2. 默认安装和检查流程

双击启动器或执行 `npm run app:start` 后，按以下顺序处理：

1. 环境预检：输出平台、Node.js、npm、直接依赖数、锁定包数、依赖状态、构建状态和校验状态。
2. 依赖判断：`node_modules` 缺失或早于 `package-lock.json` 时执行 `npm ci --no-fund`。
3. 依赖校验：确认每个直接依赖的安装版本与锁文件一致。
4. 项目校验：执行 ESLint、语言包一致性、核心逻辑测试和 TypeScript 类型检查。
5. 缓存结果：源码、配置、Node.js 版本和平台不变时复用上次成功校验；升级 Node.js 后自动重新检查。
6. 按需构建：仅在 `dist/` 缺失、源码较新或指定强制构建时运行 Rollup。
7. 启动服务：仅监听 `127.0.0.1`，从首选端口开始寻找可用端口。

`npm ci` 会先重建 `node_modules`，再严格安装锁文件中的版本。它不会像 `npm update` 一样选择新版本，也不会修改 `package.json` 或 `package-lock.json`。项目当前包含 36 个直接开发依赖、538 个锁定包（包含传递依赖），锁文件格式为 v3。

如果发行 ZIP 已包含有效的 `dist/`，且源码没有变化，启动器可以直接使用构建产物，无需为了运行网页重复下载开发依赖。

## 3. 命令和恢复方式

| 命令 | 安装 | 检查 | 构建 | 启动服务 |
| --- | --- | --- | --- | --- |
| `npm run app:start` | 按需 | 按需并缓存 | 按需 | 是 |
| `npm run setup` | 按需 | 强制 | 按需 | 否 |
| `node scripts/start-local.mjs --install` | 强制 | 是 | 按需 | 是 |
| `node scripts/start-local.mjs --check` | 按需 | 强制 | 按需 | 是 |
| `node scripts/start-local.mjs --rebuild` | 按需 | 是 | 强制 | 是 |
| `node scripts/start-local.mjs --repair` | 强制 | 强制 | 强制 | 是 |

诊断命令：

```sh
npm run doctor             # 声明版本、锁定版本、实际安装版本
npm run doctor:outdated    # 查询 registry 中的可用更新，不修改文件
npm run deps:check         # 验证直接依赖与锁文件一致
npm run check              # 依赖、代码、语言包、测试与类型检查
```

Windows 无交互 Node 预检：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/ensure-node-windows.ps1 -NonInteractive
```

## 4. 直接依赖清单

以下是 2026-08-18 锁文件中的直接依赖。带 `^` 的声明仍由锁文件固定到“锁定版本”，普通启动不会自动改变它。

| 包 | 锁定版本 | 作用 |
| --- | --- | --- |
| `@babylonjs/core` | 9.21.2 | Babylon.js 3D 数学与场景能力 |
| `@playcanvas/eslint-config` | 2.1.0 | PlayCanvas 代码规范配置 |
| `@playcanvas/pcui` | 6.1.4 | 编辑器 UI 控件库 |
| `@playcanvas/splat-transform` | 3.3.0 | Gaussian Splat 格式解析与转换 |
| `@rollup/plugin-alias` | 6.0.0 | Rollup 模块别名 |
| `@rollup/plugin-image` | 3.0.3 | 构建时导入图片资源 |
| `@rollup/plugin-json` | 6.1.0 | 构建时导入 JSON |
| `@rollup/plugin-node-resolve` | 16.0.3 | 解析 npm 模块 |
| `@rollup/plugin-strip` | 3.0.4 | 发布构建移除调试代码 |
| `@rollup/plugin-terser` | 1.0.0 | JavaScript 压缩 |
| `@rollup/plugin-typescript` | 12.3.0 | Rollup TypeScript 编译 |
| `@types/archiver` | 8.0.0 | Archiver TypeScript 类型 |
| `@types/wicg-file-system-access` | 2023.10.7 | 浏览器目录读写 API 类型 |
| `@typescript-eslint/eslint-plugin` | 8.67.0 | TypeScript ESLint 规则 |
| `@typescript-eslint/parser` | 8.67.0 | ESLint TypeScript 解析器 |
| `@webgpu/glslang` | 0.0.15 | WebGPU GLSL 到 SPIR-V 编译 |
| `archiver` | 8.0.0 | 生成导出和发布 ZIP |
| `autoprefixer` | 10.5.4 | CSS 浏览器前缀处理 |
| `concurrently` | 10.0.5 | 并行运行开发构建与服务 |
| `cors` | 2.8.6 | 本地开发服务跨域支持 |
| `cross-env` | 10.1.0 | 跨平台设置构建环境变量 |
| `eslint` | 9.39.5 | 源码静态检查 |
| `eslint-import-resolver-typescript` | 4.4.5 | ESLint TypeScript 导入解析 |
| `globals` | 17.11.0 | 浏览器与 Node 全局变量定义 |
| `i18next` | 26.3.6 | 国际化核心 |
| `i18next-browser-languagedetector` | 8.2.1 | 浏览器语言检测 |
| `i18next-http-backend` | 4.0.1 | 通过 HTTP 加载语言包 |
| `mediabunny` | 1.55.1 | 浏览器媒体编码与容器处理 |
| `playcanvas` | 2.21.4 | SuperSplat 的主渲染引擎 |
| `postcss` | 8.5.26 | CSS 转换管线 |
| `rollup` | 4.62.4 | 应用打包器 |
| `rollup-plugin-scss` | 4.0.1 | SCSS 构建集成 |
| `sass` | 1.102.0 | SCSS 编译器 |
| `serve` | 14.2.6 | 开发环境静态文件服务 |
| `tslib` | 2.8.1 | TypeScript 运行辅助函数 |
| `typescript` | 6.0.3 | 类型检查和源码编译 |

## 5. 本次依赖升级结果

2026-08-18 的 registry 检查发现 13 个直接依赖存在新版本。本次升级了其中 11 个不跨主版本的依赖：

| 依赖 | 原版本 | 新版本 |
| --- | --- | --- |
| `@babylonjs/core` | 9.20.0 | 9.21.2 |
| `@playcanvas/splat-transform` | 3.1.7 | 3.3.0 |
| `@typescript-eslint/eslint-plugin` | 8.65.0 | 8.67.0 |
| `@typescript-eslint/parser` | 8.65.0 | 8.67.0 |
| `concurrently` | 10.0.4 | 10.0.5 |
| `globals` | 17.7.0 | 17.11.0 |
| `i18next-http-backend` | 4.0.0 | 4.0.1 |
| `mediabunny` | 1.51.0 | 1.55.1 |
| `playcanvas` | 2.21.1 | 2.21.4 |
| `postcss` | 8.5.23 | 8.5.26 |
| `rollup` | 4.62.2 | 4.62.4 |

`@playcanvas/splat-transform` 3.3.0 新增了必填训练模型元数据；流式导出源已显式使用上游定义的安全默认值 `default`。干净安装实际加入 478 个本地包、审计 479 个包，报告 0 个已知漏洞。升级后依赖一致性、ESLint、8 个语言包、核心逻辑测试、TypeScript 和 release 构建均已通过。

`eslint` 暂时保留 9.39.5，不跨主版本升级到 10.8.1；`typescript` 暂时保留 6.0.3，不跨主版本升级到 7.0.2。这两个升级需要单独处理规则与编译器兼容性，不属于普通补丁更新。

后续升级应显式修改版本，再依次运行 `node scripts/start-local.mjs --repair --setup-only` 和 `npm run doctor:outdated`，不要把依赖升级混入普通启动流程。

## 6. 常见问题

### Node.js 升级后仍显示旧版本

关闭所有旧命令行窗口并重新启动。Windows 可执行 `where node`，macOS 可执行 `which -a node`，检查是否存在多个安装路径。Windows 检查脚本会选择发现的最高版本，但其他终端仍可能保留旧 `PATH`。

### winget 长时间无响应或失败

先在 Windows 设置中更新“应用安装程序”，然后执行 `winget source update`。也可以从 Node.js 官方下载页安装当前 LTS。完成后关闭旧终端，再运行 `start-windows.cmd`。

### npm 安装中断或依赖版本不一致

运行：

```sh
node scripts/start-local.mjs --repair --setup-only
```

该命令严格重建依赖、执行完整检查并重新生成构建；不会删除项目源码或用户数据。

### 只想快速运行已有发行构建

当 `dist/index.js` 存在且不早于源码时，普通启动会直接使用发行构建。不要添加 `--install`、`--check`、`--rebuild` 或 `--repair`。
