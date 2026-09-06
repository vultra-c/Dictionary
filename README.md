# 词典（小米 Vela 轻应用 · 手环离线英汉双向词典）

纯离线运行的英汉 / 汉英双向词典，适配小米手环 9 Pro（336×480 矩形屏）。
6.3 万词条全部内置在包内，无需联网。

- 包名：`com.whyy.dictionary`
- 当前版本：`V26.9.1.DICT`（versionCode 2609001）
- 设计尺寸：336 × 480（designWidth 336）
- UI 风格规范：仓库根目录 `VELA_UI_SKILL.md`（后续 AI 开发必读，与化学工具箱同源的「闪念小抄」风格）
- 开发提示词文档：仓库根目录 `DEV_PROMPTS.md`（AI 辅助开发直接参考）
- 风格参考仓库：[examreader](https://github.com/vultra-c/examreader)、[Chemical-calculator](https://github.com/vultra-c/Chemical-calculator)

## 功能

1. **英汉查询**：输入英文单词查看中文释义、音标（IPA）。
2. **汉英互查**：输入法打中文（内置拼音连打词库），命中释义字段反查英文词条。
3. **前缀扩散搜索**：输入 `ap` 即扩散出 `apple/apply/…`（键盘英文模式候选行实时出词；结果列表随按键同步）。字典序二分查找，键键毫秒级。
4. **词形变化**：常规变形全展示——过去式、过去分词、现在分词、三单、复数、比较级、最高级（如 go → went/gone/going/goes），点击词形可跳转该词条。
5. **派生词**：不常规变形（+tion/+able/+ment/+ity/+ly/+er/+ist/+ism… 共 35 种后缀规则）规则生成候选并回查词库验证（如 create → creation/creative/creator），点击可跳转。
6. **反向查询**：
   - 不规则变形反查：输入 went 显示「go 的过去式」，一键跳词根（2.8 万词条级反查标注来自 ECDICT lemma 标注）；
   - 派生词根还原：输入 creation，规则剥离后缀 + 词库验证显示「词根 create」；
   - 中文释义反查即汉英互查。
7. **生词本**：词条页「+ 收藏」，本地 storage 持久化（上限 200，最新在前）；生词本页可查看/跳转/两步确认清空。
8. **设置中心**：主页右上角进入；常亮显示、按键振动开关（`@system.storage` 持久化，双端生效）。

## 页面结构

| 路由 | 说明 |
|------|------|
| `pages/index` | 主页：查词 / 生词本 / 设置 三张功能卡 + 右上角设置直达 |
| `pages/search` | 查词页：药丸搜索框 + 共享输入法（中/英）+ 实时结果列表；英文候选行联动词典扩散 |
| `pages/detail` | 词条详情：音标 / 释义 / 词形变化芯片 / 词形还原与派生还原链接 / 派生词芯片 / 收藏 |
| `pages/favorites` | 生词本列表（空态图 + 两步确认清空） |
| `pages/settings` | 设置：常亮显示、按键振动、关于入口 |
| `pages/about` | 关于：版本、包名、词库规模、数据致谢 |

所有页面支持右滑退出（`@swipe right`），操作逻辑与考点阅读器/化学工具箱一致。

## 目录

```
├── package.json                # aiot-toolkit 构建配置
├── src/manifest.json           # 包名/版本/路由/designWidth=336
├── src/app.ux                  # $def 跨页传参（dictWord）+ 常亮启动应用
├── src/common/
│   ├── style.css               # 闪念小抄风格公共令牌与组件样式（hd 顶栏四件套）
│   ├── images/                 # hd/back/more/enter/empty_state/icon.png
│   ├── data/dict.js            # ★ 词典数据（自动生成，~4.3MB，63071 条单一长字符串）
│   └── logic/
│       ├── dict.js             # ★ 词典引擎：二级分隔字段 + OFF 偏移数组 + 二分/扩散/中文反查
│       ├── forms.js            # ★ 词形解析与派生规则引擎（正查/反查，词典验证零误报）
│       ├── fav.js              # 生词本 storage 封装
│       └── settings.js         # 设置持久化 + 常亮应用
├── src/components/InputMethod/ # 书中书：拼音连打中文 + 英文词典联想输入法（通用词库版）
├── src/pages/*/                # 六个页面（index/search/detail/favorites/settings/about）
├── scripts/
│   ├── patch-aiotpack.js       # rspack 原生绑定 SIGBUS 补丁（postinstall 自动执行）
│   └── verify-rpk.mjs          # 包名 + RPK Sig Block 42 签名块闸门校验
├── tests/smoke.mjs             # 引擎冒烟测试（46 条断言，CI 必过）
├── tools/
│   ├── gen-dict.mjs            # ECDICT → data/dict.js 生成器
│   └── gen-icon.mjs            # 零依赖 PNG 图标生成器（翻页书主题）
├── sign/release/               # 发布签名 private.pem + certificate.pem
├── .github/workflows/build.yml # 推送即构建 + 冒烟 + 校验 + 体积闸门 + Release
└── DEV_PROMPTS.md              # 开发提示词文档（AI 开发约束与设计意图）
```

## 词库数据（tools/gen-dict.mjs）

- 数据源：ECDICT 简明英汉词典增强版（[skywind3000/ECDICT](https://github.com/skywind3000/ECDICT)，含音标/释义/词频/柯林斯星级/变形标注）。
- 生成：将 `ecdict.csv`（65MB，不入库）下载到 `tools/ecdict.csv` 后执行
  `npm run gen:dict`，产物为 `src/common/data/dict.js`。
- 词条规模与筛选：纯小写词根 2–18 字符；柯林斯/牛津/考试标签/词频排名择优 3.5 万；
  另有 2.8 万装「变形反查词条」（如无可靠的词频信号但带 lemma 回指标注的 went/gone/better 等全形态）。
- 数据格式（每行一条，运行时零解析建库）：
  `word \x01 音标 \x02 释义(≤2义项56字) \x03 变形标记`，行 `\n` 分隔；
  变形标记：`k:v` 逗号串（常规变形）或 `=词根:角色`（反查标记）。
- 体积：dict.js 载荷约 4.7MB，成品 rpk（zip 压缩）全包约 3.4MB，距 7MB 红线富余。

## 构建与验证

本仓库不在本地构建 rpk（参考 README「CI 工作流」约定）：
推送 main/master 分支即触发 GitHub Action，自动完成

1. `npm install`（postinstall 打 aiotpack 补丁）
2. `node tests/smoke.mjs`（46 条引擎断言）
3. `npm run release`（aiot release --enable-jsc → dist/*.rpk）
4. `node scripts/verify-rpk.mjs dist/*.rpk`（包名 + 签名块闸门）
5. 体积闸门（≤ 7MB，超出报错）
6. 上传 Artifact + 发布原始 rpk 到 GitHub Release

固定安装包下载地址：
`https://github.com/vultra-c/Dictionary/releases/latest/download/com.whyy.dictionary.release.V26.9.1.DICT.rpk`
（版本号随行更新，以 Release 最新资产为准；Artifacts 是 zip 容器，直接装会显示「没有包名」。）

本地准备环境（可选）：

```bash
# 安装构建工具链（跑冒烟/图标/词库再生成需要）
npm install
# 环境冒烟：引擎与规则断言（构建前必跑过一遍）
node tests/smoke.mjs
# 重新生成图标（零依赖）
npm run gen:icon
# 重新生成词库（需先手工下载 ecdict.csv 到 tools/）
npm run gen:dict
```

## 签名

- `sign/release/` 下的证书为本应用发布签名，勿更换（更换会导致已安装设备无法覆盖升级）。

## 版本号规则

- `versionName` 按 `V26.9.XX.DICT` 递增，`versionCode`（2609XXX）同步递增；
- 发布/关于页中的版本文案手动同步更新。

## 数据与版权致谢

- 词条源自 ECDICT（飞刀版词典工程），本项目按需裁剪字段并做腕表运行时适配。
- 输入法拼音单字表与连打词库来自考点阅读器（examreader）通用词库版。
