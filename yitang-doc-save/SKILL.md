---
name: yitang-doc-save
description: >-
  当用户提供 yitang.top 课件文档 URL 并要求保存/下载页面时触发。
  将页面完整内容（文字、样式、图片、排版）保存为本地 HTML 和 Markdown 文件。
version: 2.0.0
requires:
  node: ">=18"
  playwright: "^1.59"
  os: [windows, macos, linux]
  claude-code: "*"
---

# 一堂课件文档保存

将一堂（yitang.top）课件文档页面保存为本地 HTML + Markdown，保留文字样式、图片和排版。

## 前置条件

- Node.js 已安装（`>=18`）
- Playwright 浏览器已就绪

## 工作区初始化（首次使用）

首次在当前工作区使用本 skill 时，需将 `save-webpage/` 目录拷贝到工作区。**所有后续操作都在工作区的副本中进行，不依赖 skill 目录**（skill 目录在更新时会被整体删除）。

### 步骤 0：检查并初始化

1. 检查工作区根目录下是否已存在 `save-webpage/save.js`
2. 若**不存在**，执行以下初始化：

```bash
# 从 skill 目录拷贝 save-webpage 到工作区
cp -r "<skill_dir>/save-webpage/" "./save-webpage/"

# 安装依赖（如 node_modules 已存在则跳过）
cd save-webpage && npm install

# 安装 Chromium（如已安装则跳过）
npx playwright install chromium
```

> 将 `<skill_dir>` 替换为当前 SKILL.md 所在目录的实际路径。

3. 若**已存在**，跳过初始化，直接进入步骤 1。

## 路径约定

| 内容 | 位置 |
|------|------|
| 产出物（HTML、MD、images/） | 当前工作目录（`process.cwd()`） |
| 脚本（save.js） | 工作区的 `save-webpage/` |
| GO 信号文件 | 工作区的 `save-webpage/GO` |
| browser-data（登录态） | 工作区的 `save-webpage/browser-data/` |
| node_modules | 工作区的 `save-webpage/node_modules/` |

> 不写死任何机器的绝对路径，保持仓库可移植。skill 目录仅供首次拷贝使用，后续操作不依赖它。

## 输出目录命名

1. 若用户在消息中已给出明确名称，**直接使用，不要再询问**
2. 若用户未指定名称，使用 `AskUserQuestion` 提供选项：
   - 「以页面标题命名」— 传入 `__FROM_TITLE__`，脚本自动用标题生成安全目录名
   - 「我来自定义」— 让用户手动输入名称

## 使用流程

用户提供 URL 后，按以下步骤执行：

### 步骤 1：确认输出目录名

- 用户已指定名称 → 直接进入步骤 2
- 用户未指定 → 使用 `AskUserQuestion` 让用户选择命名方式

### 步骤 2：启动脚本

在工作区根目录下执行：

```bash
node save-webpage/save.js "<文档URL>" "<输出目录名>"
# 或以页面标题命名：
node save-webpage/save.js "<文档URL>" "__FROM_TITLE__"
```

使用 `run_in_background` 非阻塞启动，等待输出中出现 `YITANG_DOC_TITLE` 和 `YITANG_OUTPUT_DIR`。

### 步骤 3：触发保存

页面加载完成后，直接创建 `GO` 信号文件：

```bash
touch save-webpage/GO
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
- 产出物写入当前工作目录（`process.cwd()`），与脚本目录分离
- `save.js` 以 `__dirname` 作为 SAVE_ROOT，用于定位 GO 信号文件和 browser-data
- 所有持久化数据（browser-data、node_modules）在工作区中，不受 skill 更新影响

## 脚本位置

工作区的 `save-webpage/save.js`（首次使用时从 skill 目录拷贝而来）。
