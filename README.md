# 口袋词典 · 小米手环 9 Pro

Vela JS 离线英汉词典，设计分辨率 **336×480**。界面参考 examreader 和 Chemical-calculator 的黑底、蓝色操作和大触控区域，页面与键盘为本项目独立实现。

## 功能

- 英文前缀联想：输入 `ap` 检索 `apple` 等候选；结果每页 12 条。
- 中文查询：切换中文，输入单字拼音、选择汉字，连续选字组成词组后检索中文释义。
- 详情：中文释义、源数据音标、过去式、过去分词、现在分词、三单、复数及比较级等。
- 关系反查：ECDICT 屈折变化、WordNet 派生关系和经审核的补充关系均可点击；例如 `went → go`、`act ↔ action`、`read ↔ readable`。
- 数据文件按需加载，最多缓存 4 个分片；整包上限 **7,000,000 bytes**，超限即 CI 失败。

## 安装与构建

每次 push 触发 GitHub Actions。成功后从仓库 **Releases** 下载原始 `.rpk`；Artifacts 下载包须先解压。

CI 固定工具链版本、验证词库下载哈希、运行测试、生成词库、构建并验证 RPK 包名、签名块和真实文件体积。本地按项目约定只运行：

```bash
npm test
```

未配置签名时使用 aiot 开发构建。正式发布请在仓库 Actions Secrets 配置 `VELA_PRIVATE_KEY` 与 `VELA_CERTIFICATE`，内容分别为 PEM 私钥和证书，CI 自动改用 release 构建。后续升级须保持同一签名。

## 词库范围

ECDICT 常用词优先选入约 14,000 条，加必要关联词后最多 18,000 条，保留所选词中文释义的前 240 字符和已有音标。实际数量由构建输出的 `meta.json` 记录。词库为精选离线版，生僻词、未收录派生和源数据缺失音标会存在覆盖边界；未知词明确显示空结果。

中文检索在中文释义中执行完整子串匹配；拼音键盘支持单字选字，`v` 表示 `ü`。应用运行时无联网依赖、无语音识别和发音音频。

## 源码与开发提示词

| 路径 | 用途 |
| --- | --- |
| `src/pages/index/index.ux` | 查询、键盘、详情和导航 |
| `src/common/search.js` | 异步分片查询核心 |
| `scripts/build_dictionary.py` | 可复现词库筛选和索引生成 |
| `scripts/dictionary_sources.json` | 固定数据版本、校验值和来源 |
| `.monkeycode/docs/DEVELOPMENT_PROMPT.md` | 后续开发提示词 |

完整数据在 CI 生成并随 RPK 分发；仓库包含全部生成源码和来源锁定配置。词库完整许可证写入安装包内 `common/dict/licenses.json`，随 Actions artifact 一起提供。

真机安装、触摸响应、音标字体及峰值内存需要在小米手环 9 Pro 上验收。CI 成功仅代表构建和自动检查通过。
