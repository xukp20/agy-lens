# 参与贡献与反馈

[English](CONTRIBUTING.md) | **简体中文**

感谢使用并帮助改进 **AGY Lens**。非常欢迎通过 Issue 反馈 Bug、提出希望扩展的功能或平台兼容需求、补充模型定价，也欢迎直接提交 Pull Request。

## 反馈 Bug 与提出功能建议

请前往 [GitHub Issues](https://github.com/xukp20/agy-lens/issues/new/choose) 创建对应类型的 Issue：

- **Bug 反馈**：建议附上操作系统（macOS / Linux / Windows / 远程 SSH）、AGY Lens 版本、运行模式（Desktop Sidecar 或独立 CLI 服务）、复现步骤，以及脱敏后的报错信息或截图。
- **功能建议**：欢迎描述你的使用场景、痛点以及期望扩展的能力（例如新的分析维度、模型定价适配、导出格式或跨平台交互体验等）。

## 项目核心设计原则

在提出方案或提交 PR 前，请先了解并遵守以下边界：

1. **100% 本地优先与只读访问源库** —— 始终以只读方式读取 Antigravity 对话数据库，绝不向源会话库执行任何写入操作。
2. **零凭据触碰与零内部接口探测** —— 绝不读取 OAuth 凭据文件，绝不探测未公开的本地宿主 RPC 接口；任何官方 CLI 集成（如默认关闭的 `agy -p "/usage" --output-format json` 自动额度对齐）都必须保持可选开启、文档透明且可安全验证。
3. **零外部运行时依赖** —— 仅依赖 Node.js 24 原生能力（`node:sqlite`、内置 `http`、原生 JS/CSS），确保安装、独立运行与自动更新始终轻量自包含。
4. **严格的 `--read-only` 隔离** —— 所有写操作路由都必须由 `guardWrite(...)` 保护，在 `--read-only` 模式下统一返回 `403`。
5. **双语界面与主题一致** —— 所有用户可见文案需同步补齐 `zh-CN` 与 `en` 词条，遵循宿主暗/亮主题 CSS Token，下拉选择统一使用 `renderCustomDropdown`（不使用原生 `<select>`）。
6. **文档语言严格分离** —— 独立文档按英文（`*.md`）与简体中文（`*.zh-CN.md`）分文件维护，不混排中英文。

## 本地开发与校验

环境要求：**Node.js 24+**（无需执行 `npm install`）。

```bash
# 运行全部离线单元测试与集成测试
node --test scripts/test_*.mjs

# 校验插件清单与目录结构（需要本机安装 agy CLI）
agy plugin validate --strict .

# 以只读模式本地预览独立 Web 仪表盘
node bin/agy-lens.mjs serve --read-only
```

提交 Pull Request 前请确认：

- `node --test scripts/test_*.mjs` 全部通过。
- 新增逻辑或 Bug 修复配有对应的单元测试。
- PR 范围清晰聚焦。

## 维护者发版规范

发版标题格式、中英上下分栏 Release Notes 模板与发版前检查清单，请统一遵循 [.github/RELEASE_TEMPLATE.md](.github/RELEASE_TEMPLATE.md)。
