# 快速集成指南

## 将选择编辑功能集成到 SuperSplat 中

本指南说明如何将新的选择编辑功能集成到现有的 SuperSplat 应用中。

## 集成步骤

### 步骤 1：添加本地化字符串

编辑 `dist/static/locales/zh-CN.json`，在文件末尾添加（注意保持JSON格式）：

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

编辑 `dist/static/locales/en.json`，添加：

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

### 步骤 2：集成到主UI

找到主UI文件（可能是 `src/ui/editor.ts` 或类似文件），在文件顶部添加导入：

```typescript
import { SelectionEditPanel } from './selection-edit-panel';
```

在创建UI组件的位置添加：

```typescript
// 创建选择编辑面板
const selectionEditPanel = new SelectionEditPanel(events, tooltips);
```

将面板添加到右侧面板容器（或您希望的位置）：

```typescript
// 假设有一个右侧面板容器
rightPanelContainer.append(selectionEditPanel);
```

### 步骤 3：添加CSS样式

有两种方式添加CSS：

**方式A：直接在主样式文件中导入**

在 `src/ui/editor.css` 或主样式文件中添加：

```css
@import './selection-edit-panel.css';
```

**方式B：在TypeScript中导入**

在 `src/ui/selection-edit-panel.ts` 顶部添加：

```typescript
import './selection-edit-panel.css';
```

### 步骤 4：添加显示/隐藏控制（可选）

如果想添加快捷键或菜单项来切换面板：

```typescript
// 在事件注册部分添加
events.on('selectionEditPanel.toggle', () => {
    selectionEditPanel.hidden = !selectionEditPanel.hidden;
});

// 添加快捷键（例如 E 键）
shortcuts.register('e', {
    name: 'toggleSelectionEditPanel',
    fn: () => events.fire('selectionEditPanel.toggle')
});
```

### 步骤 5：构建和测试

```bash
# 构建项目
npm run build

# 或在开发模式下运行
npm run develop
```

## 验证集成

### 测试清单

1. **基本功能**
   - [ ] 面板正确显示
   - [ ] 选择高斯点时数量更新
   - [ ] 所有输入控件可以交互

2. **位置偏移**
   - [ ] 输入值并应用后高斯点移动
   - [ ] 撤销功能正常工作

3. **缩放调整**
   - [ ] 独立轴缩放工作正常
   - [ ] 统一缩放同步三个轴
   - [ ] 撤销功能正常工作

4. **不透明度**
   - [ ] 滑块调整工作正常
   - [ ] 数值显示正确
   - [ ] 撤销功能正常工作

5. **颜色调整**
   - [ ] RGB调整生效
   - [ ] 撤销功能正常工作

6. **快速操作**
   - [ ] 全选按钮工作
   - [ ] 取消选择按钮工作
   - [ ] 反选按钮工作
   - [ ] 隐藏按钮工作
   - [ ] 删除按钮工作

7. **本地化**
   - [ ] 中文界面正确显示
   - [ ] 英文界面正确显示
   - [ ] 切换语言后文本更新

## 常见集成问题

### 问题 1：面板不显示

**可能原因：**
- CSS 文件未正确导入
- 容器元素不存在
- 面板被设置为 hidden

**解决方法：**
```typescript
// 确保面板初始可见
selectionEditPanel.hidden = false;

// 检查容器
console.log('Container exists:', !!rightPanelContainer);
```

### 问题 2：选择数量不更新

**可能原因：**
- 事件未正确连接
- Splat 对象引用问题

**解决方法：**
```typescript
// 手动触发更新测试
events.fire('splat.stateChanged', currentSplat);
```

### 问题 3：编辑操作无效

**可能原因：**
- EditHistory 未正确初始化
- Resource 更新方法不存在

**解决方法：**
检查 Splat 类是否有以下方法：
- `resource.updateColors()`
- `resource.updateTransforms()`
- `markRenderDataDirty()`

### 问题 4：样式不正确

**可能原因：**
- CSS 变量未定义
- 样式冲突

**解决方法：**
检查浏览器开发工具，确保 CSS 变量正确定义：
```css
:root {
    --panel-background: #2a2a2a;
    --text-color: #e0e0e0;
    /* ... 其他变量 */
}
```

## 高级集成选项

### 选项 1：添加到菜单

在菜单配置中添加：

```typescript
{
    text: i18n.t('menu.view.selection-edit'),
    onSelect: () => events.fire('selectionEditPanel.toggle')
}
```

### 选项 2：添加工具栏按钮

```typescript
const selectionEditButton = new Button({
    icon: '✏️',
    text: i18n.t('toolbar.selection-edit')
});

selectionEditButton.on('click', () => {
    selectionEditPanel.hidden = !selectionEditPanel.hidden;
});

toolbar.append(selectionEditButton);
```

### 选项 3：持久化面板状态

保存面板显示/隐藏状态到本地存储：

```typescript
// 保存状态
events.on('selectionEditPanel.toggle', () => {
    localStorage.setItem('selectionEditPanelVisible', 
        String(!selectionEditPanel.hidden));
});

// 恢复状态
const savedState = localStorage.getItem('selectionEditPanelVisible');
if (savedState !== null) {
    selectionEditPanel.hidden = savedState !== 'true';
}
```

## 性能优化建议

### 1. 延迟加载
如果面板初始不可见，考虑延迟创建：

```typescript
let selectionEditPanel: SelectionEditPanel = null;

const getSelectionEditPanel = () => {
    if (!selectionEditPanel) {
        selectionEditPanel = new SelectionEditPanel(events, tooltips);
        rightPanelContainer.append(selectionEditPanel);
    }
    return selectionEditPanel;
};
```

### 2. 事件节流
对于频繁触发的事件，添加节流：

```typescript
let updateTimeout: number = null;
events.on('splat.stateChanged', (splat: Splat) => {
    if (updateTimeout) clearTimeout(updateTimeout);
    updateTimeout = window.setTimeout(() => {
        // 更新UI
    }, 100);
});
```

## 下一步

集成完成后，建议：

1. **阅读用户指南** - 了解如何使用新功能
2. **进行完整测试** - 使用测试清单验证所有功能
3. **收集反馈** - 从用户获取使用反馈
4. **优化体验** - 根据反馈改进UI和功能

## 支持

如果遇到集成问题，请参考：
- `SELECTION_EDIT_FEATURE.md` - 技术实现详情
- `USER_GUIDE_SELECTION_EDIT.md` - 用户使用指南
- SuperSplat 官方文档
- GitHub Issues

---

祝集成顺利！
