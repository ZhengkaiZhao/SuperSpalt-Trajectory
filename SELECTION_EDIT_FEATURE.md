# SuperSplat 选择编辑功能增强

## 概述
为 SuperSplat 添加了选择高斯点的批量编辑功能，允许用户对选中的高斯点进行位置、缩放、不透明度和颜色调整。

## 新增文件

### 1. `src/ui/selection-edit-panel.ts`
选择编辑面板的主要UI组件，提供：
- 显示当前选择的高斯点数量
- 位置偏移控制（X, Y, Z）
- 缩放倍数控制（X, Y, Z 和统一缩放）
- 不透明度调整滑块
- 颜色调整控制（R, G, B）
- 快速操作按钮（全选、取消选择、反选、隐藏、删除）

### 2. `src/edit-ops-advanced.ts`
高级编辑操作实现，包含：
- `ApplyPositionOffsetOp` - 应用位置偏移
- `ApplyScaleMultiplierOp` - 应用缩放倍数
- `ApplyOpacityMultiplierOp` - 应用不透明度倍数
- `ApplyColorTintOp` - 应用颜色调整

所有操作都支持撤销/重做功能。

### 3. `src/ui/selection-edit-panel.css`
选择编辑面板的样式定义，支持深色和浅色主题。

## 功能特性

### 1. 位置偏移
- 支持 X、Y、Z 三个方向的独立偏移
- 使用变换调色板（Transform Palette）系统
- 保持高斯点的其他属性不变
- 可撤销操作

### 2. 缩放调整
- 支持 X、Y、Z 三个方向的独立缩放
- 提供统一缩放快捷控制
- 直接修改高斯点的缩放数据
- 可撤销操作

### 3. 不透明度调整
- 使用滑块进行直观调整（0.0 - 1.0）
- 实时显示当前值
- 自动限制在有效范围内
- 可撤销操作

### 4. 颜色调整
- 支持 RGB 三通道独立调整
- 倍数范围：0.0 - 2.0
- 直接修改 DC 颜色系数
- 可撤销操作

### 5. 快速操作
- 全选：选择所有可见的高斯点
- 取消选择：清除所有选择
- 反选：反转当前选择
- 隐藏选中：隐藏选中的高斯点
- 删除选中：删除选中的高斯点

## 集成步骤

### 步骤 1：导入组件
在 `src/ui/editor.ts` 中导入新的选择编辑面板：

```typescript
import { SelectionEditPanel } from './selection-edit-panel';
```

### 步骤 2：添加到UI
在编辑器初始化代码中创建并添加面板：

```typescript
const selectionEditPanel = new SelectionEditPanel(events, tooltips);
// 添加到合适的容器中（例如右侧面板）
rightPanel.append(selectionEditPanel);
```

### 步骤 3：添加CSS
在主样式文件中导入新的CSS：

```scss
@import './selection-edit-panel.css';
```

### 步骤 4：添加本地化字符串
将以下键值对添加到 `dist/static/locales/zh-CN.json` 和 `dist/static/locales/en.json`：

**中文 (zh-CN):**
```json
{
  "panel.selection-edit.title": "编辑选择",
  "panel.selection-edit.selected": "已选择",
  "panel.selection-edit.position-offset": "位置偏移",
  "panel.selection-edit.scale-multiplier": "缩放倍数",
  "panel.selection-edit.opacity": "不透明度",
  "panel.selection-edit.color-tint": "颜色调整",
  "panel.selection-edit.quick-actions": "快速操作"
}
```

**英文 (en):**
```json
{
  "panel.selection-edit.title": "Edit Selection",
  "panel.selection-edit.selected": "Selected",
  "panel.selection-edit.position-offset": "Position Offset",
  "panel.selection-edit.scale-multiplier": "Scale Multiplier",
  "panel.selection-edit.opacity": "Opacity",
  "panel.selection-edit.color-tint": "Color Tint",
  "panel.selection-edit.quick-actions": "Quick Actions"
}
```

### 步骤 5：显示/隐藏控制
可以添加快捷键或菜单项来切换面板的可见性：

```typescript
events.on('selectionEditPanel.toggle', () => {
    selectionEditPanel.hidden = !selectionEditPanel.hidden;
});
```

## 使用方法

1. **选择高斯点**：使用任何选择工具（矩形、套索、画笔等）选择高斯点
2. **打开编辑面板**：面板会自动显示选中的高斯点数量
3. **调整参数**：
   - 输入位置偏移值并点击"应用位置偏移"
   - 调整缩放倍数并点击"应用缩放"
   - 拖动不透明度滑块并点击"设置不透明度"
   - 调整颜色RGB值并点击"应用颜色调整"
4. **使用快速操作**：点击相应按钮执行快速操作
5. **撤销/重做**：所有操作都支持标准的撤销/重做功能

## 技术细节

### 数据结构
- 使用 `SplatState` 跟踪选择状态
- 使用 `TransformPalette` 管理位置变换
- 直接操作 `splatData` 中的原始数据

### 性能优化
- 仅对选中的高斯点执行操作
- 使用 GPU 纹理更新进行批量修改
- 增量式更新，避免全量重建

### 撤销/重做
- 所有编辑操作都实现了 `EditOp` 接口
- 保存原始值以支持精确撤销
- 集成到现有的 `EditHistory` 系统

## 未来改进

1. **实时预览**：在应用前预览效果
2. **批量操作**：支持多个操作的组合
3. **预设系统**：保存和加载常用的调整预设
4. **高级选择**：基于属性值的高级选择功能
5. **数据可视化**：显示选中高斯点的属性分布图表
6. **旋转调整**：添加四元数旋转的编辑功能
7. **渐变效果**：支持在选中区域应用渐变调整

## 测试建议

1. 测试选择少量高斯点（< 100）
2. 测试选择大量高斯点（> 10,000）
3. 测试撤销/重做功能
4. 测试极端值（如非常大的缩放或偏移）
5. 测试多次连续操作
6. 测试与其他工具的交互

## 注意事项

- 位置偏移使用变换调色板，最大支持 512 个独立变换
- 直接修改数据后需要调用 `rebuildData()` 更新 GPU 资源
- 所有数值输入都应验证和限制在合理范围内
- 颜色调整直接修改 DC 系数，不影响球谐函数系数

## 贡献
本功能增强了 SuperSplat 的编辑能力，使用户能够更精确地控制选中的高斯点。
