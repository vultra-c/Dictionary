# 词典 · 开发提示词文档（AI 辅助开发必读）

> 本文档面向后续参与本仓库开发的 AI 助手与人类开发者，
> 约束「工程结构 + 数据设计意图 + 交互规范 + 真机铁律」。
> 视觉与交互规范见同目录 `VELA_UI_SKILL.md`（闪念小抄风格，与化学工具箱同源），
> 本文聚焦词典特有的引擎、数据与页面逻辑，两者配合使用。

---

## 0. 一句话定位

小米手环 9 Pro（336×480，Vela 快应用）上的**纯离线英汉双向词典**：
6.3 万词条打包为包内资产文件（dict.dat/dict.smp/zh.dat）+ 小窗随机读取引擎 + 规则派生，
rpk 全包 ≤ 7MB（实测约 4.6MB）。

## 1. 硬性约束（违反必翻车，真机验证过的坑）

1. **屏幕**：336×480，`manifest.json` 里 `config.designWidth = 336`，CSS 一律 `px` 绝对定位。
2. **list-item 铁律**：`for` 与 `if` **不得同用**（Vela 不按条目求值，真机整列空白）。
   多形态行用「单一 type + 行内 `show` + 动态 class」表达（见 `pages/detail/detail.ux` 的 `.d-row` 体系）。
3. **选择器**：不支持后代选择器（`.a .b`），一律单 class。
4. **键盘遮挡**：共享 InputMethod 弹起时 y > 252px 被遮挡；搜索框/清除按钮必须在 y ≤ 252px。
5. **watch/setTimeout 链不可靠**（部分机型）：键盘显隐直接由 `hide` prop 驱动；
   页面逻辑尽量「事件驱动同步执行」，少用定时器串联。
6. **图片**：静态资源 `<img static>`；页面间引用用绝对路径 `/common/...`。
7. **纯逻辑库禁止 import @system.\***：`common/logic/dict.js`、`forms.js` 必须保持 Node 可测
   （`node tests/smoke.mjs` 直接 import 它们）；storage/brightness/file 只在页面层或
   settings.js/fav.js/dictfile.js 封装层出现（dict 引擎靠 `warmup(makeReader())` 注入 readRange）。
8. **版本号**：`src/manifest.json` 的 `versionName` 按 `V26.9.XX.DICT` 递增，`versionCode` 同步递增；
   关于页版本文案手动同步。
9. **每次修改完都要 git 推送**：本仓库以 GitHub Action 为唯一构建出口（见 §6）。

## 2. 词典数据设计（v2：为什么是文件而不是 JS 模块）

`src/common/data/` 三件套由 `tools/lib/dict-pack.mjs` 生成（gen-dict.mjs / migrate-from-js.mjs 驱动），**勿手改**。

**v1 的教训（必记）**：单字符串 `data/dict.js`（5.9MB / 339 万字符）在真机 JS 堆下限加载即 OOM，
凡 import 它的页面（查词/生词本/详情）打开就崩（应用进程死，系统无恙）。v2 起改为：

```
dict.dat = "apple\x01æpl\x02n. 苹果\x03s:apples\ngood\x01gud\x02...\x03p:went,...\nwent\x01\x02\x03=go:p\n..."   (~4.7MB)
dict.smp = 32B 头('DSMP'|ver|样本数|词条数|dictLen|zhLen|保留) + 每样本 8B [word前6字母 packed u32 | 行首偏移 u32]   (~27KB)
zh.dat   = "apple\x02n. 苹果\n..."（只含释义非空词条，中文反查扫描语料）   (~3.4MB)
```

- 每行一条词条，行 `\n` 分隔，字段 `\x01 \x02 \x03` 分隔，全表按 word 字典序排序。
- **运行时零常驻**：`smp` 抽样索引整表驻留（~27KB），英文查询 = smp 在 RAM 二分定位「桶」
  → `readArrayBuffer(position, length)` 读 ≤2KB 桶窗 → 行扫。桶跨度生成期保证 ≤ ~1.7KB。
  常驻内存 ~100KB（smp + 6 桶 LRU 缓存 + 中文扫描单窗缓冲）。
- 身份门槛：`readRange` 由页面层经 `dictfile.makeReader()` 注入（file API 串行队列），
  引擎本体不 import @system.*，Node 直测（smoke 用 fs 切片同构复现窗口逻辑）。
- 变形标记两套编码（同 v1）：
  - 词根条目 `k:v` 逗号串：`p:went,d:gone,i:going,3:goes`（k∈p/d/i/3/s/r/t）；
  - 反查词条 `=词根:角色`：`went → =go:p`（反向查询的数据票根）。
- 纯反查词条（释义为「xx的过去式」式样板文）**释义置空**，运行时用变形标记结构化重建文案，省 ~600KB。

**改词库的唯一入口**：改 `tools/gen-dict.mjs` 的筛选/清洗规则 → 把 `ecdict.csv`（65MB，不入库）
下载到 `tools/ecdict.csv` → `npm run gen:dict` → 跑冒烟 → 提交生成物（dat+smp+zh 三件一起提交）。

## 3. 引擎（common/logic/dict.js，全异步回调风格对齐 @system.*）

| 能力 | 实现 | I/O 复杂度 |
|------|------|--------|
| 英文精确查询 `findExact(w, cb)` | smp RAM 二分定位桶 + ≤2KB 桶窗行扫 | 1 次读（命中缓存 0 次） |
| 前缀扩散 `prefixQuery(q, cap, cb)` | 定位桶逐行收集前缀连续段，跨桶续扫（≤8 桶） | 1~3 次读 |
| 键盘英文联想 `suggestEn(q, cap, cb)` | 同上，取词不取条 | 同上 |
| 批量取词 `entriesFor(words, cb)` | 顺序链 + 桶LRU缓存（同前缀候选基本零 I/O） | ≤N 次读 |
| 中文反查 `zhQuery(q, cap, cb)` | zh.dat 顺序 64KB 窗口扫描（owned 区间判属 + word 去重 + seq 舵标废弃） | ≤~54 次读（全扫）/提前收满即止 |
| 统一调度 `search(raw, cap, cb)` | CJK 判定 / 输入净化 / kind 分类 | — |

接口约定（页面先接线再查询，未 warm 会自动挂起 smp 装载后再回调）：

```js
dict.warmup(makeReader())  // app.ux onCreate 一次性：注入 readRange + 预热 smp（幂等）
dict.search(q, 60, (rst) => { /* {kind, exact, rows:[{word,ph,trans,ex}]} */ })
dict.findExact(w, (entry|null) => ...)
dict.entriesFor([w...], (map{w:entry|null}) => ...)
dict.suggestEn(q, 12, ([w...]) => ...)
```

- **过期舵标**：页面持有自增 seq，回调时 seq 不等即丢弃（搜索页/输入法同模式）；
  引擎内部 `querySeq` 让中文长扫描在新查询到来时空中止。
- **损坏兜底**：资产缺失/I-O 失败 → broken 态，所有查询回空结果，页面显示空态，不崩。
- UTF-8 自行解码（dict.js decodeU8），不依赖 TextDecoder（可用性无文档保障）；
  分隔符 `\x01/\x02/\x03/\n` 为单字节 ASCII，窗口切割至多破坏边缘字符解码，不破行解析。

修引擎必须同步补 `tests/smoke.mjs` 断言（当前 51 条，CI 必过）。

## 4. 词形与派生（common/logic/forms.js，纯候选生成）

- `parseExchange(ex)`：解析两套变形编码 → `{lemma, role, forms:[{k,label,v}]}`。
- `forwardDerive(word)`：派生正查候选（不过滤）。35 种后缀 × 词干变换集（drop e / y→i / 辅音双写）。
- `reverseStem(q)`：派生反查候选（不过滤）。后缀剥离 + 词干恢复（补 e / undouble / i→y）。
- **验证在调用方**：调 `entriesFor` 批量查词典后过滤（**规则引擎零词表、零误报由验证步骤保证**）；
  detail 页每个后缀取首个验证通过的词根（cap 6），派生 chip 取前 12 条验证通过的候选。
- 后缀表 `SUFFIXES` 有序（ion 最先——create→creation 是最高频派生型）。
  加后缀时同时补正查变换集与反查恢复集，并加冒烟断言。

## 5. 页面与交互约定

- 路由六页：index / search / detail / favorites / settings / about，见 `src/manifest.json`。
- 跨页传参只走 `this.$app.$def.dictWord`（app.ux 预声明）。
- 右滑 = 收键盘（若开）→ `router.back()`；`onBackPress` 返回 true。
- 引擎异步回调（~10-50ms 量级，无防抖定时器）：每个查询发端持有自增 seq 舵标，回调过期即弃；
  结果分块渲染（首屏 18 行，`onscrollbottom` 追加）。
- 词条详情行数据在 `assemble()` 里组装成 `{type, cls, text/label/word/suffix/sense}` 平铺数组，
  模板单一 list-item + `show` 分发；跳转词条 = 改 `$def.dictWord` + push 同页（栈式钻取，返回即回上级词）。
- 收藏上限 200，`toggleFav` 返回 added/removed/null，UI 立即回显；
  生词本行经 `entriesFor` 一次批量反查组装。

## 6. 构建与发布（本仓库不在本地构建 rpk）

推送 main/master → `.github/workflows/build.yml` 自动：
`npm install`（postinstall 打 aiotpack SIGBUS 补丁）→ 冒烟 → `aiot release --enable-jsc`
→ `verify-rpk`（包名+签名块闸门）→ 体积闸门（≤7MB）→ Artifact + GitHub Release（原始 rpk）。

- **安装包只认 Release 原始 .rpk**；Actions Artifact 是 zip 容器，直接装会显示「没有包名」。
- CI 失败 → 看日志修复 → 重新推送触发；CI 成功 → 无需任何后续处理。
- 签名 `sign/release/` 勿更换（换签名导致已装设备无法覆盖升级）。

## 7. 新页面/新功能检查清单

1. 路由注册进 `src/manifest.json` `router.pages`？
2. 页面根 `page` + `@swipe` + `onBackPress`？顶栏四件套（hd/back/sub/title）原样带上？
3. 有滚动列表？→ `.list` 全屏铺底 + 分块渲染 + `tid` + 同 type 同 DOM（多形态用 show+动态 class）。
4. 输入相关元素在 y ≤ 252px 安全区？
5. 新逻辑进 `common/logic/*.js` 且不 import @system.*？补冒烟断言？
6. 资源绝对路径 `/common/...` + `<img static>`？
7. 改完：`node tests/smoke.mjs` 过 → 提交推送 → 看 CI 绿。

## 8. 快速上手命令

```bash
# 引擎与规则冒烟（46 断言）
node tests/smoke.mjs

# 重新生成图标（零依赖 PNG 编码器）
npm run gen:icon

# 重新生成词库（需先手工下载 ecdict.csv 到 tools/，65MB 不入库）
npm run gen:dict

# 本地起模拟器（可选，真机构装走 CI）
npm run start
```
