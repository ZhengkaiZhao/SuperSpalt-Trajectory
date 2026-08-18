# SuperSpalt Trajectory

基于 [PlayCanvas SuperSplat Editor](https://github.com/playcanvas/supersplat) 的轨迹打点与 COLMAP 相机外参增强版本。

## Windows 启动

环境要求：Windows 10/11、[Node.js 20.19+](https://nodejs.org/) 和支持 WebGPU 的 Chrome 或 Edge。

1. 双击 [`start-windows.cmd`](start-windows.cmd)。
2. 脚本会按需执行 `npm ci`、构建项目、寻找 `3011-3030` 的可用端口并打开应用。
3. 保持命令窗口运行；按 `Ctrl+C` 停止本地服务。

NVIDIA/RTX 用户可以双击 [`SuperSplat RTX.cmd`](SuperSplat%20RTX.cmd)。该入口使用独立 Chrome 配置和高性能 GPU 参数，且不包含任何固定用户目录。

强制重新安装/构建：

```bat
start-windows.cmd --rebuild
```

## macOS 启动

环境要求：macOS、[Node.js 20.19+](https://nodejs.org/) 和支持 WebGPU 的 Chrome。

1. 首次下载后，在终端执行：

   ```sh
   chmod +x start-macos.command package-release.command
   ```

2. 双击 [`start-macos.command`](start-macos.command)。
3. 若系统阻止运行，请右键脚本并选择“打开”。
4. 保持终端窗口运行；按 `Control+C` 停止本地服务。

强制重新安装/构建：

```sh
./start-macos.command --rebuild
```

## 主要功能

- 加载和编辑 `.ply`、`.splat`、`.sog`、`.ksplat`、`.spz` 等高斯模型。
- 在当前观察视角记录人工关键点，并插值成任意数量的相机轨迹。
- 读取 COLMAP `images.txt`、可选 `cameras.txt` 及原始图片作为真实相机参考。
- 拖入普通图片，在真实相机与虚拟轨迹候选中返回最大概率匹配，而不是假定百分百匹配。
- 在右上角 HUD 实时查看并复制当前 COLMAP/OpenCV W2C Pose。
- 导出可直接用于 COLMAP `images.txt` 的 `qw qx qy qz tx ty tz` CSV 外参。
- 批量渲染插值轨迹 PNG，或导出 WAN K/T + COLMAP 数据包。
- 对四元数归一化、旋转正交性、行列式、C2W/W2C 互逆和相机中心进行导出校验。

完整使用步骤、坐标约定和故障排查见：

- [中文操作手册](docs/USER_GUIDE.zh-CN.md)
- [原版 SuperSplat 基础指南](docs/index.md)
- [分发与打包说明](DISTRIBUTION.md)

## 从 GitHub 获取

```sh
git clone https://github.com/ZhengkaiZhao/SuperSpalt-Trajectory.git
cd SuperSpalt-Trajectory
npm ci
npm run app:start
```

也可以不预先安装依赖，直接使用系统对应的双击启动脚本；缺失依赖会自动安装。

## 常用命令

```sh
npm run app:start          # 按需构建并启动，默认自动打开浏览器
npm run app:start:rebuild  # 强制重新构建并启动
npm run develop            # 开发模式：监听源码并自动构建
npm run check              # ESLint、语言包、核心测试和 TypeScript 检查
npm run build              # 生成 release 构建到 dist/
npm run release:zip        # 生成可分发 ZIP 到 release/
```

指定端口或禁止自动打开浏览器：

```sh
node scripts/start-local.mjs --port=3020 --no-open
```

## 目录说明

| 路径 | 内容 |
| --- | --- |
| `src/` | 编辑器、相机轨迹、匹配与导出源码 |
| `static/` | HTML、语言包、图标及静态资源 |
| `scripts/` | 启动、检查、验证和发布脚本 |
| `docs/` | 操作手册与基础指南 |
| `samples/` | 小型示例输入 |
| `dist/` | 构建产物，不提交 Git |
| `test-results/` | 浏览器验证产物，不提交 Git |

## 开发与验证

```sh
npm ci
npm run check
npm run build
```

CI 会在 GitHub 上执行安装、构建和静态检查。提交前不要加入 `node_modules/`、`dist/`、浏览器配置、测试截图、日志或本地数据集。

## 来源与许可证

本项目在 PlayCanvas SuperSplat 基础上扩展，保留原项目的 MIT 许可证。SuperSplat 是一个用于查看、编辑、优化和发布 3D Gaussian Splat 的开源浏览器编辑器。

- 上游项目：https://github.com/playcanvas/supersplat
- 上游在线编辑器：https://superspl.at/editor
- 许可证：[LICENSE](LICENSE)
