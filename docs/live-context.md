# Live Context, Prompt Cache & Token Flow

**English** | [简体中文](zh-CN/live-context.md) · [← Back to README](../README.md)

This guide covers the three session-level modules in AGY Lens: **Live Context (Module #1)**, **Prompt Cache Diagnostics (Module #2)**, and **Input/Output & Token Flow (Module #3)**.

---

## 1. Live Context Composition (Module #1)

Tracks the active conversation's prompt footprint directly from Antigravity's local SQLite conversation databases (opened strictly read-only).

- **7-Category Breakdown Bar**: Splits the latest turn's prompt into `System Prompt`, `Subagents`, `Skills`, `Plugins`, `Rules`, `Tools`, and `Chat Messages` with token counts and percentage shares.
- **Auto-Compact Threshold Markers**: Visualizes current context usage against the model's context ceiling with `55%` and `80%` threshold markers, surfacing a warning banner when approaching auto-compaction.
- **Live Cache Warmth Indicator**: Tracks elapsed time since the previous assistant reply to indicate whether the prompt prefix cache is likely warm or cold.
- **Session Switcher**: In Standalone Web mode (and multi-session Desktop setups), switch between recent Desktop and CLI conversations from the unified custom dropdown.

## 2. Prompt Cache Diagnostics (Module #2)

Measures real prefix-cache effectiveness turn by turn within the selected conversation.

- **Key Metrics**:
  - **Last Turn Hit %**: `cache_read / (cache_read + uncached_in)` for the latest turn.
  - **Session Cumulative Hit %**: Weighted cache reuse across the full conversation.
  - **Estimated Cache Saved**: Pure API-equivalent savings compared to sending every input token uncached.
- **15-Turn Stacked Composition Bar**: Distinguishes `Cache Read`, `Uncached`, `Cold` (initial turn / cold prefix), and `Drop` (sudden cache hit drop) at a glance.

## 3. Input/Output & Token Flow (Module #3)

Breaks total token volume into four explicit buckets with an instant **`Session` | `Global`** toggle:

- `Uncached Input`
- `Cache Read`
- `Thinking Out` (reasoning tokens)
- `Visible Out`

Also reports throughput (`tok/hr`), pure API-equivalent cost, and average latency (`TTFT` / generation duration).
