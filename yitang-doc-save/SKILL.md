---
name: yitang-doc-save
description: >-
  当用户提供 yitang.top 课件文档 URL 并要求保存/下载页面时触发。
  将页面完整内容（文字、样式、图片、排版）保存为本地 HTML 和 Markdown 文件。
version: 1.0.0
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

- **推荐**：在 `save-webpage/` 目录下执行命令
- **可选**：设置环境变量 `YITANG_SAVE_ROOT` 为该目录的绝对路径，即可在任意 cwd 调用 `save.js`
- 不写死任何机器的绝对路径，保持仓库可移植

## 输出目录命名（必须先与用户确认）

1. 禁止在未征得用户同意时，使用 URL 中的 id、哈希或随机串作为输出目录名
2. 若用户已给出明确名称（如「清单体笔记」），直接使用
3. 若用户同意以页面标题命名，传入第三个参数 `__FROM_TITLE__`，脚本会自动用标题生成安全目录名并打印 `YITANG_OUTPUT_DIR`
4. 页面加载后会输出 `YITANG_DOC_TITLE`（JSON 字符串），可用于与用户核对标题

## 使用流程

用户提供 URL 后，先确认输出目录名，再执行以下步骤：

### 步骤 1：启动脚本

```bash
cd save-webpage
node save.js "<文档URL>" "<输出目录名>"
# 或以页面标题命名（需用户事先同意）：
node save.js "<文档URL>" "__FROM_TITLE__"
```

非阻塞启动，等待输出中出现「页面已打开」及 `YITANG_DOC_TITLE`。

### 步骤 2：等待用户确认

告知用户浏览器已打开，请确认正文内容与标题显示正常后再继续。

### 步骤 3：触发保存

在 `save-webpage/` 目录下创建 `GO` 信号文件：

```bash
touch GO
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
- `YITANG_SAVE_ROOT` 环境变量支持在任意 cwd 调用脚本

## 脚本位置

`save-webpage/save.js`
