# Contributing to AGY Lens

**English** | [简体中文](CONTRIBUTING.zh-CN.md)

Thank you for using and helping improve **AGY Lens**. Bug reports, feature ideas, model pricing updates, platform compatibility feedback, and pull requests are all welcome.

## Reporting Bugs & Requesting Features

Please open an issue on [GitHub Issues](https://github.com/xukp20/agy-lens/issues/new/choose):

- **Bug Report**: Include your operating system (macOS / Linux / Windows / remote SSH), AGY Lens version, runtime mode (Desktop Sidecar or Standalone CLI), reproduction steps, and any sanitized error output or screenshots.
- **Feature Request**: Describe your workflow, pain point, and the capability you would like added (for example, new analytics dimensions, model pricing updates, export options, or cross-platform improvements).

## Core Design Principles

Before proposing changes or opening a pull request, please keep these boundaries in mind:

1. **Local-First & Strictly Read-Only Source Access** — Antigravity conversation databases are always opened read-only; AGY Lens never writes to source conversation DBs.
2. **Zero Credential Touching & No Undocumented RPC Probing** — Never read OAuth tokens/credentials or probe undocumented local host RPC services. Any CLI integration (such as opt-in Auto Quota Alignment via `agy -p "/usage" --output-format json`) must remain opt-in, documented, and safe.
3. **Zero External Runtime Dependencies** — Keep the Node.js 24 runtime (`node:sqlite`, built-in `http`, vanilla JS/CSS) dependency-free so installation, standalone usage, and self-updates remain fast and self-contained.
4. **Strict `--read-only` Isolation** — Every mutating API route must be wrapped in `guardWrite(...)` and return `403` in `--read-only` mode.
5. **Bilingual UI & Theme Consistency** — User-facing strings should be added to both `en` and `zh-CN` dictionaries in `app.js`, follow host dark/light CSS tokens, and use `renderCustomDropdown` instead of native `<select>` elements.
6. **Clean Documentation Language Separation** — Standalone docs use separate English (`*.md`) and Chinese (`*.zh-CN.md`) files rather than mixing languages inline.

## Local Development & Verification

Requirements: **Node.js 24+** (no `npm install` needed).

```bash
# Run the full offline unit & integration test suite
node --test scripts/test_*.mjs

# Validate plugin manifest & structure (requires agy CLI)
agy plugin validate --strict .

# Preview the standalone web dashboard in read-only mode
node bin/agy-lens.mjs serve --read-only
```

Before submitting a pull request:

- Ensure `node --test scripts/test_*.mjs` passes completely.
- Add or update unit tests in `scripts/test_*.mjs` for new behavior or bug fixes.
- Keep pull requests focused and concise.

## Maintainer Releases

For release titles, top-bottom bilingual release notes, and the pre-release checklist, follow [.github/RELEASE_TEMPLATE.md](.github/RELEASE_TEMPLATE.md).
