# User Instruction Memory

This file records user instructions, preferences, and teachings for reference in future interactions.

## Format

### User Instruction Entry
User instruction entries should follow this format:

[User Instruction Summary]
- Date: [YYYY-MM-DD]
- Context: [Mentioned scenario or time]
- Instructions:
  - [Content of user teaching or instruction, described line by line]

### Project Knowledge Entry
Entries discovered by the Agent during task execution should follow this format:

[Project Knowledge Summary]
- Date: [YYYY-MM-DD]
- Context: Discovered by Agent while performing [specific task description]
- Category: [Operations & Deployment|Build Methods|Testing Methods|Troubleshooting & Debugging|Workflow & Collaboration|Environment Configuration]
- Instructions:
  - [Specific knowledge points, described line by line]

## Deduplication Strategy
- Before adding a new entry, check for similar or identical instructions.
- If a duplicate is found, skip the new entry or merge it with the existing one.
- When merging, update the context or date information.
- This helps avoid redundant entries and keeps the memory file tidy.

## Entries

[User Instruction Summary]
- Date: 2026-09-06
- Context: 词典（小米手环 Vela 应用）项目首次开发任务
- Instructions:
  - 本仓库不在本地构建 rpk：每次修改完成即 git 推送，GitHub Action 自动构建 rpk
  - 用户临时提供 GitHub push token：token 绝不写入任何仓库文件或 git 配置，只在单次命令的 URL/环境变量中使用
  - 推送后只需用 token 调 gh/curl 检查 CI 构建是否成功；CI 失败修复后重推，CI 成功则无需后续处理

[Project Knowledge Summary]
- Date: 2026-09-06
- Context: Agent 初始化词典项目工程（参考 examreader / Chemical-calculator 同源风格）
- Category: Build Methods
- Instructions:
  - 构建链：aiot-toolkit release --enable-jsc；npm postinstall 自动跑 scripts/patch-aiotpack.js（rspack 原生绑定 SIGBUS 回退 webpack5）
  - CI 闸门链：node tests/smoke.mjs → aiot release → node scripts/verify-rpk.mjs dist/*.rpk（包名+签名块）→ ≤7MB 体积闸门 → Release 原始 rpk
  - 安装包只认 GitHub Release 的原始 .rpk；Actions Artifact 是 zip 容器，直接安装会显示「没有包名」
  - 词库源 ECDICT ecdict.csv（65MB）不入库；再生成：下载到 tools/ecdict.csv 后 npm run gen:dict
  - 真机铁律：list-item 的 for 与 if 不得同用（用单一 type + 行内 show + 动态 class）；不支持后代选择器；键盘遮挡区 y>252px；watch/setTimeout 链不可靠
