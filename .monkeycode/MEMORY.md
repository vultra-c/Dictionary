# User Instruction Memory

## Entries

[构建与推送约定]
- Date: 2026-09-05
- Context: 用户明确指定本项目交付流程。
- Instructions:
  - 每轮完成修改并验证后提交、推送到用户指定仓库。
  - 本地仅执行检查和纯测试；词库生成、RPK 构建在 GitHub Actions 执行，并检查远程构建结果。
  - 授权凭据只通过安全授权机制使用，源码、文档和日志均保持无凭据。
