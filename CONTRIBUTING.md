# Contributing to AGY Lens / 参与贡献与反馈

Thank you for using and helping improve **AGY Lens**! Bug reports, feature requests, model pricing updates, platform compatibility feedback, and pull requests are all warmly welcome.

感谢使用并帮助改进 **AGY Lens**！非常欢迎通过 Issue 反馈 Bug、提出希望扩展的能力或平台适配需求，也欢迎提交 PR。

---

## Reporting Bugs & Requesting Features / 反馈 Bug 与提需求

Please open an issue at **[GitHub Issues](https://github.com/xukp20/agy-lens/issues/new/choose)**:

- **Bug Report**：请尽量附上操作系统（macOS / Linux / Windows / SSH 远程）、AGY Lens 版本、运行方式（Desktop Sidecar 还是 Standalone CLI）、复现步骤以及报错信息或脱敏截图。
- **Feature Request**：欢迎描述你的使用场景与希望扩展的能力（例如新的分析维度、模型定价支持、导出能力、跨平台体验优化等）。

---

## Core Design Principles / 项目核心设计原则

Before proposing changes or opening a PR, please keep AGY Lens's core boundaries in mind:

1. **100% Local-First & Read-Only Source Access** — Conversation databases are always opened read-only; AGY Lens never writes to Antigravity's source DBs.
2. **Zero Credential Touching & No Undocumented RPC Probing** — Never read OAuth tokens/credentials or probe undocumented local host RPC services. Any CLI integration (such as opt-in Auto Quota Alignment via `agy -p "/usage" --output-format json`) must stay opt-in, documented, and safe.
3. **Zero External Runtime Dependencies** — Keep the Node.js 24 runtime (`node:sqlite`, built-in `http`, vanilla JS/CSS) dependency-free so installation, standalone execution, and self-updates remain fast and self-contained.
4. **Strict `--read-only` Isolation** — Any new write endpoint must be wrapped in `guardWrite(...)` and return `403` in `--read-only` mode.
5. **Bilingual UI (`zh-CN` & `en`) & Theme Consistency** — User-facing strings should include both Chinese and English translations and follow host dark/light CSS tokens (avoid native `<select>` elements in favor of `renderCustomDropdown`).

---

## Local Development & Verification / 本地开发与校验

Requirements: **Node.js 24+** (no `npm install` needed).

```bash
# Run the full offline unit & integration test suite
node --test scripts/test_*.mjs

# Validate plugin manifest & structure (requires agy CLI)
agy plugin validate --strict .

# Optional: preview standalone web dashboard against local data (read-only)
node bin/agy-lens.mjs serve --read-only
```

Before opening a pull request:
- Ensure `node --test scripts/test_*.mjs` passes completely.
- Add or update unit tests in `scripts/test_*.mjs` for new logic or bug fixes.
- Keep PRs focused and well-scoped.
