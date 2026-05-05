# Skills 仓库

自定义 Claude Code Skills 集合。

## 可用 Skills

| Skill | 目录 | 用途 |
|-------|------|------|
| yitang-doc-save | `yitang-doc-save/` | 保存一堂(yitang.top)课件文档为本地 HTML + Markdown |

## 目录约定

- 每个 skill 一个独立目录，目录名与 SKILL.md 中的 `name` 一致
- SKILL.md 位于 skill 目录根下，包含 frontmatter（name、description）和使用说明
- 辅助脚本/配置放在 skill 目录内的子目录中

## Skill 编写规范

- `name` 与目录名一致，使用 kebab-case
- `description` 用中文写明 **何时触发** 该 skill（触发条件 + 做什么），不超过 3 句话
- SKILL.md 正文是给 Claude 的指令，用中文，简洁优先
- 脚本路径使用相对于 skill 目录的路径，不写死绝对路径
