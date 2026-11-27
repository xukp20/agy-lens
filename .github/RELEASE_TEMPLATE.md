# AGY Lens GitHub Release Template & Standard

Every GitHub Release MUST follow this exact title and body structure so both the GitHub Releases page and the AGY Lens in-panel Update Popover remain clean, scannable, and consistent.

## 1. Release Title

Format:

```text
vX.Y.Z — <Short English Theme (3–8 words)>
```

Examples:
- `v1.12.0 — Opt-In Auto Quota Alignment & UI Polish`
- `v1.12.1 — Relaxed agy /usage CLI Timeout Margins`

Rules:
- Always start with `vX.Y.Z — ` (em-dash with spaces).
- Never use generic titles like `AGY Lens vX.Y.Z`.

## 2. Release Body

Rules:
- **Do NOT repeat the version heading** (`## AGY Lens vX.Y.Z`) inside the body; GitHub and the in-panel Update Popover already display the title and version.
- **Strict Top-Bottom Bilingual Split**: Put the complete **English** section on top, followed by `---`, followed by the complete **简体中文** section below. **Never mix English and Chinese in the same heading, bullet title, or sentence.**
- **Omit empty sections**: Only include sections that apply (`Highlights`, `Fixes`, `Improvements`, `Verification` / `新功能`, `修复`, `优化`, `验证`).
- **Optional `manual-only` flag**: For minor/internal releases that should NOT trigger auto-update or the header update pill, add `<!-- agy-lens:manual-only -->` on the very first line (stripped automatically by `updater.mjs`).

### Template

```markdown
### Highlights
- **Feature Name**: Concise 1–2 sentence explanation of what changed and why it matters.

### Fixes
- **Fix Name**: Concise explanation of the issue and fix.

### Improvements
- **Improvement Name**: Concise explanation of UX, performance, or docs polish.

### Verification
- `node --test scripts/test_*.mjs`: **N/N passed**
- `agy plugin validate --strict .`: **passed**

---

### 新功能
- **功能名称**：1–2 句清晰说明新增能力与使用方式。

### 修复
- **修复项名称**：简要说明原因与修复后的行为。

### 优化
- **优化项名称**：简要说明界面、性能或文档优化。

### 验证
- `node --test scripts/test_*.mjs`：**N/N 通过**
- `agy plugin validate --strict .`：**通过**
```

## 3. Pre-Release Checklist

1. Bump `version` in both `plugin.json` and `package.json`.
2. Run `node --test scripts/test_*.mjs`, `agy plugin validate --strict .`, and `npm pack --dry-run`.
3. Commit to `main`, create annotated tag `vX.Y.Z`, push both `main` and `vX.Y.Z`.
4. Create the GitHub Release using the template above (`gh release create vX.Y.Z --title "vX.Y.Z — ..." --notes "..."`).
5. Confirm `.github/workflows/release-asset.yml` finishes with `success` and attaches `agy-lens-X.Y.Z.tgz` + `SHA256SUMS.txt`.
