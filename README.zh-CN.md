<p align="center">
  <img src="assets/logo.svg" width="88" alt="AGY Lens Logo" />
</p>

<h1 align="center">AGY Lens</h1>

<p align="center">
  <strong>本地优先、严格只读的 Antigravity Desktop &amp; CLI 遥测观察面板（Sidecar 插件）。</strong><br />
  集实时上下文构成、Prompt Cache 诊断、跨会话全局缓存观测台、长上下文 API 等价成本分析、16 周使用日历热力图与 2 位小数额度对齐于一体。
</p>

<p align="center">
  <a href="README.md">English</a> | <strong>简体中文</strong>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Antigravity_Sidecar-2.22%2B-5b9cf6?style=flat-square" alt="Antigravity Sidecar 2.22+" />
  <img src="https://img.shields.io/badge/Node.js-24%2B_%E9%9B%B6%E4%BE%9D%E8%B5%96-4eb88e?style=flat-square" alt="Node.js 24+ 零依赖" />
  <img src="https://img.shields.io/badge/%E9%81%A5%E6%B5%8B%E6%9C%BA%E5%88%B6-100%25_%E6%9C%AC%E5%9C%B0%E5%8F%AA%E8%AF%BB-2e8540?style=flat-square" alt="100% 本地只读" />
  <img src="https://img.shields.io/badge/%E4%B8%BB%E9%A2%98-%E8%87%AA%E9%80%82%E5%BA%94%E6%B7%B1%E6%B5%85%E8%89%B2-7a5ec4?style=flat-square" alt="自适应深浅色" />
  <img src="https://img.shields.io/badge/License-MIT-646b78?style=flat-square" alt="MIT License" />
</p>

<p align="center">
  <img src="assets/screenshots/hero-dual-theme.png" alt="AGY Lens 深色与浅色双主题侧边栏预览" width="100%" />
</p>

---

## 为什么选择 AGY Lens？

不少社区用量插件通过探测未公开的内部 RPC 接口、读取 OAuth 凭证，或常驻后台守护进程持续轮询来获取数据。**AGY Lens** 坚持完全相反的工程准则：

- **严格本地只读**：仅通过 `{ readOnly: true }` 只读模式打开 Antigravity Desktop（`~/.gemini/antigravity/conversations/*.db`）与 CLI（`~/.gemini/antigravity-cli/conversations/*.db`）本地 SQLite 数据库，并使用纯 Node.js 24 内置 `node:sqlite` 直接解析 Protobuf 轮次数据（零 npm 外部依赖）。
- **零内部 RPC 探测 / 零账号风险**：绝不探测宿主私有端口、绝不触碰 OAuth Token 或认证文件、绝不上传任何本地遥测（内置自动更新仅读取 GitHub Releases 公开版本信息，可随时在设置中关闭；远程定价同步默认关闭）。
- **可见性门控、零空转开销**：基于 Antigravity 原生 `sidecar_sdk` 辅助侧栏（Auxiliary Pane）生命周期构建；当侧栏收起或不可见时自动暂停全部轮询。
- **宿主主题自适应同步**：实时嗅探宿主注入的 CSS 变量（`--background`、`--card`、`--primary` 等），深浅色主题无缝跟随宿主切换。

---

## 模块化功能展示

AGY Lens 内置 **7 个可独立开关与自由排序的模块**——默认全部开启（仅「实时上下文」默认展开，其余以紧凑 KPI 摘要卡呈现），开箱即可一览全部能力；不需要的模块随时一键关闭，关闭后将完全跳过对应查询与扫描。

### 1. 实时上下文、Prompt Cache 诊断与 Token 流向（辅助侧栏）

如上方双主题首屏预览图所示：
- **实时上下文（Live Context）**：对照模型 **Auto-Compact 自动压缩阈值**展示进度条（附带 `55%` 警戒线与 `80%` 高压线），并按 `System Prompt`、`Tools`、`Rules`、`Skills`、`Subagents`、`Chat Messages` 逐项拆解构成明细。
- **Prompt Cache 诊断**：展示最近一轮命中率、会话累计缓存命中率、相对未缓存输入的估算节省美元，以及无接缝 **15 轮输入构成堆叠柱状图**（醒目标注 `Cold` 冷启动与 `Drop` 骤降）。
- **输入输出与 Token 流向**：将全部 Token 拆分为 4 桶（`Uncached In`、`Cache Read`、`Thinking Out`、`Visible Out`），支持 `本会话 | 全局` 一键切换，并统计平均 `TTFT / 生成` 响应耗时。

### 2. 全局缓存观测台（模块 #6）

专为排查跨会话 Prompt Cache 不稳定问题而设——精准识别随空闲间隔（Idle Gap）衰减、瞬态 0% 断崖与前缀边界截断，支持多指标可配置矩阵、单元格全量详情卡与一键脱敏报告导出。

<p align="center">
  <img src="assets/screenshots/cache-observatory.png" alt="AGY Lens 全局缓存观测台：多指标矩阵、指标配置弹窗、单元格详情卡、对数散点图与 Top 异常" width="100%" />
</p>

- **4 项健康 KPI 卡片**：跟随轮总命中率、意外 `0%` 断崖次数（含 **Bounce-Back** 下一轮立刻恢复计数）、边界截断（自动剔除正常换模与上下文压缩）以及估算 Miss 损失金额与浪费 Token。
- **可配置多指标 & 自定义时间挡位 `Model × Idle-Gap` 矩阵**：默认采用兼顾侧栏宽度与长 TTL 观察的 6 档区间（`<=10s`、`10-60s`、`1-5m`、`5-10m`、`10-60m`、`>1h`），并与口径完全统一的样本加权「总计」列并排对比。通过右上角 **`区间 · ≤1h ▾`** 弹窗可一键开关快捷分界点（`2s`–`6h`）或输入自定义时长（`1s`–`24h`，如 `45s`、`15m`、`2h`），自动生成 `<=min`、相邻中间区间与 `>max`，并同步扩展对数散点图 X 轴范围。通过 **`命中率 +2 ▾`** 弹窗可在 **6 大指标**中自由指定主指标（决定热力色阶）并任意勾选竖排格内小字：**Token 实际命中率**（默认主指标）、**缓存保活率**与**轮均花费**（默认副指标）、**区间总花费**、**Miss 额外罚金**与**样本轮次数**；切换主指标时原主指标自动保留为副指标，不丢对比上下文。
- **悬浮预览 + 点击固定全量详情卡**：鼠标悬停在任意时间桶或「总计」格上，即可查看完整分组明细（含 `[主]`/`[副]` 标识、异常事件、缓存已省费用、平均输入上下文与浪费 Token）；单击单元格可固定详情卡从容对照。
- **空闲间隔 vs 命中率对数散点图**：支持按模型过滤，在对数时间轴上直观区分正常命中、意外 0% 断崖、边界截断与低命中样本。
- **Top 异常列表与 `Copy Issue Markdown`**：展示 `前轮 → 异常轮 → 后轮` 命中变化与 `Idle Gap / Start Gap`，并可一键复制已彻底剥离工作区和会话标题的脱敏 Markdown 报告。

### 3. 模型分布、长上下文阶梯计费与 16 周日历热力图（模块 #4 & #5）

<p align="center">
  <img src="assets/screenshots/cost-calendar.png" alt="模型 API 等价成本分布与 16 周使用日历热力图" width="100%" />
</p>

- **模型分布与 API 等价成本**：按模型或工作区汇总算力价值与缓存节省金额；当单轮总输入超过 200k tokens 时自动触发 **>200k 长上下文阶梯溢价** 计费并标注 `>200k` 徽标。
- **16 周使用日历热力图与按日下钻**：统计连续活跃天数、今日 vs 7 日均值涨跌幅、14 日迷你柱状图，以及 1:1 像素对齐的交互式热力图（支持切换 `等价 $ | Tokens | 轮次`）。点击任意日期方块即可下钻查看当日所有对话与费用明细。

### 4. 手动额度对齐与周期总额反推（模块 #7）

由于 Antigravity 目前未向 Sidecar 开放官方订阅额度 API，AGY Lens 采用完全合规的 **2 位小数手动对齐锚点**（例如 `94.25%`）来反推周期总额度。

<p align="center">
  <img src="assets/screenshots/quota-budget.png" alt="手动额度对齐与周期隐含总额反推" width="100%" />
</p>

- **默认 `7d` 单周期聚焦与 2 位小数精度**：自动识别输入步长（`1%`、`0.1%` 或 `0.01%`），默认仅展示并拟合当前活跃周期的对齐记录（历史旧周期自动折叠收起）。
- **重置周期自动继承**：在同一活跃周期内补充记录锚点时，重置倒计时可**留空自动继承**本周期上次的 `reset_at` 时间戳（若发生提前重置则填写新倒计时即可覆盖）。
- **正交 3 因子权重校准实验室（`M / C / O` 全子集自动择优）**：锚点模型与 `pricing_defaults.json` 的 `defaultAnchors` 共用配置且支持面板自由切换 Base (`1.00×`)；将**模型倍率 (`M`)**、**缓存倍率 (`C`)** 与**输出倍率 (`O`)** 解耦为 3 个正交开关（单模型周期也可独立校准 `C` 或 `O`），全枚举 8 个子集并基于剖面网格 Huber-WLS + 留一交叉验证（LOOCV）+ `VIF < 10` 自动择优；自动守恒合并微滞后/短间隔（`<10m`/`<5m`）与微回弹抖动，并透明展示未采纳因子的试算值与实测/预测（`pp`）残差对比图。

### 5. 设置抽屉、面板内自动更新、`?` 帮助与中英双语切换

<p align="center">
  <img src="assets/screenshots/settings-drawer.png" alt="AGY Lens 顶栏更新微徽标、更新详情弹窗、7 大模块设置抽屉、版本与自动更新控制及问号帮助气泡" width="100%" />
</p>

- **面板内自动更新与一键回滚**：
  - **主界面顶栏微徽标与更新弹窗**：发现新版本时，`AGY Lens` 标题紧右侧自动亮出精致的 `↑ vX.Y.Z` 微徽标（待下载为蓝色，已预下载并通过烟雾测试后变为绿色）。点击即可查看 Release Notes，一键 **「立即重启应用」** 或 **「忽略此版本」**。
  - **三档可配置更新策略（`自动更新` | `仅提醒` | `关闭`）**：默认 **`自动更新`**——面板活跃期间每 6h 检查一次 GitHub Releases，后台预下载并在独立子进程运行烟雾测试（`AGY_LENS_SMOKE=1`），随后在你点击重启、后端全端闲置 10 分钟或下次冷启动时无感应用。发布者也可在 GitHub Release 正文中放入隐形注释 `<!-- agy-lens:manual-only -->` 标记「可选小更新」（不自动推送、不打扰顶栏，仅在设置里供按需手动升级）。随时可在 **设置 → 版本与自动更新** 切换为 **`仅提醒`** 或 **`关闭`**（100% 离线）。
  - **防变砖 `boot.mjs` 冷启动引导与崩溃自救回滚**：所有文件替换均由极简稳定的 `boot.mjs` 在 `main.mjs` 加载前完成，杜绝前后端版本错位；若某新版本连续 2 次启动异常，`boot.mjs` 会**自动从备份回滚**到上一稳定版本并跳过该坏版本；设置里也提供手动 **「回滚至上一版本」** 按钮。
- **7 大模块默认全开、独立开关与排序**：新安装默认开启全部 7 个模块（次要卡片先以紧凑 KPI 摘要呈现）；不需要的模块可随时关闭以完全跳过查询与扫描。
- **原生 `?` 自解释帮助气泡**：每个模块标题与设置项旁均配有 `?` 触发器，悬停或点击即可查看「展示内容 / 何时开启 / 扫描范围」。
- **即时中英双语切换**：设置抽屉支持即时切换 `中文 / English`（亦支持 URL 参数 `?lang=en` / `?lang=zh-CN` 临时覆盖）。

---

## 隐私与合规保证

| 维度 | AGY Lens 承诺 |
| :--- | :--- |
| **源数据库访问** | 严格通过 `new DatabaseSync(path, { readOnly: true })` 只读打开（WAL 感知增量 mtime/size 索引，绝不写入源库）。 |
| **宿主 RPC 与凭证** | **零**内部 RPC 探测、**零** OAuth/Token 文件读取、**零**未公开接口调用。 |
| **后台驻留与轮询** | 仅作为 Antigravity 托管 UI Sidecar 按需运行（`on-failure`）；面板不可见时自动暂停轮询（支持 `关 / 15s / 30s / 60s / 5m`）。 |
| **可选联网说明** | 面板内自动更新仅通过严格 HTTPS 主机白名单 `GET` GitHub Releases 公开元数据（不上传任何本地信息，可在「设置 → 更新策略 → 关闭」一键关闭）；远程定价同步默认关闭。 |
| **本地缓存路径** | 增量索引、用户配置、定价覆写、更新备份与额度锚点均保存在 `~/.gemini/antigravity/sidecar_data/agy-lens/lens_panel/data/`（与插件代码目录物理隔离，更新绝不触碰用户数据）。 |
| **Issue 导出脱敏** | `Copy Issue Markdown` 自动剥离工作区路径、目录名与真实会话标题，仅保留汇总指标、模型 ID、间隔时长与 Request ID。 |

---

## 安装与更新

### 方式一：直接克隆到插件目录（推荐）

```bash
git clone https://github.com/xukp20/agy-lens.git ~/.gemini/config/plugins/agy-lens
agy plugin validate --strict ~/.gemini/config/plugins/agy-lens
```

*最推荐*：同时支持 **面板内 Git 精确 Release Tag 自动更新**（自动保护未提交本地修改与非 `main` 分支）以及终端手动 `git pull --ff-only`。

### 方式二：通过 CLI 独立安装或压缩包安装

```bash
git clone https://github.com/xukp20/agy-lens.git /tmp/agy-lens
agy plugin install /tmp/agy-lens
```

*同样完整支持面板内自动更新*：即使目录中没有 `.git`，AGY Lens 也能通过内置零依赖纯 Node 流式 `.tar.gz` 解包器拉取 GitHub Release 包，完成 SHA-256 校验与独立烟雾测试后由 `boot.mjs` 安全升级（完整兼容 Linux、macOS 与 Windows）。

> **环境要求**：Antigravity `2.22+`（支持 Sidecar Web UI）与 Node.js `24+`（内置 `node:sqlite`）。无需执行 `npm install`。

### 支持的 3 种更新方式

1. **面板内自动更新（默认，最省心）**：每 6h 自动检测新版本 -> 后台预下载并通过烟雾测试 -> 顶栏 `AGY Lens` 旁亮出绿色 `↑ vX.Y.Z` 微徽标。点击立即重启生效，不点也会在下次重开面板时无感升级；Git 与独立安装均支持，且绝不触碰 `sidecar_data/` 中的个人数据。
2. **面板内手动更新 / 回滚**：在 **设置 → 版本与自动更新** 将策略设为 `仅提醒` 或 `关闭`，随时手动点击 **「检查更新」** / **「一键更新并重启」**；升级后若不习惯还可一键 **「回滚至上一版本」**。
3. **终端手动更新**（适用于 `git clone` 安装）：
   ```bash
   git -C ~/.gemini/config/plugins/agy-lens pull --ff-only
   agy plugin validate --strict ~/.gemini/config/plugins/agy-lens
   ```

---

## 自定义模型定价

AGY Lens 内置 **三层定价解析引擎**（`sidecars/lens_panel/lib/pricing.mjs`）：

1. **用户覆写（`pricing_overrides.json`）** — 最高优先级。可在 **设置 → 定价表管理** 中直接编辑单模型的 Input、Output、Thinking、Cache Read、Cache Write 及 `>200k` 长上下文溢价，或随时一键恢复默认。
2. **内置日期版本化默认表（`sidecars/lens_panel/lib/pricing_defaults.json`）** — 开箱即用的离线基线，覆盖 Gemini 4、Gemini 3.8 与 Claude 5.5 各档位、阶梯生效日期与 `>200k` 费率。
3. **可选远程定价同步（`remote_pricing_cache.json`）** — 默认关闭以保持 100% 离线运行。开启 **自动同步远程公开定价**（24h 缓存）或点击 **立即手动刷新定价** 即可从 LiteLLM / OpenRouter 公开目录更新参考单价。

---

## 本地数据流架构

```text
  只读源数据库 (mode=ro)                        AGY Lens Sidecar (Node.js 24)
  ──────────────────────                        ─────────────────────────────
  ~/.gemini/antigravity/                        sidecars/lens_panel/
   └─ conversations/<uuid>.db   ──┐              ├─ lib/protobuf.mjs    (Protobuf 线协议解码)
                                  ├─(ro)──────▶  ├─ lib/indexer.mjs     (WAL 增量 SQLite 索引)
  ~/.gemini/antigravity-cli/      │              ├─ lib/pricing.mjs     (3 层定价 + >200k 阶梯)
   └─ conversations/<uuid>.db   ──┘              ├─ lib/cache_observatory.mjs
                                                 ├─ lib/quota.mjs       (2 位小数 CI 反推)
                                                 ├─ lib/updater.mjs     (Git/独立包自更新)
                                                 ├─ lib/tar_extract.mjs (纯 JS 流式解包)
                                                 ├─ boot.mjs            (冷启动应用与自动回滚)
                                                 └─ main.mjs            (SidecarApp REST API)
                                                       │
                                                       ▼  127.0.0.1 HTTP + /preload.js 主题变量
                                                 web/{index.html,styles.css,app.js}
                                                 (Antigravity 辅助侧栏 — 7 大独立模块卡片)
```

---

## 本地演示模式与截图工具

无需连接任何真实本地对话库，即可用匿名合成数据在浏览器中体验完整 AGY Lens 界面：

```bash
node scripts/demo_server.mjs --port 4318
```

随后访问：
- 浅色模式（简体中文）：`http://127.0.0.1:4318/?theme=light&lang=zh-CN`
- 深色模式（English）：`http://127.0.0.1:4318/?theme=dark&lang=en`

### 重新生成文档预览图

- **无浏览器 2x Retina 预览渲染**（基于 `cairosvg` + `Pillow`）：
  ```bash
  python3 scripts/render_previews.py
  ```
- **可选真实浏览器 Playwright 截图**（适用于已安装 Chromium 的环境）：
  ```bash
  npm install --no-save playwright && npx playwright install chromium
  node scripts/capture_screenshots.mjs --out assets/screenshots/live
  ```

---

## 致谢与灵感来源

AGY Lens 的设计与实现深受 Antigravity 及 AI 编程 CLI 生态中多项优秀本地遥测实践的启发：

- **[`ahmetdotsh/agy-context`](https://github.com/ahmetdotsh/agy-context) & [`ahmetdotsh/agy-usage`](https://github.com/ahmetdotsh/agy-usage)** — 开创了面向 Antigravity 本地对话库的严格只读 SQLite + Protobuf 遥测解析范式。
- **OpenAI Codex CLI（`/status` & `/usage`）与 [`steipete/CodexBar`](https://github.com/steipete/CodexBar)** — 启发了「单会话实时上下文 vs 账户级额度周期」分离、剩余/已用视角切换以及均速节奏参考线（Even-Use Pace）。
- **`cc-switch` & `ccusage`** — 启发了多数据源开关（`桌面端 + CLI`）、可编辑模型单价覆写、4 桶 Token 拆分与使用日历热力图设计。
- **Antigravity 内置 `swarm_board` Sidecar** — 提供了 `SidecarApp` 生命周期、`/preload.js` 宿主亮度嗅探与无闪烁 CSS Token 同步的标准参考实现。
- **[`google-antigravity/antigravity-cli#1533`](https://github.com/google-antigravity/antigravity-cli/issues/1533)** — 社区关于 Prompt Cache 命中衰减与瞬态断崖的深入讨论，直接启发了模块 #6「全局缓存观测台」的 `Model × Idle-Gap` 矩阵、边界截断阈值、Bounce-Back 恢复识别与脱敏 Issue 导出。

---

<p align="center">
  基于 <a href="LICENSE">MIT License</a> 开源发布。
</p>
