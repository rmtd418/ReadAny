# 阅读选区加入 AI 最小改造方案

## 结论

本次只做最小改造：

- 继续使用现有“小菜单加入对话”动作
- 不再新造第二套双击选区系统
- 不做“再次双击删除”

## 改造原则

1. `FoliateViewer` 不动

- 不改 `pointerup`
- 不改选区清空规则
- 不新增底层双击监听

2. `handleAskAI` 不复制

- 直接复用 `ReaderView` 里现有的 `handleAskAI`
- 双击只是换一种触发方式

3. 命中范围直接使用当前 `selection.rects` 的最大外接矩形

- 由当前已经存在的选区状态来判断
- 不再额外维护第二份选区缓存
- 取最左、最右、最上、最下四条边，组成一个完整矩形
- 矩形内命中，矩形外不命中

## 落点

- `packages/app/src/components/reader/ReaderView.tsx`
- `packages/app/src/components/reader/SelectionPopover.tsx`

## 预期效果

- 用户先正常框选文字
- 小菜单仍然照常出现
- 在当前蓝色选区最大外接矩形内双击
- 直接触发和小菜单星星按钮同一条逻辑

## 不做的事

- 不做删除切换
- 不做底层命中系统重写
- 不做新的快捷键方案
