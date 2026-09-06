# Vela 穿戴 小抄 UI 风格开发 Skill

> 适用于采用「闪念小抄」设计体系的小米 Vela 快应用（词典、化学工具箱、弦电子书同源风格）。
> AI 开发时遵循本文件即可无缝衔接现有风格，无需再读全部页面源码。
> 工程与构建细节以仓库内实际文件为准，本文件约束「视觉 + 交互 + 代码模式」。

---

## 0. 硬性约束（违反必翻车）

1. **屏幕**：矩形屏 `336×480`，`manifest.json` 里 `config.designWidth = 336`，CSS 一律用 `px`。
2. **单位与坐标**：所有坐标手算绝对值；主体的卡片/列表/按钮全部 `position: absolute` 顶层挂载，**不依赖 flex 流式测量**（VDOM 小、布局稳定、低端手表不抖）。
3. **选择器**：**不支持后代选择器**（如 `.a .b`），构建只会告警且样式失效。一律单 class，命名体现层级（`.cat-item` / `.cat-main`）。
4. **list-item**：
   - `for` 与 `if` **不得同用**——Vela 不会按条目求值，真机会整列空白（已在 catalog 踩过）。
   - 同 `type` 的 `list-item` DOM 结构必须完全一致；差异用**动态 class 三元**表达：
     `class="{{$item.kind === 'title' ? 'cat-title-item' : 'cat-item'}}"`。
   - 每个 `list-item` 必须有唯一 `tid`。
   - 列表数据**分块渲染**（首屏 15–24 条，`onscrollbottom` 追加），防首屏卡顿。
5. **键盘遮挡**：共享 InputMethod 弹起时，y > 252px 的区域被遮挡。**输入卡、主要按钮必须放在 y ≤ 252px 内**。
6. **图片**：静态资源 `<img static>`（静态标记利于编译期优化）。页面间引用用绝对路径 `/common/...`（aiot 2.0 不允许相对路径拼接）。
7. **模板**：`{{ }}` 内不得再嵌套 `{{ }}`；`template` 根节点唯一。

---

## 1. 设计令牌（Design Tokens）

```css
/* 颜色 */
背景（页面）          #000000            纯黑
卡片底                #262626            深灰
卡片内嵌行底          #333333            更深一档灰（element 页结果行）
主按钮 / 选中态       #0d6eff            品牌蓝
强调文字（浅蓝）      #4da3ff            副信息/徽章/选中提示
徽标底                rgba(13,110,255,0.22)
主文字                #ffffff
次文字                rgba(255,255,255,0.6)
弱文字/占位           rgba(255,255,255,0.35 ~ 0.45)

/* 圆角梯度 */
大卡片/按钮           36px（112px 菜单卡、输入卡、主按钮）
中行/小按钮           28px / 24px（62–72px 数据行卡、56px 操作按钮）
徽标/胶囊             15px / 21px（chip）

/* 字号梯度 */
页面大标题（顶栏）    32px bold
菜单卡主标题          32px bold / 副题 28px bold rgba(255,255,255,0.6)
数据行主文            24–26px bold
数据行副文            20–24px rgba(255,255,255,0.55~0.72)
区段标签 sec-label    20px rgba(255,255,255,0.45)
徽章/辅助文字         19–22px
```

---

## 2. 顶栏规范（所有页面统一）

```
<img static src="/common/images/hd.png" class="hd-bg" />          <!-- 0,0 336×102 -->
<img static src="/common/images/back.png" class="hd-back" />      <!-- 6,6 72×72 -->
<img static src="/common/images/more.png" class="hd-more" />      <!-- 258,6 72×72（可选） -->
<text static class="hd-sub">副题（左对齐语义，居中于标题区）</text>
<text static class="hd-title">页面主标题</text>
```

hd-bg/back/more/sub/title 的坐标与样式已在 `common/style.css` 定义，新页面直接用。

- **hd.png 本身就是遮罩**：它 336×102，alpha 逐行 255→6，绘制在 list 之后时，
  滚动内容在顶栏下方自然渐隐（与弦电子书原版 hd.png 逐字节一致）。
- **禁止再叠任何自制遮罩层**（如 top_fade.png）：叠层会压住 hd.png 的渐变，
  真机观感是「遮罩消失 / 像多加了一层」（2026-08 真机连踩三次后确认，
  相关资产与 .top-fade 类已全部移除）。滚动列表页只需 hd 四件套原样带上。

## 3. 页面骨架模式

- 根节点 `<div class="page" @swipe="onSwipe">`。
- 列表：全屏铺底 `.list`（`top:0;height:480px;padding:102px 6px 8px;`），首屏内容自 102px 之下开始。
- 功能区：`top:104~108` 起放第一卡（输入卡/方程式卡），向下排布，底部操作按钮顶边一般 ≤ 418px（高 56，底边 474）。
- 兜底：`if="{{!valid}}"` 的空态用 `common/images/empty_state.png` + 灰字。

## 4. 组件配方

| 组件 | 结构要点 |
| --- | --- |
| 菜单卡（主页/设置 hub） | `.item`（112px）> `.item-content`（竖排标题+副题） + `.arrow` enter.png |
| 数据行（catalog / constants / mr-list） | 62–72–88px 高卡片；内层 `div.cat-content` 横排 `space-between` 或竖排 |
| 区段标签 | `.sec-label`（动态页中 top 跟随卡片档位） |
| 主/次按钮 | `.btn-main`（蓝底白字）/ `.btn-ghost`（灰底浅字），56–72px 高 |
| 芯片选择 chip | `chip` / `chip-on` 两 class，点击切换选中态（mass 页已知物质） |
| 输入卡 | 圆角 36 卡片，无输入显示占位灰字，有输入显示内容 + 光标 `_` |
| 徽标 | 半透明蓝底圆角胶囊，内嵌强调色文字 |
| 模态/键盘 | 共享 `components/InputMethod/InputMethod.ux`；`hide="{{!showKb}}"` 控制显隐 |

## 5. 交互规范

1. `onSwipe(e)`：`e.direction === 'right'` → 键盘开则先收键盘，否则 `router.back()`。主页右滑 `app.terminate()`。
2. `onBackPress()` 返回 `true` 并 `router.back()`，禁止默认弹退出框。
3. 异步反馈统一用 `prompt.showToast({ message, duration })`，避免阻塞。
4. 跨页传参走 `this.$app.$def`（app.ux 里预声明字段，如 `reaction` / `pendingFormula` / `massKnownIdx`）。
5. 设置持久化走 `@system.storage`（见 `common/logic/settings.js` 封装；**页面层才能 import @system.***，纯逻辑库禁止）。

## 6. 性能铁律

1. 长文本渲染前拼成**单个字符串**（方程式、候选词），一个 `<text>` 解决，不逐段绑节点。
2. 计算结果缓存：`parseFormula` 与 `classify` 已做 Map 缓存，新加重计算函数照此模式（模块级缓存 + 上限 clear）。
3. 大数据（银行/字典）**惰性构建**：模块先出工厂函数，首次用时再 `initDict()`（见 dicUtil / elementQuery 的 `_text` / `_segs` 缓存）。
4. 列表分块 + `onscrollbottom` 追加；同屏 VDOM 节点数保持最小。
5. 新代码不引入额外依赖；构建走 `npm run release`（`aiot release --enable-jsc`）。

## 7. 工程与创新约束

1. **版本号**：`src/manifest.json` 的 `versionName` 按 `V26.8.XX.CALC` 递增，`versionCode` 同步递增（发布/关于页文案手动同步）。
2. 任何逻辑改动必须过 `node tests/smoke.mjs`（当前 88 条断言），新增规则要补防回归用例。
3. 构建产物必须过 `node scripts/verify-rpk.mjs dist/*.rpk`（包名 + 签名块校验）。
4. 分发只认 **Releases 原始 .rpk**；CI 的 artifact 是 zip 容器，直接装会“没有包名”。
5. AI 改动遵循「最小侵入」：复用本文件模式，不引入新框架/新样式体系。

---

## 8. 快速上手清单（给后续 AI）

开发新页面时按顺序自检：

1. 路由是否注册进 `src/manifest.json` `router.pages`？
2. 页面是否 `page` 根 + `@swipe` + `onBackPress`？
3. 顶栏四件套（hd/back(或 more)/sub/title）是否原样带上？
4. 有滚动列表吗？有则 `.list` 全屏铺底 + 分块渲染 + `tid` + 同 type 同 DOM；遮罩交给 hd.png 自身渐变，**不得**叠自制遮罩层。
5. 输入相关元素是否在 y ≤ 252px 安全区（有键盘时）？
6. 用到 `@system.*` 的模块是否只在页面层 import？纯逻辑库保持 Node 可测。
7. 显示数值是否走 `fmtOut`（尊重用户精度设置）？
8. 新增资源用绝对路径 `/common/...` 且 `<img static>`。
9. 改完跑 `npm run release` + `node tests/smoke.mjs` + `verify-rpk`。

---

参考实现（多对一看法）：
- 主页/设置 hub：`src/pages/index/index.ux`、`src/pages/settings/settings.ux`
- 列表+catalog：`src/pages/catalog/catalog.ux`
- 方程式卡+自适应：`src/pages/result/result.ux`
- 芯片+键盘：`src/pages/mass/mass.ux`
- 公共令牌与顶栏：`src/common/style.css`
- 工具与测试：`scripts/`、`tests/smoke.mjs`、`scripts/verify-rpk.mjs`
