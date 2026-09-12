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

[Project Knowledge Summary]
- Date: 2026-09-12
- Context: 真机修复「点击查词/生词本应用崩溃、词典无内容」，词典数据架构 v2 改造（单 JS 模块 → 包内资产文件）
- Category: Troubleshooting & Debugging
- Instructions:
  - 手环 Vela 运行时 JS 堆极小：超大型 JS 数据模块（5.9MB 单字符串字面量）加载即 OOM，凡 import 它的页面打开就崩（应用进程死、系统无恙），不 import 的页面正常——「部分页面崩溃、部分正常」先查页面依赖的大模块体积
  - 大数据唯一可靠方案：包内资产文件 + `@system.file.readArrayBuffer`（官方文档确认支持包内资源路径 '/common/...' 与 position/length 部分读取）小窗随机读取；引擎常驻内存应从 ~7MB 压到 ~100KB
  - aiot 打包会把 src/common/ 下 .dat/.smp 非图片资产复制入 rpk（>1MB 仅告警）；verify-rpk.mjs 已加数据资产入包闸门，本地 npm run build/release 可验证
  - 词典引擎为异步回调风格（对齐 @system.*），dict.init 注入 readRange（dictfile.makeReader 串行队列），common/logic/dict.js 保持纯逻辑 Node 可测（smoke 用 fs 切片复现窗口逻辑）
  - TextDecoder 可用性无文档保障，引擎自行解码 UTF-8；分隔符用单字节 ASCII（\x01/\x02/\x03/\n）保证窗口切割不破行解析
