---
name: yitang-doc-save
description: >-
  当用户提供 yitang.top 课件文档 URL 并要求保存/下载页面时触发。
  将页面完整内容（文字、样式、图片、排版）保存为本地 HTML 和 Markdown 文件。
version: 1.1.0
requires:
  node: ">=18"
  playwright: "^1.59"
  os: [windows, macos, linux]
  claude-code: "*"
---

# 一堂课件文档保存

将一堂（yitang.top）课件文档页面保存为本地 HTML + Markdown，保留文字样式、图片和排版。

## 前置条件

- Node.js 已安装
- 在 `save-webpage/` 目录下已执行 `npm install`，Playwright 浏览器已就绪
- `save-webpage/browser-data/` 用于持久化 Chromium 登录态（首次使用需微信扫码）

## 路径约定

- **产出物**保存到当前工作目录（即用户在 IDE 中打开的项目根目录）
- **脚本、GO 信号文件、browser-data** 仍在 skill 的 `save-webpage/` 目录下
- 不写死任何机器的绝对路径，保持仓库可移植

## 输出目录命名

1. 若用户在消息中已给出明确名称（如「清单体笔记」），**直接使用，不要再询问**
2. 若用户未指定名称，使用 `AskUserQuestion` 提供选项：
   - 「以页面标题命名」— 传入 `__FROM_TITLE__`，脚本自动用标题生成安全目录名
   - 「我来自定义」— 让用户手动输入名称

## 使用流程

用户提供 URL 后，按以下步骤执行：

### 步骤 1：确认输出目录名

- 用户已指定名称 → 直接进入步骤 2
- 用户未指定 → 使用 `AskUserQuestion` 让用户选择命名方式

### 步骤 2：启动脚本

在项目根目录下执行：

```bash
node yitang-doc-save/save-webpage/save.js "<文档URL>" "<输出目录名>"
# 或以页面标题命名：
node yitang-doc-save/save-webpage/save.js "<文档URL>" "__FROM_TITLE__"
```

使用 `run_in_background` 非阻塞启动，等待输出中出现 `YITANG_DOC_TITLE` 和 `YITANG_OUTPUT_DIR`。

### 步骤 3：触发保存

页面加载完成后，直接创建 `GO` 信号文件：

```bash
touch yitang-doc-save/save-webpage/GO
```

### 步骤 4：监控进度

等待脚本输出「全部完成」。脚本会自动完成：
1. 逐屏滚动采集虚拟列表中的内容块
2. 提取文字（含计算样式）、图片、标题、列表、表格、代码、引用
3. 通过浏览器上下文下载图片
4. 生成带侧边栏目录的 HTML
5. 生成 Markdown

### 步骤 5：报告结果

| 文件 | 说明 |
|------|------|
| `<输出目录名>/page_final.html` | 带侧边栏目录的完整 HTML |
| `<输出目录名>/page.md` | Markdown |
| `<输出目录名>/images/` | 图片 |

## 技术要点

- 页面使用虚拟列表，必须滚动采集，不能直接另存 MHTML
- 通过 `GO` 信号文件触发保存，避免终端交互阻塞
- 产出物写入当前工作目录（`process.cwd()`），与 skill 脚本分离

## 脚本位置

`save-webpage/save.js`
