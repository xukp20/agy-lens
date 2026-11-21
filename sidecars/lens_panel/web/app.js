(() => {
  'use strict';

  // =========================================================================
  // 1. Theme Sync (mirrors swarm_board preload.js luminance probing)
  // =========================================================================
  function syncTheme() {
    const probe = document.createElement('span');
    probe.style.cssText = 'position:absolute;visibility:hidden;color:var(--background, #f7f7f8)';
    document.documentElement.appendChild(probe);
    const c = getComputedStyle(probe).color;
    probe.remove();
    const nums = (c.match(/[\d.]+/g) || []).map(Number);
    if (nums.length < 3) return;
    const scale = c.startsWith('color(') ? 1 : 255;
    const [r, g, b] = nums.slice(0, 3).map((v) => v / scale);
    const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    const theme = lum < 0.5 ? 'dark' : 'light';
    if (document.documentElement.dataset.theme !== theme) {
      document.documentElement.dataset.theme = theme;
    }
  }
  syncTheme();
  new MutationObserver(() => syncTheme()).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['style']
  });

  // =========================================================================
  // 2. Host Sidecar & REST Helpers
  // =========================================================================
  function apiFetch(path, options) {
    if (window.sidecar && typeof window.sidecar.fetch === 'function') {
      return window.sidecar.fetch(path, options);
    }
    const rel = typeof path === 'string' && path.startsWith('/') ? '.' + path : path;
    return fetch(rel, options);
  }

  async function getJson(path) {
    const res = await apiFetch(path, { method: 'GET' });
    if (!res.ok) {
      let msg = `${res.status}`;
      try {
        const errBody = await res.json();
        if (errBody && errBody.error) msg = errBody.error;
      } catch (_) {}
      throw new Error(`${path}: ${msg}`);
    }
    return res.json();
  }

  async function postJson(path, body) {
    const res = await apiFetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body ?? {})
    });
    if (!res.ok) {
      let msg = `${res.status}`;
      try {
        const errBody = await res.json();
        if (errBody && errBody.error) msg = errBody.error;
      } catch (_) {}
      throw new Error(`${path}: ${msg}`);
    }
    return res.json();
  }

  function isStandaloneMode() {
    return Boolean(window.__AGY_LENS_STANDALONE__ || state.runtime?.mode === 'standalone');
  }

  function isReadOnlyMode() {
    return Boolean(state.runtime?.readOnly);
  }

  function resolveConversationId() {
    if (window.sidecar && window.sidecar.conversationId) {
      return String(window.sidecar.conversationId);
    }
    if (state.selectedConversationId) {
      return String(state.selectedConversationId);
    }
    try {
      return new URLSearchParams(window.location.search).get('conversationId') || '';
    } catch (_) {
      return '';
    }
  }

  // =========================================================================
  // 3. Query Param Helpers (Demo / Screenshot Overrides — Never Persisted)
  // =========================================================================
  const ALL_MODULE_IDS = [
    'live-context',
    'cache-diagnostics',
    'io-flow',
    'model-cost',
    'calendar-trends',
    'cache-observatory',
    'quota-budget'
  ];

  function normalizeLang(raw) {
    if (!raw) return null;
    const low = String(raw).trim().toLowerCase();
    if (low === 'en' || low === 'en-us' || low === 'english') return 'en';
    if (low === 'zh' || low === 'zh-cn' || low === 'zh_cn' || low === 'chinese') return 'zh-CN';
    return null;
  }

  function parseQueryOverrides() {
    const out = {
      lang: null,
      expandAll: false,
      expandSet: null,
      onlySet: null,
      openSettings: false,
      hideHeader: false
    };
    try {
      const sp = new URLSearchParams(window.location.search);
      const qLang = normalizeLang(sp.get('lang'));
      if (qLang) out.lang = qLang;

      const qExpand = (sp.get('expand') || '').trim();
      if (qExpand === 'all') {
        out.expandAll = true;
      } else if (qExpand) {
        const parts = qExpand.split(',').map((s) => s.trim()).filter((s) => ALL_MODULE_IDS.includes(s));
        if (parts.length) out.expandSet = new Set(parts);
      }

      const qOnly = (sp.get('only') || '').trim();
      if (qOnly) {
        const parts = qOnly.split(',').map((s) => s.trim()).filter((s) => ALL_MODULE_IDS.includes(s));
        if (parts.length) out.onlySet = new Set(parts);
      }

      const qSet = (sp.get('openSettings') || '').trim().toLowerCase();
      if (qSet === '1' || qSet === 'true') out.openSettings = true;

      const qHide = (sp.get('hideHeader') || '').trim().toLowerCase();
      if (qHide === '1' || qHide === 'true') out.hideHeader = true;
    } catch (_) {}
    return out;
  }

  // =========================================================================
  // 4. Bilingual I18N Dictionary (zh-CN / en)
  // =========================================================================
  const I18N = {
    'zh-CN': {
      common: {
        help: '帮助说明',
        readFailed: '读取失败',
        unknownModel: '未知模型',
        unknownWorkspace: '未知工作区',
        unknownPool: '未知池',
        unknown: '未知',
        turns: '轮',
        justNow: '刚刚',
        secAgo: '{n}s 前',
        minAgo: '{n}m 前',
        hrAgo: '{n}h 前',
        dayAgo: '{n}d 前',
        all: '全部',
        cancel: '取消',
        edit: '编辑',
        delete: '删除',
        close: '收起',
        copied: '已复制！',
        copyFailed: '复制失败'
      },
      header: {
        freshnessTitle: '数据更新状态',
        preparing: '准备中',
        refreshing: '刷新中',
        error: '异常',
        paused: '已暂停',
        manual: '手动',
        pending: '待同步',
        refreshIntervalTitle: '自动刷新间隔（面板不可见时自动暂停）',
        refreshIntervalAria: '自动刷新间隔',
        off: '关',
        refreshNow: '立即刷新',
        settingsTitle: '面板设置',
        themeToggleTitle: '切换浅色 / 深色主题',
        readonlyTitle: '只读模式：写操作与后台同步已禁用',
        readonlyBadge: '只读',
        switchSessionAria: '切换对话会话',
        matrixPopoverAria: '矩阵单元格详情',
        updatePopoverAria: '更新详情',
        rangeGroupAria: '全局时间范围',
        rangeToday: '今日',
        rangeAll: '全部',
        rangeCustom: '自定义',
        fromDateAria: '开始日期',
        toDateAria: '结束日期',
        apply: '应用',
        sourcesBadgeTitle: '点击配置数据源',
        sourcesBoth: '桌面端 + CLI',
        sourcesDesktop: '仅桌面端',
        sourcesCli: '仅 CLI',
        sourcesNone: '未选数据源',
        emptyTitle: '所有模块已关闭',
        emptyDesc: '可在设置中开启实时上下文、缓存诊断、Token 流向、成本分析、热力图、缓存观测台或额度对齐模块。',
        openSettings: '打开设置',
        configLoadErr: '配置加载失败，已使用默认布局: {msg}',
        configSaveErr: '保存设置失败: {msg}',
        refreshFailed: '刷新失败'
      },
      source: {
        desktop: '桌面端',
        cli: 'CLI'
      },
      pricingSrc: {
        default: '默认',
        remote: '远程',
        override: '覆写',
        unpriced: '未定价'
      },
      modules: {
        'live-context': {
          title: '实时上下文',
          desc: '当前会话模型、压缩阈值进度条与上下文构成拆解',
          setHelp: '展示内容：当前活跃会话的模型上下文占用、Auto-Compact 压缩上限及各部分构成。\n何时开启：需要实时盯盘长对话何时接近自动压缩时开启。\n扫描范围：仅读取当前活跃对话的单个 SQLite 库（极低开销）。',
          headHelp: '进度条上限为模型 Auto-Compact 自动压缩阈值（而非原始理论窗口）。\n55% 为中位警戒线，80% 为高压临界线；接近上限时系统将触发自动摘要并重置部分缓存前缀。'
        },
        'cache-diagnostics': {
          title: 'Prompt Cache 诊断',
          desc: '最近轮次缓存命中率、冷启动检测与逐轮走势',
          setHelp: '展示内容：当前会话最近一轮与累计 Prompt Cache 命中率、冷启动/骤降标记与缓存节省。\n何时开启：排查单次对话缓存是否频繁失效时开启。\n扫描范围：仅读取当前活跃对话的单个 SQLite 库。',
          headHelp: '缓存命中率 = cacheRead / (cacheRead + uncachedIn)。\n缓存节省美元 = 命中的 cacheRead tokens × (普通输入单价 - 缓存读取单价)，反映相对全额未缓存输入的节省基线。'
        },
        'io-flow': {
          title: '输入输出与 Token 流向',
          desc: '未缓存输入 / 缓存读 / 思考 / 可见输出占比与 TTFT',
          setHelp: '展示内容：未缓存输入、缓存读、思考过程与可见输出的 Token 比例及 TTFT / 生成耗时。\n何时开启：需要对比推理思考占比或响应延迟时开启。\n扫描范围：「本会话」仅扫单库；「全局」会按时间范围查询本地历史索引。',
          headHelp: '按 4 类 Token 桶拆分：Uncached In（新输入）、Cache Read（前缀命中）、Thinking Out（推理思考）、Visible Out（最终回复）。\nTTFT 为首 Token 延迟，生成耗时为完整流式输出持续时间。'
        },
        'model-cost': {
          title: '模型分布与 API 等价成本',
          desc: '按模型与工作区汇总用量、长上下文计费与缓存节省',
          setHelp: '展示内容：各模型与工作区的用量排名、缓存节省及 >200k 长上下文阶梯计费明细。\n何时开启：需要盘点周期消耗分布或对比不同模型成本时开启。\n扫描范围：查询所选时间范围内本地历史索引（桌面端 / CLI）。',
          headHelp: '「API 等价」按公开 API 标准单价估算算力价值，不代表订阅制实际扣费。\n部分模型在单轮总输入 >200k tokens 时触发长上下文阶梯溢价，面板会自动分段计价并标注轮次。'
        },
        'calendar-trends': {
          title: '使用日历热力图与趋势',
          desc: '活跃连续天数、14 日走势及交互式日历下钻',
          setHelp: '展示内容：连续活跃天数、今日 vs 7 日均值、14 天柱状趋势及交互式日历热力图。\n何时开启：想复盘长期使用节奏或按日期回溯特定对话开销时开启。\n扫描范围：查询本地历史索引中的所有已索引日期。',
          headHelp: '热力图颜色按有记录活跃日（非零天数）的四分位数 Q1 / Q2 / Q3 划分为 4 档强度。\n点击任意日期方块可下钻加载当日全部会话与费用明细。'
        },
        'cache-observatory': {
          title: '全局缓存观测台',
          desc: '跨对话追踪模型 × 空闲间隔命中率衰减、0% 意外断崖与边界截断',
          setHelp: '展示内容：跨会话 Model × Idle-Gap 命中率矩阵、对数散点图、意外 0% Miss / 边界截断异常及一键脱敏 Issue 报告。\n何时开启：排查特定模型随请求间隔衰减、疑似 TTL 失效或上下文边界截断问题时开启（默认关闭）。\n扫描范围：按所选时间范围扫描历史索引中的全部连续轮次对。',
          headHelp: 'Idle Gap = 本轮发起时间 - 上轮完成时间；Start Gap = 本轮发起时间 - 上轮发起时间。\nUnexpected 0% Miss：上轮命中 ≥70% 且未换模/未压缩，本轮却突然 0 命中。\nBoundary Cut：上轮命中 ≥70%，本轮骤降至 <40% 且 cacheRead 落在 5k~28k。\nBounce-Back：异常断崖后的下一轮立刻恢复 ≥70% 命中，指向瞬态路由/缓存抖动而非前缀变化。'
        },
        'quota-budget': {
          title: '订阅额度与总额反推',
          desc: '手动记录剩余 % 对齐点，推算周期隐含总额度与置信区间',
          setHelp: '展示内容：基于手动记录的剩余百分比（支持 2 位小数）与区间花费，反推订阅周期隐含总额度及消耗节奏。\n何时开启：想估算 5h/7d 订阅池的隐含美元总额度与剩余可用量时开启（默认关闭）。\n扫描范围：读取对齐锚点表及锚点时间段内的本地索引花费。',
          headHelp: '输入精度步长（如 94.25% 对应 0.01% 步长，误差半径 ±0.005%）决定每次 Δu 的区间不确定性。\n面板基于多段有效 Δu 消耗加权反推隐含总额度，并给出 95% 置信区间（CI）。'
        }
      },
      ctx: {
        noActive: '无活跃会话',
        noData: '当前会话暂无上下文遥测数据（发送首轮对话后自动出现）。',
        warn55: '55% 警戒线',
        warn80: '80% 高压线',
        turnsDur: '轮次: {turns} · 时长: {dur}',
        nearCompact: '接近压缩阈值',
        markers: '55% / 80% 标线',
        nearWarnBanner: '⚠ 上下文已达压缩阈值附近（≥75%），即将触发自动摘要或前缀重算。',
        uncategorized: '未分类',
        chartAria: '上下文构成堆叠图',
        noBreakdown: '暂无上下文构成明细（仅最新轮次保留构成快照）。'
      },
      cache: {
        noDataBadge: '无会话数据',
        noDataBody: '当前会话暂无 Prompt Cache 统计。',
        coldBadge: 'Cold 启动',
        hitBadge: '命中 {pct}',
        lastTurn: '最近一轮',
        hitSub: '{n} 命中',
        sessionTotal: '会话累计',
        cacheSaved: '缓存节省',
        vsUncached: '相对未缓存',
        noTrajectory: '暂无逐轮缓存轨迹。',
        recentTitle: '近 {n} 轮输入命中构成',
        legendCacheRead: 'Cache Read',
        legendUncached: 'Uncached',
        legendCold: 'Cold',
        legendDrop: '骤降',
        chartAria: '逐轮缓存命中柱状图',
        tipHit: '命中率',
        tipCold: ' [Cold 启动]',
        tipDrop: ' [缓存骤降]'
      },
      io: {
        scopeSession: '本会话',
        scopeGlobal: '全局',
        noSession: '当前会话暂无 Token 流向记录。',
        noGlobal: '所选时间范围内暂无 Token 流向记录。',
        barAria: 'Token 流向比例条',
        uncachedShort: '未缓存',
        cacheReadShort: '缓存读',
        thinkingShort: '思考',
        visibleShort: '输出',
        uncachedFull: '未缓存输入 (Uncached In)',
        cacheReadFull: '缓存读取 (Cache Read)',
        cacheWriteNote: '(写 {n})',
        thinkingFull: '思考输出 (Thinking Out)',
        visibleFull: '可见输出 / 总输出',
        latencyRow: '平均响应延迟 (TTFT / 生成)',
        longCtxPill: '>200k 长上下文 {n} 轮',
        unpricedPill: '未定价模型 {n} 轮'
      },
      cost: {
        badge: 'API 等价估算',
        noData: '正在加载或暂无用量统计。',
        savedPill: '缓存已省 {usd}',
        longCtxPill: '>200k {n}轮',
        unpricedPill: '未定价 {n}轮',
        emptyRange: '所选时间范围内无模型消费记录。',
        byModel: '按模型 ({n})',
        byWorkspace: '按工作区 ({n})',
        sortCost: '成本',
        sortTokens: 'Tokens',
        sortTurns: '轮次',
        sortCache: 'Cache%',
        modelSub: '{turns} 轮 · {tok} tok · 缓存 {cache}',
        wsSub: '{turns} 轮 · {tok} tok'
      },
      cal: {
        badge: '趋势',
        noData: '暂无日历趋势数据。',
        streak: '连续 {n} 天',
        no7dBase: '无 7 日基准',
        vs7d: '{delta} vs 7d 均值',
        todayPrefix: '今日',
        avg7dPrefix: '/ 7d均',
        sparkAria: '近 14 天消费迷你柱状图',
        metricCost: '等价 $',
        metricTokens: 'Tokens',
        metricTurns: '轮次',
        less: '少',
        more: '多',
        heatmapAria: '每日使用日历热力图',
        drillHint: '点击任意日期方块可下钻查看当日会话与费用明细。',
        loadingDay: '正在加载 {date} 明细…',
        unnamedSession: '未命名会话',
        noConvsDay: '当日无对话记录。',
        dayLabels: { mon: '一', wed: '三', fri: '五' },
        monthLabel: (m) => `${m + 1}月`,
        tipCost: '成本',
        tipTurns: '轮次'
      },
      obs: {
        badgeOk: '跟随命中 {pct}',
        badgeMiss: '{n} 次 0% 断崖',
        noDataBadge: '等待数据',
        noDataBody: '所选时间范围内暂无多轮对话缓存观测数据。',
        kpiFollowHit: '跟随轮命中率',
        kpiFollowSub: '{n} 个跟随轮次',
        kpiFullMiss: '意外 0% 断崖',
        kpiBounceSub: '{n} 次瞬态回弹',
        kpiBoundaryCut: '边界截断',
        kpiBoundarySub: '换模 {sw} · 压缩 {cmp}',
        kpiPenalty: 'Miss 额外代价',
        kpiWastedSub: '{tok} 浪费',
        matrixTitle: 'Model × Idle-Gap 矩阵',
        matrixSub: '不含 Turn-0 冷启动 · 格内为命中率',
        matrixLegend: '主：{primary}{sub} · 悬停预览 / 点击固定全量',
        matrixLegendSub: ' · 副：{subs}',
        matrixCfgTitle: '矩阵指标设置',
        matrixReset: '恢复默认',
        matrixColMetric: '指标',
        matrixColPrimary: '主(色阶)',
        matrixColSub: '格内小字',
        matrixPrimaryTag: '主',
        matrixSubTag: '副',
        matrixCfgNote: '可自由勾选任意项作为格内小字（每项一行）；切换主指标时原主指标会自动保留为小字；全部指标均在悬浮/点击弹窗中完整展示。',
        gapBtnLabel: '区间 · ≤{max}',
        gapCfgTitle: '时间区间断点',
        gapPresetsLabel: '常用断点（勾选即生效）',
        gapCustomLabel: '自定义断点（支持 s / m / h）',
        gapCustomPlaceholder: '如 45s、3m、45m、4h',
        gapAddBtn: '添加',
        gapCustomTags: '自定义：',
        gapPreviewLabel: '当前区间（{n} 档）：',
        gapCfgNote: '最小点左侧为 <=min，最大点右侧为 >max，相邻两点自动组成中间区间（1~12 个断点）。',
        gapErrInvalid: '无法解析时长，请输入如 45s、3m、45m、2h（范围 1s~24h）',
        gapErrMinOne: '至少需要保留 1 个时间断点',
        gapErrMax: '最多支持 12 个时间断点，请先取消部分再添加',
        metricFull: {
          keepRate: '缓存保活率',
          weightedHit: 'Token 实际命中率',
          avgCost: '轮均花费',
          totalCost: '区间总花费',
          missPenalty: 'Miss 额外罚金',
          turns: '样本轮次数'
        },
        metricShort: {
          keepRate: '保活率',
          weightedHit: '命中率',
          avgCost: '轮均价',
          totalCost: '总花费',
          missPenalty: 'Miss罚金',
          turns: '轮次'
        },
        popTurns: '{n} 轮',
        popKeepRate: '缓存保活率',
        popWeightedHit: 'Token 实际命中率',
        popTurnAvgSub: '轮均 {pct}',
        popAnomalies: '异常事件',
        popAnomNone: '无异常',
        popAnomFullMiss: '{n} 断崖',
        popAnomBoundary: '{n} 截断',
        popAnomBounce: '{n} 回弹',
        popAvgCost: '轮均 API 花费',
        popTotalCost: '区间总花费',
        popMissPenalty: 'Miss 额外罚金',
        popPerTurn: '{usd}/轮',
        popCacheSaved: '缓存已省费用',
        popAvgCtx: '平均输入上下文',
        popCacheVsIn: '缓存读 / 总输入',
        popWastedTok: '浪费 Token',
        popUnbucketed: '注：含 {n} 轮因缺少时间戳未归入空闲区间桶',
        popPinHint: '点击单元格可固定详情卡',
        popClose: '关闭',
        colModel: '模型',
        colTotal: '总计',
        scatterTitle: 'Idle-Gap vs 命中率对数散点图',
        filterAll: '全部',
        legendHit: '正常命中',
        legendFullMiss: '0% 断崖',
        legendBoundary: '边界截断',
        legendLowHit: '低命中',
        kindHit: '正常命中',
        kindFullMiss: '意外 0% 断崖',
        kindBoundary: '边界截断',
        kindLowHit: '低命中',
        bounceYes: '是（下轮恢复）',
        bounceNo: '否',
        bounceBadge: '回弹恢复',
        showAnomalies: '展开 Top 异常 ({n})',
        hideAnomalies: '收起 Top 异常 ({n})',
        copyIssue: '复制脱敏 Issue 报告',
        noAnomalies: '当前时间范围内未检测到 0% 断崖或边界截断异常。',
        noScatterPoints: '当前筛选条件下暂无散点数据。',
        tipHitsTotal: '命中/总轮: {hits}/{total} (Miss {misses})',
        tipAvgHit: '平均命中率: {pct}',
        tipWeighted: '加权命中率: {pct}',
        tipIdleGap: 'Idle Gap',
        tipStartGap: 'Start Gap',
        tipSeq: '前→本→后',
        tipBounce: '瞬态回弹',
        tipPenalty: '浪费 / 代价',
        scatterAria: 'Idle-Gap 与命中率对数散点图'
      },
      quota: {
        remaining: '剩余',
        used: '已用',
        paceFastBad: '超速',
        paceFastWarn: '偏快',
        paceOk: '充裕',
        paceLabel: '节奏 {ratio}x · {lbl}',
        cycleWindow: '周期 {start} → {end}',
        cycleWindowInferred: '推断新周期 {start} → {end}',
        cycleExpired: '已过重置点 · 待录新快照',
        cycleExpiredNew: '新周期已开启 · 已耗 {usd} · 待录新快照',
        cycleAwaiting: '新周期未开始 · 待录新快照',
        prevCycleRef: '上周期参考 ~{usd}',
        cycleTotalSpend: '本周期已耗 {usd}',
        originBootBadge: '周期起点推算',
        originBootHint: '由周期起点 100% 推算（跨设备历史消耗未计入，置信上限开放）；再录一条有效消耗快照即自动切回纯差分校准。',
        cycleOriginRef: '全周期口径对照 ~{usd}',
        resetConflictBadge: '重置时间冲突',
        resetConflictHint: '同周期内存在不兼容的重置时间读数，已优先采用最新显式录入。',
        projectedNow: '推算当前: {pct}',
        spentSince: '区间已耗 {usd}',
        emptyDesc: '尚未记录订阅额度对齐点。展开卡片后可记录当前的精确剩余百分比（如 94.25%），自动反推周期隐含总额度。',
        formTitle: '快速记录对齐点',
        poolLabel: '额度池',
        pool3p: '第三方 (3P)',
        windowLabel: '统计窗口',
        win5h: '5h 窗口',
        win7d: '7d 周期',
        pctLabel: '当前剩余百分比 (%)',
        pctPlaceholder: '例如 94.25',
        pctHint: '支持最多 2 位小数（如 94.25）；系统会自动识别小数精度以计算置信区间误差。',
        resetLabel: '重置倒计时 / 时间（可选）',
        resetPlaceholder: '如 6d 23h、3h20m、11-28 10:30',
        resetHint: '支持 6d 23h / 5天3小时 / 3h20m / 11-28 10:30 / HH:MM',
        resetInheritHint: '留空自动沿用本周期重置 ({time})，新周期请重填',
        resetPreview: '预计重置: {time}',
        resetPreviewCycle: '预计重置 {time}{prec} · 本周期 {start} → {end}（早于 {start} 自动折叠）',
        resetPrecHour: ' (±1h)',
        resetOutOfWindow: '重置时间超出 {wt} 窗口范围，请检查是否选错 7d / 5h',
        resetBad: '无法解析时间格式（支持 6d 23h、5天3小时、3h20m、11-28 10:30 或 HH:MM）',
        captureTimeLabel: '记录时刻',
        now: '此刻',
        custom: '自定义',
        noteLabel: '备注（可选）',
        notePlaceholder: '例如：IDE 设置面板截图校准',
        submitting: '记录中…',
        submitBtn: '记录时间点',
        impliedTitle: '{pool} · {wt} 隐含总额度',
        statusOk: '高置信',
        statusLow: '低置信',
        statusCal: '校准中',
        statusNewCycle: '新周期',
        calDesc: '已观测有效消耗 Δu = {du}%（{seg} 段），本周期累计 {usd}；需继续积累消耗百分比以完成反推校准。',
        effDelta: '有效 Δu: {du}% ({seg} 段) · 校准段 {usd}',
        impliedRem: '推算剩余: {usd}',
        ciOpenHigh: '[{low}, ∞)',
        mixedWarn: '⚠ 检测到同池内多模型混用方差较大，反推总额仅供参考。',
        historyTitle: '历史对齐记录 ({n})',
        currentHistoryTitle: '当前 7d 周期记录 ({n})',
        noCurrentAnchors: '当前 7d 周期尚无对齐记录。',
        poolCycleNoReset: '未设重置时间（填入后可自动划界）',
        poolCycleEmptyNew: '新周期尚无快照（本周期已耗 {usd}）',
        poolCycleEmptyIdle: '新周期尚未开始，待录首个快照',
        showOlderCycles: '展开历史周期及其他记录 ({m})',
        hideOlderCycles: '收起历史周期及其他记录 ({m})',
        olderGroup7d: '历史 7d 周期',
        olderGroup5h: '5h 窗口记录',
        cycleGroupMeta: '花费 {usd}',
        cycleGroupEst: '估值 ~{usd}',
        precision: '精度 {step}%',
        resetAt: '重置 {time}',
        resetInheritedTag: '继承',
        editResetBtn: '改重置',
        editResetSave: '保存',
        editResetClear: '清空',
        editResetCancel: '取消',
        editResetPlaceholder: '如 6d 23h 或 11-28 10:30',
        invalidPct: '请输入 0 到 100 之间的有效剩余百分比（支持最多 2 位小数，如 94.25）',
        recordFailed: '记录失败: {msg}',
        updateFailed: '更新失败: {msg}',
        deleteFailed: '删除失败: {msg}',
        subsetBase: '基准',
        subsetM: '模型 (M)',
        subsetC: '缓存 (C)',
        subsetO: '输出 (O)',
        subsetMC: '模型+缓存',
        subsetMO: '模型+输出',
        subsetCO: '缓存+输出',
        subsetMCO: '全因子 (M+C+O)',
        factorM: '模型倍率 (M)',
        factorC: '缓存倍率 (C)',
        factorO: '输出倍率 (O)',
        calibBadgeHelp: '正交 3 因子校准：模型倍率 (M)、缓存倍率 (C)、输出倍率 (O) 彼此独立，按双层门槛（手动探索 / 自动择优）独立解锁。\n自动模式仅在满足严格数据量与共线性门槛的子集中，按 LOOCV-MAE 与过离散校正 χ² 准则择优；所有子集的 95% CI 均按统一残差与完整 Delta 法协方差计算。',
        mixEqHint: '当前配比等效',
        clamped: '受限',
        exploratoryBadge: '探索性',
        exploratoryTip: '当前组合处于手动探索区间（未达自动择优门槛：{reason}），参数方差较大，结果仅供参考。',
        stripBase: '基准',
        stripCache: '缓存',
        stripOutput: '输出',
        maeStrip: 'MAE ±{mae}pp',
        labTitle: '权重校准实验室',
        labSummary: '推荐 {rec} · {n} 段',
        modeAuto: '自动择优',
        modeAutoHelp: '在通过严格准入的子集中按 LOOCV-MAE 与过离散校正 χ² 准则自动选择最优模型。',
        modeManual: '手动 {mode}',
        allFactorsUnlocked: '全部 3 个正交因子已就绪，可自由组合或使用自动择优。',
        exploreOnlyHint: '探索可手动点选（未达自动门槛）：{list}',
        manualFallbackHint: '组合 {subset} 暂不可用（{reason}），已回退至 {fallback}。',
        subsetIneligible: '样本量或共线性条件未满足',
        reasonNeedAnchors: '至少需要 2 条含有效额度消耗的对齐记录',
        reasonMSingleModel: '本周期仅使用 1 个活跃模型',
        reasonMLowShare: '需至少 2 个模型且副模型占比 ≥ {minPct}%',
        reasonMLowStd: '各段模型配比变化偏低（std {std} < {minStd}）',
        reasonMNeedSegs: '还需 {need} 个模型配比有变化的平滑段（{cur}/{req}）',
        reasonMAutoShareOrSegs: '副模型占比 {sharePct}% < 10%（自动采纳需 ≥10% 或 ≥6 段）',
        reasonCLowStd: '各段缓存占比变化偏低（std {std} < {minStd}）',
        reasonCNeedSegs: '还需 {need} 个缓存占比有变化的平滑段（{cur}/{req}）',
        reasonOLowStd: '各段输出占比变化偏低（std {std} < {minStd}）',
        reasonONeedSegs: '还需 {need} 个输出占比有变化的平滑段（{cur}/{req}）',
        reasonSubsetNeedSegs: '组合 {subset} 还需 {need} 个平滑段（{cur}/{req}）',
        reasonSubsetCollinear: '组合 {subset} 维度共线性过高（VIF {vif} ≥ {maxVif}）',
        reasonSubsetLowEffDf: '组合 {subset} 数据主导度偏低（{effDf} < {minEffDf}，主要由先验决定）',
        promoIntro: '首销 {pct}% 优惠，截至 {date}',
        smoothSegSummary: '{anchors} 锚点 → {segs} 平滑段 (合并 {merged} 处抖动)',
        smoothHuberTag: 'Huber 降权 {n} 处跳变',
        smoothTipInfo: '保守区间平滑：自动归并微小结算滞后与微幅回弹，保持总花费与 Δu 守恒；Huber 权重自动抑制偶发滞后异常点。',
        baseAnchorLabel: '1.00× 基准锚点',
        anchorSrcDefault: '默认',
        anchorSrcUser: '自定义',
        anchorSrcFallback: '自动回退',
        anchorPoolQ: '锚点口径 Q: ~{usd}',
        anchorPoolQHelp: '「锚点口径 Q」指完全使用所选 1.00× 基准模型时的周期总额度；卡片顶部大号数字为按当前混合配比折算的等效 API 总额度，切换因子组合时平滑不跳变。',
        paramBase: '基准 1.00×',
        paramFitted: '已拟合',
        paramDefault: '默认 1.00×',
        paramCacheName: '缓存读取 (α_cache)',
        paramOutName: '输出 / 思考 (α_out)',
        interpBase: '以该模型 API 单价作为本池 1.00× 基准标尺。',
        interpModelEff: '同 API 花费下，额度消耗约为基准模型的 {v}×（更省额度）。',
        interpModelHeavy: '同 API 花费下，额度消耗约为基准模型的 {v}×（更费额度）。',
        interpModelNeutral: '与基准模型额度消耗速率基本一致（~{v}×）。',
        interpModelUnfit: '沿用 API 标价 1.00×（启用因子 M 后拟合）。',
        interpCacheCheap: '同池消费加权平均：缓存读取按 API 缓存价的 {v}× 扣额（命中更划算）。',
        interpCacheExpensive: '同池消费加权平均：缓存读取按 API 缓存价的 {v}× 扣额（折扣低于 API）。',
        interpCacheNeutral: '同池消费加权平均：缓存读取扣额与官方 API 定价基本一致（~{v}×）。',
        interpCacheUnfit: '按官方 API 缓存折扣计算（启用因子 C 后拟合池平均倍率）。',
        interpOutExpensive: '同池消费加权平均：输出 / 思考按 API 输出价的 {v}× 扣额（输出更贵）。',
        interpOutCheap: '同池消费加权平均：输出 / 思考按 API 输出价的 {v}× 扣额（输出更省）。',
        interpOutNeutral: '同池消费加权平均：输出与输入消耗比基本符合官方 API 定价（~{v}×）。',
        interpOutUnfit: '按官方 API 输出比例计算（启用因子 O 后拟合池平均倍率）。',
        trialNotAdopted: '未采纳 · 试算 {val}{clamped}（{reason}）',
        trialReasonWorse: 'LOOCV ±{trial}pp 差于基准 ±{base}pp',
        trialReasonMarginal: 'LOOCV ±{trial}pp 较基准 ±{base}pp 降幅不足 15%',
        trialReasonChi2: '信息准则 χ² 改善未达门槛',
        promoNoteFollow: '提示：本周期内促销模型尚未跨越调价点，暂无法独立辨识订阅是否跟随促销折扣，当前按「跟随 API 促销价」假设校准。',
        promoNoteList: '提示：本周期内促销模型尚未跨越调价点，暂按「标准原价（不跟随促销）」假设校准。',
        residualTitle: '实测 vs 预测残差 (pp)',
        residualNoData: '当前周期分段拟合数据不足。',
        residualSummary: '{l0} ±{mae0}pp → {cur} ±{mae1}pp ({metric})',
        residualBaseOnly: '{base} ±{mae0}pp ({metric})',
        legendObs: '实测',
        legendBase: '基准预测',
        legendCur: '{lvl} 预测',
        legendHuber: 'Huber 降权',
        segTipTitle: '区间 #{idx} · 花费 {usd}',
        segTipObs: '实测消耗: {v}pp',
        segTipBase: '基准预测: {v}pp (误差 {err}pp)',
        segTipCur: '{lvl} 预测: {v}pp (误差 {err}pp)',
        segTipMerged: '合并了 {n} 个原始间隔',
        segTipDownweighted: 'Huber 已降权（疑似滞后跳变）'
      },
      settings: {
        title: '面板设置',
        closeTitle: '关闭设置',
        langSection: '界面语言',
        langDesc: '即时切换中英文界面（支持 ?lang=en 临时覆盖）',
        generalSection: '刷新与采集控制',
        autoRefreshName: '自动刷新间隔',
        autoRefreshDesc: '仅在面板可见时按间隔轮询；最小化或切走标签页自动零开销暂停',
        autoRefreshHelp: '控制侧边栏处于可见状态时的自动刷新周期。\n面板隐藏或切到后台时自动暂停轮询，避免无意义 CPU/磁盘占用；选「关」则仅手动刷新。',
        modulesSection: '模块开关与排序',
        moveUp: '上移',
        moveDown: '下移',
        toggleModuleTitle: '启用或关闭此模块',
        sourcesSection: '数据源与本地索引',
        sourcesHelp: '所有数据均以 SQLite 只读模式（mode=ro）扫描本地会话库，不修改原库也不上传任何远程服务器。\n勾选对应数据源后，全局分析模块与索引重建将聚合所选来源。',
        desktopName: 'Antigravity 桌面端',
        desktopDesc: '只读扫描 conversations/*.db（{n} 个库）',
        cliName: 'Antigravity CLI',
        cliDesc: '只读扫描 antigravity-cli/conversations/*.db（{n} 个库）',
        indexedTurns: '已索引轮次: {n}',
        lastIndexed: '上次索引: {time}',
        rebuildHint: '重建索引仅清理缓存，完整保留额度对齐记录。',
        rebuilding: '重建中…',
        rebuildBtn: '重建索引',
        rebuildDone: '重建完成：扫描 {dbs} 个库，耗时 {ms}ms',
        rebuildFail: '重建失败: {msg}',
        pricingSection: '定价表管理',
        promoBadge: '促销价',
        defaultAnchorsNote: '默认基准锚点 (1.00×): {list}',
        defaultsPath: '离线默认配置文件 (pricing_defaults.json)',
        builtinDefaults: '内置默认表',
        overridesPath: '用户覆写配置文件 (pricing_overrides.json)',
        autoSyncName: '自动同步远程公开定价',
        autoSyncDesc: '每 24h 从 LiteLLM / OpenRouter 更新公开参考单价',
        autoSyncHelp: '开启后每 24 小时从公开的 LiteLLM / OpenRouter 定价 JSON 拉取最新参考单价。\n关闭时完全离线运行，仅使用内置默认值与本地 overrides 覆写。',
        lastSynced: '上次同步: {time}',
        neverSynced: '尚未同步',
        syncing: '同步中…',
        syncBtn: '立即手动刷新定价',
        syncOk: '同步成功，已匹配 {n} 个模型',
        syncOkFiltered: '同步成功：扫描远端 {total} 条，已匹配保留 {n} 个相关模型',
        syncErr: '同步异常: {msg}',
        syncFail: '同步失败: {msg}',
        collapsePricing: '收起模型单价表',
        expandPricing: '展开模型单价表与自定义覆写',
        loadingPricing: '正在加载定价表…',
        restoreDefault: '恢复默认',
        saveOverride: '保存覆写',
        restoreFail: '恢复默认失败: {msg}',
        saveFail: '保存覆写失败: {msg}',
        thThreshold: '长上下文阈值',
        thThresholdPlaceholder: '留空表示无',
        thInAbove: '超阈值 Input ($/1M)',
        thOutAbove: '超阈值 Output ($/1M)',
        thCacheAbove: '超阈值 Cache Read ($/1M)'
      },
      update: {
        sectionTitle: '版本与自动更新',
        pillLabel: '↑ v{ver}',
        pillTitle: '发现新版本 v{ver}，点击查看更新详情',
        popTitle: '新版本可用',
        upToDate: '已是最新版本',
        installGit: 'Git 安装',
        installTarball: '独立安装',
        installBuiltin: '内置插件',
        modeLabel: '更新策略',
        modeHelp: '自动更新：每 6h 检查 GitHub Releases，发现新版自动下载校验，点击重启或闲置/重开面板时无感生效。\n仅提醒：只显示新版徽标，点击后手动更新。\n关闭：完全离线，不发起更新检查。',
        manualOnlyBadge: '可选小更新',
        manualOnlyNote: '该版本已由发布者标记为可选小更新，不会自动推送或打扰顶栏；如需升级可在此手动点击更新。',
        modeAuto: '自动更新',
        modeNotify: '仅提醒',
        modeOff: '关闭',
        checkBtn: '检查更新',
        checking: '检查中…',
        applyBtn: '一键更新并重启',
        restartBtn: '立即重启应用 v{ver}',
        applying: '正在准备更新…',
        rollbackBtn: '回滚至 v{ver}',
        rollingBack: '正在回滚…',
        skipBtn: '忽略此版本',
        viewGithub: 'GitHub 详情',
        copyCmd: '复制更新命令',
        stagedReady: '已通过预检与烟雾测试，可随时重启生效（不点也会在下次重开面板时自动应用）',
        staging: '正在后台下载并校验更新包…',
        hostRestartNote: '本版本更新了 sidecar.json，应用后需重启 Antigravity 使新配置完全生效。',
        restartingBanner: '正在应用 v{ver} 并重启 AGY Lens 面板…',
        rollingBackBanner: '正在回滚至 v{ver} 并重启面板…',
        reopenFallback: '更新已就绪（v{ver}），请关闭并重新打开 AGY Lens 面板即可生效。',
        justUpdatedBanner: '已自动更新至 v{to}（来自 v{from}）',
        mismatchBanner: '检测到磁盘插件已更新至 v{disk}，请刷新面板以同步版本。',
        reloadBtn: '刷新面板',
        ackBtn: '知道了',
        lastChecked: '上次检查: {time}',
        neverChecked: '尚未检查',
        failedWarn: '上次尝试升级 v{ver} 失败并已自动保护回滚，请查看原因或手动重试。',
        noNotes: '暂无 Release Notes 摘要，可前往 GitHub 查看完整变更。',
        blocked: {
          dirty_git: '当前 Git 目录有未提交修改，已跳过自动覆盖以保护本地改动。',
          non_main_branch: '当前不在 main 分支，已跳过自动更新。',
          custom_remote: '远程仓库非官方源，已跳过自动更新。',
          git_unavailable: '当前环境未检测到 git 命令，无法自动拉取 Git 仓库。',
          git_locked: '检测到 .git/index.lock，请稍后再试。',
          not_writable: '插件目录无写权限，无法自动替换文件。',
          builtin_plugin: '内置插件由宿主统一管理，不支持自更新。',
          standalone_cli: '当前为独立 Web / CLI 运行模式，请通过 git pull 或 npm 更新后手动重启服务。',
          git_error: '无法读取 Git 仓库状态。'
        }
      }
    },
    en: {
      common: {
        help: 'Help',
        readFailed: 'Load failed',
        unknownModel: 'Unknown model',
        unknownWorkspace: 'Unknown workspace',
        unknownPool: 'Unknown pool',
        unknown: 'Unknown',
        turns: 'turns',
        justNow: 'just now',
        secAgo: '{n}s ago',
        minAgo: '{n}m ago',
        hrAgo: '{n}h ago',
        dayAgo: '{n}d ago',
        all: 'All',
        cancel: 'Cancel',
        edit: 'Edit',
        delete: 'Delete',
        close: 'Close',
        copied: 'Copied!',
        copyFailed: 'Copy failed'
      },
      header: {
        freshnessTitle: 'Data freshness status',
        preparing: 'Ready',
        refreshing: 'Syncing',
        error: 'Error',
        paused: 'Paused',
        manual: 'Manual',
        pending: 'Pending',
        refreshIntervalTitle: 'Auto-refresh interval (pauses automatically when pane is hidden)',
        refreshIntervalAria: 'Auto-refresh interval',
        off: 'Off',
        refreshNow: 'Refresh now',
        settingsTitle: 'Panel settings',
        themeToggleTitle: 'Toggle light / dark theme',
        readonlyTitle: 'Read-only mode: write operations and background sync are disabled',
        readonlyBadge: 'Read-Only',
        switchSessionAria: 'Switch conversation',
        matrixPopoverAria: 'Matrix cell details',
        updatePopoverAria: 'Update details',
        rangeGroupAria: 'Global time range',
        rangeToday: 'Today',
        rangeAll: 'All',
        rangeCustom: 'Custom',
        fromDateAria: 'Start date',
        toDateAria: 'End date',
        apply: 'Apply',
        sourcesBadgeTitle: 'Click to configure data sources',
        sourcesBoth: 'Desktop + CLI',
        sourcesDesktop: 'Desktop only',
        sourcesCli: 'CLI only',
        sourcesNone: 'No sources',
        emptyTitle: 'All modules disabled',
        emptyDesc: 'Enable Live Context, Cache Diagnostics, IO Flow, Model Cost, Calendar Heatmap, Cache Observatory, or Quota Budget in Settings.',
        openSettings: 'Open Settings',
        configLoadErr: 'Failed to load config, using defaults: {msg}',
        configSaveErr: 'Failed to save settings: {msg}',
        refreshFailed: 'Refresh failed'
      },
      source: {
        desktop: 'Desktop',
        cli: 'CLI'
      },
      pricingSrc: {
        default: 'Default',
        remote: 'Remote',
        override: 'Override',
        unpriced: 'Unpriced'
      },
      modules: {
        'live-context': {
          title: 'Live Context',
          desc: 'Active session model, auto-compact ceiling bar & context breakdown',
          setHelp: 'What it shows: Active conversation context usage, Auto-Compact ceiling, and per-category token breakdown.\nWhen to enable: Keep ON to watch when long threads approach auto-compaction.\nScan scope: Single active conversation SQLite DB (read-only, minimal overhead).',
          headHelp: 'Bar ceiling tracks the model Auto-Compact threshold (not the raw max context window).\nMarkers sit at 55% (caution) and 80% (high pressure); nearing the ceiling triggers auto-summarization.'
        },
        'cache-diagnostics': {
          title: 'Prompt Cache Diagnostics',
          desc: 'Latest turn & cumulative cache hit rate, cold starts & turn trajectory',
          setHelp: 'What it shows: Last-turn and session cumulative Prompt Cache hit ratio, cold-start/drop markers, and savings.\nWhen to enable: Enable to monitor prefix cache stability inside the active session.\nScan scope: Single active conversation SQLite DB (read-only).' ,
          headHelp: 'Cache Hit % = cacheRead / (cacheRead + uncachedIn).\nCache Savings USD = cacheRead tokens × (standard input price - cache read price), measured against an uncached baseline.'
        },
        'io-flow': {
          title: 'Input/Output & Token Flow',
          desc: 'Uncached In / Cache Read / Thinking / Visible Output ratio & TTFT',
          setHelp: 'What it shows: Token mix across Uncached In, Cache Read, Thinking, and Visible Output plus TTFT/generation latency.\nWhen to enable: Use to inspect reasoning overhead or response latency.\nScan scope: "Session" reads the single active DB; "Global" queries the local historical index.',
          headHelp: 'Splits tokens into 4 buckets: Uncached In, Cache Read, Thinking Out, and Visible Out.\nTTFT = average Time To First Token; Gen = average streaming generation duration.'
        },
        'model-cost': {
          title: 'Models & API-Eq. Cost',
          desc: 'Usage by model & workspace, >200k long-context tiering & cache savings',
          setHelp: 'What it shows: API-equivalent cost breakdown by model and workspace, cache savings, and >200k long-context turn counts.\nWhen to enable: Use to audit token spend across projects and models.\nScan scope: Local historical SQLite index filtered by the selected range & sources.',
          headHelp: 'API-eq. estimates compute value using public API list prices (not actual subscription billing).\nModels with >200k tiered pricing automatically switch to above-threshold rates on qualifying turns.'
        },
        'calendar-trends': {
          title: 'Calendar Heatmap & Trends',
          desc: 'Active streak, 14-day sparkline & interactive day drill-down',
          setHelp: 'What it shows: Consecutive active days, Today vs 7d average, 14-day sparkbars, and a clickable calendar heatmap.\nWhen to enable: Turn ON to review daily cadence or drill into past sessions by date.\nScan scope: All indexed dates in the local historical SQLite index.',
          headHelp: 'Cell colors map active (non-zero) days into 4 intensity levels via Q1/Q2/Q3 quartiles.\nClick any day cell to drill down into that day’s conversations and API-eq. cost.'
        },
        'cache-observatory': {
          title: 'Global Cache Observatory',
          desc: 'Cross-session Model × Idle-Gap hit decay, unexpected 0% misses & boundary cuts',
          setHelp: 'What it shows: Cross-session Model × Idle-Gap hit matrix, log-scale gap scatter plot, top anomalies, and anonymized issue report.\nWhen to enable: Turn ON when diagnosing TTL decay, model-specific cache drops, or routing misses (OFF by default).\nScan scope: Consecutive turn pairs across the local historical index within the selected range.',
          headHelp: 'Idle Gap = cur.createdAt - prev.completedAt; Start Gap = cur.createdAt - prev.createdAt.\nUnexpected 0% Miss: prev hit ≥70% (same model, uncompacted) drops to 0 cacheRead.\nBoundary Cut: prev hit ≥70% drops to <40% with cacheRead in 5k–28k.\nBounce-Back: next turn immediately recovers ≥70% hit, indicating transient miss rather than prefix drift.'
        },
        'quota-budget': {
          title: 'Quota & Cycle Budget',
          desc: 'Manual 2-decimal remaining % anchors with 95% CI cycle budget inversion',
          setHelp: 'What it shows: Tracks manual remaining % anchors (up to 2 decimals) and inverts implied cycle budget + pace ratio.\nWhen to enable: Turn ON to calibrate 5h/7d subscription pools against API-eq. spend (OFF by default).\nScan scope: Local quota_anchors table + indexed spend between anchor timestamps.',
          headHelp: 'Input precision step (e.g., 94.25% -> 0.01% step, ±0.005% error radius) bounds Δu interval width.\nMultiple Δu segments are weighted to estimate implied total pool USD and its 95% confidence interval.'
        }
      },
      ctx: {
        noActive: 'No active session',
        noData: 'No context telemetry yet for this conversation (appears after first turn).',
        warn55: '55% caution mark',
        warn80: '80% high-pressure mark',
        turnsDur: 'Turns: {turns} · Dur: {dur}',
        nearCompact: 'Near compact ceiling',
        markers: '55% / 80% markers',
        nearWarnBanner: '⚠ Context is nearing the auto-compact ceiling (≥75%); summarization or prefix recompute may trigger soon.',
        uncategorized: 'Uncategorized',
        chartAria: 'Context composition stacked bar',
        noBreakdown: 'No detailed context breakdown available (captured on latest turn only).'
      },
      cache: {
        noDataBadge: 'No data',
        noDataBody: 'No Prompt Cache telemetry for this session yet.',
        coldBadge: 'Cold start',
        hitBadge: 'Hit {pct}',
        lastTurn: 'Last Turn',
        hitSub: '{n} hit',
        sessionTotal: 'Session',
        cacheSaved: 'Saved',
        vsUncached: 'vs uncached',
        noTrajectory: 'No per-turn cache trajectory yet.',
        recentTitle: 'Last {n} turns input composition',
        legendCacheRead: 'Cache Read',
        legendUncached: 'Uncached',
        legendCold: 'Cold',
        legendDrop: 'Drop',
        chartAria: 'Per-turn cache hit bar chart',
        tipHit: 'Hit ratio',
        tipCold: ' [Cold start]',
        tipDrop: ' [Cache drop]'
      },
      io: {
        scopeSession: 'Session',
        scopeGlobal: 'Global',
        noSession: 'No token flow recorded for this session yet.',
        noGlobal: 'No token flow recorded in the selected range.',
        barAria: 'Token flow ratio bar',
        uncachedShort: 'Uncached',
        cacheReadShort: 'Cache Read',
        thinkingShort: 'Thinking',
        visibleShort: 'Visible',
        uncachedFull: 'Uncached Input',
        cacheReadFull: 'Cache Read',
        cacheWriteNote: '(write {n})',
        thinkingFull: 'Thinking Output',
        visibleFull: 'Visible / Total Output',
        latencyRow: 'Avg Latency (TTFT / Gen)',
        longCtxPill: '>200k long ctx {n} turns',
        unpricedPill: 'Unpriced {n} turns'
      },
      cost: {
        badge: 'API-eq.',
        noData: 'Loading or no usage data yet.',
        savedPill: 'Saved {usd}',
        longCtxPill: '>200k {n}t',
        unpricedPill: 'Unpriced {n}t',
        emptyRange: 'No model spend in the selected range.',
        byModel: 'Models ({n})',
        byWorkspace: 'Workspaces ({n})',
        sortCost: 'Cost',
        sortTokens: 'Tokens',
        sortTurns: 'Turns',
        sortCache: 'Cache%',
        modelSub: '{turns} turns · {tok} tok · Cache {cache}',
        wsSub: '{turns} turns · {tok} tok'
      },
      cal: {
        badge: 'Trends',
        noData: 'No calendar trend data yet.',
        streak: '{n}d streak',
        no7dBase: 'No 7d baseline',
        vs7d: '{delta} vs 7d avg',
        todayPrefix: 'Today',
        avg7dPrefix: '/ 7d avg',
        sparkAria: '14-day spend sparkbars',
        metricCost: 'API-eq. $',
        metricTokens: 'Tokens',
        metricTurns: 'Turns',
        less: 'Less',
        more: 'More',
        heatmapAria: 'Daily usage calendar heatmap',
        drillHint: 'Click any day cell to drill down into conversations and cost for that day.',
        loadingDay: 'Loading {date} details…',
        unnamedSession: 'Untitled session',
        noConvsDay: 'No conversations recorded on this date.',
        dayLabels: { mon: 'Mon', wed: 'Wed', fri: 'Fri' },
        monthLabel: (m) => ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][m] || `${m + 1}`,
        tipCost: 'Cost',
        tipTurns: 'Turns'
      },
      obs: {
        badgeOk: 'Follow-up {pct}',
        badgeMiss: '{n} 0%-misses',
        noDataBadge: 'No data',
        noDataBody: 'No multi-turn cache transition data in the selected range.',
        kpiFollowHit: 'Follow-up Hit %',
        kpiFollowSub: '{n} follow-up turns',
        kpiFullMiss: 'Unexpected 0% Misses',
        kpiBounceSub: '{n} bounce-backs',
        kpiBoundaryCut: 'Boundary Cuts',
        kpiBoundarySub: '{sw} switch · {cmp} compact',
        kpiPenalty: 'Miss Penalty',
        kpiWastedSub: '{tok} wasted',
        matrixTitle: 'Model × Idle-Gap Matrix',
        matrixSub: 'Excl. Turn-0 cold starts · cell shows hit %',
        matrixLegend: 'Primary: {primary}{sub} · Hover preview / Click to pin',
        matrixLegendSub: ' · Sub: {subs}',
        matrixCfgTitle: 'Matrix Metrics',
        matrixReset: 'Reset',
        matrixColMetric: 'Metric',
        matrixColPrimary: 'Primary',
        matrixColSub: 'In-Cell',
        matrixPrimaryTag: 'Main',
        matrixSubTag: 'Sub',
        matrixCfgNote: 'Check any metrics to stack as in-cell rows. Switching primary keeps the previous primary as a sub-row. All metrics appear in the detail card.',
        gapBtnLabel: 'Gaps · ≤{max}',
        gapCfgTitle: 'Idle-Gap Breakpoints',
        gapPresetsLabel: 'Preset Breakpoints (toggle to apply)',
        gapCustomLabel: 'Custom Breakpoint (s / m / h)',
        gapCustomPlaceholder: 'e.g. 45s, 3m, 45m, 4h',
        gapAddBtn: 'Add',
        gapCustomTags: 'Custom:',
        gapPreviewLabel: 'Buckets ({n}):',
        gapCfgNote: 'Left of min becomes <=min, right of max becomes >max, adjacent pairs form middle intervals (1–12 breakpoints).',
        gapErrInvalid: 'Invalid duration — use e.g. 45s, 3m, 45m, 2h (1s to 24h)',
        gapErrMinOne: 'Keep at least 1 breakpoint',
        gapErrMax: 'Maximum 12 breakpoints allowed; uncheck one first',
        metricFull: {
          keepRate: 'Cache Keep Rate',
          weightedHit: 'Token Hit Ratio',
          avgCost: 'Avg Cost / Turn',
          totalCost: 'Bucket Total Cost',
          missPenalty: 'Miss Penalty',
          turns: 'Follow-up Turns'
        },
        metricShort: {
          keepRate: 'Keep %',
          weightedHit: 'Hit %',
          avgCost: '$/turn',
          totalCost: 'Cost',
          missPenalty: 'Penalty',
          turns: 'Turns'
        },
        popTurns: '{n} turns',
        popKeepRate: 'Cache Keep Rate',
        popWeightedHit: 'Token Hit Ratio',
        popTurnAvgSub: 'turn avg {pct}',
        popAnomalies: 'Anomalies',
        popAnomNone: 'None',
        popAnomFullMiss: '{n} 0%-miss',
        popAnomBoundary: '{n} cut',
        popAnomBounce: '{n} bounce',
        popAvgCost: 'Avg Cost / Turn',
        popTotalCost: 'Bucket Total Cost',
        popMissPenalty: 'Miss Penalty',
        popPerTurn: '{usd}/t',
        popCacheSaved: 'Cache Saved',
        popAvgCtx: 'Avg Input Context',
        popCacheVsIn: 'Cache Read / Input',
        popWastedTok: 'Wasted Tokens',
        popUnbucketed: 'Note: includes {n} turns without timestamps (unbucketed)',
        popPinHint: 'Click cell to pin detail card',
        popClose: 'Close',
        colModel: 'Model',
        colTotal: 'All',
        scatterTitle: 'Idle-Gap vs Hit-Rate (Log Scale)',
        filterAll: 'All',
        legendHit: 'Hit',
        legendFullMiss: '0% Miss',
        legendBoundary: 'Boundary Cut',
        legendLowHit: 'Low Hit',
        kindHit: 'Hit',
        kindFullMiss: 'Unexpected 0% Miss',
        kindBoundary: 'Boundary Cut',
        kindLowHit: 'Low Hit',
        bounceYes: 'Yes (recovered next turn)',
        bounceNo: 'No',
        bounceBadge: 'Bounce-Back',
        showAnomalies: 'Show Top Anomalies ({n})',
        hideAnomalies: 'Hide Top Anomalies ({n})',
        copyIssue: 'Copy Issue Markdown',
        noAnomalies: 'No unexpected 0% misses or boundary cuts detected in this range.',
        noScatterPoints: 'No scatter points match the current model filter.',
        tipHitsTotal: 'Hits/Total: {hits}/{total} (Misses: {misses})',
        tipAvgHit: 'Avg Hit Ratio: {pct}',
        tipWeighted: 'Weighted Hit Ratio: {pct}',
        tipIdleGap: 'Idle Gap',
        tipStartGap: 'Start Gap',
        tipSeq: 'Prev → Cur → Next',
        tipBounce: 'Bounce-Back',
        tipPenalty: 'Wasted / Penalty',
        scatterAria: 'Idle-Gap vs Hit-Rate log scatter plot'
      },
      quota: {
        remaining: 'Left',
        used: 'Used',
        paceFastBad: 'Overpace',
        paceFastWarn: 'Fast',
        paceOk: 'Healthy',
        paceLabel: 'Pace {ratio}x · {lbl}',
        cycleWindow: 'Cycle {start} → {end}',
        cycleWindowInferred: 'Inferred {start} → {end}',
        cycleExpired: 'Reset passed · log new snapshot',
        cycleExpiredNew: 'New cycle active · {usd} spent · log snapshot',
        cycleAwaiting: 'New cycle not started · log snapshot',
        prevCycleRef: 'Prev cycle ref ~{usd}',
        cycleTotalSpend: 'Cycle spent {usd}',
        originBootBadge: 'From cycle start',
        originBootHint: 'Bootstrapped from 100% cycle start (open upper bound for cross-device spend); log another active snapshot to switch to differential calibration.',
        cycleOriginRef: 'Full-cycle ref ~{usd}',
        resetConflictBadge: 'Reset conflict',
        resetConflictHint: 'Conflicting reset times inside this cycle; using the latest explicit entry.',
        projectedNow: 'Projected now: {pct}',
        spentSince: 'Spent since: {usd}',
        emptyDesc: 'No quota anchors yet. Expand to log your remaining % (e.g. 94.25%) and estimate the implied cycle budget.',
        formTitle: 'Record Alignment Anchor',
        poolLabel: 'Quota Pool',
        pool3p: 'Third-Party (3P)',
        windowLabel: 'Window',
        win5h: '5h Window',
        win7d: '7d Cycle',
        pctLabel: 'Current Remaining (%)',
        pctPlaceholder: 'e.g. 94.25',
        pctHint: 'Supports up to 2 decimal places (e.g. 94.25); precision step is auto-detected for CI bounds.',
        resetLabel: 'Reset Countdown / Time (optional)',
        resetPlaceholder: 'e.g. 6d 23h, 3h20m, 11-28 10:30',
        resetHint: 'Supports 6d 23h / 3h20m / 11-28 10:30 / HH:MM',
        resetInheritHint: 'Leave blank to inherit {time}; enter new value for a new cycle',
        resetPreview: 'Est. reset: {time}',
        resetPreviewCycle: 'Est. reset {time}{prec} · Cycle {start} → {end} (earlier folded)',
        resetPrecHour: ' (±1h)',
        resetOutOfWindow: 'Reset time exceeds the {wt} window range — check 7d / 5h selection',
        resetBad: 'Invalid format (try 6d 23h, 3h20m, 11-28 10:30, or HH:MM)',
        captureTimeLabel: 'Captured At',
        now: 'Now',
        custom: 'Custom',
        noteLabel: 'Note (optional)',
        notePlaceholder: 'e.g. IDE settings snapshot',
        submitting: 'Saving…',
        submitBtn: 'Save Anchor',
        impliedTitle: '{pool} · {wt} Implied Budget',
        statusOk: 'High CI',
        statusLow: 'Low CI',
        statusCal: 'Calibrating',
        statusNewCycle: 'New Cycle',
        calDesc: 'Observed Δu = {du}% ({seg} segs), cycle spend {usd}; log more usage to complete budget inversion.',
        effDelta: 'Effective Δu: {du}% ({seg} segs) · Calib {usd}',
        impliedRem: 'Implied left: {usd}',
        ciOpenHigh: '[{low}, ∞)',
        mixedWarn: '⚠ High multi-model variance detected in this pool; implied budget is approximate.',
        historyTitle: 'Anchor History ({n})',
        currentHistoryTitle: 'Current 7d Cycle Anchors ({n})',
        noCurrentAnchors: 'No anchors logged in the current 7d cycle yet.',
        poolCycleNoReset: 'No reset time set (add one to bound cycle)',
        poolCycleEmptyNew: 'No snapshots in new cycle yet ({usd} spent)',
        poolCycleEmptyIdle: 'New cycle has not started yet',
        showOlderCycles: 'Show Older Cycles & Other Records ({m})',
        hideOlderCycles: 'Hide Older Cycles & Other Records ({m})',
        olderGroup7d: 'Older 7d Cycles',
        olderGroup5h: '5h Window Records',
        cycleGroupMeta: 'Spent {usd}',
        cycleGroupEst: 'Est. ~{usd}',
        precision: 'Step {step}%',
        resetAt: 'Reset {time}',
        resetInheritedTag: 'inherited',
        editResetBtn: 'Reset',
        editResetSave: 'Save',
        editResetClear: 'Clear',
        editResetCancel: 'Cancel',
        editResetPlaceholder: 'e.g. 6d 23h or 11-28 10:30',
        invalidPct: 'Enter a valid percentage between 0 and 100 (up to 2 decimals, e.g. 94.25)',
        recordFailed: 'Failed to save anchor: {msg}',
        updateFailed: 'Failed to update anchor: {msg}',
        deleteFailed: 'Failed to delete anchor: {msg}',
        subsetBase: 'Base',
        subsetM: 'Models (M)',
        subsetC: 'Cache (C)',
        subsetO: 'Output (O)',
        subsetMC: 'M+C',
        subsetMO: 'M+O',
        subsetCO: 'C+O',
        subsetMCO: 'All (M+C+O)',
        factorM: 'Models (M)',
        factorC: 'Cache (C)',
        factorO: 'Output (O)',
        calibBadgeHelp: 'Orthogonal 3-factor calibration: Models (M), Cache (C), and Output (O) use two-tier gates (manual exploration vs strict auto adoption).\nAuto evaluates auto-eligible subsets using LOOCV-MAE and overdispersion-scaled χ²; all 95% CIs use unified residual dispersion and full Delta-Method covariance.',
        mixEqHint: 'Current-mix eq.',
        clamped: 'clamped',
        exploratoryBadge: 'Exploratory',
        exploratoryTip: 'Manual exploratory fit (below auto threshold: {reason}). Wider parameter variance; treat as directional only.',
        stripBase: 'Base',
        stripCache: 'Cache',
        stripOutput: 'Output',
        maeStrip: 'MAE ±{mae}pp',
        labTitle: 'Weight Calibration Lab',
        labSummary: 'Rec {rec} · {n} segs',
        modeAuto: 'Auto',
        modeAutoHelp: 'Evaluates strictly auto-eligible subsets via LOOCV-MAE & overdispersion-scaled χ² to pick the optimal model.',
        modeManual: 'Manual {mode}',
        allFactorsUnlocked: 'All 3 orthogonal factors are eligible.',
        exploreOnlyHint: 'Manual explore only (below auto gate): {list}',
        manualFallbackHint: 'Subset {subset} is ineligible ({reason}); showing {fallback}.',
        subsetIneligible: 'insufficient segments or collinearity',
        reasonNeedAnchors: 'Need at least 2 anchors with positive quota delta',
        reasonMSingleModel: 'Only 1 active model in cycle',
        reasonMLowShare: 'Need >=2 models with >={minPct}% cycle spend share',
        reasonMLowStd: 'Model mix variation across segments too low (std {std} < {minStd})',
        reasonMNeedSegs: 'Need {need} more smoothed segments with varied model mix ({cur}/{req})',
        reasonMAutoShareOrSegs: 'Secondary model share {sharePct}% < 10% (auto needs >=10% or >=6 segments)',
        reasonCLowStd: 'Cache-read share variation too low (std {std} < {minStd})',
        reasonCNeedSegs: 'Need {need} more smoothed segments with varied cache-read share ({cur}/{req})',
        reasonOLowStd: 'Output share variation too low (std {std} < {minStd})',
        reasonONeedSegs: 'Need {need} more smoothed segments with varied output share ({cur}/{req})',
        reasonSubsetNeedSegs: 'Need {need} more smoothed segments for {subset} ({cur}/{req})',
        reasonSubsetCollinear: 'Collinear {subset} dimensions rejected (VIF {vif} >= {maxVif})',
        reasonSubsetLowEffDf: 'Prior-dominated {subset} fit (data share {effDf} < {minEffDf})',
        promoIntro: '{pct}% intro through {date}',
        smoothSegSummary: '{anchors} anchors → {segs} smoothed segs ({merged} merged)',
        smoothHuberTag: 'Huber downweighted {n}',
        smoothTipInfo: 'Conservative smoothing merges tiny settlement-lag & micro-rebound intervals while conserving total spend & Δu; Huber IRLS downweights lag outliers.',
        baseAnchorLabel: '1.00× Base Anchor',
        anchorSrcDefault: 'Default',
        anchorSrcUser: 'Custom',
        anchorSrcFallback: 'Fallback',
        anchorPoolQ: 'Anchor Q: ~{usd}',
        anchorPoolQHelp: 'Anchor Q is the cycle budget measured in 1.00× Base Anchor API USD. The card headline shows your current-mix equivalent API budget so switching factor subsets stays smooth.',
        paramBase: 'Base 1.00×',
        paramFitted: 'Fitted',
        paramDefault: 'Default 1.00×',
        paramCacheName: 'Cache Read (α_cache)',
        paramOutName: 'Output / Thinking (α_out)',
        interpBase: 'Reference 1.00× API price scale for this quota pool.',
        interpModelEff: 'Consumes ~{v}× quota per API $ vs base (more efficient).',
        interpModelHeavy: 'Consumes ~{v}× quota per API $ vs base (heavier drain).',
        interpModelNeutral: 'Drains at nearly 1:1 rate vs base (~{v}×).',
        interpModelUnfit: 'Uses 1.00× API list ratio (enable M to fit).',
        interpCacheCheap: 'Spend-weighted pool avg: cache reads drain {v}× their API price (extra savings).',
        interpCacheExpensive: 'Spend-weighted pool avg: cache reads drain {v}× their API price (smaller discount).',
        interpCacheNeutral: 'Spend-weighted pool avg: cache read discount aligns with API pricing (~{v}×).',
        interpCacheUnfit: 'Follows public API cache discount (enable C to fit pool average).',
        interpOutExpensive: 'Spend-weighted pool avg: output / thinking weight is {v}× its API price (costlier).',
        interpOutCheap: 'Spend-weighted pool avg: output / thinking weight is {v}× its API price (cheaper).',
        interpOutNeutral: 'Spend-weighted pool avg: output-to-input weight aligns with API pricing (~{v}×).',
        interpOutUnfit: 'Follows public API output ratio (enable O to fit pool average).',
        trialNotAdopted: 'Not adopted · Trial {val}{clamped} ({reason})',
        trialReasonWorse: 'LOOCV ±{trial}pp worse than base ±{base}pp',
        trialReasonMarginal: 'LOOCV ±{trial}pp <15% gain vs base ±{base}pp',
        trialReasonChi2: 'Overdispersed χ² gain below threshold',
        promoNoteFollow: 'Note: Current segments have not crossed a price transition; promo pass-through is unidentifiable and assumed to follow the API promo price.',
        promoNoteList: 'Note: Current segments have not crossed a price transition; currently assumed to follow standard list price.',
        residualTitle: 'Observed vs Predicted Residuals (pp)',
        residualNoData: 'Not enough segment fits in current cycle.',
        residualSummary: '{l0} ±{mae0}pp → {cur} ±{mae1}pp ({metric})',
        residualBaseOnly: '{base} ±{mae0}pp ({metric})',
        legendObs: 'Observed',
        legendBase: 'Base Pred',
        legendCur: '{lvl} Pred',
        legendHuber: 'Huber downweighted',
        segTipTitle: 'Segment #{idx} · Spend {usd}',
        segTipObs: 'Observed: {v}pp',
        segTipBase: 'Base Pred: {v}pp (err {err}pp)',
        segTipCur: '{lvl} Pred: {v}pp (err {err}pp)',
        segTipMerged: 'Merged {n} raw intervals',
        segTipDownweighted: 'Huber downweighted (lag outlier)'
      },
      settings: {
        title: 'Settings',
        closeTitle: 'Close settings',
        langSection: 'Language',
        langDesc: 'Switch UI language immediately (?lang=en overrides without saving)',
        generalSection: 'Refresh & Polling',
        autoRefreshName: 'Auto-Refresh Interval',
        autoRefreshDesc: 'Polls only while pane is visible; pauses automatically in background',
        autoRefreshHelp: 'Controls automatic polling frequency while the side pane is visible.\nWhen hidden or minimized, polling pauses completely for zero idle overhead.',
        modulesSection: 'Modules & Order',
        moveUp: 'Move up',
        moveDown: 'Move down',
        toggleModuleTitle: 'Enable or disable this module',
        sourcesSection: 'Data Sources & Local Index',
        sourcesHelp: 'All conversation databases are opened strictly read-only (mode=ro) and never modified or uploaded.\nEnabled sources are aggregated into the local SQLite index for analytics modules.',
        desktopName: 'Antigravity Desktop',
        desktopDesc: 'Read-only scan of conversations/*.db ({n} DBs)',
        cliName: 'Antigravity CLI',
        cliDesc: 'Read-only scan of antigravity-cli/conversations/*.db ({n} DBs)',
        indexedTurns: 'Indexed turns: {n}',
        lastIndexed: 'Last indexed: {time}',
        rebuildHint: 'Rebuilding clears only the telemetry cache; quota anchors are preserved.',
        rebuilding: 'Rebuilding…',
        rebuildBtn: 'Rebuild Index',
        rebuildDone: 'Rebuild done: {dbs} DBs scanned in {ms}ms',
        rebuildFail: 'Rebuild failed: {msg}',
        pricingSection: 'Pricing Management',
        promoBadge: 'Promo',
        defaultAnchorsNote: 'Default 1.00× Anchors: {list}',
        defaultsPath: 'Offline defaults (pricing_defaults.json)',
        builtinDefaults: 'Built-in defaults',
        overridesPath: 'User overrides (pricing_overrides.json)',
        autoSyncName: 'Auto-Sync Remote Pricing',
        autoSyncDesc: 'Updates reference rates every 24h from LiteLLM / OpenRouter',
        autoSyncHelp: 'When enabled, refreshes public reference API prices every 24h from LiteLLM / OpenRouter JSON.\nWhen disabled, runs 100% offline using built-in defaults and local overrides.',
        lastSynced: 'Last sync: {time}',
        neverSynced: 'Never synced',
        syncing: 'Syncing…',
        syncBtn: 'Sync Pricing Now',
        syncOk: 'Synced successfully ({n} models matched)',
        syncOkFiltered: 'Synced: scanned {total} remote entries, kept {n} relevant models',
        syncErr: 'Sync warning: {msg}',
        syncFail: 'Sync failed: {msg}',
        collapsePricing: 'Hide Model Pricing & Overrides',
        expandPricing: 'Show Model Pricing & Custom Overrides',
        loadingPricing: 'Loading pricing table…',
        restoreDefault: 'Reset',
        saveOverride: 'Save Override',
        restoreFail: 'Reset failed: {msg}',
        saveFail: 'Save override failed: {msg}',
        thThreshold: 'Long-Context Threshold',
        thThresholdPlaceholder: 'Empty = none',
        thInAbove: 'Above-Thresh Input ($/1M)',
        thOutAbove: 'Above-Thresh Output ($/1M)',
        thCacheAbove: 'Above-Thresh Cache Read ($/1M)'
      },
      update: {
        sectionTitle: 'Version & Auto-Update',
        pillLabel: '↑ v{ver}',
        pillTitle: 'Update v{ver} available — click for details',
        popTitle: 'Update Available',
        upToDate: 'Up to date',
        installGit: 'Git Install',
        installTarball: 'Standalone',
        installBuiltin: 'Built-in',
        modeLabel: 'Update Policy',
        modeHelp: 'Auto: Checks GitHub Releases every 6h, downloads & smoke-tests in the background, and applies on click or next restart.\nNotify: Shows update badge only; downloads when you click Update.\nOff: 100% offline, never checks for updates.',
        manualOnlyBadge: 'Optional',
        manualOnlyNote: 'Marked by the maintainer as an optional minor release (auto-push skipped). Click Update anytime to install manually.',
        modeAuto: 'Auto',
        modeNotify: 'Notify',
        modeOff: 'Off',
        checkBtn: 'Check Now',
        checking: 'Checking…',
        applyBtn: 'Update & Restart',
        restartBtn: 'Restart to Apply v{ver}',
        applying: 'Preparing update…',
        rollbackBtn: 'Rollback to v{ver}',
        rollingBack: 'Rolling back…',
        skipBtn: 'Skip Version',
        viewGithub: 'View on GitHub',
        copyCmd: 'Copy Update Cmd',
        stagedReady: 'Verified & smoke-tested — restart now to apply, or it will apply automatically next launch.',
        staging: 'Downloading & verifying update package…',
        hostRestartNote: 'This release updates sidecar.json; restart Antigravity after applying for full effect.',
        restartingBanner: 'Applying v{ver} and restarting AGY Lens…',
        rollingBackBanner: 'Rolling back to v{ver} and restarting…',
        reopenFallback: 'Update ready (v{ver}) — close and reopen the AGY Lens panel to finish reloading.',
        justUpdatedBanner: 'Updated to v{to} (from v{from})',
        mismatchBanner: 'Disk plugin updated to v{disk} — reload panel to sync versions.',
        reloadBtn: 'Reload',
        ackBtn: 'Got it',
        lastChecked: 'Last checked: {time}',
        neverChecked: 'Never checked',
        failedWarn: 'Previous attempt to upgrade to v{ver} failed and was safely rolled back.',
        noNotes: 'No release notes summary available. View full changelog on GitHub.',
        blocked: {
          dirty_git: 'Local Git working tree has uncommitted changes; auto-overwrite skipped to protect your edits.',
          non_main_branch: 'Repository is not on main branch; auto-update skipped.',
          custom_remote: 'Origin remote does not match upstream repo; auto-update skipped.',
          git_unavailable: 'git executable not found in PATH; cannot auto-update Git clone.',
          git_locked: 'Active .git/index.lock detected; retry later.',
          not_writable: 'Plugin directory is not writable.',
          builtin_plugin: 'Built-in plugins are managed by Antigravity.',
          standalone_cli: 'Running in Standalone Web / CLI mode. Update via git pull or npm, then restart the server.',
          git_error: 'Unable to inspect Git repository state.'
        }
      }
    }
  };

  function getLang() {
    if (state.query.lang) return state.query.lang;
    const cfgLang = normalizeLang(state.config.lang);
    return cfgLang || 'zh-CN';
  }

  function t(path, vars) {
    const lang = getLang();
    const parts = path.split('.');
    let cur = I18N[lang];
    for (const p of parts) {
      if (cur && typeof cur === 'object' && p in cur) cur = cur[p];
      else {
        cur = null;
        break;
      }
    }
    if (cur == null && lang !== 'zh-CN') {
      cur = I18N['zh-CN'];
      for (const p of parts) {
        if (cur && typeof cur === 'object' && p in cur) cur = cur[p];
        else {
          cur = path;
          break;
        }
      }
    }
    if (typeof cur === 'function') return cur(vars);
    let str = String(cur ?? path);
    if (vars && typeof vars === 'object') {
      for (const [k, v] of Object.entries(vars)) {
        str = str.replaceAll(`{${k}}`, String(v ?? ''));
      }
    }
    return str;
  }

  // =========================================================================
  // 5. Formatting, Escaping & Defensive Utilities
  // =========================================================================
  function esc(val) {
    return String(val ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function helpTip(tipText) {
    return `<button type="button" class="help-tip" data-tip="${esc(tipText)}" data-stop-card aria-label="${esc(t('common.help'))}">?</button>`;
  }

  function num(val, fallback = 0) {
    const n = Number(val);
    return Number.isFinite(n) ? n : fallback;
  }

  function clamp(val, min, max) {
    return Math.min(max, Math.max(min, val));
  }

  function fmtTokens(n) {
    const v = num(n, 0);
    if (v >= 1e9) return `${(v / 1e9).toFixed(2)}B`;
    if (v >= 1e6) return `${(v / 1e6).toFixed(2)}M`;
    if (v >= 1e3) return `${(v / 1e3).toFixed(v >= 1e5 ? 0 : 1)}k`;
    return `${Math.round(v)}`;
  }

  function fmtUsd(n, digits = 2) {
    const v = num(n, 0);
    if (v > 0 && v < 0.01 && digits === 2) return `$${v.toFixed(4)}`;
    return `$${v.toFixed(digits)}`;
  }

  function fmtPct(ratio, digits = 1) {
    return `${(clamp(num(ratio, 0), 0, 1) * 100).toFixed(digits)}%`;
  }

  function fmtPctDirect(pct, precisionStep) {
    const v = clamp(num(pct, 0), 0, 100);
    if (precisionStep != null && precisionStep <= 0.01) return `${v.toFixed(2)}%`;
    if (precisionStep != null && precisionStep <= 0.1) return `${v.toFixed(1)}%`;
    if (Math.abs(v - Math.round(v)) > 0.001) return `${v.toFixed(2)}%`;
    return `${Math.round(v)}%`;
  }

  function fmtDurationMs(ms) {
    if (ms == null) return '—';
    const v = num(ms, -1);
    if (v < 0) return '—';
    if (v === 0) return '0ms';
    if (v < 1000) return `${Math.round(v)}ms`;
    if (v < 60000) return `${(v / 1000).toFixed(v >= 10000 ? 1 : 2)}s`;
    const mins = Math.floor(v / 60000);
    if (mins < 60) {
      const remS = Math.round((v % 60000) / 1000);
      return remS > 0 && mins < 10 ? `${mins}m${remS}s` : `${mins}m`;
    }
    const hrs = Math.floor(mins / 60);
    const remM = mins % 60;
    return `${hrs}h${remM ? remM + 'm' : ''}`;
  }

  function fmtRelTime(tsMs) {
    if (!tsMs) return '—';
    const diff = Math.max(0, Date.now() - num(tsMs, 0));
    const sec = Math.floor(diff / 1000);
    if (sec < 5) return t('common.justNow');
    if (sec < 60) return t('common.secAgo', { n: sec });
    const min = Math.floor(sec / 60);
    if (min < 60) return t('common.minAgo', { n: min });
    const hr = Math.floor(min / 60);
    if (hr < 24) return t('common.hrAgo', { n: hr });
    const day = Math.floor(hr / 24);
    return t('common.dayAgo', { n: day });
  }

  function fmtTimeShort(tsMs) {
    if (!tsMs) return '—';
    const d = new Date(num(tsMs));
    if (Number.isNaN(d.getTime())) return '—';
    const pad = (x) => String(x).padStart(2, '0');
    return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  function fmtResetClock(tsMs) {
    if (!tsMs) return '—';
    const d = new Date(num(tsMs));
    if (Number.isNaN(d.getTime())) return '—';
    const now = new Date();
    const pad = (x) => String(x).padStart(2, '0');
    const hhmm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
    if (
      d.getFullYear() === now.getFullYear() &&
      d.getMonth() === now.getMonth() &&
      d.getDate() === now.getDate()
    ) {
      return hhmm;
    }
    return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${hhmm}`;
  }

  function getInheritableResetAt(pool, windowType) {
    const summaries = Array.isArray(state.quotaData?.summaries) ? state.quotaData.summaries : [];
    const match = summaries.find((s) => s.pool === pool && s.windowType === windowType);
    if (!match) return null;
    const candidate = match.inheritableResetAt ?? match.latestAnchor?.resetAt ?? match.latestAnchor?.reset_at ?? null;
    if (candidate != null && Number.isFinite(Number(candidate)) && Number(candidate) > Date.now()) {
      return Number(candidate);
    }
    return null;
  }

  function fmtLocalDateStr(d) {
    const pad = (x) => String(x).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }

  function baseName(p) {
    if (!p) return t('common.unknownWorkspace');
    const clean = String(p).replace(/^file:\/\//, '').replace(/\/+$/, '');
    const parts = clean.split('/').filter(Boolean);
    return parts.length ? parts[parts.length - 1] : clean;
  }

  function poolLabel(pool) {
    if (pool === 'gemini') return 'Gemini';
    if (pool === 'argon') return 'Argon';
    if (pool === '3p') return 'Third-Party';
    return pool || t('common.unknownPool');
  }

  function sourceLabel(src) {
    if (src === 'desktop') return t('source.desktop');
    if (src === 'cli') return t('source.cli');
    return src || t('common.unknown');
  }

  function pricingSourceLabel(src) {
    if (src === 'default' || src === 'remote' || src === 'override' || src === 'unpriced') {
      return t(`pricingSrc.${src}`);
    }
    return src || t('pricingSrc.default');
  }

  function shortModelName(canonicalId) {
    const id = String(canonicalId || '').trim();
    const map = {
      'gemini-4-neon': 'Neon',
      'gemini-4-hydrogen': 'Hydrogen',
      'gemini-4-carbon': 'Carbon',
      'gemini-4-argon': 'Argon',
      'gemini-3.8-flash': '3.8 Flash',
      'gemini-3.5-flash-lite': '3.5 Lite',
      'claude-opus-5-5': 'Opus 5.5',
      'claude-sonnet-5-5': 'Sonnet 5.5',
      'gpt-oss-120b': 'GPT-OSS'
    };
    if (map[id]) return map[id];
    return id.replace(/^(?:gemini|claude)-/, '');
  }

  function factorsToSubsetKey(factors) {
    const parts = [];
    if (factors?.M) parts.push('M');
    if (factors?.C) parts.push('C');
    if (factors?.O) parts.push('O');
    return parts.length ? parts.join('+') : 'base';
  }

  function subsetKeyToFactors(key) {
    const parts = new Set(String(key || 'base').split('+'));
    return {
      M: parts.has('M'),
      C: parts.has('C'),
      O: parts.has('O')
    };
  }

  function calibSubsetLabel(subsetKey) {
    const map = {
      base: 'quota.subsetBase',
      M: 'quota.subsetM',
      C: 'quota.subsetC',
      O: 'quota.subsetO',
      'M+C': 'quota.subsetMC',
      'M+O': 'quota.subsetMO',
      'C+O': 'quota.subsetCO',
      'M+C+O': 'quota.subsetMCO'
    };
    return t(map[subsetKey] || 'quota.subsetBase');
  }

  function calibSubsetShort(subsetKey) {
    return !subsetKey || subsetKey === 'base' ? t('quota.subsetBase') : String(subsetKey);
  }

  function fmtMultWithSe(p) {
    const v = num(p?.value, 1).toFixed(2);
    if (p?.se != null && Number.isFinite(Number(p.se))) {
      return `${v}±${num(p.se).toFixed(2)}×`;
    }
    return `${v}×`;
  }

  function getFormCapturedAtMs(f = state.quotaForm) {
    if (f?.captureOffsetMin === 'custom' && f?.customCaptureAt) {
      const ts = Date.parse(f.customCaptureAt);
      if (!Number.isNaN(ts)) return Math.round(ts);
    } else if (typeof f?.captureOffsetMin === 'number' && f.captureOffsetMin < 0) {
      return Math.round(Date.now() + f.captureOffsetMin * 60000);
    }
    return Date.now();
  }

  function parseResetInput(raw, baseCapturedAt = Date.now(), windowType = '7d') {
    const text = String(raw || '').trim();
    if (!text) return { ok: true, ts: null, precisionMs: null, resetLo: null, resetHi: null, preview: '' };

    const DAY_MS = 86400 * 1000;
    const HOUR_MS = 3600 * 1000;
    const REL_MIN_MS = 5 * 60 * 1000;
    const MIN_MS = 60 * 1000;
    const SEC_MS = 1000;

    const baseMs = Number.isFinite(Number(baseCapturedAt)) ? Number(baseCapturedAt) : Date.now();
    const wt = windowType === '5h' ? '5h' : '7d';
    const winMs = wt === '5h' ? 5 * HOUR_MS : 7 * DAY_MS;
    const valTol = wt === '5h' ? 30 * MIN_MS : 90 * MIN_MS;

    function computeBounds(roundedTs, precisionMs) {
      if (precisionMs >= DAY_MS) return { lo: roundedTs - 12 * HOUR_MS, hi: roundedTs + 24 * HOUR_MS };
      if (precisionMs >= HOUR_MS) return { lo: roundedTs - 30 * MIN_MS, hi: roundedTs + 60 * MIN_MS };
      if (precisionMs >= REL_MIN_MS) return { lo: roundedTs - 5 * MIN_MS, hi: roundedTs + 5 * MIN_MS };
      if (precisionMs >= MIN_MS) return { lo: roundedTs - 90 * SEC_MS, hi: roundedTs + 90 * SEC_MS };
      return { lo: roundedTs - 5 * SEC_MS, hi: roundedTs + 5 * SEC_MS };
    }

    function finalize(ts, precisionMs) {
      const roundedTs = Math.round(ts);
      const effectiveTol = precisionMs >= DAY_MS && wt === '7d' ? 12 * HOUR_MS : valTol;
      const bounds = computeBounds(roundedTs, precisionMs);
      if (roundedTs < baseMs - effectiveTol || roundedTs > baseMs + winMs + effectiveTol) {
        return {
          ok: false,
          ts: roundedTs,
          precisionMs,
          resetLo: bounds.lo,
          resetHi: bounds.hi,
          preview: t('quota.resetOutOfWindow', { wt }),
        };
      }
      const cycleStart = roundedTs - winMs;
      const precTag =
        precisionMs >= DAY_MS
          ? ' (±1d)'
          : precisionMs >= HOUR_MS
            ? t('quota.resetPrecHour')
            : '';
      return {
        ok: true,
        ts: roundedTs,
        precisionMs,
        resetLo: bounds.lo,
        resetHi: bounds.hi,
        cycleStart,
        preview: t('quota.resetPreviewCycle', {
          time: fmtTimeShort(roundedTs),
          prec: precTag,
          start: fmtTimeShort(cycleStart),
          end: fmtTimeShort(roundedTs),
        }),
      };
    }

    const stripped = text.replace(/^(?:in|after|还有|约)\s*/i, '').trim();

    // Relative duration (English & Chinese): e.g. "5d", "6d 23h", "5天3小时", "3h20m", "45m"
    const durRe =
      /^(?:(\d+(?:\.\d+)?)\s*(?:d(?:ays?)?|天|日))?\s*(?:(\d+(?:\.\d+)?)\s*(?:h(?:rs?|ours?)?|小时|时))?\s*(?:(\d+(?:\.\d+)?)\s*(?:m(?:ins?|inutes?)?|分钟|分))?\s*(?:(\d+(?:\.\d+)?)\s*(?:s(?:ecs?|econds?)?|秒))?$/i;
    const m = stripped.match(durRe);
    if (m && (m[1] || m[2] || m[3] || m[4])) {
      const ms =
        (num(m[1], 0) * 86400 +
          num(m[2], 0) * 3600 +
          num(m[3], 0) * 60 +
          num(m[4], 0)) *
        1000;
      if (ms > 0) {
        // Day-only -> DAY_MS; hour-only -> HOUR_MS; relative minute -> REL_MIN_MS (5m jitter band); second -> SEC_MS
        const precisionMs = m[4]
          ? SEC_MS
          : m[3]
            ? REL_MIN_MS
            : m[2]
              ? HOUR_MS
              : DAY_MS;
        return finalize(baseMs + ms, precisionMs);
      }
    }

    // Local HH:MM anchored to baseCapturedAt
    const hm = stripped.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
    if (hm) {
      const hh = Number(hm[1]);
      const mm = Number(hm[2]);
      const ss = hm[3] ? Number(hm[3]) : 0;
      if (hh >= 0 && hh <= 23 && mm >= 0 && mm <= 59 && ss >= 0 && ss <= 59) {
        const d = new Date(baseMs);
        d.setHours(hh, mm, ss, 0);
        if (d.getTime() <= baseMs) d.setDate(d.getDate() + 1);
        return finalize(d.getTime(), hm[3] ? SEC_MS : MIN_MS);
      }
    }

    // Local MM-DD HH:MM or MM/DD HH:MM with year-rollover inference against [baseMs, baseMs + winMs]
    const mdhm = stripped.match(/^(\d{1,2})[-/](\d{1,2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?$/);
    if (mdhm) {
      const mo = Number(mdhm[1]);
      const day = Number(mdhm[2]);
      const hh = Number(mdhm[3]);
      const mm = Number(mdhm[4]);
      const ss = mdhm[5] ? Number(mdhm[5]) : 0;
      if (mo >= 1 && mo <= 12 && day >= 1 && day <= 31 && hh <= 23 && mm <= 59 && ss <= 59) {
        const baseYear = new Date(baseMs).getFullYear();
        const years = [baseYear, baseYear + 1, baseYear - 1];
        let chosen = null;
        let fallbackFuture = null;
        for (const yr of years) {
          const d = new Date(yr, mo - 1, day, hh, mm, ss, 0);
          if (d.getMonth() !== mo - 1 || d.getDate() !== day) continue;
          const ts = d.getTime();
          if (ts >= baseMs - valTol && ts <= baseMs + winMs + valTol) {
            chosen = ts;
            break;
          }
          if (ts >= baseMs && (fallbackFuture === null || ts < fallbackFuture)) {
            fallbackFuture = ts;
          }
        }
        const finalTs = chosen ?? fallbackFuture ?? new Date(baseYear, mo - 1, day, hh, mm, ss, 0).getTime();
        return finalize(finalTs, mdhm[5] ? SEC_MS : MIN_MS);
      }
    }

    // Local YYYY-MM-DD HH:MM(:SS)
    const ymdhm = stripped.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?$/);
    if (ymdhm) {
      const yr = Number(ymdhm[1]);
      const mo = Number(ymdhm[2]);
      const day = Number(ymdhm[3]);
      const hh = Number(ymdhm[4]);
      const mm = Number(ymdhm[5]);
      const ss = ymdhm[6] ? Number(ymdhm[6]) : 0;
      if (mo >= 1 && mo <= 12 && day >= 1 && day <= 31 && hh <= 23 && mm <= 59 && ss <= 59) {
        const d = new Date(yr, mo - 1, day, hh, mm, ss, 0);
        if (d.getMonth() === mo - 1 && d.getDate() === day) {
          return finalize(d.getTime(), ymdhm[6] ? SEC_MS : MIN_MS);
        }
      }
    }

    // Only delegate explicit full date-time strings (ISO-8601 with time or RFC2822 with month name) to Date.parse
    // so bare numbers like "12" or date-only "2026-11-28" don't silently parse as year 2001 or UTC midnight (M5).
    const looksLikeFullDateTime =
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(stripped) ||
      /(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec).*\d{1,2}:\d{2}/i.test(stripped);
    if (looksLikeFullDateTime) {
      const parsed = Date.parse(stripped);
      if (!Number.isNaN(parsed)) {
        return finalize(parsed, SEC_MS);
      }
    }

    return { ok: false, ts: null, precisionMs: null, resetLo: null, resetHi: null, preview: t('quota.resetBad') };
  }

  // =========================================================================
  // 6. Default Config & Application State
  // =========================================================================
  const OBS_MATRIX_METRIC_IDS = ['weightedHit', 'keepRate', 'avgCost', 'totalCost', 'missPenalty', 'turns'];
  const DEFAULT_OBS_GAP_BREAKPOINTS = [10, 60, 300, 600, 3600];
  const OBS_GAP_PRESETS = [2, 5, 10, 20, 60, 300, 600, 900, 1800, 3600, 7200, 21600];

  const DEFAULT_CONFIG = {
    lang: 'zh-CN',
    modules: {
      'live-context': true,
      'cache-diagnostics': true,
      'io-flow': true,
      'model-cost': true,
      'calendar-trends': true,
      'cache-observatory': true,
      'quota-budget': true
    },
    moduleOrder: [...ALL_MODULE_IDS],
    expanded: {
      'live-context': true,
      'cache-diagnostics': false,
      'io-flow': false,
      'model-cost': false,
      'calendar-trends': false,
      'cache-observatory': false,
      'quota-budget': false
    },
    sources: { desktop: true, cli: true },
    refreshSec: 30,
    pricingAutoSync: false,
    quotaDisplayMode: 'remaining',
    defaultRange: '7d',
    quotaAnchorsByPool: {},
    quotaCalibMode: 'auto',
    quotaManualFactors: { M: false, C: false, O: false },
    obsMatrixPrimary: 'weightedHit',
    obsMatrixSubMetrics: ['keepRate', 'avgCost'],
    obsGapBreakpointsSec: [...DEFAULT_OBS_GAP_BREAKPOINTS],
    updateMode: 'auto',
    dismissedUpdateVersion: ''
  };

  const state = {
    booted: false,
    query: parseQueryOverrides(),
    localExpandedOverrides: new Map(), // temporary per-session expand override when ?expand is set
    config: structuredClone(DEFAULT_CONFIG),
    runningVersion: '',
    runtime: {
      mode: window.__AGY_LENS_STANDALONE__ ? 'standalone' : 'sidecar',
      readOnly: false,
      basePath: '/',
    },
    selectedConversationId: '',
    recentSessions: [],
    paths: {},
    pricingStatus: {},
    indexStatus: {},

    update: {
      data: null,
      lastFetchedAt: 0,
      popoverOpen: false,
      checking: false,
      applying: false,
      rollingBack: false,
      restartMsg: '',
      restartFallback: false,
      copyStatus: ''
    },

    rangeKey: '7d',
    customFrom: '',
    customTo: '',

    ioScope: 'session', // 'session' | 'analytics'
    modelSort: 'cost', // 'cost' | 'turns' | 'tokens' | 'cache'
    modelView: 'models', // 'models' | 'workspaces'
    calMetric: 'cost', // 'cost' | 'tokens' | 'turns'
    widePane: window.matchMedia('(min-width: 680px)').matches,

    ctxOpenCategories: new Set(),
    selectedDay: null, // { date, loading, error, data }

    // Cache Observatory UI state
    obsModelFilter: 'all',
    obsAnomaliesOpen: false,
    obsMetricMenuOpen: false,
    obsGapMenuOpen: false,
    obsGapDraft: '',
    obsGapError: '',
    obsPinnedCell: null, // { modelIdx, bucketKey } | null
    obsCopyStatus: '', // '' | 'copied' | 'failed'
    obsCopyTimer: null,

    // Quota Calibration Lab & History UI state
    quotaLabOpenByKey: new Map(),
    quotaOlderOpen: false,
    quotaEditingAnchorId: null,
    quotaEditingResetInput: '',
    quotaEditingOriginalText: '',
    quotaEditingError: '',
    quotaEditingSaving: false,

    session: null,
    sessionError: null,
    analytics: null,
    analyticsError: null,
    quotaData: null,
    quotaError: null,

    quotaForm: {
      pool: 'gemini',
      windowType: '7d',
      remainingPct: '',
      resetInput: '',
      captureOffsetMin: 0, // 0 = now, -5, -15, or 'custom'
      customCaptureAt: '',
      note: '',
      submitting: false,
      error: ''
    },

    pricing: {
      expanded: false,
      loading: false,
      prefetching: false,
      data: null,
      error: '',
      syncing: false,
      syncMsg: '',
      editingId: null,
      draft: null
    },

    rebuilding: false,
    rebuildMsg: '',

    settingsOpen: false,
    refreshing: false,
    lastUpdatedAt: 0,
    globalError: '',
    refreshTimer: null,
    freshnessTimer: null,
    pinnedHelpEl: null
  };

  // =========================================================================
  // 7. DOM References & Logo Fallback
  // =========================================================================
  const $ = (id) => document.getElementById(id);
  const dom = {
    loadingShell: $('loading-shell'),
    app: $('app'),
    stickyHeader: $('sticky-header'),
    brandLogoImg: $('brand-logo-img'),
    brandLogoFallback: $('brand-logo-fallback'),
    appTitle: $('app-title'),
    freshness: $('freshness'),
    freshnessText: $('freshness-text'),
    btnUpdatePill: $('btn-update-pill'),
    readonlyPill: $('readonly-pill'),
    btnThemeToggle: $('btn-theme-toggle'),
    refreshSelectWrap: $('refresh-select-wrap'),
    refreshSelect: $('refresh-select'),
    btnRefresh: $('btn-refresh'),
    btnSettings: $('btn-settings'),
    rangeBar: $('range-bar'),
    rangePills: $('range-pills'),
    customRangeRow: $('custom-range-row'),
    customFrom: $('custom-from'),
    customTo: $('custom-to'),
    btnApplyCustom: $('btn-apply-custom'),
    sourcesBadge: $('sources-badge'),
    updateBanner: $('update-banner'),
    globalBanner: $('global-banner'),
    modulesGrid: $('modules-grid'),
    emptyModules: $('empty-modules'),
    emptyTitle: $('empty-title'),
    emptyDesc: $('empty-desc'),
    btnOpenSettingsEmpty: $('btn-open-settings-empty'),
    settingsBackdrop: $('settings-backdrop'),
    settingsDrawer: $('settings-drawer'),
    settingsTitle: $('settings-title'),
    btnCloseSettings: $('btn-close-settings'),
    settingsBody: $('settings-body'),
    chartTooltip: $('chart-tooltip'),
    obsCellPopover: $('obs-cell-popover'),
    updatePopover: $('update-popover')
  };

  // Self-heal update DOM anchors in case an older cached index.html was loaded.
  if (!dom.btnUpdatePill) {
    const brand = document.querySelector('.brand');
    if (brand) {
      const btn = document.createElement('button');
      btn.id = 'btn-update-pill';
      btn.type = 'button';
      btn.className = 'update-pill hidden';
      btn.setAttribute('aria-haspopup', 'dialog');
      btn.setAttribute('aria-expanded', 'false');
      brand.appendChild(btn);
      dom.btnUpdatePill = btn;
    }
  }
  if (!dom.updateBanner) {
    const main = $('main-content');
    if (main) {
      const div = document.createElement('div');
      div.id = 'update-banner';
      div.className = 'banner update-banner hidden';
      div.setAttribute('role', 'status');
      main.prepend(div);
      dom.updateBanner = div;
    }
  }
  if (!dom.updatePopover) {
    const div = document.createElement('div');
    div.id = 'update-popover';
    div.className = 'update-popover hidden';
    div.setAttribute('role', 'dialog');
    div.setAttribute('aria-label', 'Update details');
    document.body.appendChild(div);
    dom.updatePopover = div;
  }

  function setupLogoFallback() {
    const img = dom.brandLogoImg;
    const svg = dom.brandLogoFallback;
    if (!img || !svg) return;
    const showFallback = () => {
      img.classList.add('hidden');
      svg.classList.remove('hidden');
    };
    img.addEventListener('error', showFallback);
    if (img.complete && img.naturalWidth === 0) showFallback();
  }
  setupLogoFallback();

  // =========================================================================
  // 8. Effective View Helpers & Data Fetching
  // =========================================================================
  function isModuleActiveForView(id) {
    if (state.query.onlySet) return state.query.onlySet.has(id);
    return Boolean(state.config.modules[id]);
  }

  function isCardExpandedForView(id) {
    if (state.localExpandedOverrides.has(id)) {
      return state.localExpandedOverrides.get(id);
    }
    if (state.query.expandAll) return true;
    if (state.query.expandSet) return state.query.expandSet.has(id);
    return Boolean(state.config.expanded[id]);
  }

  function getActiveSourcesList() {
    const out = [];
    if (state.config.sources?.desktop) out.push('desktop');
    if (state.config.sources?.cli) out.push('cli');
    return out;
  }

  function hasAnyAnalyticsModule() {
    return Boolean(
      isModuleActiveForView('model-cost') ||
        isModuleActiveForView('calendar-trends') ||
        isModuleActiveForView('cache-observatory') ||
        (isModuleActiveForView('io-flow') && state.ioScope === 'analytics')
    );
  }

  function getNeededSessionModules() {
    const list = [];
    if (isModuleActiveForView('live-context')) list.push('live-context');
    if (isModuleActiveForView('cache-diagnostics')) list.push('cache-diagnostics');
    if (isModuleActiveForView('io-flow') && state.ioScope === 'session') list.push('io-flow');
    return list;
  }

  function getNeededAnalyticsModules() {
    const list = [];
    if (isModuleActiveForView('io-flow') && state.ioScope === 'analytics') list.push('io-flow');
    if (isModuleActiveForView('model-cost')) list.push('model-cost');
    if (isModuleActiveForView('calendar-trends')) list.push('calendar-trends');
    if (isModuleActiveForView('cache-observatory')) list.push('cache-observatory');
    return list;
  }

  function normalizeConfigPayload(res) {
    if (!res) return;
    const cfg = res.config || {};
    const rawMf = cfg.quotaManualFactors && typeof cfg.quotaManualFactors === 'object' ? cfg.quotaManualFactors : null;
    let quotaCalibMode = cfg.quotaCalibMode === 'manual' ? 'manual' : 'auto';
    let quotaManualFactors = {
      M: Boolean(rawMf?.M),
      C: Boolean(rawMf?.C),
      O: Boolean(rawMf?.O)
    };
    if (['L0', 'L1', 'L2', 'L3'].includes(cfg.quotaCalibMode)) {
      quotaCalibMode = 'manual';
      if (!rawMf) {
        quotaManualFactors = {
          M: cfg.quotaCalibMode === 'L1' || cfg.quotaCalibMode === 'L2' || cfg.quotaCalibMode === 'L3',
          C: cfg.quotaCalibMode === 'L2' || cfg.quotaCalibMode === 'L3',
          O: cfg.quotaCalibMode === 'L3'
        };
      }
    }
    const obsMatrixPrimary = OBS_MATRIX_METRIC_IDS.includes(cfg.obsMatrixPrimary)
      ? cfg.obsMatrixPrimary
      : DEFAULT_CONFIG.obsMatrixPrimary;
    const rawObsSubs = Array.isArray(cfg.obsMatrixSubMetrics)
      ? cfg.obsMatrixSubMetrics
      : DEFAULT_CONFIG.obsMatrixSubMetrics;
    const obsSubSet = new Set();
    for (const id of rawObsSubs) {
      if (OBS_MATRIX_METRIC_IDS.includes(id) && id !== obsMatrixPrimary) {
        obsSubSet.add(id);
      }
    }
    const obsMatrixSubMetrics = OBS_MATRIX_METRIC_IDS.filter((id) => obsSubSet.has(id));
    const rawGapBps = Array.isArray(cfg.obsGapBreakpointsSec)
      ? cfg.obsGapBreakpointsSec
      : DEFAULT_CONFIG.obsGapBreakpointsSec;
    const obsGapBreakpointsSec = sanitizeObsGapBreakpoints(rawGapBps);
    state.config = {
      ...DEFAULT_CONFIG,
      ...cfg,
      lang: normalizeLang(cfg.lang) || DEFAULT_CONFIG.lang,
      modules: { ...DEFAULT_CONFIG.modules, ...(cfg.modules || {}) },
      expanded: { ...DEFAULT_CONFIG.expanded, ...(cfg.expanded || {}) },
      sources: { ...DEFAULT_CONFIG.sources, ...(cfg.sources || {}) },
      quotaAnchorsByPool: {
        ...(cfg.quotaAnchorsByPool && typeof cfg.quotaAnchorsByPool === 'object' ? cfg.quotaAnchorsByPool : {})
      },
      quotaCalibMode,
      quotaManualFactors,
      obsMatrixPrimary,
      obsMatrixSubMetrics,
      obsGapBreakpointsSec,
      updateMode: ['auto', 'notify', 'off'].includes(cfg.updateMode) ? cfg.updateMode : DEFAULT_CONFIG.updateMode,
      dismissedUpdateVersion: typeof cfg.dismissedUpdateVersion === 'string' ? cfg.dismissedUpdateVersion : '',
      moduleOrder: Array.isArray(cfg.moduleOrder) && cfg.moduleOrder.length
        ? cfg.moduleOrder.filter((id) => ALL_MODULE_IDS.includes(id))
        : [...DEFAULT_CONFIG.moduleOrder]
    };
    for (const id of DEFAULT_CONFIG.moduleOrder) {
      if (!state.config.moduleOrder.includes(id)) state.config.moduleOrder.push(id);
    }
    if (typeof res.version === 'string' && res.version) {
      state.runningVersion = res.version;
    }
    if (res.runtime && typeof res.runtime === 'object') {
      state.runtime = {
        mode: res.runtime.mode === 'standalone' ? 'standalone' : 'sidecar',
        readOnly: Boolean(res.runtime.readOnly),
        basePath: typeof res.runtime.basePath === 'string' ? res.runtime.basePath : '/',
      };
    }
    state.paths = res.paths || {};
    state.pricingStatus = res.pricingStatus || {};
    state.indexStatus = res.indexStatus || {};
    if (dom.readonlyPill) {
      dom.readonlyPill.classList.toggle('hidden', !state.runtime.readOnly);
    }
    if (dom.btnThemeToggle) {
      dom.btnThemeToggle.classList.toggle('hidden', !isStandaloneMode() || typeof window.__AGY_LENS_SET_THEME__ !== 'function');
    }
  }

  async function saveConfigPatch(patch) {
    if (isReadOnlyMode()) {
      // Read-only mode: keep view-state changes in local memory without hitting POST /api/config.
      return true;
    }
    try {
      const res = await postJson('/api/config', patch);
      normalizeConfigPayload(res);
      return true;
    } catch (err) {
      state.globalError = t('header.configSaveErr', { msg: err.message });
      renderHeader();
      return false;
    }
  }

  async function refreshQuotaOnly() {
    try {
      state.quotaData = await getJson('/api/quota/anchors');
      state.quotaError = null;
    } catch (err) {
      state.quotaError = err.message;
    }
    renderGrid();
  }

  async function refreshAll(manual = false) {
    if (state.refreshing) return;
    if (!manual && document.visibilityState !== 'visible') return;

    state.refreshing = true;
    state.globalError = '';
    updateFreshnessUI();
    dom.btnRefresh.classList.add('spinning');

    try {
      const sessionMods = getNeededSessionModules();
      const analyticsMods = getNeededAnalyticsModules();
      const needQuota = isModuleActiveForView('quota-budget');
      const tasks = [];

      if (sessionMods.length > 0) {
        const cid = encodeURIComponent(resolveConversationId());
        const mods = encodeURIComponent(sessionMods.join(','));
        tasks.push(
          getJson(`/api/session?conversationId=${cid}&modules=${mods}`)
            .then((d) => {
              state.session = d;
              state.sessionError = null;
            })
            .catch((e) => {
              state.sessionError = e.message;
            })
        );
        if (isStandaloneMode()) {
          const srcs = encodeURIComponent(getActiveSourcesList().join(','));
          tasks.push(
            getJson(`/api/sessions/recent?limit=15&sources=${srcs}`)
              .then((d) => {
                if (Array.isArray(d?.sessions)) state.recentSessions = d.sessions;
              })
              .catch(() => {})
          );
        }
      }

      if (analyticsMods.length > 0) {
        const srcs = encodeURIComponent(getActiveSourcesList().join(','));
        const mods = encodeURIComponent(analyticsMods.join(','));
        let qs = `range=${encodeURIComponent(state.rangeKey)}&sources=${srcs}&modules=${mods}`;
        if (state.rangeKey === 'custom' && state.customFrom && state.customTo) {
          qs += `&from=${encodeURIComponent(state.customFrom)}&to=${encodeURIComponent(state.customTo)}`;
        }
        tasks.push(
          getJson(`/api/analytics?${qs}`)
            .then((d) => {
              state.analytics = d;
              state.analyticsError = null;
            })
            .catch((e) => {
              state.analyticsError = e.message;
            })
        );
      }

      if (needQuota) {
        tasks.push(
          getJson('/api/quota/anchors')
            .then((d) => {
              state.quotaData = d;
              state.quotaError = null;
            })
            .catch((e) => {
              state.quotaError = e.message;
            })
        );
      }

      if (isModuleActiveForView('model-cost') && !state.pricing.data && !state.pricing.prefetching) {
        state.pricing.prefetching = true;
        tasks.push(
          getJson('/api/pricing')
            .then((d) => {
              if (!state.pricing.data) state.pricing.data = d;
            })
            .catch(() => {})
            .finally(() => {
              state.pricing.prefetching = false;
            })
        );
      }

      if (manual || Date.now() - state.update.lastFetchedAt > 60000) {
        tasks.push(
          getJson('/api/update/status')
            .then((d) => {
              state.update.data = d;
              state.update.lastFetchedAt = Date.now();
            })
            .catch(() => {})
        );
      }

      await Promise.all(tasks);
      state.lastUpdatedAt = Date.now();
    } catch (err) {
      state.globalError = err.message || t('header.refreshFailed');
    } finally {
      state.refreshing = false;
      dom.btnRefresh.classList.remove('spinning');
      renderAll(!manual);
    }
  }

  function resetRefreshTimer() {
    if (state.refreshTimer) {
      clearInterval(state.refreshTimer);
      state.refreshTimer = null;
    }
    if (state.freshnessTimer) {
      clearInterval(state.freshnessTimer);
      state.freshnessTimer = null;
    }

    const sec = num(state.config.refreshSec, 30);
    if (document.visibilityState === 'visible') {
      if (sec > 0) {
        state.refreshTimer = setInterval(() => {
          if (document.visibilityState === 'visible') refreshAll(false);
        }, sec * 1000);
      }
      state.freshnessTimer = setInterval(updateFreshnessUI, 1000);
    }
    updateFreshnessUI();
  }

  function updateFreshnessUI() {
    const el = dom.freshness;
    const txt = dom.freshnessText;
    if (!el || !txt) return;
    el.classList.remove('paused', 'loading', 'error');

    if (state.refreshing) {
      el.classList.add('loading');
      txt.textContent = t('header.refreshing');
      return;
    }
    if (state.globalError) {
      el.classList.add('error');
      txt.textContent = t('header.error');
      return;
    }
    if (document.visibilityState !== 'visible') {
      el.classList.add('paused');
      txt.textContent = t('header.paused');
      return;
    }
    const sec = num(state.config.refreshSec, 30);
    if (sec === 0) {
      el.classList.add('paused');
      txt.textContent = state.lastUpdatedAt ? `${fmtRelTime(state.lastUpdatedAt)} · ${t('header.manual')}` : t('header.manual');
      return;
    }
    txt.textContent = state.lastUpdatedAt ? fmtRelTime(state.lastUpdatedAt) : t('header.pending');
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      resetRefreshTimer();
      refreshAll(false);
    } else {
      resetRefreshTimer();
    }
  });

  // =========================================================================
  // 9. Rendering: Static I18N & Header / Filter Bar
  // =========================================================================
  function applyStaticI18n() {
    const lang = getLang();
    if (document.documentElement.lang !== lang) {
      document.documentElement.lang = lang;
    }
    dom.appTitle.textContent = 'AGY Lens';
    dom.freshness.title = t('header.freshnessTitle');
    dom.refreshSelectWrap.title = t('header.refreshIntervalTitle');
    dom.refreshSelect.setAttribute('aria-label', t('header.refreshIntervalAria'));
    const offOpt = dom.refreshSelect.querySelector('option[value="0"]');
    if (offOpt) offOpt.textContent = t('header.off');
    dom.btnRefresh.title = t('header.refreshNow');
    dom.btnRefresh.setAttribute('aria-label', t('header.refreshNow'));
    dom.btnSettings.title = t('header.settingsTitle');
    dom.btnSettings.setAttribute('aria-label', t('header.settingsTitle'));
    if (dom.readonlyPill) {
      dom.readonlyPill.textContent = t('header.readonlyBadge');
      dom.readonlyPill.title = t('header.readonlyTitle');
    }
    if (dom.btnThemeToggle) {
      dom.btnThemeToggle.title = t('header.themeToggleTitle');
      dom.btnThemeToggle.setAttribute('aria-label', t('header.themeToggleTitle'));
    }
    if (dom.obsCellPopover) {
      dom.obsCellPopover.setAttribute('aria-label', t('header.matrixPopoverAria'));
    }
    if (dom.updatePopover) {
      dom.updatePopover.setAttribute('aria-label', t('header.updatePopoverAria'));
    }

    dom.rangePills.setAttribute('aria-label', t('header.rangeGroupAria'));
    const pillLabels = {
      today: t('header.rangeToday'),
      all: t('header.rangeAll'),
      custom: t('header.rangeCustom')
    };
    dom.rangePills.querySelectorAll('.range-pill').forEach((btn) => {
      const r = btn.dataset.range;
      if (pillLabels[r]) btn.textContent = pillLabels[r];
    });
    dom.sourcesBadge.title = t('header.sourcesBadgeTitle');
    dom.customFrom.setAttribute('aria-label', t('header.fromDateAria'));
    dom.customTo.setAttribute('aria-label', t('header.toDateAria'));
    dom.btnApplyCustom.textContent = t('header.apply');

    dom.emptyTitle.textContent = t('header.emptyTitle');
    dom.emptyDesc.textContent = t('header.emptyDesc');
    dom.btnOpenSettingsEmpty.textContent = t('header.openSettings');
    dom.settingsTitle.textContent = t('settings.title');
    dom.btnCloseSettings.title = t('settings.closeTitle');
    dom.btnCloseSettings.setAttribute('aria-label', t('settings.closeTitle'));
  }

  function renderHeader() {
    applyStaticI18n();
    dom.stickyHeader.classList.toggle('hidden', Boolean(state.query.hideHeader));

    const sec = String(num(state.config.refreshSec, 30));
    if (dom.refreshSelect.value !== sec) dom.refreshSelect.value = sec;
    updateFreshnessUI();

    const showAnalyticsBar = hasAnyAnalyticsModule();
    dom.rangeBar.classList.toggle('hidden', !showAnalyticsBar);
    dom.customRangeRow.classList.toggle(
      'hidden',
      !showAnalyticsBar || state.rangeKey !== 'custom'
    );

    if (showAnalyticsBar) {
      const pills = dom.rangeBar.querySelectorAll('.range-pill');
      pills.forEach((p) => {
        p.classList.toggle('active', p.dataset.range === state.rangeKey);
      });

      const dOn = Boolean(state.config.sources?.desktop);
      const cOn = Boolean(state.config.sources?.cli);
      if (dOn && cOn) dom.sourcesBadge.textContent = t('header.sourcesBoth');
      else if (dOn) dom.sourcesBadge.textContent = t('header.sourcesDesktop');
      else if (cOn) dom.sourcesBadge.textContent = t('header.sourcesCli');
      else dom.sourcesBadge.textContent = t('header.sourcesNone');
    }

    if (state.globalError) {
      dom.globalBanner.textContent = state.globalError;
      dom.globalBanner.classList.remove('hidden');
    } else {
      dom.globalBanner.classList.add('hidden');
    }

    renderUpdateUI();
  }

  function getUpdateInstallLabel(kind) {
    if (kind === 'git') return t('update.installGit');
    if (kind === 'builtin') return t('update.installBuiltin');
    return t('update.installTarball');
  }

  function getUpdateBlockedMessage(reason) {
    if (!reason) return '';
    return t(`update.blocked.${reason}`);
  }

  function positionUpdatePopover() {
    if (!dom.updatePopover || !dom.btnUpdatePill) return;
    const pad = 10;
    const aRect = dom.btnUpdatePill.getBoundingClientRect();
    const pRect = dom.updatePopover.getBoundingClientRect();
    let x = aRect.left;
    let y = aRect.bottom + 6;
    if (x + pRect.width > window.innerWidth - pad) {
      x = window.innerWidth - pRect.width - pad;
    }
    if (x < pad) x = pad;
    if (y + pRect.height > window.innerHeight - pad) {
      y = Math.max(pad, window.innerHeight - pRect.height - pad);
    }
    dom.updatePopover.style.left = `${Math.round(x)}px`;
    dom.updatePopover.style.top = `${Math.round(y)}px`;
  }

  function renderUpdateUI() {
    const u = state.update.data;
    const diskVer = typeof window.__AGY_LENS_DISK_VERSION__ === 'string' ? window.__AGY_LENS_DISK_VERSION__ : '';
    const hasMismatch = Boolean(diskVer && state.runningVersion && diskVer !== state.runningVersion);

    // 1. Header pill (shown only when an undismissed, auto-pushable update exists)
    const showPill = Boolean(
      u &&
        u.hasUpdate &&
        !u.manualOnly &&
        u.latestVersion &&
        u.latestVersion !== state.config.dismissedUpdateVersion
    );
    if (showPill && dom.btnUpdatePill) {
      dom.btnUpdatePill.textContent = t('update.pillLabel', { ver: u.latestVersion });
      dom.btnUpdatePill.title = t('update.pillTitle', { ver: u.latestVersion });
      dom.btnUpdatePill.classList.remove('hidden');
      dom.btnUpdatePill.classList.toggle('ready', Boolean(u.stagedVersion === u.latestVersion));
      dom.btnUpdatePill.setAttribute('aria-expanded', state.update.popoverOpen ? 'true' : 'false');
    } else if (dom.btnUpdatePill) {
      dom.btnUpdatePill.classList.add('hidden');
      state.update.popoverOpen = false;
    }

    // 2. Top status banner (restarting / fallback / version mismatch / one-time just-updated notice)
    if (dom.updateBanner) {
      if (state.update.restartMsg) {
        dom.updateBanner.innerHTML = `
          <span class="update-banner-text">${esc(state.update.restartMsg)}</span>
          ${state.update.restartFallback ? `<button type="button" class="btn-sm" data-action="reload-page">${esc(t('update.reloadBtn'))}</button>` : ''}
        `;
        dom.updateBanner.classList.remove('hidden');
      } else if (hasMismatch) {
        dom.updateBanner.innerHTML = `
          <span class="update-banner-text">${esc(t('update.mismatchBanner', { disk: diskVer }))}</span>
          <button type="button" class="btn-sm primary" data-action="reload-page">${esc(t('update.reloadBtn'))}</button>
        `;
        dom.updateBanner.classList.remove('hidden');
      } else if (u && u.justUpdated && u.justUpdated.to) {
        dom.updateBanner.innerHTML = `
          <span class="update-banner-text">${esc(t('update.justUpdatedBanner', { to: u.justUpdated.to, from: u.justUpdated.from || '?' }))}</span>
          <button type="button" class="btn-sm" data-action="ack-just-updated">${esc(t('update.ackBtn'))}</button>
        `;
        dom.updateBanner.classList.remove('hidden');
      } else {
        dom.updateBanner.classList.add('hidden');
      }
    }

    // 3. Floating Update Details Popover
    if (!dom.updatePopover) return;
    if (!state.update.popoverOpen || !showPill) {
      dom.updatePopover.classList.add('hidden');
      return;
    }

    const isStaged = u.stagedVersion === u.latestVersion;
    const isBusy = state.update.applying || u.staging;
    const ctaLabel = state.update.applying
      ? t('update.applying')
      : isStaged
        ? t('update.restartBtn', { ver: u.latestVersion })
        : t('update.applyBtn');
    const copyLabel =
      state.update.copyStatus === 'copied'
        ? t('common.copied')
        : state.update.copyStatus === 'failed'
          ? t('common.copyFailed')
          : t('update.copyCmd');

    dom.updatePopover.innerHTML = `
      <div class="upd-pop-head">
        <div class="upd-pop-title-wrap">
          <span class="upd-pop-title">${esc(t('update.popTitle'))}</span>
          <span class="upd-pop-ver mono">v${esc(u.currentVersion)} → v${esc(u.latestVersion)}</span>
        </div>
        <button type="button" class="obs-pop-close" data-action="close-update-popover" aria-label="${esc(t('obs.popClose'))}">×</button>
      </div>
      ${isStaged ? `<div class="upd-pop-pill ok">${esc(t('update.stagedReady'))}</div>` : ''}
      ${u.staging && !isStaged ? `<div class="upd-pop-pill">${esc(t('update.staging'))}</div>` : ''}
      ${u.requiresHostRestart ? `<div class="upd-pop-pill warn">${esc(t('update.hostRestartNote'))}</div>` : ''}
      ${!u.canAutoApply ? `<div class="upd-pop-pill warn">${esc(getUpdateBlockedMessage(u.blockedReason))}</div>` : ''}
      <div class="upd-pop-notes">${esc((u.releaseNotes || '').trim() || t('update.noNotes'))}</div>
      <div class="upd-pop-actions">
        ${
          u.canAutoApply
            ? `<button type="button" class="btn-sm primary" data-action="apply-update" ${isBusy ? 'disabled' : ''}>${esc(ctaLabel)}</button>`
            : `<button type="button" class="btn-sm primary" data-action="copy-update-cmd">${esc(copyLabel)}</button>`
        }
        <button type="button" class="btn-sm" data-action="dismiss-update" data-ver="${esc(u.latestVersion)}">${esc(t('update.skipBtn'))}</button>
        <a class="btn-sm upd-pop-link" href="${esc(u.releaseUrl)}" target="_blank" rel="noopener noreferrer">${esc(t('update.viewGithub'))}</a>
      </div>
    `;
    dom.updatePopover.classList.remove('hidden');
    positionUpdatePopover();
  }

  async function fetchUpdateStatus() {
    try {
      state.update.data = await getJson('/api/update/status');
      state.update.lastFetchedAt = Date.now();
      renderUpdateUI();
      if (state.settingsOpen) renderSettings();
    } catch {
      // silent if offline or endpoint unsupported (e.g. older demo server)
    }
  }

  async function triggerUpdateCheck() {
    if (isReadOnlyMode() || state.update.checking) return;
    state.update.checking = true;
    if (state.settingsOpen) renderSettings();
    try {
      state.update.data = await postJson('/api/update/check', {});
    } catch (err) {
      if (state.update.data) state.update.data.lastError = err.message;
    } finally {
      state.update.checking = false;
      renderUpdateUI();
      if (state.settingsOpen) renderSettings();
    }
  }

  async function pollForRestartCompletion(prevVersion, targetVersion) {
    const deadline = Date.now() + 12000;
    let sawDown = false;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 800));
      try {
        const res = await apiFetch('/api/health', { cache: 'no-store' });
        if (res.ok) {
          const h = await res.json();
          if (h && h.ok && (sawDown || (h.version && h.version !== prevVersion))) {
            window.location.reload();
            return;
          }
        }
      } catch {
        sawDown = true;
      }
    }
    state.update.restartMsg = t('update.reopenFallback', { ver: targetVersion });
    state.update.restartFallback = true;
    state.update.applying = false;
    state.update.rollingBack = false;
    renderUpdateUI();
    if (state.settingsOpen) renderSettings();
  }

  async function triggerUpdateApply() {
    if (isReadOnlyMode() || state.update.applying) return;
    const prevVersion = state.update.data?.currentVersion || state.runningVersion;
    const targetVersion = state.update.data?.latestVersion || '';
    state.update.applying = true;
    state.update.popoverOpen = false;
    state.update.restartFallback = false;
    state.update.restartMsg = t('update.restartingBanner', { ver: targetVersion });
    renderUpdateUI();
    if (state.settingsOpen) renderSettings();
    try {
      const res = await postJson('/api/update/apply', {});
      pollForRestartCompletion(prevVersion, res.updatedTo || targetVersion);
    } catch (err) {
      state.update.applying = false;
      state.update.restartMsg = '';
      if (state.update.data) state.update.data.lastError = err.message;
      renderUpdateUI();
      if (state.settingsOpen) renderSettings();
    }
  }

  async function triggerUpdateRollback() {
    if (isReadOnlyMode() || state.update.rollingBack) return;
    const prevVersion = state.update.data?.currentVersion || state.runningVersion;
    const targetVersion = state.update.data?.rollbackVersion || '';
    state.update.rollingBack = true;
    state.update.restartFallback = false;
    state.update.restartMsg = t('update.rollingBackBanner', { ver: targetVersion });
    renderUpdateUI();
    if (state.settingsOpen) renderSettings();
    try {
      const res = await postJson('/api/update/rollback', {});
      pollForRestartCompletion(prevVersion, res.rollbackTo || targetVersion);
    } catch (err) {
      state.update.rollingBack = false;
      state.update.restartMsg = '';
      if (state.update.data) state.update.data.lastError = err.message;
      renderUpdateUI();
      if (state.settingsOpen) renderSettings();
    }
  }

  // =========================================================================
  // 10. Rendering: Module 1 — Live Context
  // =========================================================================
  const CTX_COLORS = {
    1: 'var(--ctx-1)',
    2: 'var(--ctx-2)',
    3: 'var(--ctx-3)',
    4: 'var(--ctx-4)',
    5: 'var(--ctx-5)',
    6: 'var(--ctx-7)',
    7: 'var(--ctx-6)'
  };

  function getCtxColor(cat, idx) {
    if (cat && cat.id != null && CTX_COLORS[cat.id]) return CTX_COLORS[cat.id];
    const palette = ['var(--ctx-1)', 'var(--ctx-2)', 'var(--ctx-3)', 'var(--ctx-4)', 'var(--ctx-5)', 'var(--ctx-6)', 'var(--ctx-7)'];
    return palette[idx % palette.length];
  }

  function renderSessionPickerHtml(currentSession) {
    if (!isStandaloneMode() || state.recentSessions.length === 0) return '';
    const activeId = currentSession?.found && currentSession.conversationId ? currentSession.conversationId : '';
    const hasActiveInList = activeId ? state.recentSessions.some((rs) => rs.conversationId === activeId) : false;
    const options = [];
    if (!activeId) {
      options.push(`<option value="" selected disabled>— ${esc(t('ctx.noActive'))} —</option>`);
    } else if (!hasActiveInList) {
      const curLbl = currentSession.title || baseName(currentSession.workspace) || activeId.slice(0, 8);
      const curSrcTag = currentSession.source === 'cli' ? 'CLI' : 'Desktop';
      options.push(`<option value="${esc(activeId)}" selected>[${curSrcTag}] ${esc(curLbl.slice(0, 56))}</option>`);
    }
    for (const rs of state.recentSessions) {
      const lbl = rs.title || baseName(rs.workspace) || rs.conversationId.slice(0, 8);
      const srcTag = rs.source === 'cli' ? 'CLI' : 'Desktop';
      const selected = activeId && rs.conversationId === activeId ? 'selected' : '';
      options.push(`<option value="${esc(rs.conversationId)}" ${selected}>[${srcTag}] ${esc(lbl.slice(0, 56))}</option>`);
    }
    return `<div class="session-picker-bar" data-stop-card>
      <select class="session-picker-select" data-action="select-session" aria-label="${esc(t('header.switchSessionAria'))}">
        ${options.join('')}
      </select>
    </div>`;
  }

  function renderLiveContext(expanded) {
    if (state.sessionError) {
      return {
        badges: `<span class="pill bad">${esc(t('common.readFailed'))}</span>`,
        body: `<div class="banner error">${esc(state.sessionError)}</div>`
      };
    }
    const s = state.session;
    const sessionPickerHtml = renderSessionPickerHtml(s);
    if (!s || !s.found || !s.liveContext) {
      return {
        badges: `<span class="pill outline">${esc(t('ctx.noActive'))}</span>`,
        body: `${sessionPickerHtml}<div class="muted-note">${esc(t('ctx.noData'))}</div>`
      };
    }

    const lc = s.liveContext;
    const used = num(lc.contextUsed, 0);
    const limit = num(lc.compactLimit, 0);
    const ratio = limit > 0 ? clamp(used / limit, 0, 1) : clamp(num(lc.ratio, 0), 0, 1);
    const pct = ratio * 100;
    const barClass = pct >= 80 ? 'bad' : pct >= 55 ? 'warn' : '';

    const badges = `
      <span class="pill accent truncate" title="${esc(lc.modelId || lc.displayName)}">${esc(lc.displayName || lc.modelId || t('common.unknownModel'))}</span>
      ${lc.pool ? `<span class="pill outline">${esc(poolLabel(lc.pool))}</span>` : ''}
    `;

    const titleText = s.title || baseName(s.workspace) || (s.conversationId ? s.conversationId.slice(0, 8) : '');
    let html = `
      ${sessionPickerHtml}
      <div class="session-meta-row">
        <span class="pill outline">${esc(sourceLabel(s.source))}</span>
        <span class="truncate" title="${esc(s.title || s.workspace || s.conversationId)}">${esc(titleText)}</span>
      </div>
      <div class="ctx-progress-wrap">
        <div class="ctx-numbers">
          <span class="ctx-used num mono">${fmtTokens(used)} <span class="muted-note">/ ${limit ? fmtTokens(limit) : '—'}</span></span>
          <span class="num mono ${pct >= 80 ? 'pill bad' : pct >= 55 ? 'pill warn' : 'muted-note'}">${pct.toFixed(1)}%</span>
        </div>
        <div class="ctx-track" role="progressbar" aria-valuenow="${pct.toFixed(1)}" aria-valuemin="0" aria-valuemax="100">
          <div class="ctx-fill ${barClass}" style="width:${clamp(pct, 0, 100).toFixed(2)}%"></div>
          <span class="ctx-tick" style="left:55%" title="${esc(t('ctx.warn55'))}"></span>
          <span class="ctx-tick" style="left:80%" title="${esc(t('ctx.warn80'))}"></span>
        </div>
        <div class="chart-caption-row num">
          <span>${esc(t('ctx.turnsDur', { turns: num(lc.turnCount, 0), dur: fmtDurationMs(lc.sessionDurationMs) }))}</span>
          ${pct >= 75 ? `<span class="pill warn">${esc(t('ctx.nearCompact'))}</span>` : `<span>${esc(t('ctx.markers'))}</span>`}
        </div>
      </div>
    `;

    if (expanded) {
      let expHtml = '<div class="card-expanded">';
      if (pct >= 75) {
        expHtml += `<div class="banner warn">${esc(t('ctx.nearWarnBanner'))}</div>`;
      }

      const breakdown = Array.isArray(lc.breakdown) ? lc.breakdown.filter((b) => num(b.tokens, 0) > 0) : [];
      const bdTotal = breakdown.reduce((acc, b) => acc + num(b.tokens, 0), 0) || used;

      if (breakdown.length > 0 && bdTotal > 0) {
        let xAcc = 0;
        const rects = breakdown.map((b, idx) => {
          const w = (num(b.tokens, 0) / bdTotal) * 300;
          const x = xAcc;
          xAcc += w;
          const share = ((num(b.tokens, 0) / bdTotal) * 100).toFixed(1);
          const tip = `${b.name || t('ctx.uncategorized')}: ${fmtTokens(b.tokens)} (${share}%)`;
          return `<rect x="${x.toFixed(2)}" y="0" width="${Math.max(1.5, w).toFixed(2)}" height="12" fill="${getCtxColor(b, idx)}" data-tip="${esc(tip)}" tabindex="0"/>`;
        }).join('');

        expHtml += `
          <svg class="svg-chart" viewBox="0 0 300 12" preserveAspectRatio="none" style="height:12px;border-radius:6px;overflow:hidden" aria-label="${esc(t('ctx.chartAria'))}">
            ${rects}
          </svg>
          <div class="breakdown-list">
        `;

        breakdown.forEach((b, idx) => {
          const key = `${b.id ?? idx}-${b.name}`;
          const items = Array.isArray(b.items) ? b.items : [];
          const isOpen = state.ctxOpenCategories.has(key);
          const share = ((num(b.tokens, 0) / bdTotal) * 100).toFixed(1);
          expHtml += `
            <div class="bd-row">
              <div class="bd-main ${items.length ? 'clickable' : ''}" ${items.length ? `data-action="toggle-ctx-cat" data-cat="${esc(key)}"` : ''}>
                <div class="bd-left">
                  <span class="bd-dot" style="background:${getCtxColor(b, idx)}"></span>
                  <span class="truncate">${esc(b.name || t('ctx.uncategorized'))}</span>
                  ${items.length ? `<span class="muted-note">(${items.length})</span>` : ''}
                </div>
                <div class="bd-right num mono">
                  <span>${fmtTokens(b.tokens)}</span>
                  <span>${share}%</span>
                  ${items.length ? `<span>${isOpen ? '▾' : '▸'}</span>` : ''}
                </div>
              </div>
              ${
                isOpen && items.length
                  ? `<div class="bd-items">${items.slice(0, 12).map((it) => `
                      <div class="bd-item">
                        <span class="truncate" title="${esc(it.name)}">${esc(it.name)}</span>
                        <span class="num mono">${fmtTokens(it.tokens)}</span>
                      </div>`).join('')}</div>`
                  : ''
              }
            </div>
          `;
        });
        expHtml += '</div>';
      } else {
        expHtml += `<div class="muted-note">${esc(t('ctx.noBreakdown'))}</div>`;
      }

      expHtml += '</div>';
      html += expHtml;
    }

    return { badges, body: html };
  }

  // =========================================================================
  // 11. Rendering: Module 2 — Cache Diagnostics
  // =========================================================================
  function renderCacheDiagnostics(expanded) {
    if (state.sessionError) {
      return {
        badges: `<span class="pill bad">${esc(t('common.readFailed'))}</span>`,
        body: `<div class="banner error">${esc(state.sessionError)}</div>`
      };
    }
    const s = state.session;
    if (!s || !s.found || !s.cacheDiagnostics) {
      return {
        badges: `<span class="pill outline">${esc(t('cache.noDataBadge'))}</span>`,
        body: `<div class="muted-note">${esc(t('cache.noDataBody'))}</div>`
      };
    }

    const cd = s.cacheDiagnostics;
    const last = cd.lastTurn || {};
    const sess = cd.session || {};
    const isCold = Boolean(last.cold);
    const lastHitRatio = num(last.hitRatio, 0);
    const sessHitRatio = num(sess.hitRatio, 0);

    const statusBadge = isCold
      ? `<span class="pill warn">${esc(t('cache.coldBadge'))}</span>`
      : lastHitRatio >= 0.75
        ? `<span class="pill ok num">${esc(t('cache.hitBadge', { pct: fmtPct(lastHitRatio, 0) }))}</span>`
        : `<span class="pill warn num">${esc(t('cache.hitBadge', { pct: fmtPct(lastHitRatio, 0) }))}</span>`;

    const html = `
      <div class="kpi-strip">
        <div class="kpi-tile">
          <span class="kpi-label">${esc(t('cache.lastTurn'))}</span>
          <span class="kpi-val num mono">${isCold ? 'Cold' : fmtPct(lastHitRatio, 1)}</span>
          <span class="kpi-sub num">${esc(t('cache.hitSub', { n: fmtTokens(last.cacheRead) }))}</span>
        </div>
        <div class="kpi-tile">
          <span class="kpi-label">${esc(t('cache.sessionTotal'))}</span>
          <span class="kpi-val num mono">${fmtPct(sessHitRatio, 1)}</span>
          <span class="kpi-sub num">${fmtTokens(sess.totalCacheRead)} / ${fmtTokens(num(sess.totalCacheRead) + num(sess.totalUncachedIn))}</span>
        </div>
        <div class="kpi-tile">
          <span class="kpi-label">${esc(t('cache.cacheSaved'))}</span>
          <span class="kpi-val ok num mono">${fmtUsd(sess.cacheSavedUsd)}</span>
          <span class="kpi-sub">${esc(t('cache.vsUncached'))}</span>
        </div>
      </div>
      ${expanded ? renderCacheExpanded(cd) : ''}
    `;

    return { badges: statusBadge, body: html };
  }

  function renderCacheExpanded(cd) {
    const turns = Array.isArray(cd.turns) ? cd.turns.slice(-15) : [];
    if (!turns.length) {
      return `<div class="card-expanded"><div class="muted-note">${esc(t('cache.noTrajectory'))}</div></div>`;
    }

    const maxTot = Math.max(
      1,
      ...turns.map((tItem) => num(tItem.cacheRead, 0) + num(tItem.uncachedIn, 0))
    );
    const W = 300;
    const H = 96;
    const padB = 14;
    const chartH = H - padB;
    const slotW = W / Math.max(turns.length, 1);
    const barW = clamp(slotW * 0.66, 6, 20);

    const clipDefs = [];
    const bars = turns.map((tItem, i) => {
      const cr = num(tItem.cacheRead, 0);
      const ui = num(tItem.uncachedIn, 0);
      const tot = cr + ui;
      const x = i * slotW + (slotW - barW) / 2;
      const crH = (cr / maxTot) * (chartH - 8);
      const uiH = (ui / maxTot) * (chartH - 8);
      const totH = crH + uiH;
      const yCr = chartH - crH;
      const yUi = yCr - uiH;
      const yTop = chartH - totH;
      const tag = tItem.cold ? t('cache.tipCold') : tItem.drop ? t('cache.tipDrop') : '';
      const tip = `Step #${tItem.stepIdx ?? i + 1}${tag}\n${t('cache.tipHit')}: ${fmtPct(tItem.hitRatio, 1)}\nCache Read: ${fmtTokens(cr)}\nUncached In: ${fmtTokens(ui)}`;
      const clipId = `cache-bar-clip-${i}`;
      if (totH > 0) {
        clipDefs.push(`<clipPath id="${clipId}"><rect x="${x.toFixed(1)}" y="${yTop.toFixed(1)}" width="${barW.toFixed(1)}" height="${totH.toFixed(1)}" rx="3" ry="3"/></clipPath>`);
      }

      return `
        <g data-tip="${esc(tip)}" tabindex="0">
          <rect x="${x.toFixed(1)}" y="0" width="${barW.toFixed(1)}" height="${chartH}" fill="transparent"/>
          ${
            totH > 0
              ? `<g clip-path="url(#${clipId})">
                  ${crH > 0 ? `<rect x="${x.toFixed(1)}" y="${yCr.toFixed(1)}" width="${barW.toFixed(1)}" height="${crH.toFixed(1)}" rx="0" ry="0" fill="var(--ch-cache)"/>` : ''}
                  ${uiH > 0 ? `<rect x="${x.toFixed(1)}" y="${yUi.toFixed(1)}" width="${barW.toFixed(1)}" height="${uiH.toFixed(1)}" rx="0" ry="0" fill="${tItem.drop ? 'var(--bad)' : tItem.cold ? 'var(--warn)' : 'var(--ch-uncached)'}"/>` : ''}
                 </g>`
              : ''
          }
          ${(tItem.cold || tItem.drop) && tot > 0 ? `<circle cx="${(x + barW / 2).toFixed(1)}" cy="${Math.max(3, yUi - 4).toFixed(1)}" r="2.2" fill="${tItem.drop ? 'var(--bad)' : 'var(--warn)'}"/>` : ''}
          <text x="${(x + barW / 2).toFixed(1)}" y="${H - 2}" text-anchor="middle" font-size="8" fill="var(--fg-muted)" class="mono">${esc(tItem.stepIdx ?? i + 1)}</text>
        </g>
      `;
    }).join('');

    return `
      <div class="card-expanded">
        <div class="chart-caption-row">
          <span>${esc(t('cache.recentTitle', { n: turns.length }))}</span>
          <div class="legend-inline">
            <span class="legend-item"><span class="legend-swatch" style="background:var(--ch-cache)"></span>${esc(t('cache.legendCacheRead'))}</span>
            <span class="legend-item"><span class="legend-swatch" style="background:var(--ch-uncached)"></span>${esc(t('cache.legendUncached'))}</span>
            <span class="legend-item"><span class="legend-swatch" style="background:var(--warn)"></span>${esc(t('cache.legendCold'))}</span>
            <span class="legend-item"><span class="legend-swatch" style="background:var(--bad)"></span>${esc(t('cache.legendDrop'))}</span>
          </div>
        </div>
        <svg class="svg-chart" viewBox="0 0 ${W} ${H}" aria-label="${esc(t('cache.chartAria'))}">
          <defs>${clipDefs.join('')}</defs>
          <line x1="0" y1="${chartH}" x2="${W}" y2="${chartH}" stroke="var(--line)" stroke-width="1"/>
          ${bars}
        </svg>
      </div>
    `;
  }

  // =========================================================================
  // 12. Rendering: Module 3 — IO Flow
  // =========================================================================
  function renderIoFlow(expanded) {
    const isSess = state.ioScope === 'session';
    const err = isSess ? state.sessionError : state.analyticsError;
    const scopeToggle = `
      <div class="seg" data-stop-card>
        <button type="button" class="${isSess ? 'active' : ''}" data-action="set-io-scope" data-scope="session">${esc(t('io.scopeSession'))}</button>
        <button type="button" class="${!isSess ? 'active' : ''}" data-action="set-io-scope" data-scope="analytics">${esc(t('io.scopeGlobal'))}</button>
      </div>
    `;

    if (err) {
      return { badges: scopeToggle, body: `<div class="banner error">${esc(err)}</div>` };
    }

    const data = isSess ? state.session?.ioFlow : state.analytics?.ioFlow;
    if (!data || (isSess && !state.session?.found)) {
      return {
        badges: scopeToggle,
        body: `<div class="muted-note">${esc(isSess ? t('io.noSession') : t('io.noGlobal'))}</div>`
      };
    }

    const uncached = num(data.uncachedIn, 0);
    const cacheRead = num(data.cacheRead, 0);
    const cacheCreate = num(data.cacheCreate, 0);
    const thinking = num(data.thinkingOut, 0);
    const visible = num(data.visibleOut, 0);
    const totalOut = num(data.totalOut, thinking + visible);
    const total = num(data.totalTokens, uncached + cacheRead + cacheCreate + totalOut);

    const denom = Math.max(1, uncached + cacheRead + thinking + visible);
    const pU = (uncached / denom) * 100;
    const pC = (cacheRead / denom) * 100;
    const pT = (thinking / denom) * 100;
    const pV = (visible / denom) * 100;

    let rateHtml = '';
    if (isSess) {
      const durHr = num(state.session?.liveContext?.sessionDurationMs, 0) / 3600000;
      const burnStr = durHr > 0.01 ? `${fmtTokens(total / durHr)} tok/hr` : '';
      rateHtml = `<span class="io-rate num mono">${burnStr ? `${burnStr} · ` : ''}${fmtUsd(data.costUsd)}</span>`;
    } else {
      rateHtml = `<span class="io-rate num mono">${fmtTokens(data.burnTokensPerHr)} tok/hr · ${fmtUsd(data.burnUsdPerHr)}/hr</span>`;
    }

    let html = `
      <div class="io-headline">
        <span class="io-big num mono">${fmtTokens(total)} <span class="muted-note" style="font-size:12px;font-weight:400">tokens</span></span>
        ${rateHtml}
      </div>
      <div class="ratio-bar" aria-label="${esc(t('io.barAria'))}">
        ${uncached > 0 ? `<div class="ratio-seg" style="width:${pU.toFixed(2)}%;background:var(--ch-uncached)" data-tip="${esc(`Uncached In: ${fmtTokens(uncached)} (${pU.toFixed(1)}%)`)}"></div>` : ''}
        ${cacheRead > 0 ? `<div class="ratio-seg" style="width:${pC.toFixed(2)}%;background:var(--ch-cache)" data-tip="${esc(`Cache Read: ${fmtTokens(cacheRead)} (${pC.toFixed(1)}%)`)}"></div>` : ''}
        ${thinking > 0 ? `<div class="ratio-seg" style="width:${pT.toFixed(2)}%;background:var(--ch-think)" data-tip="${esc(`Thinking Out: ${fmtTokens(thinking)} (${pT.toFixed(1)}%)`)}"></div>` : ''}
        ${visible > 0 ? `<div class="ratio-seg" style="width:${pV.toFixed(2)}%;background:var(--ch-visible)" data-tip="${esc(`Visible Out: ${fmtTokens(visible)} (${pV.toFixed(1)}%)`)}"></div>` : ''}
      </div>
      <div class="legend-inline num">
        <span class="legend-item"><span class="legend-swatch" style="background:var(--ch-uncached)"></span>${esc(t('io.uncachedShort'))} ${fmtTokens(uncached)}</span>
        <span class="legend-item"><span class="legend-swatch" style="background:var(--ch-cache)"></span>${esc(t('io.cacheReadShort'))} ${fmtTokens(cacheRead)}</span>
        <span class="legend-item"><span class="legend-swatch" style="background:var(--ch-think)"></span>${esc(t('io.thinkingShort'))} ${fmtTokens(thinking)}</span>
        <span class="legend-item"><span class="legend-swatch" style="background:var(--ch-visible)"></span>${esc(t('io.visibleShort'))} ${fmtTokens(visible)}</span>
      </div>
    `;

    if (expanded) {
      html += `
        <div class="card-expanded">
          <div class="metric-grid-5">
            <div class="metric-row">
              <span class="metric-key"><span class="legend-swatch" style="background:var(--ch-uncached)"></span>${esc(t('io.uncachedFull'))}</span>
              <span class="metric-val num mono">${uncached.toLocaleString()}</span>
            </div>
            <div class="metric-row">
              <span class="metric-key"><span class="legend-swatch" style="background:var(--ch-cache)"></span>${esc(t('io.cacheReadFull'))}</span>
              <span class="metric-val num mono">${cacheRead.toLocaleString()}${cacheCreate > 0 ? ` <span class="muted-note">${esc(t('io.cacheWriteNote', { n: fmtTokens(cacheCreate) }))}</span>` : ''}</span>
            </div>
            <div class="metric-row">
              <span class="metric-key"><span class="legend-swatch" style="background:var(--ch-think)"></span>${esc(t('io.thinkingFull'))}</span>
              <span class="metric-val num mono">${thinking.toLocaleString()}</span>
            </div>
            <div class="metric-row">
              <span class="metric-key"><span class="legend-swatch" style="background:var(--ch-visible)"></span>${esc(t('io.visibleFull'))}</span>
              <span class="metric-val num mono">${visible.toLocaleString()} / ${totalOut.toLocaleString()}</span>
            </div>
            <div class="metric-row">
              <span class="metric-key">${esc(t('io.latencyRow'))}</span>
              <span class="metric-val num mono">${fmtDurationMs(data.avgTtftMs)} / ${fmtDurationMs(data.avgGenMs)}</span>
            </div>
          </div>
          ${
            num(data.longContextTurns, 0) > 0 || num(data.unpricedTurns, 0) > 0
              ? `<div class="chart-caption-row">
                  ${num(data.longContextTurns, 0) > 0 ? `<span class="pill warn num">${esc(t('io.longCtxPill', { n: data.longContextTurns }))}</span>` : ''}
                  ${num(data.unpricedTurns, 0) > 0 ? `<span class="pill outline num">${esc(t('io.unpricedPill', { n: data.unpricedTurns }))}</span>` : ''}
                 </div>`
              : ''
          }
        </div>
      `;
    }

    return { badges: scopeToggle, body: html };
  }

  // =========================================================================
  // 13. Rendering: Module 4 — Model Cost & Workspaces
  // =========================================================================
  function renderModelCost(expanded) {
    if (state.analyticsError) {
      return {
        badges: `<span class="pill bad">${esc(t('common.readFailed'))}</span>`,
        body: `<div class="banner error">${esc(state.analyticsError)}</div>`
      };
    }

    const mc = state.analytics?.modelCost;
    if (!mc) {
      return {
        badges: `<span class="pill outline">${esc(t('cost.badge'))}</span>`,
        body: `<div class="muted-note">${esc(t('cost.noData'))}</div>`
      };
    }

    const models = Array.isArray(mc.models) ? [...mc.models] : [];
    const workspaces = Array.isArray(mc.workspaces) ? [...mc.workspaces] : [];
    const totalUsd = num(mc.totalCostUsd, 0);
    const savedUsd = num(mc.cacheSavedUsd, 0);

    const top3 = [...models]
      .sort((a, b) => num(b.costUsd, 0) - num(a.costUsd, 0))
      .slice(0, 3);

    let html = `
      <div class="cost-headline-row">
        <span class="cost-big num mono">${fmtUsd(totalUsd)}</span>
        <div class="legend-inline">
          <span class="pill ok num">${esc(t('cost.savedPill', { usd: fmtUsd(savedUsd) }))}</span>
          ${num(mc.longContextTurns, 0) > 0 ? `<span class="pill warn num">${esc(t('cost.longCtxPill', { n: mc.longContextTurns }))}</span>` : ''}
          ${num(mc.unpricedTurns, 0) > 0 ? `<span class="pill outline num">${esc(t('cost.unpricedPill', { n: mc.unpricedTurns }))}</span>` : ''}
        </div>
      </div>
      ${
        top3.length
          ? `<div class="top-models-pills">${top3.map((m) => {
              const share = num(m.share, totalUsd > 0 ? num(m.costUsd, 0) / totalUsd : 0);
              return `<span class="pill num" title="${esc(m.canonicalId)}">${esc(m.displayName || m.canonicalId)} · ${(share * 100).toFixed(0)}%</span>`;
            }).join('')}</div>`
          : `<div class="muted-note">${esc(t('cost.emptyRange'))}</div>`
      }
    `;

    if (expanded && (models.length || workspaces.length)) {
      const sortKey = state.modelSort;
      models.sort((a, b) => {
        if (sortKey === 'turns') return num(b.turns, 0) - num(a.turns, 0);
        if (sortKey === 'tokens') {
          const ta = num(a.uncachedIn) + num(a.cacheRead) + num(a.totalOut);
          const tb = num(b.uncachedIn) + num(b.cacheRead) + num(b.totalOut);
          return tb - ta;
        }
        if (sortKey === 'cache') return num(b.cacheHitRatio, 0) - num(a.cacheHitRatio, 0);
        return num(b.costUsd, 0) - num(a.costUsd, 0);
      });

      workspaces.sort((a, b) => num(b.costUsd, 0) - num(a.costUsd, 0));

      html += `
        <div class="card-expanded">
          <div class="toolbar-inline">
            <div class="seg">
              <button type="button" class="${state.modelView === 'models' ? 'active' : ''}" data-action="set-model-view" data-view="models">${esc(t('cost.byModel', { n: models.length }))}</button>
              <button type="button" class="${state.modelView === 'workspaces' ? 'active' : ''}" data-action="set-model-view" data-view="workspaces">${esc(t('cost.byWorkspace', { n: workspaces.length }))}</button>
            </div>
            ${
              state.modelView === 'models'
                ? `<div class="sort-pills">
                    <button type="button" class="sort-btn ${sortKey === 'cost' ? 'active' : ''}" data-action="set-model-sort" data-sort="cost">${esc(t('cost.sortCost'))}</button>
                    <button type="button" class="sort-btn ${sortKey === 'tokens' ? 'active' : ''}" data-action="set-model-sort" data-sort="tokens">${esc(t('cost.sortTokens'))}</button>
                    <button type="button" class="sort-btn ${sortKey === 'turns' ? 'active' : ''}" data-action="set-model-sort" data-sort="turns">${esc(t('cost.sortTurns'))}</button>
                    <button type="button" class="sort-btn ${sortKey === 'cache' ? 'active' : ''}" data-action="set-model-sort" data-sort="cache">${esc(t('cost.sortCache'))}</button>
                   </div>`
                : ''
            }
          </div>
          <div class="model-list">
            ${
              state.modelView === 'models'
                ? (() => {
                    const pricingById = new Map(
                      (state.pricing.data?.models || []).map((pm) => [pm.canonicalId, pm])
                    );
                    return models.map((m) => {
                      const totTok = num(m.uncachedIn) + num(m.cacheRead) + num(m.totalOut);
                      const isUnpriced = m.pricingSource === 'unpriced';
                      const pricingInfo = pricingById.get(m.canonicalId);
                      const promoLabel = m.promoLabel || pricingInfo?.promoLabel || '';
                      return `
                        <div class="model-item">
                          <div class="model-item-top">
                            <div class="model-item-name">
                              <span class="truncate" title="${esc(m.canonicalId)}">${esc(m.displayName || m.canonicalId)}</span>
                              ${m.longContextTurns > 0 ? '<span class="pill warn">&gt;200k</span>' : ''}
                              ${promoLabel ? `<span class="pill warn promo-pill" data-tip="${esc(formatPromoLabel(promoLabel))}">${esc(t('settings.promoBadge'))}</span>` : ''}
                            </div>
                            <span class="model-item-cost num mono">${isUnpriced ? `<span class="pill warn">${esc(t('pricingSrc.unpriced'))}</span>` : fmtUsd(m.costUsd)}</span>
                          </div>
                          <div class="model-item-sub num">
                            <span>${esc(t('cost.modelSub', { turns: num(m.turns), tok: fmtTokens(totTok), cache: fmtPct(m.cacheHitRatio, 0) }))}</span>
                            <span class="pill outline">${esc(pricingSourceLabel(m.pricingSource))}</span>
                          </div>
                        </div>
                      `;
                    }).join('');
                  })()
                : workspaces.map((w) => `
                    <div class="model-item">
                      <div class="model-item-top">
                        <div class="model-item-name"><span class="truncate" title="${esc(w.workspace)}">${esc(baseName(w.workspace))}</span></div>
                        <span class="model-item-cost num mono">${fmtUsd(w.costUsd)}</span>
                      </div>
                      <div class="model-item-sub num">
                        <span>${esc(t('cost.wsSub', { turns: num(w.turns), tok: fmtTokens(w.totalTokens) }))}</span>
                        <span class="truncate muted-note" style="max-width:160px">${esc(w.workspace || '')}</span>
                      </div>
                    </div>
                  `).join('')
            }
          </div>
        </div>
      `;
    }

    return {
      badges: `<span class="pill outline">${esc(t('cost.badge'))}</span>`,
      body: html
    };
  }

  // =========================================================================
  // 14. Rendering: Module 5 — Calendar Trends & Day Drill-down (1:1 .hm-svg)
  // =========================================================================
  function renderCalendarTrends(expanded) {
    if (state.analyticsError) {
      return {
        badges: `<span class="pill bad">${esc(t('common.readFailed'))}</span>`,
        body: `<div class="banner error">${esc(state.analyticsError)}</div>`
      };
    }
    const ct = state.analytics?.calendarTrends;
    if (!ct) {
      return {
        badges: `<span class="pill outline">${esc(t('cal.badge'))}</span>`,
        body: `<div class="muted-note">${esc(t('cal.noData'))}</div>`
      };
    }

    const streak = num(ct.streakDays, 0);
    const todayCost = num(ct.todayCostUsd, 0);
    const avg7d = num(ct.avg7dCostUsd, 0);
    const delta = ct.deltaVs7dPct;

    const deltaHtml =
      delta == null || !Number.isFinite(Number(delta))
        ? `<span class="muted-note">${esc(t('cal.no7dBase'))}</span>`
        : `<span class="pill num ${Number(delta) > 15 ? 'warn' : Number(delta) < 0 ? 'ok' : 'outline'}">${esc(t('cal.vs7d', { delta: `${Number(delta) >= 0 ? '+' : ''}${Number(delta).toFixed(1)}%` }))}</span>`;

    const daysArr = Array.isArray(ct.days) ? ct.days : [];
    const dayMap = new Map(daysArr.map((d) => [d.date, d]));
    const sparkDays = [];
    const now = new Date();
    for (let i = 13; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
      const key = fmtLocalDateStr(d);
      sparkDays.push(dayMap.get(key) || { date: key, costUsd: 0, tokens: 0, turns: 0 });
    }
    const maxSpark = Math.max(0.001, ...sparkDays.map((d) => num(d.costUsd, 0)));
    const sparkSvg = `
      <svg class="cal-spark svg-chart" viewBox="0 0 132 30" aria-label="${esc(t('cal.sparkAria'))}">
        ${sparkDays
          .map((d, idx) => {
            const val = num(d.costUsd, 0);
            const h = val > 0 ? Math.max(2.5, (val / maxSpark) * 26) : 1.5;
            const x = idx * 9.5 + 1;
            const y = 28 - h;
            const fill = val > 0 ? 'var(--ch-cache)' : 'var(--hm-0)';
            const tip = `${d.date}: ${fmtUsd(val)} (${num(d.turns)} ${t('common.turns')})`;
            return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="6.5" height="${h.toFixed(1)}" rx="1.5" fill="${fill}" data-tip="${esc(tip)}"/>`;
          })
          .join('')}
      </svg>
    `;

    let html = `
      <div class="cal-compact-row">
        <div class="cal-stats">
          <div class="num mono" style="font-size:15px;font-weight:600">${esc(t('cal.todayPrefix'))} ${fmtUsd(todayCost)} <span class="muted-note" style="font-size:11px;font-weight:400">${esc(t('cal.avg7dPrefix'))} ${fmtUsd(avg7d)}</span></div>
          <div>${deltaHtml}</div>
        </div>
        ${sparkSvg}
      </div>
    `;

    if (expanded) {
      html += renderCalendarExpanded(dayMap);
    }

    return {
      badges: `<span class="pill ${streak > 0 ? 'ok' : 'outline'} num">${esc(t('cal.streak', { n: streak }))}</span>`,
      body: html
    };
  }

  function renderCalendarExpanded(dayMap) {
    const metric = state.calMetric;
    const totalDays = state.widePane ? 168 : 112;
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const todayDow = (today.getDay() + 6) % 7;
    const numCols = Math.ceil((totalDays + (6 - todayDow)) / 7);
    const startDate = new Date(today);
    startDate.setDate(today.getDate() - (numCols * 7 - 1 - (6 - todayDow)));

    const cells = [];
    const vals = [];
    for (let i = 0; i < numCols * 7; i++) {
      const d = new Date(startDate);
      d.setDate(startDate.getDate() + i);
      const isFuture = d > today;
      const dateStr = fmtLocalDateStr(d);
      const rec = dayMap.get(dateStr) || { date: dateStr, turns: 0, totalTokens: 0, costUsd: 0 };
      const val =
        metric === 'tokens'
          ? num(rec.totalTokens, 0)
          : metric === 'turns'
            ? num(rec.turns, 0)
            : num(rec.costUsd, 0);
      if (!isFuture && val > 0) vals.push(val);
      cells.push({
        col: Math.floor(i / 7),
        row: i % 7,
        date: dateStr,
        isFuture,
        rec,
        val
      });
    }

    vals.sort((a, b) => a - b);
    const q1 = vals[Math.floor(vals.length * 0.25)] || 0;
    const q2 = vals[Math.floor(vals.length * 0.5)] || 0;
    const q3 = vals[Math.floor(vals.length * 0.75)] || 0;

    function levelColor(v) {
      if (v <= 0) return 'var(--hm-0)';
      if (v <= q1) return 'var(--hm-1)';
      if (v <= q2) return 'var(--hm-2)';
      if (v <= q3) return 'var(--hm-3)';
      return 'var(--hm-4)';
    }

    // 1:1 fixed-pixel crisp heatmap (11px cells, 3px gap, 10px labels)
    const cellSz = 11;
    const gap = 3;
    const leftPad = getLang() === 'en' ? 24 : 18;
    const topPad = 16;
    const svgW = leftPad + numCols * (cellSz + gap) - gap + 2;
    const svgH = topPad + 7 * (cellSz + gap) - gap + 2;

    const dayLabels = [
      { row: 0, text: t('cal.dayLabels.mon') },
      { row: 2, text: t('cal.dayLabels.wed') },
      { row: 4, text: t('cal.dayLabels.fri') }
    ];

    const selectedDate = state.selectedDay?.date || '';
    let monthMarks = '';
    let prevMonth = -1;
    let lastMonthX = -999;
    for (let c = 0; c < numCols; c++) {
      const cell = cells[c * 7];
      const dt = new Date(cell.date + 'T00:00:00');
      const m = dt.getMonth();
      const x = leftPad + c * (cellSz + gap);
      if (m !== prevMonth) {
        prevMonth = m;
        if (x - lastMonthX >= 28) {
          lastMonthX = x;
          monthMarks += `<text class="hm-label" x="${x}" y="11">${esc(t('cal.monthLabel', m))}</text>`;
        }
      }
    }

    const rects = cells
      .filter((c) => !c.isFuture)
      .map((c) => {
        const x = leftPad + c.col * (cellSz + gap);
        const y = topPad + c.row * (cellSz + gap);
        const tip = `${c.date}\n${t('cal.tipCost')}: ${fmtUsd(c.rec.costUsd)}\nTokens: ${fmtTokens(c.rec.totalTokens)}\n${t('cal.tipTurns')}: ${num(c.rec.turns)}`;
        const selClass = c.date === selectedDate ? 'selected' : '';
        return `<rect class="hm-cell ${selClass}" x="${x}" y="${y}" width="${cellSz}" height="${cellSz}" rx="2.5" fill="${levelColor(c.val)}" data-action="select-day" data-date="${esc(c.date)}" data-tip="${esc(tip)}" tabindex="0"/>`;
      })
      .join('');

    let drillHtml = '';
    if (state.selectedDay) {
      const sd = state.selectedDay;
      if (sd.loading) {
        drillHtml = `<div class="day-drilldown"><div class="muted-note">${esc(t('cal.loadingDay', { date: sd.date }))}</div></div>`;
      } else if (sd.error) {
        drillHtml = `<div class="day-drilldown"><div class="banner error">${esc(sd.error)}</div></div>`;
      } else if (sd.data) {
        const d = sd.data;
        const tot = d.totals || {};
        const convs = Array.isArray(d.conversations) ? d.conversations : [];
        drillHtml = `
          <div class="day-drilldown">
            <div class="day-drill-head">
              <strong class="num mono" style="font-size:12px">${esc(sd.date)} · ${fmtUsd(tot.costUsd)} · ${fmtTokens(tot.totalTokens)} tok · ${num(tot.turns)} ${esc(t('common.turns'))}</strong>
              <button type="button" class="btn-link" data-action="close-day">${esc(t('common.close'))}</button>
            </div>
            ${
              convs.length
                ? `<div class="day-conv-list">${convs
                    .map(
                      (c) => `
                  <div class="day-conv-row">
                    <div style="min-width:0;flex:1">
                      <div class="truncate" style="font-weight:500" title="${esc(c.title || c.conversationId)}">${esc(c.title || c.conversationId?.slice(0, 8) || t('cal.unnamedSession'))}</div>
                      <div class="muted-note truncate">${esc(sourceLabel(c.source))} · ${esc(baseName(c.workspace))} · ${num(c.turns)} ${esc(t('common.turns'))}</div>
                    </div>
                    <span class="num mono" style="font-weight:600;flex:none">${fmtUsd(c.costUsd)}</span>
                  </div>`
                    )
                    .join('')}</div>`
                : `<div class="muted-note">${esc(t('cal.noConvsDay'))}</div>`
            }
          </div>
        `;
      }
    }

    return `
      <div class="card-expanded">
        <div class="toolbar-inline">
          <div class="seg">
            <button type="button" class="${metric === 'cost' ? 'active' : ''}" data-action="set-cal-metric" data-metric="cost">${esc(t('cal.metricCost'))}</button>
            <button type="button" class="${metric === 'tokens' ? 'active' : ''}" data-action="set-cal-metric" data-metric="tokens">${esc(t('cal.metricTokens'))}</button>
            <button type="button" class="${metric === 'turns' ? 'active' : ''}" data-action="set-cal-metric" data-metric="turns">${esc(t('cal.metricTurns'))}</button>
          </div>
          <div class="hm-legend">
            <span>${esc(t('cal.less'))}</span>
            <span class="hm-swatch" style="background:var(--hm-0)"></span>
            <span class="hm-swatch" style="background:var(--hm-1)"></span>
            <span class="hm-swatch" style="background:var(--hm-2)"></span>
            <span class="hm-swatch" style="background:var(--hm-3)"></span>
            <span class="hm-swatch" style="background:var(--hm-4)"></span>
            <span>${esc(t('cal.more'))}</span>
          </div>
        </div>
        <div class="heatmap-wrap">
          <svg class="hm-svg" width="${svgW}" height="${svgH}" viewBox="0 0 ${svgW} ${svgH}" aria-label="${esc(t('cal.heatmapAria'))}">
            ${monthMarks}
            ${dayLabels.map((l) => `<text class="hm-label" x="1" y="${topPad + l.row * (cellSz + gap) + 9}">${esc(l.text)}</text>`).join('')}
            ${rects}
          </svg>
        </div>
        <div class="muted-note" style="font-size:11px">${esc(t('cal.drillHint'))}</div>
        ${drillHtml}
      </div>
    `;
  }

  // =========================================================================
  // 15. Rendering: Module 6 — Global Cache Observatory
  // =========================================================================
  function sanitizeObsGapBreakpoints(raw) {
    if (!Array.isArray(raw)) return [...DEFAULT_OBS_GAP_BREAKPOINTS];
    const set = new Set();
    for (const v of raw) {
      const n = Math.round(Number(v));
      if (Number.isFinite(n) && n >= 1 && n <= 86400) set.add(n);
    }
    const sorted = [...set].sort((a, b) => a - b).slice(0, 12);
    return sorted.length > 0 ? sorted : [...DEFAULT_OBS_GAP_BREAKPOINTS];
  }

  function fmtGapBpSec(sec) {
    const s = Math.max(1, Math.round(num(sec, 0)));
    if (s < 60) return `${s}s`;
    if (s < 3600) {
      const m = Math.floor(s / 60);
      const rem = s % 60;
      return rem === 0 ? `${m}m` : `${m}m${rem}s`;
    }
    const h = Math.floor(s / 3600);
    const remM = Math.round((s % 3600) / 60);
    return remM === 0 ? `${h}h` : `${h}h${remM}m`;
  }

  function parseGapDurationInput(raw) {
    const s = String(raw || '').trim().toLowerCase().replace(/\s+/g, '');
    if (!s) return null;
    // Supports: "45", "45s", "3m", "1.5m", "45m", "2h", "1.5h", "1m30s", "1h30m"
    const hm = s.match(/^(\d+)h(\d+)m$/);
    if (hm) {
      const sec = Number(hm[1]) * 3600 + Number(hm[2]) * 60;
      return sec >= 1 && sec <= 86400 ? Math.round(sec) : null;
    }
    const ms = s.match(/^(\d+)m(\d+)s$/);
    if (ms) {
      const sec = Number(ms[1]) * 60 + Number(ms[2]);
      return sec >= 1 && sec <= 86400 ? Math.round(sec) : null;
    }
    const single = s.match(/^(\d+(?:\.\d+)?)(s|sec|m|min|h|hr)?$/);
    if (!single) return null;
    const val = Number(single[1]);
    if (!Number.isFinite(val) || val <= 0) return null;
    const unit = single[2] || 's';
    const mult = unit.startsWith('h') ? 3600 : unit.startsWith('m') ? 60 : 1;
    const sec = Math.round(val * mult);
    return sec >= 1 && sec <= 86400 ? sec : null;
  }

  function buildGapPreviewLabels(bps) {
    const arr = sanitizeObsGapBreakpoints(bps);
    const fmtPair = (a, b) => {
      if (a < 60 && b < 60) return `${a}-${b}s`;
      if (a < 60 && b === 60) return `${a}-60s`;
      if (a >= 60 && a < 3600 && a % 60 === 0 && b < 3600 && b % 60 === 0) return `${a / 60}-${b / 60}m`;
      if (a >= 60 && a < 3600 && a % 60 === 0 && b === 3600) return `${a / 60}-60m`;
      if (a >= 3600 && a % 3600 === 0 && b >= 3600 && b % 3600 === 0) return `${a / 3600}-${b / 3600}h`;
      return `${fmtGapBpSec(a)}-${fmtGapBpSec(b)}`;
    };
    const out = [`<=${fmtGapBpSec(arr[0])}`];
    for (let i = 1; i < arr.length; i++) out.push(fmtPair(arr[i - 1], arr[i]));
    out.push(`>${fmtGapBpSec(arr[arr.length - 1])}`);
    return out;
  }

  function getObsMatrixPrefs() {
    const primary = OBS_MATRIX_METRIC_IDS.includes(state.config.obsMatrixPrimary)
      ? state.config.obsMatrixPrimary
      : DEFAULT_CONFIG.obsMatrixPrimary;
    const rawSubs = Array.isArray(state.config.obsMatrixSubMetrics)
      ? state.config.obsMatrixSubMetrics
      : DEFAULT_CONFIG.obsMatrixSubMetrics;
    const subSet = new Set();
    for (const id of rawSubs) {
      if (OBS_MATRIX_METRIC_IDS.includes(id) && id !== primary) {
        subSet.add(id);
      }
    }
    const subs = OBS_MATRIX_METRIC_IDS.filter((id) => subSet.has(id));
    return { primary, subs };
  }

  function fmtUsdCompact(v) {
    const n = num(v, 0);
    if (n <= 0) return '$0';
    if (n < 0.001) return '<$0.001';
    if (n < 0.01) return `$${n.toFixed(3)}`;
    if (n < 10) return `$${n.toFixed(2)}`;
    if (n < 100) return `$${n.toFixed(1)}`;
    return `$${Math.round(n)}`;
  }

  function fmtTurnsCompact(n) {
    const v = Math.max(0, Math.round(num(n, 0)));
    if (v >= 1000) return `${(v / 1000).toFixed(1)}kt`;
    return `${v}t`;
  }

  function getObsMetricRaw(entry, metricId, isTotal) {
    if (!entry) return null;
    const total = isTotal ? num(entry.followUpTurns, 0) : num(entry.total, 0);
    if (total <= 0) return null;
    switch (metricId) {
      case 'keepRate':
        return entry.hitRate != null ? num(entry.hitRate, 0) : null;
      case 'weightedHit':
        return entry.weightedHitRatio != null ? num(entry.weightedHitRatio, 0) : null;
      case 'avgCost':
        return num(entry.avgCostUsd, 0);
      case 'totalCost':
        return num(entry.costUsd, 0);
      case 'missPenalty':
        return num(entry.missPenaltyUsd, 0);
      case 'turns':
        return total;
      default:
        return null;
    }
  }

  function formatObsMetricCell(entry, metricId, isTotal) {
    const val = getObsMetricRaw(entry, metricId, isTotal);
    if (val === null) return '—';
    switch (metricId) {
      case 'keepRate':
      case 'weightedHit':
        return `${Math.round(val * 100)}%`;
      case 'avgCost':
      case 'totalCost':
      case 'missPenalty':
        return fmtUsdCompact(val);
      case 'turns':
        return fmtTurnsCompact(val);
      default:
        return '—';
    }
  }

  function obsHeatCellClass(primaryMetric, val, maxVal, count) {
    if (!count || count <= 0 || val === null || val === undefined) return 'heat-empty';
    if (primaryMetric === 'keepRate' || primaryMetric === 'weightedHit') {
      if (val >= 0.85) return 'heat-deep';
      if (val >= 0.65) return 'heat-soft';
      if (val >= 0.40) return 'heat-amber';
      return 'heat-coral';
    }
    if (primaryMetric === 'missPenalty') {
      if (val <= 0) return 'heat-ok-soft';
      const ratio = maxVal > 0 ? val / maxVal : 1;
      if (ratio >= 0.65) return 'heat-coral';
      if (ratio >= 0.25) return 'heat-amber';
      return 'heat-warn-soft';
    }
    if (primaryMetric === 'avgCost' || primaryMetric === 'totalCost') {
      if (val <= 0) return 'heat-neutral';
      const ratio = maxVal > 0 ? val / maxVal : 0;
      if (ratio >= 0.72) return 'heat-coral';
      if (ratio >= 0.38) return 'heat-amber';
      return 'heat-cost-lo';
    }
    // turns
    const ratio = maxVal > 0 ? val / maxVal : 0;
    if (ratio >= 0.65) return 'heat-vol-hi';
    if (ratio >= 0.25) return 'heat-vol-mid';
    return 'heat-vol-lo';
  }

  function renderObsCellInner(entry, primary, subs, isTotal) {
    const mainStr = formatObsMetricCell(entry, primary, isTotal);
    const subLines = subs
      .map((id) => formatObsMetricCell(entry, id, isTotal))
      .filter((s) => s && s !== '—')
      .map((s) => `<div class="heat-sub">${esc(s)}</div>`)
      .join('');
    return `
      <div class="heat-main">${esc(mainStr)}</div>
      ${subLines}
    `;
  }

  function renderCacheObservatory(expanded) {
    if (state.analyticsError) {
      return {
        badges: `<span class="pill bad">${esc(t('common.readFailed'))}</span>`,
        body: `<div class="banner error">${esc(state.analyticsError)}</div>`
      };
    }

    const co = state.analytics?.cacheObservatory;
    if (!co || !co.summary || num(co.summary.followUpTurns, 0) === 0) {
      return {
        badges: `<span class="pill outline">${esc(t('obs.noDataBadge'))}</span>`,
        body: `<div class="muted-note">${esc(t('obs.noDataBody'))}</div>`
      };
    }

    const sum = co.summary;
    const misses = num(sum.unexpectedFullMisses, 0);
    const cuts = num(sum.boundaryCuts, 0);
    const hitPct = fmtPct(sum.weightedFollowUpHitRatio, 1);

    const badge = misses > 0
      ? `<span class="pill bad num">${esc(t('obs.badgeMiss', { n: misses }))}</span>`
      : `<span class="pill ok num">${esc(t('obs.badgeOk', { pct: fmtPct(sum.weightedFollowUpHitRatio, 0) }))}</span>`;

    let html = `
      <div class="obs-kpi-grid">
        <div class="kpi-tile">
          <span class="kpi-label">${esc(t('obs.kpiFollowHit'))}</span>
          <span class="kpi-val ${num(sum.weightedFollowUpHitRatio) >= 0.85 ? 'ok' : num(sum.weightedFollowUpHitRatio) >= 0.65 ? 'warn' : 'bad'} num mono">${hitPct}</span>
          <span class="kpi-sub num">${esc(t('obs.kpiFollowSub', { n: num(sum.followUpTurns).toLocaleString() }))}</span>
        </div>
        <div class="kpi-tile">
          <span class="kpi-label">${esc(t('obs.kpiFullMiss'))}</span>
          <span class="kpi-val ${misses > 0 ? 'bad' : 'ok'} num mono">${misses}</span>
          <span class="kpi-sub num">${esc(t('obs.kpiBounceSub', { n: num(sum.bounceBackCount) }))}</span>
        </div>
        <div class="kpi-tile">
          <span class="kpi-label">${esc(t('obs.kpiBoundaryCut'))}</span>
          <span class="kpi-val ${cuts > 0 ? 'warn' : ''} num mono">${cuts}</span>
          <span class="kpi-sub num">${esc(t('obs.kpiBoundarySub', { sw: num(sum.modelSwitchTurns), cmp: num(sum.compactedTurns) }))}</span>
        </div>
        <div class="kpi-tile">
          <span class="kpi-label">${esc(t('obs.kpiPenalty'))}</span>
          <span class="kpi-val ${num(sum.missPenaltyUsd) > 0 ? 'bad' : ''} num mono">${fmtUsd(sum.missPenaltyUsd)}</span>
          <span class="kpi-sub num">${esc(t('obs.kpiWastedSub', { tok: fmtTokens(sum.wastedTokens) }))}</span>
        </div>
      </div>
    `;

    if (expanded) {
      html += renderCacheObservatoryExpanded(co);
    }

    return { badges: badge, body: html };
  }

  function renderCacheObservatoryExpanded(co) {
    const activeBps = sanitizeObsGapBreakpoints(
      Array.isArray(state.config.obsGapBreakpointsSec) && state.config.obsGapBreakpointsSec.length
        ? state.config.obsGapBreakpointsSec
        : co.gapBreakpointsSec
    );
    const buckets = Array.isArray(co.gapBuckets) && co.gapBuckets.length
      ? co.gapBuckets
      : buildGapPreviewLabels(activeBps);
    const matrix = Array.isArray(co.matrix) ? co.matrix : [];
    const scatterAll = Array.isArray(co.scatterPoints) ? co.scatterPoints : [];
    const anomalies = Array.isArray(co.topAnomalies) ? co.topAnomalies : [];
    const { primary, subs } = getObsMatrixPrefs();

    // Viz 1: Model x Idle-Gap Configurable Metric Matrix
    let matrixHtml = '';
    if (matrix.length > 0) {
      const totalColMax = matrix.reduce((mx, m) => {
        const v = getObsMetricRaw(m, primary, true);
        return v !== null && v > mx ? v : mx;
      }, 0);

      const rowsHtml = matrix
        .map((m, mIdx) => {
          const bList = Array.isArray(m.buckets) ? m.buckets : [];
          const bMap = new Map(bList.map((b) => [b.key, b]));
          const rowBucketMax = bList.reduce((mx, b) => {
            const v = getObsMetricRaw(b, primary, false);
            return v !== null && v > mx ? v : mx;
          }, 0);

          const totalCount = num(m.followUpTurns, 0);
          const totalVal = getObsMetricRaw(m, primary, true);
          const totalCls = obsHeatCellClass(primary, totalVal, totalColMax, totalCount);
          const totalPinned =
            state.obsPinnedCell &&
            state.obsPinnedCell.modelIdx === mIdx &&
            state.obsPinnedCell.bucketKey === '__total__';

          const bucketTds = buckets
            .map((bk) => {
              const b = bMap.get(bk);
              const cnt = b ? num(b.total, 0) : 0;
              if (!b || cnt === 0) {
                return `<td class="heat-cell heat-empty">—</td>`;
              }
              const val = getObsMetricRaw(b, primary, false);
              const cls = obsHeatCellClass(primary, val, rowBucketMax, cnt);
              const lowNCls = cnt < 5 ? ' heat-low-n' : '';
              const isPinned =
                state.obsPinnedCell &&
                state.obsPinnedCell.modelIdx === mIdx &&
                state.obsPinnedCell.bucketKey === bk;
              return `<td class="heat-cell ${cls}${lowNCls}${isPinned ? ' is-pinned' : ''}" data-obs-cell="1" data-model-idx="${mIdx}" data-bucket-key="${esc(bk)}" tabindex="0">${renderObsCellInner(b, primary, subs, false)}</td>`;
            })
            .join('');

          const totalLowN = totalCount > 0 && totalCount < 5 ? ' heat-low-n' : '';
          return `
            <tr>
              <td>
                <div class="obs-model-cell" title="${esc(m.canonicalId)}">
                  <span class="obs-model-name truncate">${esc(m.displayName || m.canonicalId)}</span>
                  <span class="obs-model-meta num">${num(m.followUpTurns)}t${num(m.unexpectedFullMisses) > 0 ? ` · ${num(m.unexpectedFullMisses)}m` : ''}</span>
                </div>
              </td>
              <td class="heat-cell heat-total-col ${totalCls}${totalLowN}${totalPinned ? ' is-pinned' : ''}" data-obs-cell="1" data-model-idx="${mIdx}" data-bucket-key="__total__" tabindex="0">${renderObsCellInner(m, primary, subs, true)}</td>
              ${bucketTds}
            </tr>
          `;
        })
        .join('');

      const primaryShort = t(`obs.metricShort.${primary}`);
      const primaryFull = t(`obs.metricFull.${primary}`);
      const subLegend = subs.length > 0
        ? t('obs.matrixLegendSub', { subs: subs.map((id) => t(`obs.metricShort.${id}`)).join(' / ') })
        : '';
      const legendText = t('obs.matrixLegend', { primary: primaryFull, sub: subLegend });
      const triggerLabel = `${primaryShort}${subs.length > 0 ? ` +${subs.length}` : ''}`;

      const menuHtml = state.obsMetricMenuOpen
        ? `
          <div class="obs-metric-popover" data-stop-card role="dialog" aria-label="${esc(t('obs.matrixCfgTitle'))}">
            <div class="obs-mp-head">
              <span class="obs-mp-title">${esc(t('obs.matrixCfgTitle'))}</span>
              <button type="button" class="obs-mp-reset" data-action="reset-obs-metrics">${esc(t('obs.matrixReset'))}</button>
            </div>
            <div class="obs-mp-grid obs-mp-cols-head">
              <span>${esc(t('obs.matrixColMetric'))}</span>
              <span class="obs-mp-c">${esc(t('obs.matrixColPrimary'))}</span>
              <span class="obs-mp-c">${esc(t('obs.matrixColSub'))}</span>
            </div>
            ${OBS_MATRIX_METRIC_IDS.map((id) => {
              const isPrimary = id === primary;
              const isSub = subs.includes(id);
              return `
                <div class="obs-mp-grid obs-mp-row ${isPrimary ? 'is-primary' : ''}">
                  <span class="obs-mp-name">${esc(t(`obs.metricFull.${id}`))}</span>
                  <button type="button" class="obs-mp-radio ${isPrimary ? 'active' : ''}" data-action="set-obs-primary" data-metric="${id}" aria-pressed="${isPrimary ? 'true' : 'false'}" aria-label="${esc(t(`obs.metricFull.${id}`))}">
                    <span class="obs-mp-dot"></span>
                  </button>
                  ${
                    isPrimary
                      ? `<span class="obs-mp-main-tag">${esc(t('obs.matrixPrimaryTag'))}</span>`
                      : `<button type="button" class="obs-mp-check ${isSub ? 'active' : ''}" data-action="toggle-obs-sub" data-metric="${id}" aria-pressed="${isSub ? 'true' : 'false'}" aria-label="${esc(t(`obs.metricFull.${id}`))}">${isSub ? '✓' : ''}</button>`
                  }
                </div>
              `;
            }).join('')}
            <div class="obs-mp-note">${esc(t('obs.matrixCfgNote'))}</div>
          </div>
        `
        : '';

      const maxBpLabel = fmtGapBpSec(activeBps[activeBps.length - 1]);
      const gapTriggerLabel = t('obs.gapBtnLabel', { max: maxBpLabel });
      const customBps = activeBps.filter((s) => !OBS_GAP_PRESETS.includes(s));
      const previewLabels = buildGapPreviewLabels(activeBps);

      const gapMenuHtml = state.obsGapMenuOpen
        ? `
          <div class="obs-metric-popover obs-gap-popover" data-stop-card role="dialog" aria-label="${esc(t('obs.gapCfgTitle'))}">
            <div class="obs-mp-head">
              <span class="obs-mp-title">${esc(t('obs.gapCfgTitle'))}</span>
              <button type="button" class="obs-mp-reset" data-action="reset-obs-gaps">${esc(t('obs.matrixReset'))}</button>
            </div>
            <div class="obs-gap-subhead">${esc(t('obs.gapPresetsLabel'))}</div>
            <div class="obs-gap-chips">
              ${OBS_GAP_PRESETS.map((sec) => {
                const on = activeBps.includes(sec);
                return `<button type="button" class="obs-gap-chip mono ${on ? 'active' : ''}" data-action="toggle-obs-gap-preset" data-sec="${sec}" aria-pressed="${on ? 'true' : 'false'}">${esc(fmtGapBpSec(sec))}</button>`;
              }).join('')}
            </div>
            <div class="obs-gap-subhead">${esc(t('obs.gapCustomLabel'))}</div>
            <div class="obs-gap-input-row">
              <input type="text" class="obs-gap-input mono" data-obs-gap-input="1" value="${esc(state.obsGapDraft)}" placeholder="${esc(t('obs.gapCustomPlaceholder'))}">
              <button type="button" class="btn-sm" data-action="add-obs-gap-custom">${esc(t('obs.gapAddBtn'))}</button>
            </div>
            ${state.obsGapError ? `<div class="obs-gap-err">${esc(state.obsGapError)}</div>` : ''}
            ${
              customBps.length > 0
                ? `<div class="obs-gap-custom-list">
                    <span class="obs-gap-subhead" style="margin:0">${esc(t('obs.gapCustomTags'))}</span>
                    ${customBps
                      .map(
                        (sec) =>
                          `<button type="button" class="obs-gap-chip active custom mono" data-action="remove-obs-gap-custom" data-sec="${sec}">${esc(fmtGapBpSec(sec))} ×</button>`
                      )
                      .join('')}
                  </div>`
                : ''
            }
            <div class="obs-gap-preview">
              <div class="obs-gap-subhead" style="margin:0 0 3px">${esc(t('obs.gapPreviewLabel', { n: previewLabels.length }))}</div>
              <div class="obs-gap-preview-list mono">${esc(previewLabels.join(' · '))}</div>
            </div>
            <div class="obs-mp-note">${esc(t('obs.gapCfgNote'))}</div>
          </div>
        `
        : '';

      matrixHtml = `
        <div class="obs-section">
          <div class="obs-section-head">
            <span class="obs-section-title">${esc(t('obs.matrixTitle'))}</span>
            <div class="obs-matrix-ctrls" data-stop-card>
              <div class="obs-metric-ctrl">
                <button type="button" class="obs-metric-trigger ${state.obsGapMenuOpen ? 'active' : ''}" data-action="toggle-obs-gap-menu" aria-expanded="${state.obsGapMenuOpen ? 'true' : 'false'}">
                  <span>${esc(gapTriggerLabel)}</span>
                  <span class="obs-caret" aria-hidden="true">▾</span>
                </button>
                ${gapMenuHtml}
              </div>
              <div class="obs-metric-ctrl">
                <button type="button" class="obs-metric-trigger ${state.obsMetricMenuOpen ? 'active' : ''}" data-action="toggle-obs-metric-menu" aria-expanded="${state.obsMetricMenuOpen ? 'true' : 'false'}">
                  <span>${esc(triggerLabel)}</span>
                  <span class="obs-caret" aria-hidden="true">▾</span>
                </button>
                ${menuHtml}
              </div>
            </div>
          </div>
          <div class="obs-matrix-legend">${esc(legendText)}</div>
          <div class="obs-matrix-wrap">
            <table class="obs-matrix-table${subs.length > 0 ? ' has-sub' : ''}">
              <thead>
                <tr>
                  <th>${esc(t('obs.colModel'))}</th>
                  <th class="obs-th-total">${esc(t('obs.colTotal'))}</th>
                  ${buckets.map((bk) => `<th class="mono">${esc(bk)}</th>`).join('')}
                </tr>
              </thead>
              <tbody>${rowsHtml}</tbody>
            </table>
          </div>
        </div>
      `;
    }

    // Viz 2: Idle-Gap vs Hit-Rate Log Scatter Plot
    const filterModels = matrix.slice(0, 6);
    const activeFilter =
      state.obsModelFilter === 'all' || filterModels.some((m) => m.canonicalId === state.obsModelFilter)
        ? state.obsModelFilter
        : 'all';

    const filteredPts = scatterAll.filter(
      (pt) =>
        pt &&
        pt.idleGapMs != null &&
        Number.isFinite(Number(pt.idleGapMs)) &&
        (activeFilter === 'all' || pt.modelId === activeFilter)
    );

    const W = 480;
    const H = 152;
    const padL = 32;
    const padR = 12;
    const padT = 10;
    const padB = 22;
    const plotW = W - padL - padR;
    const plotH = H - padT - padB;
    const maxBpMs = (activeBps[activeBps.length - 1] || 3600) * 1000;
    const MAX_X_MS = Math.max(600000, Math.min(86400000 * 1.25, Math.round(maxBpMs * 1.5)));
    const LOG_MIN = Math.log10(500);     // 0.5s
    const LOG_MAX = Math.log10(MAX_X_MS);

    const xForMs = (ms) => {
      const clamped = clamp(num(ms, 500), 500, MAX_X_MS);
      const frac = (Math.log10(clamped) - LOG_MIN) / (LOG_MAX - LOG_MIN);
      return padL + frac * plotW;
    };
    const yForRatio = (r) => padT + (1 - clamp(num(r, 0), 0, 1)) * plotH;

    const candidateTicks = [
      { ms: 1000, label: '1s' },
      { ms: 5000, label: '5s' },
      { ms: 10000, label: '10s' },
      { ms: 20000, label: '20s' },
      { ms: 60000, label: '1m' },
      { ms: 300000, label: '5m' },
      { ms: 900000, label: '15m' },
      { ms: 3600000, label: '1h' },
      { ms: 7200000, label: '2h' },
      { ms: 21600000, label: '6h' },
      { ms: 86400000, label: '24h' }
    ];
    const xTicks = [];
    for (const tk of candidateTicks) {
      if (tk.ms > MAX_X_MS * 0.96) continue;
      const xPos = xForMs(tk.ms);
      if (xTicks.length === 0 || xPos - xForMs(xTicks[xTicks.length - 1].ms) >= 48) {
        xTicks.push(tk);
      }
    }
    const yTicks = [
      { r: 1, label: '100%' },
      { r: 0.5, label: '50%' },
      { r: 0, label: '0%' }
    ];

    const gridSvg = `
      ${yTicks
        .map((tk) => {
          const y = yForRatio(tk.r);
          return `
            <line x1="${padL}" y1="${y.toFixed(1)}" x2="${W - padR}" y2="${y.toFixed(1)}" stroke="var(--line)" stroke-width="1"/>
            <text class="obs-axis-label mono" x="${padL - 5}" y="${(y + 3).toFixed(1)}" text-anchor="end">${tk.label}</text>
          `;
        })
        .join('')}
      ${xTicks
        .map((tk) => {
          const x = xForMs(tk.ms);
          return `
            <line x1="${x.toFixed(1)}" y1="${padT}" x2="${x.toFixed(1)}" y2="${padT + plotH}" stroke="var(--line)" stroke-width="1" stroke-dasharray="2,2"/>
            <text class="obs-axis-label mono" x="${x.toFixed(1)}" y="${H - 5}" text-anchor="middle">${tk.label}</text>
          `;
        })
        .join('')}
    `;

    // Order points so anomalies always render above normal hits
    const kindOrder = { hit: 0, low_hit: 1, boundary_cut: 2, unexpected_full_miss: 3 };
    const sortedPts = [...filteredPts].sort(
      (a, b) => (kindOrder[a.kind] ?? 0) - (kindOrder[b.kind] ?? 0)
    );

    const kindLabel = (k) => {
      if (k === 'unexpected_full_miss') return t('obs.kindFullMiss');
      if (k === 'boundary_cut') return t('obs.kindBoundary');
      if (k === 'low_hit') return t('obs.kindLowHit');
      return t('obs.kindHit');
    };

    const ptsSvg = sortedPts
      .map((pt) => {
        const cx = xForMs(pt.idleGapMs);
        const cy = yForRatio(pt.hitRatio);
        const prevStr = pt.prevHitRatio != null ? fmtPct(pt.prevHitRatio, 0) : '—';
        const curStr = fmtPct(pt.hitRatio, 0);
        const nextStr = pt.nextHitRatio != null ? fmtPct(pt.nextHitRatio, 0) : '—';
        const tipLines = [
          `${pt.displayName || pt.modelId} · ${kindLabel(pt.kind)}`,
          `${t('obs.tipIdleGap')}: ${fmtDurationMs(pt.idleGapMs)} · ${t('obs.tipStartGap')}: ${fmtDurationMs(pt.startGapMs)}`,
          `${t('obs.tipSeq')}: ${prevStr} → ${curStr} → ${nextStr}`
        ];
        if (pt.kind === 'unexpected_full_miss' || pt.kind === 'boundary_cut') {
          tipLines.push(`${t('obs.tipBounce')}: ${pt.bounceBack ? t('obs.bounceYes') : t('obs.bounceNo')}`);
          tipLines.push(`${t('obs.tipPenalty')}: ${fmtTokens(pt.wastedTokens)} tok / ${fmtUsd(pt.penaltyUsd)}`);
        }
        const tipAttr = esc(tipLines.join('\n'));

        if (pt.kind === 'unexpected_full_miss') {
          return `<circle class="obs-pt" cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="4" fill="var(--bad)" fill-opacity="0.92" stroke="var(--surface)" stroke-width="0.8" data-tip="${tipAttr}" tabindex="0"/>`;
        }
        if (pt.kind === 'boundary_cut') {
          const s = 4.2;
          const p1 = `${cx.toFixed(1)},${(cy - s).toFixed(1)}`;
          const p2 = `${(cx - s * 0.9).toFixed(1)},${(cy + s * 0.75).toFixed(1)}`;
          const p3 = `${(cx + s * 0.9).toFixed(1)},${(cy + s * 0.75).toFixed(1)}`;
          return `<polygon class="obs-pt" points="${p1} ${p2} ${p3}" fill="var(--warn)" fill-opacity="0.92" stroke="var(--surface)" stroke-width="0.6" data-tip="${tipAttr}" tabindex="0"/>`;
        }
        if (pt.kind === 'low_hit') {
          return `<circle class="obs-pt" cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="2.6" fill="var(--fg-muted)" fill-opacity="0.55" data-tip="${tipAttr}"/>`;
        }
        return `<circle class="obs-pt" cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="2.8" fill="var(--ch-uncached)" fill-opacity="0.55" data-tip="${tipAttr}"/>`;
      })
      .join('');

    const scatterHtml = `
      <div class="obs-section">
        <div class="obs-section-head">
          <span class="obs-section-title">${esc(t('obs.scatterTitle'))}</span>
          <div class="legend-inline">
            <span class="legend-item"><span class="legend-swatch" style="background:var(--ch-uncached);border-radius:50%"></span>${esc(t('obs.legendHit'))}</span>
            <span class="legend-item"><span class="legend-swatch" style="background:var(--bad);border-radius:50%"></span>${esc(t('obs.legendFullMiss'))}</span>
            <span class="legend-item"><span class="legend-swatch" style="background:var(--warn)"></span>${esc(t('obs.legendBoundary'))}</span>
            <span class="legend-item"><span class="legend-swatch" style="background:var(--fg-muted);border-radius:50%"></span>${esc(t('obs.legendLowHit'))}</span>
          </div>
        </div>
        <div class="obs-scatter-box">
          ${
            filterModels.length > 1
              ? `<div class="obs-filter-pills">
                  <button type="button" class="sort-btn ${activeFilter === 'all' ? 'active' : ''}" data-action="set-obs-filter" data-model="all">${esc(t('obs.filterAll'))}</button>
                  ${filterModels
                    .map(
                      (m) =>
                        `<button type="button" class="sort-btn ${activeFilter === m.canonicalId ? 'active' : ''}" data-action="set-obs-filter" data-model="${esc(m.canonicalId)}">${esc(m.displayName || m.canonicalId)}</button>`
                    )
                    .join('')}
                </div>`
              : ''
          }
          ${
            sortedPts.length > 0
              ? `<svg class="obs-scatter-svg" viewBox="0 0 ${W} ${H}" aria-label="${esc(t('obs.scatterAria'))}">
                  ${gridSvg}
                  ${ptsSvg}
                </svg>`
              : `<div class="muted-note">${esc(t('obs.noScatterPoints'))}</div>`
          }
        </div>
      </div>
    `;

    // Collapsible Top Anomalies + One-Click Copy Issue Markdown
    const copyLabel =
      state.obsCopyStatus === 'copied'
        ? t('common.copied')
        : state.obsCopyStatus === 'failed'
          ? t('common.copyFailed')
          : t('obs.copyIssue');
    const copyCls = state.obsCopyStatus === 'copied' ? 'ok' : '';

    let anomaliesHtml = '';
    if (state.obsAnomaliesOpen) {
      if (anomalies.length === 0) {
        anomaliesHtml = `<div class="muted-note">${esc(t('obs.noAnomalies'))}</div>`;
      } else {
        anomaliesHtml = `
          <div class="obs-anomaly-list">
            ${anomalies
              .map((a) => {
                const isMiss = a.kind === 'unexpected_full_miss';
                const kindPill = `<span class="pill ${isMiss ? 'bad' : 'warn'}">${esc(kindLabel(a.kind))}</span>`;
                const bouncePill = a.bounceBack ? `<span class="pill ok">${esc(t('obs.bounceBadge'))}</span>` : '';
                const reqRaw = String(a.providerRequestId || '');
                const reqShort = reqRaw ? `${reqRaw.slice(0, 14)}${reqRaw.length > 14 ? '…' : ''}` : '—';
                const seqStr = `${fmtPct(a.before?.hitRatio, 0)} → ${fmtPct(a.miss?.hitRatio, 0)} → ${a.after ? fmtPct(a.after.hitRatio, 0) : '—'}`;
                return `
                  <div class="obs-anomaly-row">
                    <div class="obs-anomaly-top">
                      <div style="display:flex;align-items:center;gap:5px;min-width:0;flex-wrap:wrap">
                        <strong class="truncate" style="font-size:11.5px">${esc(a.displayName || a.modelId)}</strong>
                        ${kindPill}
                        ${bouncePill}
                      </div>
                      <span class="num mono" style="color:var(--bad);font-weight:600">-${fmtUsd(a.penaltyUsd)} <span class="muted-note" style="font-weight:400">(${fmtTokens(a.wastedTokens)} tok)</span></span>
                    </div>
                    <div class="obs-anomaly-sub num muted-note">
                      <span>Idle ${fmtDurationMs(a.idleGapMs)} / Start ${fmtDurationMs(a.startGapMs)}</span>
                      <span class="mono" style="color:var(--fg-2)">${seqStr}</span>
                      <span class="mono truncate" title="${esc(reqRaw)}">${esc(reqShort)}</span>
                    </div>
                  </div>
                `;
              })
              .join('')}
          </div>
        `;
      }
    }

    const actionsHtml = `
      <div class="obs-section">
        <div class="obs-actions-row">
          <button type="button" class="btn-sm" data-action="toggle-obs-anomalies">
            ${esc(state.obsAnomaliesOpen ? t('obs.hideAnomalies', { n: anomalies.length }) : t('obs.showAnomalies', { n: anomalies.length }))}
          </button>
          <button type="button" class="btn-sm ${copyCls}" data-action="copy-obs-issue" ${!co.issueMarkdown ? 'disabled' : ''}>
            ${esc(copyLabel)}
          </button>
        </div>
        ${anomaliesHtml}
      </div>
    `;

    return `
      <div class="card-expanded">
        ${matrixHtml}
        ${scatterHtml}
        ${actionsHtml}
      </div>
    `;
  }

  // =========================================================================
  // 16. Rendering: Module 7 — Quota Alignment & Cycle Budget
  // =========================================================================
  function renderQuotaBudget(expanded) {
    const mode = state.config.quotaDisplayMode === 'used' ? 'used' : 'remaining';
    const modeToggle = `
      <div class="seg" data-stop-card>
        <button type="button" class="${mode === 'remaining' ? 'active' : ''}" data-action="set-quota-mode" data-mode="remaining">${esc(t('quota.remaining'))}</button>
        <button type="button" class="${mode === 'used' ? 'active' : ''}" data-action="set-quota-mode" data-mode="used">${esc(t('quota.used'))}</button>
      </div>
    `;

    if (state.quotaError) {
      return { badges: modeToggle, body: `<div class="banner error">${esc(state.quotaError)}</div>` };
    }

    const qd = state.quotaData || {};
    const summaries = Array.isArray(qd.summaries) ? qd.summaries : [];
    const anchors = Array.isArray(qd.anchors) ? qd.anchors : [];
    const activeSummaries = summaries.filter((s) => s.latestAnchor != null);

    let compactHtml = '';
    if (activeSummaries.length > 0) {
      compactHtml = `<div class="quota-pool-grid">${activeSummaries
        .map((s) => {
          if (s.cycleExpired) {
            const expStatus =
              s.cycleState === 'awaiting_activity'
                ? t('quota.cycleAwaiting')
                : t('quota.cycleExpiredNew', { usd: fmtUsd(s.cycleSpendUsd) });
            const infSpanHtml =
              s.cycleWindowStart != null && s.cycleResetAt != null
                ? `<div class="quota-cycle-span num mono">${esc(
                    t('quota.cycleWindowInferred', {
                      start: fmtTimeShort(s.cycleWindowStart),
                      end: fmtTimeShort(s.cycleResetAt),
                    })
                  )}</div>`
                : '';
            const prevRefHtml =
              s.previousCycleEstimation?.estimatedPoolUsd != null
                ? `<div class="quota-ref-note num mono">${esc(
                    t('quota.prevCycleRef', { usd: fmtUsd(s.previousCycleEstimation.estimatedPoolUsd) })
                  )}</div>`
                : '';
            return `
              <div class="quota-pool-card">
                <div class="quota-pool-top">
                  <span class="pill accent">${esc(poolLabel(s.pool))} · ${esc(s.windowType)}</span>
                  <span class="pill warn">${esc(t('quota.statusNewCycle'))}</span>
                </div>
                <div class="quota-sub num" style="color:var(--fg-2);font-weight:500">${esc(expStatus)}</div>
                ${infSpanHtml}
                ${prevRefHtml}
              </div>
            `;
          }

          const latest = s.latestAnchor;
          const remPct = num(latest.remainingPct ?? latest.remaining_pct, 0);
          const step = num(latest.precisionStep ?? latest.precision_step, 1);
          const capAt = num(latest.capturedAt ?? latest.captured_at, 0);
          const shownPct = mode === 'used' ? 100 - remPct : remPct;
          const projRem = s.projectedRemainingPct;
          const projShown = projRem != null ? (mode === 'used' ? 100 - num(projRem) : num(projRem)) : null;

          let paceBadge = '';
          if (s.evenUsePaceRatio != null && Number.isFinite(Number(s.evenUsePaceRatio))) {
            const pr = Number(s.evenUsePaceRatio);
            const cls = pr > 1.3 ? 'bad' : pr > 1.05 ? 'warn' : 'ok';
            const lbl = pr > 1.3 ? t('quota.paceFastBad') : pr > 1.05 ? t('quota.paceFastWarn') : t('quota.paceOk');
            paceBadge = `<span class="pill ${cls} num">${esc(t('quota.paceLabel', { ratio: pr.toFixed(2), lbl }))}</span>`;
          }

          const conflictBadge = s.resetConflict
            ? `<span class="pill warn" title="${esc(t('quota.resetConflictHint'))}">${esc(t('quota.resetConflictBadge'))}</span>`
            : '';
          const bootBadge = s.estimation?.originBootstrap
            ? `<span class="pill accent">${esc(t('quota.originBootBadge'))}</span>`
            : '';

          const cycleSpanHtml =
            s.cycleWindowStart != null && s.cycleResetAt != null
              ? `<div class="quota-cycle-span num mono">${esc(
                  t(s.cycleInferred ? 'quota.cycleWindowInferred' : 'quota.cycleWindow', {
                    start: fmtTimeShort(s.cycleWindowStart),
                    end:
                      s.cycleInferred &&
                      s.cycleResetEarliest != null &&
                      s.cycleResetLatest != null &&
                      s.cycleResetLatest - s.cycleResetEarliest > 30 * 60 * 1000
                        ? `${fmtTimeShort(s.cycleResetEarliest)}~${fmtTimeShort(s.cycleResetLatest)}`
                        : fmtTimeShort(s.cycleResetAt),
                  })
                )}</div>`
              : '';

          const cycleSpendLine =
            s.cycleSpendUsd != null && s.cycleWindowStart != null
              ? `<div class="quota-sub num">${esc(t('quota.cycleTotalSpend', { usd: fmtUsd(s.cycleSpendUsd) }))}</div>`
              : '';

          const badgesRow = `${paceBadge}${bootBadge}${conflictBadge}`;
          return `
            <div class="quota-pool-card">
              <div class="quota-pool-top">
                <span class="pill accent">${esc(poolLabel(s.pool))} · ${esc(s.windowType)}</span>
                <span class="muted-note num" style="font-size:10.5px">${fmtRelTime(capAt)}</span>
              </div>
              <div class="quota-pct num mono">${esc(mode === 'used' ? t('quota.used') : t('quota.remaining'))} ${fmtPctDirect(shownPct, step)}</div>
              <div class="quota-sub num">
                ${projShown != null ? esc(t('quota.projectedNow', { pct: fmtPctDirect(projShown, 0.1) })) : esc(t('quota.spentSince', { usd: fmtUsd(s.spendSinceLastUsd) }))}
              </div>
              ${cycleSpendLine}
              ${cycleSpanHtml}
              ${badgesRow ? `<div style="display:flex;gap:4px;flex-wrap:wrap">${badgesRow}</div>` : ''}
            </div>
          `;
        })
        .join('')}</div>`;
    } else {
      compactHtml = `<div class="muted-note">${esc(t('quota.emptyDesc'))}</div>`;
    }

    let html = compactHtml;
    if (expanded) {
      html += renderQuotaExpanded(summaries, anchors, mode);
    }

    return { badges: modeToggle, body: html };
  }

  function renderQuotaExpanded(summaries, anchors, mode) {
    const f = state.quotaForm;
    const baseCapturedAt = getFormCapturedAtMs(f);
    const parsedReset = parseResetInput(f.resetInput, baseCapturedAt, f.windowType);
    const inheritableResetAt = getInheritableResetAt(f.pool, f.windowType);
    const resetEmptyHint = inheritableResetAt
      ? t('quota.resetInheritHint', { time: fmtResetClock(inheritableResetAt) })
      : t('quota.resetHint');

    let expHtml = `
      <div class="card-expanded">
        <form id="quota-anchor-form" class="quota-form">
          <h3 class="form-title">${esc(t('quota.formTitle'))}</h3>
          <div class="form-grid">
            <div class="field">
              <label for="qa-pool">${esc(t('quota.poolLabel'))}</label>
              <select id="qa-pool" name="pool">
                <option value="gemini" ${f.pool === 'gemini' ? 'selected' : ''}>Gemini</option>
                <option value="argon" ${f.pool === 'argon' ? 'selected' : ''}>Argon</option>
                <option value="3p" ${f.pool === '3p' ? 'selected' : ''}>${esc(t('quota.pool3p'))}</option>
              </select>
            </div>
            <div class="field">
              <label for="qa-window">${esc(t('quota.windowLabel'))}</label>
              <select id="qa-window" name="windowType">
                <option value="7d" ${f.windowType === '7d' ? 'selected' : ''}>${esc(t('quota.win7d'))}</option>
                <option value="5h" ${f.windowType === '5h' ? 'selected' : ''}>${esc(t('quota.win5h'))}</option>
              </select>
            </div>
            <div class="field full">
              <label for="qa-pct">${esc(t('quota.pctLabel'))}</label>
              <input id="qa-pct" name="remainingPct" type="number" step="0.01" min="0" max="100" placeholder="${esc(t('quota.pctPlaceholder'))}" value="${esc(f.remainingPct)}" required>
              <span class="field-hint">${esc(t('quota.pctHint'))}</span>
            </div>
            <div class="field">
              <label for="qa-reset">${esc(t('quota.resetLabel'))}</label>
              <input id="qa-reset" name="resetInput" type="text" placeholder="${esc(t('quota.resetPlaceholder'))}" value="${esc(f.resetInput)}">
              ${
                f.resetInput
                  ? `<span class="field-hint" style="color:${parsedReset.ok ? 'var(--ok)' : 'var(--bad)'}">${esc(parsedReset.preview)}</span>`
                  : `<span class="field-hint">${esc(resetEmptyHint)}</span>`
              }
            </div>
            <div class="field">
              <label>${esc(t('quota.captureTimeLabel'))}</label>
              <div class="quick-chips">
                <button type="button" class="quick-chip ${f.captureOffsetMin === 0 ? 'active' : ''}" data-action="set-qa-offset" data-offset="0">${esc(t('quota.now'))}</button>
                <button type="button" class="quick-chip ${f.captureOffsetMin === -5 ? 'active' : ''}" data-action="set-qa-offset" data-offset="-5">-5m</button>
                <button type="button" class="quick-chip ${f.captureOffsetMin === -15 ? 'active' : ''}" data-action="set-qa-offset" data-offset="-15">-15m</button>
                <button type="button" class="quick-chip ${f.captureOffsetMin === 'custom' ? 'active' : ''}" data-action="set-qa-offset" data-offset="custom">${esc(t('quota.custom'))}</button>
              </div>
              ${
                f.captureOffsetMin === 'custom'
                  ? `<input id="qa-custom-time" type="datetime-local" value="${esc(f.customCaptureAt)}" style="margin-top:4px">`
                  : ''
              }
            </div>
            <div class="field full">
              <label for="qa-note">${esc(t('quota.noteLabel'))}</label>
              <input id="qa-note" name="note" type="text" placeholder="${esc(t('quota.notePlaceholder'))}" value="${esc(f.note)}">
            </div>
          </div>
          ${f.error ? `<div class="banner error" style="margin:0">${esc(f.error)}</div>` : ''}
          <div style="display:flex;justify-content:flex-end;gap:8px">
            <button type="submit" class="btn-sm primary" ${f.submitting || isReadOnlyMode() ? 'disabled' : ''}>${esc(f.submitting ? t('quota.submitting') : t('quota.submitBtn'))}</button>
          </div>
        </form>
    `;

    const estList = summaries.filter(
      (s) =>
        (s.estimation && s.estimation.status !== 'no_data') ||
        (s.cycleExpired && (s.previousCycleEstimation != null || s.cycleSpendUsd > 0 || s.latestAnchor != null))
    );
    if (estList.length > 0) {
      expHtml += estList
        .map((s) => {
          if (s.cycleExpired) {
            const expStatus =
              s.cycleState === 'awaiting_activity'
                ? t('quota.cycleAwaiting')
                : t('quota.cycleExpiredNew', { usd: fmtUsd(s.cycleSpendUsd) });
            const infSpanHtml =
              s.cycleWindowStart != null && s.cycleResetAt != null
                ? `<div class="quota-cycle-span num mono">${esc(
                    t('quota.cycleWindowInferred', {
                      start: fmtTimeShort(s.cycleWindowStart),
                      end: fmtTimeShort(s.cycleResetAt),
                    })
                  )}</div>`
                : '';
            const prevRef = s.previousCycleEstimation;
            const prevRefHtml =
              prevRef?.estimatedPoolUsd != null
                ? `<div class="quota-ref-note num mono">${esc(
                    t('quota.prevCycleRef', { usd: fmtUsd(prevRef.estimatedPoolUsd) })
                  )}${
                    prevRef.cycleWindowStart != null && prevRef.cycleResetAt != null
                      ? ` (${fmtTimeShort(prevRef.cycleWindowStart)} → ${fmtTimeShort(prevRef.cycleResetAt)})`
                      : ''
                  }</div>`
                : '';
            return `
              <div class="est-card">
                <div class="est-head">
                  <div class="est-head-left">
                    <span style="font-weight:600;font-size:12px">${esc(t('quota.impliedTitle', { pool: poolLabel(s.pool), wt: s.windowType }))}</span>
                  </div>
                  <span class="pill warn">${esc(t('quota.statusNewCycle'))}</span>
                </div>
                ${infSpanHtml}
                <div class="muted-note num" style="color:var(--fg-2)">${esc(expStatus)}</div>
                ${prevRefHtml}
              </div>
            `;
          }

          const e = s.estimation;
          const cal = e.calibration || null;
          const activeSubset = cal?.activeSubset || 'base';
          const subsets = cal?.subsets || {};
          const activeSubObj = subsets[activeSubset] || subsets.base || null;
          const activeFactors = cal?.activeFactors || subsetKeyToFactors(activeSubset);
          const statusMap = {
            ok: { cls: 'ok', text: t('quota.statusOk') },
            low_confidence: { cls: 'warn', text: t('quota.statusLow') },
            calibrating: { cls: 'outline', text: t('quota.statusCal') }
          };
          const st = statusMap[e.status] || { cls: 'outline', text: e.status };
          const deltaPct = num(e.totalDeltaPct, 0);
          const mix = Array.isArray(e.modelMix) ? e.modelMix : [];
          const isBoot = Boolean(e.originBootstrap);

          const calibBadgeHtml = isBoot
            ? `<span class="pill accent">${esc(t('quota.originBootBadge'))}</span>`
            : cal
              ? `
                <span class="pill ${activeSubset !== 'base' ? 'accent' : 'outline'}">${esc(calibSubsetLabel(activeSubset))}</span>
                ${helpTip(t('quota.calibBadgeHelp'))}
              `
              : '';

          const conflictBadgeHtml = s.resetConflict
            ? `<span class="pill warn" title="${esc(t('quota.resetConflictHint'))}">${esc(t('quota.resetConflictBadge'))}</span>`
            : '';

          const weightStripHtml =
            !isBoot && cal && activeSubset !== 'base' && activeSubObj ? renderCalibWeightStrip(activeSubObj) : '';
          const calibLabHtml = !isBoot && cal ? buildCalibrationLabHtml(s, cal) : '';

          const estCycleHtml =
            s.cycleWindowStart != null && s.cycleResetAt != null
              ? `<div class="quota-cycle-span num mono">${esc(
                  t('quota.cycleWindow', {
                    start: fmtTimeShort(s.cycleWindowStart),
                    end: fmtTimeShort(s.cycleResetAt),
                  })
                )} · ${esc(t('quota.cycleTotalSpend', { usd: fmtUsd(s.cycleSpendUsd ?? e.cycleSpendUsd ?? e.windowSpendUsd) }))}</div>`
              : '';

          const ciText =
            e.ciLowUsd != null && e.ciHighUsd != null
              ? `95% CI [${fmtUsd(e.ciLowUsd)}, ${fmtUsd(e.ciHighUsd)}]`
              : e.ciLowUsd != null
                ? `95% CI ${t('quota.ciOpenHigh', { low: fmtUsd(e.ciLowUsd) })}`
                : '';

          const refLineHtml =
            !isBoot && e.cycleOriginRefPoolUsd != null
              ? `<div class="quota-ref-note num mono">${esc(t('quota.cycleOriginRef', { usd: fmtUsd(e.cycleOriginRefPoolUsd) }))}</div>`
              : '';

          return `
            <div class="est-card">
              <div class="est-head">
                <div class="est-head-left">
                  <span style="font-weight:600;font-size:12px">${esc(t('quota.impliedTitle', { pool: poolLabel(s.pool), wt: s.windowType }))}</span>
                  ${calibBadgeHtml}
                  ${conflictBadgeHtml}
                </div>
                <span class="pill ${st.cls}">${esc(st.text)}</span>
              </div>
              ${estCycleHtml}
              ${
                e.status === 'calibrating'
                  ? `
                    ${
                      e.estimatedPoolUsd != null
                        ? `<div class="est-total num mono" style="opacity:0.78">~${fmtUsd(e.estimatedPoolUsd)} <span class="muted-note" style="font-size:11px;font-weight:400">(${esc(st.text)})</span></div>`
                        : ''
                    }
                    <div class="muted-note num">${esc(t('quota.calDesc', { du: deltaPct.toFixed(2), seg: num(e.segmentsUsed), usd: fmtUsd(e.cycleSpendUsd ?? e.windowSpendUsd) }))}</div>
                  `
                  : `
                    <div class="est-total num mono">~${fmtUsd(e.estimatedPoolUsd)} <span class="muted-note" style="font-size:11px;font-weight:400">${esc(ciText)}${!isBoot && activeSubset !== 'base' ? ` · ${esc(t('quota.mixEqHint'))}` : ''}</span></div>
                    <div class="chart-caption-row num">
                      <span>${esc(t('quota.effDelta', { du: deltaPct.toFixed(2), seg: num(e.segmentsUsed), usd: fmtUsd(isBoot ? (e.cycleSpendUsd ?? e.windowSpendUsd) : e.windowSpendUsd) }))}</span>
                      <span>${esc(t('quota.impliedRem', { usd: e.impliedRemainingUsd != null ? fmtUsd(e.impliedRemainingUsd) : '—' }))}</span>
                    </div>
                    ${isBoot ? `<div class="muted-note" style="font-size:10.5px;line-height:1.4">${esc(t('quota.originBootHint'))}</div>` : ''}
                    ${refLineHtml}
                  `
              }
              ${weightStripHtml}
              ${
                mix.length
                  ? `<div class="top-models-pills">${mix.map((m) => `<span class="pill outline num">${esc(m.canonicalId)} ${(num(m.share) * 100).toFixed(0)}%</span>`).join('')}</div>`
                  : ''
              }
              ${
                e.mixedModelWarning && !activeFactors.M
                  ? `<div class="banner warn" style="padding:6px 8px">${esc(t('quota.mixedWarn'))}</div>`
                  : ''
              }
              ${calibLabHtml}
            </div>
          `;
        })
        .join('');
    }

    // Bottom anchor history:
    // Default expanded: each pool's independent current 7d cycle (fallback to current 5h only if pool has no 7d at all).
    // Default folded: older 7d cycles (grouped by pool + cycle window) & 5h window records.
    const anchorById = new Map();
    for (const a of anchors) {
      if (a.id != null) anchorById.set(a.id, a);
    }

    const poolOrder = ['gemini', 'argon', '3p'];
    const currentGroups = [];
    const shownAnchorIds = new Set();
    const older7dGroups = [];
    const other5hGroups = [];

    for (const p of poolOrder) {
      const s7 = summaries.find((s) => s.pool === p && s.windowType === '7d');
      const s5 = summaries.find((s) => s.pool === p && s.windowType === '5h');

      const hasAny7d = Boolean(s7 && s7.latestAnchor != null);
      if (hasAny7d) {
        const curRows = Array.isArray(s7.currentCycleAnchors) ? s7.currentCycleAnchors : [];
        for (const a of curRows) {
          if (a.id != null) shownAnchorIds.add(a.id);
        }
        currentGroups.push({
          pool: p,
          windowType: '7d',
          summary: s7,
          anchors: curRows,
        });

        const histCycles = (Array.isArray(s7.cycles) ? s7.cycles : []).filter(
          (c) => !c.isCurrent && Array.isArray(c.anchorIds) && c.anchorIds.length > 0
        );
        if (histCycles.length > 0) {
          for (const c of histCycles) {
            const rows = c.anchorIds.map((id) => anchorById.get(id)).filter(Boolean);
            if (rows.length > 0) {
              older7dGroups.push({ pool: p, windowType: '7d', cycle: c, anchors: rows });
            }
          }
        } else if (Array.isArray(s7.olderCycleAnchors) && s7.olderCycleAnchors.length > 0) {
          older7dGroups.push({ pool: p, windowType: '7d', cycle: null, anchors: s7.olderCycleAnchors });
        }
      }

      if (s5 && s5.latestAnchor != null) {
        const cur5Rows = Array.isArray(s5.currentCycleAnchors) ? s5.currentCycleAnchors : [];
        if (!hasAny7d) {
          for (const a of cur5Rows) {
            if (a.id != null) shownAnchorIds.add(a.id);
          }
          currentGroups.push({
            pool: p,
            windowType: '5h',
            summary: s5,
            anchors: cur5Rows,
          });
        }
        const cycles5 = Array.isArray(s5.cycles) ? s5.cycles : [];
        for (const c of cycles5) {
          const rows = (c.anchorIds || [])
            .map((id) => anchorById.get(id))
            .filter((a) => a && !shownAnchorIds.has(a.id));
          if (rows.length > 0) {
            other5hGroups.push({ pool: p, windowType: '5h', cycle: c, anchors: rows });
          }
        }
      }
    }

    const totalCurrentAnchors = currentGroups.reduce((acc, g) => acc + g.anchors.length, 0);
    const totalOlderAnchors =
      older7dGroups.reduce((acc, g) => acc + g.anchors.length, 0) +
      other5hGroups.reduce((acc, g) => acc + g.anchors.length, 0);

    if (currentGroups.length > 0 || totalOlderAnchors > 0) {
      const currentHtml = currentGroups
        .map((g) => {
          const s = g.summary;
          let spanText = '';
          if (s.cycleWindowStart != null && s.cycleResetAt != null) {
            spanText = s.cycleInferred
              ? t('quota.cycleWindowInferred', {
                  start: fmtTimeShort(s.cycleWindowStart),
                  end: fmtTimeShort(s.cycleResetAt),
                })
              : t('quota.cycleWindow', {
                  start: fmtTimeShort(s.cycleWindowStart),
                  end: fmtTimeShort(s.cycleResetAt),
                });
          } else {
            spanText = t('quota.poolCycleNoReset');
          }

          let bodyHtml = '';
          if (g.anchors.length > 0) {
            bodyHtml = `<div class="anchor-history">${renderAnchorRows(g.anchors, mode)}</div>`;
          } else if (s.cycleExpired) {
            const msg =
              s.cycleState === 'awaiting_activity'
                ? t('quota.poolCycleEmptyIdle')
                : t('quota.poolCycleEmptyNew', { usd: fmtUsd(s.cycleSpendUsd) });
            bodyHtml = `<div class="muted-note" style="font-size:11px;padding:4px 2px">${esc(msg)}</div>`;
          } else {
            bodyHtml = `<div class="muted-note" style="font-size:11px;padding:4px 2px">${esc(t('quota.noCurrentAnchors'))}</div>`;
          }

          return `
            <div class="quota-cycle-group">
              <div class="quota-cycle-group-head">
                <span class="pill accent">${esc(poolLabel(g.pool))} · ${esc(g.windowType)}</span>
                <span class="quota-cycle-span num mono">${esc(spanText)}</span>
              </div>
              ${bodyHtml}
            </div>
          `;
        })
        .join('');

      function renderFoldedCycleGroups(groups) {
        return groups
          .map((g) => {
            const c = g.cycle;
            const spanStr =
              c && c.startMs != null && c.endMs != null
                ? `${fmtTimeShort(c.startMs)} → ${fmtTimeShort(c.endMs)}`
                : '';
            const metaParts = [];
            if (c?.spendUsd > 0) metaParts.push(t('quota.cycleGroupMeta', { usd: fmtUsd(c.spendUsd) }));
            if (c?.estimationBrief?.estimatedPoolUsd != null) {
              metaParts.push(t('quota.cycleGroupEst', { usd: fmtUsd(c.estimationBrief.estimatedPoolUsd) }));
            }
            return `
              <div class="quota-cycle-group older">
                <div class="quota-cycle-group-head">
                  <span class="pill outline">${esc(poolLabel(g.pool))} · ${esc(g.windowType)}</span>
                  ${spanStr ? `<span class="quota-cycle-span num mono">${esc(spanStr)}</span>` : ''}
                  ${metaParts.length ? `<span class="muted-note num" style="font-size:10px;margin-left:auto">${esc(metaParts.join(' · '))}</span>` : ''}
                </div>
                <div class="anchor-history">${renderAnchorRows(g.anchors, mode)}</div>
              </div>
            `;
          })
          .join('');
      }

      expHtml += `
        <div style="display:flex;flex-direction:column;gap:7px">
          <span class="form-title">${esc(t('quota.currentHistoryTitle', { n: totalCurrentAnchors }))}</span>
          ${
            currentGroups.length > 0
              ? currentHtml
              : `<div class="muted-note" style="font-size:11px">${esc(t('quota.noCurrentAnchors'))}</div>`
          }
          ${
            totalOlderAnchors > 0
              ? `
                <button type="button" class="older-cycles-btn older-anchors-toggle ${state.quotaOlderOpen ? 'open' : ''}" data-action="toggle-older-anchors" aria-expanded="${state.quotaOlderOpen}">
                  <span>${esc(state.quotaOlderOpen ? t('quota.hideOlderCycles', { m: totalOlderAnchors }) : t('quota.showOlderCycles', { m: totalOlderAnchors }))}</span>
                  <svg class="icon chevron" width="12" height="12" viewBox="0 0 16 16" aria-hidden="true"><path d="M4 6l4 4 4-4"/></svg>
                </button>
                ${
                  state.quotaOlderOpen
                    ? `
                      <div class="older-cycles-body">
                        ${
                          older7dGroups.length > 0
                            ? `<div class="older-section-label">${esc(t('quota.olderGroup7d'))}</div>${renderFoldedCycleGroups(older7dGroups)}`
                            : ''
                        }
                        ${
                          other5hGroups.length > 0
                            ? `<div class="older-section-label">${esc(t('quota.olderGroup5h'))}</div>${renderFoldedCycleGroups(other5hGroups)}`
                            : ''
                        }
                      </div>
                    `
                    : ''
                }
              `
              : ''
          }
        </div>
      `;
    }

    expHtml += '</div>';
    return expHtml;
  }

  function renderAnchorRows(list, mode) {
    return list
      .map((a) => {
        const pool = a.pool;
        const wt = a.windowType ?? a.window_type;
        const rem = num(a.remainingPct ?? a.remaining_pct, 0);
        const step = num(a.precisionStep ?? a.precision_step, 1);
        const cap = num(a.capturedAt ?? a.captured_at, 0);
        const explicitReset = a.resetAt ?? a.reset_at;
        const effReset = a.effectiveResetAt ?? explicitReset;
        const isInherited = explicitReset == null && effReset != null;
        const shown = mode === 'used' ? 100 - rem : rem;
        const isEditing = state.quotaEditingAnchorId === a.id;

        const resetStr = effReset
          ? `${t('quota.resetAt', { time: fmtTimeShort(effReset) })}${isInherited ? ` (${t('quota.resetInheritedTag')})` : ''}`
          : '';

        const editInlineHtml = isEditing
          ? (() => {
              const trimmedDraft = String(state.quotaEditingResetInput || '').trim();
              const unchanged = trimmedDraft === state.quotaEditingOriginalText;
              const p = parseResetInput(trimmedDraft, cap, wt);
              const canSave = !state.quotaEditingSaving && Boolean(trimmedDraft) && !unchanged && p.ok;
              const placeholderText = effReset
                ? fmtTimeShort(effReset)
                : t('quota.editResetPlaceholder');
              return `
                <div class="anchor-edit-inline">
                  <div class="anchor-edit-row">
                    <input type="text" data-edit-reset-input="1" data-id="${esc(a.id)}" placeholder="${esc(placeholderText)}" value="${esc(state.quotaEditingResetInput)}" />
                    <button type="button" class="btn-sm primary" data-action="save-anchor-reset" data-id="${esc(a.id)}" ${canSave ? '' : 'disabled'}>${esc(t('quota.editResetSave'))}</button>
                    ${explicitReset != null ? `<button type="button" class="btn-sm" data-action="clear-anchor-reset" data-id="${esc(a.id)}" ${state.quotaEditingSaving ? 'disabled' : ''}>${esc(t('quota.editResetClear'))}</button>` : ''}
                    <button type="button" class="btn-sm" data-action="cancel-anchor-reset" ${state.quotaEditingSaving ? 'disabled' : ''}>${esc(t('quota.editResetCancel'))}</button>
                  </div>
                  ${
                    state.quotaEditingError
                      ? `<div class="field-hint" style="color:var(--bad)">${esc(state.quotaEditingError)}</div>`
                      : trimmedDraft
                        ? `<div class="field-hint" style="color:${p.ok ? 'var(--ok)' : 'var(--bad)'}">${esc(p.preview)}</div>`
                        : ''
                  }
                </div>
              `;
            })()
          : '';

        return `
          <div class="anchor-row-wrap">
            <div class="anchor-row">
              <div class="anchor-info">
                <div class="anchor-top num">
                  <span class="pill accent">${esc(poolLabel(pool))} ${esc(wt)}</span>
                  <strong class="mono">${esc(mode === 'used' ? t('quota.used') : t('quota.remaining'))} ${fmtPctDirect(shown, step)}</strong>
                  <span class="pill outline">${esc(t('quota.precision', { step }))}</span>
                  <span class="muted-note">${fmtTimeShort(cap)}</span>
                </div>
                ${
                  resetStr || a.note
                    ? `<div class="muted-note truncate">${resetStr ? esc(resetStr) : ''}${resetStr && a.note ? ' · ' : ''}${a.note ? esc(a.note) : ''}</div>`
                    : ''
                }
              </div>
              <div class="anchor-actions">
                <button type="button" class="btn-sm" data-action="edit-anchor-reset" data-id="${esc(a.id)}" ${isReadOnlyMode() ? 'disabled' : ''}>${esc(t('quota.editResetBtn'))}</button>
                <button type="button" class="btn-sm danger" data-action="delete-anchor" data-id="${esc(a.id)}" ${isReadOnlyMode() ? 'disabled' : ''}>${esc(t('common.delete'))}</button>
              </div>
            </div>
            ${editInlineHtml}
          </div>
        `;
      })
      .join('');
  }

  function formatPromoLabel(label) {
    const raw = String(label || '').trim();
    if (!raw) return '';
    const m = raw.match(/^(\d+)%\s+intro\s+through\s+(\d{4}-\d{2}-\d{2})$/i);
    if (m) {
      return t('quota.promoIntro', { pct: m[1], date: m[2] });
    }
    return raw;
  }

  function formatCalibReason(code, params, fallback = '') {
    const p = params && typeof params === 'object' ? params : {};
    const subLabel = p.subset ? calibSubsetShort(p.subset) : '';
    switch (code) {
      case 'need_anchors':
        return t('quota.reasonNeedAnchors');
      case 'm_single_model':
        return t('quota.reasonMSingleModel');
      case 'm_low_share':
        return t('quota.reasonMLowShare', { minPct: p.minPct ?? 5 });
      case 'm_low_std':
        return t('quota.reasonMLowStd', { std: p.std ?? '0.00', minStd: p.minStd ?? 0.04 });
      case 'm_need_segs':
        return t('quota.reasonMNeedSegs', { need: p.need ?? 1, cur: p.cur ?? 0, req: p.req ?? 3 });
      case 'm_auto_share_or_segs':
        return t('quota.reasonMAutoShareOrSegs', { sharePct: p.sharePct ?? 0, n: p.n ?? 0 });
      case 'c_low_std':
        return t('quota.reasonCLowStd', { std: p.std ?? '0.00', minStd: p.minStd ?? 0.03 });
      case 'c_need_segs':
        return t('quota.reasonCNeedSegs', { need: p.need ?? 1, cur: p.cur ?? 0, req: p.req ?? 3 });
      case 'o_low_std':
        return t('quota.reasonOLowStd', { std: p.std ?? '0.00', minStd: p.minStd ?? 0.03 });
      case 'o_need_segs':
        return t('quota.reasonONeedSegs', { need: p.need ?? 1, cur: p.cur ?? 0, req: p.req ?? 3 });
      case 'subset_need_segs':
        return t('quota.reasonSubsetNeedSegs', { subset: subLabel || p.subset || '', need: p.need ?? 1, cur: p.cur ?? 0, req: p.req ?? 3 });
      case 'subset_collinear':
        return t('quota.reasonSubsetCollinear', { subset: subLabel || p.subset || '', vif: p.vif ?? '', maxVif: p.maxVif ?? 10 });
      case 'subset_low_effdf':
        return t('quota.reasonSubsetLowEffDf', { subset: subLabel || p.subset || '', effDf: p.effDf ?? '', minEffDf: p.minEffDf ?? 0.35 });
      default:
        return fallback || '';
    }
  }

  function renderCalibWeightStrip(subsetObj) {
    const models = Array.isArray(subsetObj?.params?.models) ? subsetObj.params.models : [];
    const cache = subsetObj?.params?.cache;
    const output = subsetObj?.params?.output;
    const items = [];

    for (const m of models) {
      const name = shortModelName(m.canonicalId);
      if (m.isAnchor) {
        items.push(`<span class="calib-weight-item num"><strong>${esc(name)}</strong> 1.00× (${esc(t('quota.stripBase'))})</span>`);
      } else if (m.fitted) {
        items.push(
          `<span class="calib-weight-item num"><strong>${esc(name)}</strong> ${esc(fmtMultWithSe(m))}${m.clamped ? `<span class="calib-clamp-tag">${esc(t('quota.clamped'))}</span>` : ''}</span>`
        );
      }
    }
    if (cache?.fitted) {
      items.push(
        `<span class="calib-weight-item num"><strong>${esc(t('quota.stripCache'))}</strong> ${esc(fmtMultWithSe(cache))}${cache.clamped ? `<span class="calib-clamp-tag">${esc(t('quota.clamped'))}</span>` : ''}</span>`
      );
    }
    if (output?.fitted) {
      items.push(
        `<span class="calib-weight-item num"><strong>${esc(t('quota.stripOutput'))}</strong> ${esc(fmtMultWithSe(output))}${output.clamped ? `<span class="calib-clamp-tag">${esc(t('quota.clamped'))}</span>` : ''}</span>`
      );
    }

    const expBadge = subsetObj?.exploratory
      ? `<span class="pill warn" data-tip="${esc(
          t('quota.exploratoryTip', {
            reason: formatCalibReason(subsetObj.autoReasonCode, subsetObj.autoReasonParams, subsetObj.autoReason) || t('quota.subsetIneligible')
          })
        )}">${esc(t('quota.exploratoryBadge'))}</span>`
      : '';

    const maeText =
      subsetObj?.maePp != null && Number.isFinite(Number(subsetObj.maePp))
        ? `<span class="calib-mae-chip num">${esc(t('quota.maeStrip', { mae: num(subsetObj.maePp).toFixed(2) }))}</span>`
        : '';

    if (!items.length && !maeText && !expBadge) return '';
    return `
      <div class="calib-weight-strip">
        ${items.join('<span class="calib-weight-sep">·</span>')}
        ${expBadge}
        ${maeText}
      </div>
    `;
  }

  function renderCalibSmoothingPill(summary, cal) {
    const rawN = num(cal.rawSegmentsCount, num(cal.segmentsCount, 0));
    const segN = num(cal.segmentsCount, 0);
    const mergedN = Math.max(num(cal.coalescedCount, 0), rawN - segN);
    const huberN = num(cal.huberDownweightedCount, 0);
    if (mergedN <= 0 && huberN <= 0) return '';

    const anchorsN =
      Array.isArray(summary?.currentCycleAnchors) && summary.currentCycleAnchors.length
        ? summary.currentCycleAnchors.length
        : rawN + 1;
    const parts = [];
    if (mergedN > 0) {
      parts.push(t('quota.smoothSegSummary', { anchors: anchorsN, segs: segN, merged: mergedN }));
    }
    if (huberN > 0) {
      parts.push(t('quota.smoothHuberTag', { n: huberN }));
    }
    return `
      <span class="calib-smooth-pill num ${huberN > 0 ? 'has-huber' : ''}" data-tip="${esc(t('quota.smoothTipInfo'))}">
        ${huberN > 0 ? '<span class="calib-huber-dot" aria-hidden="true"></span>' : ''}
        <span>${esc(parts.join(' · '))}</span>
      </span>
    `;
  }

  function buildCalibrationLabHtml(summary, cal) {
    const labKey = `${summary.pool}:${summary.windowType}`;
    const activeSubset = cal.activeSubset || 'base';
    const recSubset = cal.recommendedSubset || 'base';
    const subsets = cal.subsets || {};
    const activeSubObj = subsets[activeSubset] || subsets.base || null;
    const isOpen = state.quotaLabOpenByKey.has(labKey)
      ? Boolean(state.quotaLabOpenByKey.get(labKey))
      : activeSubset !== 'base';

    const calibMode = cal.mode || state.config.quotaCalibMode || 'auto';
    const manualTag =
      calibMode === 'manual' ? ` · ${t('quota.modeManual', { mode: calibSubsetShort(activeSubset) })}` : '';

    return `
      <div class="calib-lab-wrap">
        <button type="button" class="calib-lab-toggle ${isOpen ? 'open' : ''}" data-action="toggle-calib-lab" data-key="${esc(labKey)}" aria-expanded="${isOpen}">
          <span class="calib-lab-toggle-left">
            <span>${esc(t('quota.labTitle'))}</span>
            <span class="pill outline num">${esc(t('quota.labSummary', { rec: calibSubsetShort(recSubset), n: num(cal.segmentsCount, 0) }))}${esc(manualTag)}</span>
            ${renderCalibSmoothingPill(summary, cal)}
          </span>
          <svg class="icon chevron" width="13" height="13" viewBox="0 0 16 16" aria-hidden="true"><path d="M4 6l4 4 4-4"/></svg>
        </button>
        ${
          isOpen
            ? `<div class="calib-lab-body">
                ${renderCalibControls(summary, cal)}
                ${renderCalibAnchorSelector(summary, cal, activeSubObj)}
                ${renderCalibParamTable(cal, activeSubObj)}
                ${renderCalibResidualSvg(summary, cal, activeSubObj)}
              </div>`
            : ''
        }
      </div>
    `;
  }

  function renderCalibControls(summary, cal) {
    const calibMode = cal.mode || state.config.quotaCalibMode || 'auto';
    const activeSubset = cal.activeSubset || 'base';
    const recSubset = cal.recommendedSubset || 'base';
    const activeFactors = cal.activeFactors || subsetKeyToFactors(activeSubset);
    const recFactors = subsetKeyToFactors(recSubset);
    const factorsMeta = cal.factors || {};
    const subsets = cal.subsets || {};

    const factorDefs = [
      { key: 'M', label: t('quota.factorM') },
      { key: 'C', label: t('quota.factorC') },
      { key: 'O', label: t('quota.factorO') }
    ];

    const chipsHtml = factorDefs
      .map((fd) => {
        const fMeta = factorsMeta[fd.key] || {};
        const eligible = Boolean(fMeta.eligible);
        const isActive = Boolean(activeFactors[fd.key]);
        const isRec = Boolean(recFactors[fd.key]);
        const subObj = subsets[fd.key] || {};
        const cls = [
          'calib-factor-chip',
          isActive ? 'active' : '',
          isRec ? 'recommended' : '',
          !eligible ? 'dimmed' : ''
        ]
          .filter(Boolean)
          .join(' ');

        const tipLines = [fd.label];
        if (!eligible && (fMeta.reasonCode || fMeta.reason)) {
          tipLines.push(formatCalibReason(fMeta.reasonCode, fMeta.reasonParams, fMeta.reason));
        } else {
          if (fMeta.exploratory && (fMeta.autoReasonCode || fMeta.autoReason)) {
            tipLines.push(
              `${t('quota.exploratoryBadge')}: ${formatCalibReason(fMeta.autoReasonCode, fMeta.autoReasonParams, fMeta.autoReason)}`
            );
          }
          if (subObj.loocvMaePp != null) {
            tipLines.push(`LOOCV MAE: ±${num(subObj.loocvMaePp).toFixed(2)}pp`);
          } else if (subObj.maePp != null) {
            tipLines.push(`MAE: ±${num(subObj.maePp).toFixed(2)}pp`);
          }
        }

        return `
          <button type="button" class="${cls}" data-action="toggle-calib-factor" data-factor="${fd.key}" data-pool="${esc(summary.pool)}" data-wt="${esc(summary.windowType)}" data-tip="${esc(tipLines.join('\n'))}" aria-pressed="${isActive}" ${!eligible ? 'aria-disabled="true"' : ''}>
            ${isRec ? '<span class="calib-rec-dot" aria-hidden="true"></span>' : ''}
            <span>${esc(fd.label)}</span>
          </button>
        `;
      })
      .join('');

    const manualFactors = state.config.quotaManualFactors || {};
    const requestedSubset = factorsToSubsetKey(manualFactors);
    const reqSubObj = subsets[requestedSubset];
    const fallbackWarn =
      calibMode === 'manual' && requestedSubset !== activeSubset && reqSubObj && !reqSubObj.eligible
        ? `<div class="calib-subset-warn">${esc(
            t('quota.manualFallbackHint', {
              subset: calibSubsetShort(requestedSubset),
              reason:
                formatCalibReason(reqSubObj.reasonCode, reqSubObj.reasonParams, reqSubObj.reason) ||
                t('quota.subsetIneligible'),
              fallback: calibSubsetShort(activeSubset)
            })
          )}</div>`
        : '';

    const lockedReasons = factorDefs
      .map((fd) => ({ key: fd.key, obj: factorsMeta[fd.key] }))
      .filter((x) => x.obj && !x.obj.eligible && (x.obj.reasonCode || x.obj.reason));

    const exploratoryReasons = factorDefs
      .map((fd) => ({ key: fd.key, obj: factorsMeta[fd.key] }))
      .filter((x) => x.obj && x.obj.eligible && x.obj.exploratory && (x.obj.autoReasonCode || x.obj.autoReason));

    const hintParts = [];
    if (lockedReasons.length) {
      hintParts.push(
        lockedReasons
          .map((x) => `${x.key}: ${formatCalibReason(x.obj.reasonCode, x.obj.reasonParams, x.obj.reason)}`)
          .join(' · ')
      );
    }
    if (exploratoryReasons.length) {
      hintParts.push(
        t('quota.exploreOnlyHint', {
          list: exploratoryReasons
            .map((x) => `${x.key} (${formatCalibReason(x.obj.autoReasonCode, x.obj.autoReasonParams, x.obj.autoReason)})`)
            .join(' · ')
        })
      );
    }
    const unlockHint = hintParts.length ? hintParts.join(' · ') : t('quota.allFactorsUnlocked');

    return `
      <div class="calib-controls-wrap">
        <div class="calib-controls-row">
          <button type="button" class="calib-auto-btn ${calibMode === 'auto' ? 'active' : ''}" data-action="set-calib-auto" data-tip="${esc(t('quota.modeAutoHelp'))}" aria-pressed="${calibMode === 'auto'}">
            <span>${esc(t('quota.modeAuto'))} (${esc(calibSubsetShort(recSubset))})</span>
          </button>
          <div class="calib-factors-group">${chipsHtml}</div>
        </div>
        ${fallbackWarn}
        <div class="calib-unlock-hint">${esc(unlockHint)}</div>
      </div>
    `;
  }

  function renderCalibAnchorSelector(summary, cal, activeSubObj) {
    const avail =
      Array.isArray(cal.availableAnchorModels) && cal.availableAnchorModels.length
        ? cal.availableAnchorModels
        : cal.anchorModel
          ? [{ canonicalId: cal.anchorModel, share: 1 }]
          : [];
    const selId = `calib-anchor-${summary.pool}-${summary.windowType}`;
    const srcMap = {
      default: { cls: 'outline', text: t('quota.anchorSrcDefault') },
      user: { cls: 'accent', text: t('quota.anchorSrcUser') },
      fallback: { cls: 'warn', text: t('quota.anchorSrcFallback') }
    };
    const srcInfo = srcMap[cal.anchorSource] || srcMap.default;
    const anchorUsd =
      activeSubObj?.anchorPoolUsd != null ? fmtUsd(activeSubObj.anchorPoolUsd) : '—';

    return `
      <div class="calib-anchor-row">
        <div class="calib-anchor-ctrl">
          <label for="${esc(selId)}">${esc(t('quota.baseAnchorLabel'))}</label>
          <select id="${esc(selId)}" class="calib-anchor-select mono" data-action="set-pool-anchor" data-pool="${esc(summary.pool)}">
            ${avail
              .map(
                (m) => `<option value="${esc(m.canonicalId)}" ${m.canonicalId === cal.anchorModel ? 'selected' : ''}>${esc(m.canonicalId)} (${Math.round(num(m.share) * 100)}%)</option>`
              )
              .join('')}
          </select>
          <span class="pill ${srcInfo.cls}">${esc(srcInfo.text)}</span>
        </div>
        <div class="calib-q-anchor num mono">
          <span>${esc(t('quota.anchorPoolQ', { usd: anchorUsd }))}</span>
          ${helpTip(t('quota.anchorPoolQHelp'))}
        </div>
      </div>
    `;
  }

  function renderCalibParamTable(cal, activeSubObj) {
    const models = Array.isArray(activeSubObj?.params?.models) ? activeSubObj.params.models : [];
    const cache = activeSubObj?.params?.cache;
    const output = activeSubObj?.params?.output;
    const baseSub = cal?.subsets?.base || null;
    const recFactors = subsetKeyToFactors(cal?.recommendedSubset || 'base');
    const trialM = cal?.subsets?.M || null;
    const trialC = cal?.subsets?.C || null;
    const trialO = cal?.subsets?.O || null;

    function buildTrialHint(trialSub, paramObj) {
      if (!trialSub || !trialSub.eligible || !paramObj || !paramObj.fitted) return '';
      const baseLoocv = baseSub?.loocvMaePp;
      const triLoocv = trialSub.loocvMaePp;
      let reason = t('quota.trialReasonChi2');
      if (trialSub.autoEligible === false && (trialSub.autoReasonCode || trialSub.autoReason)) {
        reason = formatCalibReason(trialSub.autoReasonCode, trialSub.autoReasonParams, trialSub.autoReason);
      } else if (baseLoocv != null && triLoocv != null) {
        const bStr = num(baseLoocv).toFixed(2);
        const tStr = num(triLoocv).toFixed(2);
        if (triLoocv >= baseLoocv) {
          reason = t('quota.trialReasonWorse', { trial: tStr, base: bStr });
        } else if (triLoocv > baseLoocv * 0.85) {
          reason = t('quota.trialReasonMarginal', { trial: tStr, base: bStr });
        }
      }
      const clampedStr = paramObj.clamped ? ` (${t('quota.clamped')})` : '';
      return t('quota.trialNotAdopted', {
        val: fmtMultWithSe(paramObj),
        clamped: clampedStr,
        reason
      });
    }

    const rows = [];

    for (const m of models) {
      const val = num(m.value, 1);
      let statusPill = `<span class="pill outline">${esc(t('quota.paramDefault'))}</span>`;
      let interp = t('quota.interpModelUnfit');
      let trialNote = '';
      if (m.isAnchor) {
        statusPill = `<span class="pill accent">${esc(t('quota.paramBase'))}</span>`;
        interp = t('quota.interpBase');
      } else if (m.fitted) {
        statusPill = `<span class="pill ok">${esc(t('quota.paramFitted'))}</span>`;
        if (val < 0.95) interp = t('quota.interpModelEff', { v: val.toFixed(2) });
        else if (val > 1.05) interp = t('quota.interpModelHeavy', { v: val.toFixed(2) });
        else interp = t('quota.interpModelNeutral', { v: val.toFixed(2) });
      } else if (!recFactors.M && trialM?.eligible) {
        const tm = (trialM.params?.models || []).find((x) => x.canonicalId === m.canonicalId);
        trialNote = buildTrialHint(trialM, tm);
      }
      rows.push({
        name: `${m.canonicalId} (${Math.round(num(m.share) * 100)}%)`,
        statusPill,
        valText: m.isAnchor || !m.fitted ? '1.00×' : fmtMultWithSe(m),
        clamped: Boolean(m.clamped),
        interp,
        trialNote
      });
    }

    if (cache) {
      const val = num(cache.value, 1);
      const fitted = Boolean(cache.fitted);
      const statusPill = fitted
        ? `<span class="pill ok">${esc(t('quota.paramFitted'))}</span>`
        : `<span class="pill outline">${esc(t('quota.paramDefault'))}</span>`;
      let interp = t('quota.interpCacheUnfit');
      let trialNote = '';
      if (fitted) {
        if (val < 0.85) interp = t('quota.interpCacheCheap', { v: val.toFixed(2) });
        else if (val > 1.15) interp = t('quota.interpCacheExpensive', { v: val.toFixed(2) });
        else interp = t('quota.interpCacheNeutral', { v: val.toFixed(2) });
      } else if (!recFactors.C && trialC?.eligible) {
        trialNote = buildTrialHint(trialC, trialC.params?.cache);
      }
      rows.push({
        name: t('quota.paramCacheName'),
        statusPill,
        valText: fitted ? fmtMultWithSe(cache) : '1.00×',
        clamped: Boolean(cache.clamped),
        interp,
        trialNote
      });
    }

    if (output) {
      const val = num(output.value, 1);
      const fitted = Boolean(output.fitted);
      const statusPill = fitted
        ? `<span class="pill ok">${esc(t('quota.paramFitted'))}</span>`
        : `<span class="pill outline">${esc(t('quota.paramDefault'))}</span>`;
      let interp = t('quota.interpOutUnfit');
      let trialNote = '';
      if (fitted) {
        if (val > 1.15) interp = t('quota.interpOutExpensive', { v: val.toFixed(2) });
        else if (val < 0.85) interp = t('quota.interpOutCheap', { v: val.toFixed(2) });
        else interp = t('quota.interpOutNeutral', { v: val.toFixed(2) });
      } else if (!recFactors.O && trialO?.eligible) {
        trialNote = buildTrialHint(trialO, trialO.params?.output);
      }
      rows.push({
        name: t('quota.paramOutName'),
        statusPill,
        valText: fitted ? fmtMultWithSe(output) : '1.00×',
        clamped: Boolean(output.clamped),
        interp,
        trialNote
      });
    }

    const promoNote =
      cal.promoIdentifiable === false && cal.promoAssumption && cal.promoAssumption !== 'none'
        ? `<div class="banner info" style="padding:6px 8px;font-size:11px">${esc(
            t(cal.promoAssumption === 'list_price' ? 'quota.promoNoteList' : 'quota.promoNoteFollow')
          )}</div>`
        : '';

    return `
      <div class="calib-param-list">
        ${rows
          .map(
            (r) => `
            <div class="calib-param-row">
              <div class="calib-param-top">
                <span class="calib-param-left">
                  <span class="mono" style="font-weight:500">${esc(r.name)}</span>
                  ${r.statusPill}
                </span>
                <span class="calib-param-val num mono">
                  <span>${esc(r.valText)}</span>
                  ${r.clamped ? `<span class="calib-clamp-tag">${esc(t('quota.clamped'))}</span>` : ''}
                </span>
              </div>
              <div class="calib-param-desc">${esc(r.interp)}</div>
              ${r.trialNote ? `<div class="calib-param-desc num mono" style="opacity:0.82">${esc(r.trialNote)}</div>` : ''}
            </div>
          `
          )
          .join('')}
      </div>
      ${promoNote}
    `;
  }

  function renderCalibResidualSvg(summary, cal, activeSubObj) {
    const activeSubset = cal.activeSubset || 'base';
    const baseObj = cal.subsets?.base || null;
    const fits = Array.isArray(activeSubObj?.segmentFits) ? activeSubObj.segmentFits : [];
    const smoothPillHtml = renderCalibSmoothingPill(summary, cal);

    const hasLoocv =
      baseObj?.loocvMaePp != null &&
      activeSubObj?.loocvMaePp != null &&
      Number.isFinite(Number(baseObj.loocvMaePp)) &&
      Number.isFinite(Number(activeSubObj.loocvMaePp));
    const baseErr = hasLoocv ? num(baseObj.loocvMaePp, 0) : num(baseObj?.maePp, 0);
    const curErr = hasLoocv ? num(activeSubObj.loocvMaePp, 0) : num(activeSubObj?.maePp, 0);
    const metricLbl = hasLoocv ? 'LOOCV' : 'MAE';
    const summaryLine =
      baseObj && activeSubObj
        ? activeSubset === 'base'
          ? t('quota.residualBaseOnly', {
              base: calibSubsetShort('base'),
              mae0: baseErr.toFixed(2),
              metric: metricLbl
            })
          : t('quota.residualSummary', {
              l0: calibSubsetShort('base'),
              mae0: baseErr.toFixed(2),
              cur: calibSubsetShort(activeSubset),
              mae1: curErr.toFixed(2),
              metric: metricLbl
            })
        : '';

    if (fits.length === 0) {
      return `
        <div class="calib-chart-box">
          <div class="calib-chart-head">
            <span style="font-weight:600">${esc(t('quota.residualTitle'))}</span>
            ${smoothPillHtml}
            ${summaryLine ? `<span class="muted-note num">${esc(summaryLine)}</span>` : ''}
          </div>
          <div class="muted-note" style="font-size:11px">${esc(t('quota.residualNoData'))}</div>
        </div>
      `;
    }

    const W = 360;
    const H = 100;
    const padL = 28;
    const padR = 8;
    const padT = 11;
    const padB = 16;
    const plotW = W - padL - padR;
    const plotH = H - padT - padB;

    let maxPp = 1;
    for (const s of fits) {
      maxPp = Math.max(maxPp, num(s.observedPp, 0), num(s.predBasePp ?? s.predL0Pp, 0), num(s.predPp, 0));
    }
    maxPp *= 1.15;

    const showCur = activeSubset !== 'base';
    const barsPerSeg = showCur ? 3 : 2;
    const slotW = plotW / fits.length;
    const groupW = Math.min(34, slotW * 0.78);
    const gap = 1.5;
    const barW = Math.max(2, (groupW - gap * (barsPerSeg - 1)) / barsPerSeg);

    const gridYs = [0, 0.5, 1].map((r) => {
      const val = maxPp * r;
      const y = padT + plotH - r * plotH;
      return `
        <line x1="${padL}" y1="${y.toFixed(1)}" x2="${W - padR}" y2="${y.toFixed(1)}" stroke="var(--line)" stroke-width="1"/>
        <text x="${padL - 4}" y="${(y + 3).toFixed(1)}" text-anchor="end" font-size="8.5" fill="var(--fg-muted)" class="num">${val.toFixed(val >= 10 ? 0 : 1)}</text>
      `;
    }).join('');

    let hasDownweighted = false;
    const groupsHtml = fits
      .map((s, idx) => {
        const obs = Math.max(0, num(s.observedPp, 0));
        const pBase = Math.max(0, num(s.predBasePp ?? s.predL0Pp, 0));
        const p1 = Math.max(0, num(s.predPp, 0));
        const xCenter = padL + (idx + 0.5) * slotW;
        const x0 = xCenter - groupW / 2;

        const hObs = Math.max(1, (obs / maxPp) * plotH);
        const hBase = Math.max(1, (pBase / maxPp) * plotH);
        const hCur = Math.max(1, (p1 / maxPp) * plotH);

        const yObs = padT + plotH - hObs;
        const yBase = padT + plotH - hBase;
        const yCur = padT + plotH - hCur;

        const errBase = pBase - obs;
        const errCur = p1 - obs;
        const fmtSigned = (v) => `${v >= 0 ? '+' : ''}${v.toFixed(2)}`;
        const mergedCnt = num(s.mergedCount, 1);
        const isDownweighted = Boolean(s.downweighted);
        if (isDownweighted) hasDownweighted = true;

        const tipLines = [
          t('quota.segTipTitle', { idx: s.idx ?? idx + 1, usd: fmtUsd(s.spendUsd) }),
          t('quota.segTipObs', { v: obs.toFixed(2) }),
          t('quota.segTipBase', { v: pBase.toFixed(2), err: fmtSigned(errBase) })
        ];
        if (showCur) {
          tipLines.push(t('quota.segTipCur', { lvl: calibSubsetShort(activeSubset), v: p1.toFixed(2), err: fmtSigned(errCur) }));
        }
        if (mergedCnt > 1) {
          tipLines.push(t('quota.segTipMerged', { n: mergedCnt }));
        }
        if (isDownweighted) {
          tipLines.push(t('quota.segTipDownweighted'));
        }

        const bx0 = x0;
        const bx1 = x0 + barW + gap;
        const bx2 = x0 + (barW + gap) * 2;
        const topBarY = Math.min(yObs, yBase, showCur ? yCur : yBase);
        const dotY = Math.max(4, topBarY - 4.5);

        return `
          <g class="calib-seg-group" data-tip="${esc(tipLines.join('\n'))}">
            <rect class="calib-seg-bg" x="${(xCenter - slotW / 2).toFixed(1)}" y="${padT}" width="${slotW.toFixed(1)}" height="${plotH}" rx="2"/>
            <rect x="${bx0.toFixed(1)}" y="${yObs.toFixed(1)}" width="${barW.toFixed(1)}" height="${hObs.toFixed(1)}" rx="1.5" fill="var(--accent)"/>
            <rect x="${bx1.toFixed(1)}" y="${yBase.toFixed(1)}" width="${barW.toFixed(1)}" height="${hBase.toFixed(1)}" rx="1.5" fill="var(--fg-muted)" opacity="0.55"/>
            ${showCur ? `<rect x="${bx2.toFixed(1)}" y="${yCur.toFixed(1)}" width="${barW.toFixed(1)}" height="${hCur.toFixed(1)}" rx="1.5" fill="var(--ok)"/>` : ''}
            ${isDownweighted ? `<circle cx="${xCenter.toFixed(1)}" cy="${dotY.toFixed(1)}" r="2.3" fill="var(--warn)" stroke="var(--surface)" stroke-width="0.6"/>` : ''}
            <text x="${xCenter.toFixed(1)}" y="${H - 3}" text-anchor="middle" font-size="8.5" fill="var(--fg-muted)" class="num">#${esc(s.idx ?? idx + 1)}</text>
          </g>
        `;
      })
      .join('');

    return `
      <div class="calib-chart-box">
        <div class="calib-chart-head">
          <span style="font-weight:600">${esc(t('quota.residualTitle'))}</span>
          ${smoothPillHtml}
          ${summaryLine ? `<span class="muted-note num">${esc(summaryLine)}</span>` : ''}
        </div>
        <svg class="calib-svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(t('quota.residualTitle'))}">
          ${gridYs}
          ${groupsHtml}
        </svg>
        <div class="legend-inline">
          <span class="legend-item"><span class="legend-dot" style="background:var(--accent)"></span>${esc(t('quota.legendObs'))}</span>
          <span class="legend-item"><span class="legend-dot" style="background:var(--fg-muted);opacity:0.55"></span>${esc(t('quota.legendBase'))}</span>
          ${showCur ? `<span class="legend-item"><span class="legend-dot" style="background:var(--ok)"></span>${esc(t('quota.legendCur', { lvl: calibSubsetShort(activeSubset) }))}</span>` : ''}
          ${hasDownweighted ? `<span class="legend-item"><span class="legend-dot" style="background:var(--warn)"></span>${esc(t('quota.legendHuber'))}</span>` : ''}
        </div>
      </div>
    `;
  }

  // =========================================================================
  // 17. Rendering: Main Modules Grid
  // =========================================================================
  function renderGrid() {
    const order = state.config.moduleOrder || DEFAULT_CONFIG.moduleOrder;
    const enabledIds = order.filter((id) => ALL_MODULE_IDS.includes(id) && isModuleActiveForView(id));

    if (enabledIds.length === 0) {
      dom.modulesGrid.innerHTML = '';
      dom.emptyModules.classList.remove('hidden');
      return;
    }
    dom.emptyModules.classList.add('hidden');

    const renderers = {
      'live-context': renderLiveContext,
      'cache-diagnostics': renderCacheDiagnostics,
      'io-flow': renderIoFlow,
      'model-cost': renderModelCost,
      'calendar-trends': renderCalendarTrends,
      'cache-observatory': renderCacheObservatory,
      'quota-budget': renderQuotaBudget
    };

    const cardsHtml = enabledIds
      .map((id) => {
        const expanded = isCardExpandedForView(id);
        const wideClass =
          expanded && (id === 'calendar-trends' || id === 'model-cost' || id === 'cache-observatory' || id === 'quota-budget')
            ? 'span-wide'
            : '';
        const res = renderers[id](expanded);
        return `
          <section class="card ${expanded ? 'expanded' : ''} ${wideClass}" data-module="${esc(id)}">
            <div class="card-head" data-action="toggle-card" data-module="${esc(id)}" role="button" tabindex="0" aria-expanded="${expanded}">
              <div class="card-head-left">
                <h2 class="card-title">${esc(t(`modules.${id}.title`))}</h2>
                ${helpTip(t(`modules.${id}.headHelp`))}
                ${res.badges || ''}
              </div>
              <div class="card-head-right">
                <svg class="icon chevron" viewBox="0 0 16 16" aria-hidden="true"><path d="M4 6l4 4 4-4"/></svg>
              </div>
            </div>
            <div class="card-body">${res.body}</div>
          </section>
        `;
      })
      .join('');

    dom.modulesGrid.innerHTML = cardsHtml;
    syncPinnedObsPopover();
  }

  // =========================================================================
  // 18. Rendering: Settings Drawer
  // =========================================================================
  function renderSettings() {
    if (!state.settingsOpen) return;

    const prevPricingScrollEl = dom.settingsBody.querySelector('[data-pricing-scroll]');
    const prevPricingScrollTop = prevPricingScrollEl ? prevPricingScrollEl.scrollTop : 0;
    const ro = isReadOnlyMode();

    const lang = getLang();
    const order = state.config.moduleOrder || DEFAULT_CONFIG.moduleOrder;
    const modRows = order
      .filter((id) => ALL_MODULE_IDS.includes(id))
      .map((id, idx, arr) => {
        const on = Boolean(state.config.modules[id]);
        return `
          <div class="set-mod-row">
            <div class="set-mod-meta">
              <span class="set-mod-name">
                <span>${esc(t(`modules.${id}.title`))}</span>
                ${helpTip(t(`modules.${id}.setHelp`))}
              </span>
              <span class="set-mod-desc">${esc(t(`modules.${id}.desc`))}</span>
            </div>
            <div class="set-mod-actions">
              <button type="button" class="icon-btn" data-action="move-module" data-module="${esc(id)}" data-dir="-1" title="${esc(t('settings.moveUp'))}" aria-label="${esc(t('settings.moveUp'))}" ${idx === 0 ? 'disabled' : ''}>↑</button>
              <button type="button" class="icon-btn" data-action="move-module" data-module="${esc(id)}" data-dir="1" title="${esc(t('settings.moveDown'))}" aria-label="${esc(t('settings.moveDown'))}" ${idx === arr.length - 1 ? 'disabled' : ''}>↓</button>
              <label class="switch" title="${esc(t('settings.toggleModuleTitle'))}">
                <input type="checkbox" data-action="toggle-module" data-module="${esc(id)}" ${on ? 'checked' : ''}>
                <span class="switch-track"></span>
              </label>
            </div>
          </div>
        `;
      })
      .join('');

    const src = state.config.sources || {};
    const idxSt = state.indexStatus || {};
    const prSt = state.pricingStatus || {};
    const pr = state.pricing;
    const refreshVal = String(num(state.config.refreshSec, 30));

    const defAnchors = pr.data?.defaultAnchors;
    const defAnchorsNoteHtml =
      defAnchors && typeof defAnchors === 'object' && Object.keys(defAnchors).length > 0
        ? `<div class="pricing-anchors-note mono">${esc(
            t('settings.defaultAnchorsNote', {
              list: Object.entries(defAnchors)
                .map(([p, model]) => `${poolLabel(p)}: ${model}`)
                .join(' · ')
            })
          )}</div>`
        : '';

    let pricingModelsHtml = '';
    if (pr.expanded) {
      if (pr.loading) {
        pricingModelsHtml = `<div class="muted-note">${esc(t('settings.loadingPricing'))}</div>`;
      } else if (pr.error) {
        pricingModelsHtml = `<div class="banner error">${esc(pr.error)}</div>`;
      } else if (pr.data && Array.isArray(pr.data.models)) {
        const rowsHtml = pr.data.models
          .map((m) => {
            const isEditing = !ro && pr.editingId === m.canonicalId;
            const d = pr.draft || m;
            return `
              <div class="pricing-model-row">
                <div class="model-item-top">
                  <div class="model-item-name">
                    <span class="mono truncate">${esc(m.canonicalId)}</span>
                    <span class="pill ${m.source === 'override' ? 'accent' : 'outline'}">${esc(pricingSourceLabel(m.source))}</span>
                    ${m.promoLabel ? `<span class="pill warn promo-pill" data-tip="${esc(formatPromoLabel(m.promoLabel))}">${esc(t('settings.promoBadge'))}</span>` : ''}
                  </div>
                  <div style="display:flex;gap:4px">
                    <button type="button" class="btn-sm" data-action="toggle-edit-price" data-id="${esc(m.canonicalId)}" ${ro ? 'disabled' : ''}>${esc(isEditing ? t('common.cancel') : t('common.edit'))}</button>
                    ${m.source === 'override' ? `<button type="button" class="btn-sm danger" data-action="reset-price-override" data-id="${esc(m.canonicalId)}" ${ro ? 'disabled' : ''}>${esc(t('settings.restoreDefault'))}</button>` : ''}
                  </div>
                </div>
                <div class="muted-note num mono" style="font-size:11px">
                  In $${num(m.inputPer1m)} · Out $${num(m.outputPer1m)} · CacheRead $${num(m.cacheReadPer1m)} / 1M
                  ${m.longContextThreshold ? ` · &gt;${fmtTokens(m.longContextThreshold)}` : ''}
                </div>
                ${
                  isEditing
                    ? `<form class="pricing-editor" data-action="save-price-override" data-id="${esc(m.canonicalId)}">
                        <div class="form-grid">
                          <div class="field"><label>Input ($/1M)</label><input name="inputPer1m" type="number" step="0.001" min="0" value="${num(d.inputPer1m)}"></div>
                          <div class="field"><label>Output ($/1M)</label><input name="outputPer1m" type="number" step="0.001" min="0" value="${num(d.outputPer1m)}"></div>
                          <div class="field"><label>Cache Read ($/1M)</label><input name="cacheReadPer1m" type="number" step="0.0001" min="0" value="${num(d.cacheReadPer1m)}"></div>
                          <div class="field"><label>${esc(t('settings.thThreshold'))}</label><input name="longContextThreshold" type="number" step="1000" min="0" placeholder="${esc(t('settings.thThresholdPlaceholder'))}" value="${d.longContextThreshold ?? ''}"></div>
                          <div class="field"><label>${esc(t('settings.thInAbove'))}</label><input name="inputAbovePer1m" type="number" step="0.001" min="0" value="${d.inputAbovePer1m ?? ''}"></div>
                          <div class="field"><label>${esc(t('settings.thOutAbove'))}</label><input name="outputAbovePer1m" type="number" step="0.001" min="0" value="${d.outputAbovePer1m ?? ''}"></div>
                          <div class="field full"><label>${esc(t('settings.thCacheAbove'))}</label><input name="cacheReadAbovePer1m" type="number" step="0.0001" min="0" value="${d.cacheReadAbovePer1m ?? ''}"></div>
                        </div>
                        <div style="display:flex;justify-content:flex-end;gap:6px;margin-top:4px">
                          <button type="submit" class="btn-sm primary">${esc(t('settings.saveOverride'))}</button>
                        </div>
                      </form>`
                    : ''
                }
              </div>
            `;
          })
          .join('');
        pricingModelsHtml = `<div class="pricing-list-scroll" data-pricing-scroll>${rowsHtml}</div>`;
      }
    }

    dom.settingsBody.innerHTML = `
      <section class="set-section">
        <div class="set-title-row">
          <h3 class="set-title">${esc(t('settings.langSection'))}</h3>
        </div>
        <div class="set-card">
          <div class="set-mod-row">
            <div class="set-mod-meta">
              <span class="set-mod-name">中文 / English</span>
              <span class="set-mod-desc">${esc(t('settings.langDesc'))}</span>
            </div>
            <div class="seg">
              <button type="button" class="${lang === 'zh-CN' ? 'active' : ''}" data-action="set-lang" data-lang="zh-CN">中文</button>
              <button type="button" class="${lang === 'en' ? 'active' : ''}" data-action="set-lang" data-lang="en">English</button>
            </div>
          </div>
          <div class="set-mod-row">
            <div class="set-mod-meta">
              <span class="set-mod-name">
                <span>${esc(t('settings.autoRefreshName'))}</span>
                ${helpTip(t('settings.autoRefreshHelp'))}
              </span>
              <span class="set-mod-desc">${esc(t('settings.autoRefreshDesc'))}</span>
            </div>
            <label class="select sm" style="border:1px solid var(--border-c);border-radius:var(--r-md)">
              <select data-action="set-refresh-sec" aria-label="${esc(t('header.refreshIntervalAria'))}">
                <option value="0" ${refreshVal === '0' ? 'selected' : ''}>${esc(t('header.off'))}</option>
                <option value="15" ${refreshVal === '15' ? 'selected' : ''}>15s</option>
                <option value="30" ${refreshVal === '30' ? 'selected' : ''}>30s</option>
                <option value="60" ${refreshVal === '60' ? 'selected' : ''}>60s</option>
                <option value="300" ${refreshVal === '300' ? 'selected' : ''}>5m</option>
              </select>
            </label>
          </div>
        </div>
      </section>

      <section class="set-section">
        <div class="set-title-row">
          <h3 class="set-title">${esc(t('settings.modulesSection'))}</h3>
        </div>
        <div class="set-card">${modRows}</div>
      </section>

      <section class="set-section">
        <div class="set-title-row">
          <h3 class="set-title">
            <span>${esc(t('settings.sourcesSection'))}</span>
            ${helpTip(t('settings.sourcesHelp'))}
          </h3>
        </div>
        <div class="set-card">
          <div class="set-mod-row">
            <div class="set-mod-meta">
              <span class="set-mod-name">${esc(t('settings.desktopName'))}</span>
              <span class="set-mod-desc">${esc(t('settings.desktopDesc', { n: num(idxSt.desktopDbs, 0) }))}</span>
            </div>
            <label class="switch">
              <input type="checkbox" data-action="toggle-source" data-source="desktop" ${src.desktop ? 'checked' : ''}>
              <span class="switch-track"></span>
            </label>
          </div>
          <div class="set-mod-row">
            <div class="set-mod-meta">
              <span class="set-mod-name">${esc(t('settings.cliName'))}</span>
              <span class="set-mod-desc">${esc(t('settings.cliDesc', { n: num(idxSt.cliDbs, 0) }))}</span>
            </div>
            <label class="switch">
              <input type="checkbox" data-action="toggle-source" data-source="cli" ${src.cli ? 'checked' : ''}>
              <span class="switch-track"></span>
            </label>
          </div>
          <div class="chart-caption-row num">
            <span>${esc(t('settings.indexedTurns', { n: num(idxSt.indexedTurns, 0).toLocaleString() }))}</span>
            <span>${esc(t('settings.lastIndexed', { time: idxSt.lastIndexedAt ? fmtTimeShort(idxSt.lastIndexedAt) : '—' }))}</span>
          </div>
          <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap">
            <span class="muted-note" style="font-size:11px">${esc(t('settings.rebuildHint'))}</span>
            <button type="button" class="btn-sm" data-action="rebuild-index" ${state.rebuilding || ro ? 'disabled' : ''}>${esc(state.rebuilding ? t('settings.rebuilding') : t('settings.rebuildBtn'))}</button>
          </div>
          ${state.rebuildMsg ? `<div class="muted-note" style="color:var(--ok)">${esc(state.rebuildMsg)}</div>` : ''}
        </div>
      </section>

      <section class="set-section">
        <div class="set-title-row">
          <h3 class="set-title">${esc(t('settings.pricingSection'))}</h3>
        </div>
        <div class="set-card">
          ${defAnchorsNoteHtml}
          <div class="field">
            <label>${esc(t('settings.defaultsPath'))}</label>
            <div class="path-box">${esc(state.paths.defaultsFile || t('settings.builtinDefaults'))}</div>
          </div>
          <div class="field">
            <label>${esc(t('settings.overridesPath'))}</label>
            <div class="path-box">${esc(state.paths.overridesFile || '—')}</div>
          </div>
          <div class="set-mod-row">
            <div class="set-mod-meta">
              <span class="set-mod-name">
                <span>${esc(t('settings.autoSyncName'))}</span>
                ${helpTip(t('settings.autoSyncHelp'))}
              </span>
              <span class="set-mod-desc">${esc(t('settings.autoSyncDesc'))}</span>
            </div>
            <label class="switch">
              <input type="checkbox" data-action="toggle-auto-sync" ${state.config.pricingAutoSync ? 'checked' : ''} ${ro ? 'disabled' : ''}>
              <span class="switch-track"></span>
            </label>
          </div>
          <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap">
            <span class="muted-note num" style="font-size:11px">${esc(t('settings.lastSynced', { time: prSt.lastSyncedAt ? fmtTimeShort(prSt.lastSyncedAt) : t('settings.neverSynced') }))}</span>
            <button type="button" class="btn-sm" data-action="sync-pricing" ${pr.syncing || ro ? 'disabled' : ''}>${esc(pr.syncing ? t('settings.syncing') : t('settings.syncBtn'))}</button>
          </div>
          ${pr.syncMsg ? `<div class="muted-note">${esc(pr.syncMsg)}</div>` : ''}
          <div style="border-top:1px solid var(--line);padding-top:8px">
            <button type="button" class="btn-sm" style="width:100%" data-action="toggle-pricing-list">
              ${esc(pr.expanded ? t('settings.collapsePricing') : t('settings.expandPricing'))}${pr.expanded && Array.isArray(pr.data?.models) ? ` (${pr.data.models.length})` : ''}
            </button>
          </div>
          ${pricingModelsHtml}
        </div>
      </section>

      ${renderSettingsUpdateSection()}
    `;

    if (prevPricingScrollTop > 0) {
      const nextPricingScrollEl = dom.settingsBody.querySelector('[data-pricing-scroll]');
      if (nextPricingScrollEl) nextPricingScrollEl.scrollTop = prevPricingScrollTop;
    }
  }

  function renderSettingsUpdateSection() {
    const u = state.update.data;
    const ro = isReadOnlyMode();
    const mode = state.config.updateMode || 'auto';
    const verStr = u?.currentVersion || state.runningVersion || '—';
    const installLbl = u ? getUpdateInstallLabel(u.installKind) : '';
    const isStaged = Boolean(u && u.hasUpdate && u.stagedVersion === u.latestVersion);
    const applyLbl = state.update.applying
      ? t('update.applying')
      : isStaged
        ? t('update.restartBtn', { ver: u.latestVersion })
        : t('update.applyBtn');

    return `
      <section class="set-section">
        <div class="set-title-row">
          <h3 class="set-title">${esc(t('update.sectionTitle'))}</h3>
          <span class="pill outline mono">v${esc(verStr)}${installLbl ? ` · ${esc(installLbl)}` : ''}</span>
        </div>
        <div class="set-card">
          <div class="set-mod-row">
            <div class="set-mod-meta">
              <span class="set-mod-name">
                <span>${esc(t('update.modeLabel'))}</span>
                ${helpTip(t('update.modeHelp'))}
              </span>
            </div>
            <div class="seg">
              <button type="button" class="${mode === 'auto' ? 'active' : ''}" data-action="set-update-mode" data-mode="auto" ${ro ? 'disabled' : ''}>${esc(t('update.modeAuto'))}</button>
              <button type="button" class="${mode === 'notify' ? 'active' : ''}" data-action="set-update-mode" data-mode="notify" ${ro ? 'disabled' : ''}>${esc(t('update.modeNotify'))}</button>
              <button type="button" class="${mode === 'off' ? 'active' : ''}" data-action="set-update-mode" data-mode="off" ${ro ? 'disabled' : ''}>${esc(t('update.modeOff'))}</button>
            </div>
          </div>

          <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap">
            <span class="muted-note num" style="font-size:11px">
              ${
                u && u.hasUpdate
                  ? `<strong style="color:var(--accent)">v${esc(u.latestVersion)}</strong>${u.manualOnly ? ` <span class="pill outline" style="font-size:9.5px">${esc(t('update.manualOnlyBadge'))}</span>` : ''} · ${esc(t('update.lastChecked', { time: u.lastCheckedAt ? fmtTimeShort(u.lastCheckedAt) : t('update.neverChecked') }))}`
                  : `${esc(t('update.upToDate'))} · ${esc(t('update.lastChecked', { time: u?.lastCheckedAt ? fmtTimeShort(u.lastCheckedAt) : t('update.neverChecked') }))}`
              }
            </span>
            <div style="display:flex;gap:6px;flex-wrap:wrap">
              <button type="button" class="btn-sm" data-action="check-update" ${state.update.checking || ro ? 'disabled' : ''}>
                ${esc(state.update.checking ? t('update.checking') : t('update.checkBtn'))}
              </button>
              ${
                u && u.hasUpdate && u.canAutoApply
                  ? `<button type="button" class="btn-sm primary" data-action="apply-update" ${state.update.applying || u.staging || ro ? 'disabled' : ''}>${esc(applyLbl)}</button>`
                  : ''
              }
            </div>
          </div>

          ${u && u.hasUpdate && u.manualOnly ? `<div class="muted-note" style="font-size:11px">${esc(t('update.manualOnlyNote'))}</div>` : ''}
          ${isStaged ? `<div class="muted-note" style="color:var(--ok);font-size:11px">${esc(t('update.stagedReady'))}</div>` : ''}
          ${u && u.staging && !isStaged ? `<div class="muted-note" style="font-size:11px">${esc(t('update.staging'))}</div>` : ''}
          ${u && u.hasUpdate && !u.canAutoApply ? `<div class="muted-note" style="color:var(--warn);font-size:11px">${esc(getUpdateBlockedMessage(u.blockedReason))}</div>` : ''}
          ${u && u.failedVersion ? `<div class="muted-note" style="color:var(--warn);font-size:11px">${esc(t('update.failedWarn', { ver: u.failedVersion }))}</div>` : ''}
          ${u && u.lastError ? `<div class="muted-note" style="color:var(--bad);font-size:11px">${esc(u.lastError)}</div>` : ''}

          ${
            u && u.canRollback && u.rollbackVersion
              ? `<div style="border-top:1px solid var(--line);padding-top:8px;display:flex;align-items:center;justify-content:flex-end">
                  <button type="button" class="btn-sm" data-action="rollback-update" ${state.update.rollingBack || ro ? 'disabled' : ''}>
                    ${esc(state.update.rollingBack ? t('update.rollingBack') : t('update.rollbackBtn', { ver: u.rollbackVersion }))}
                  </button>
                </div>`
              : ''
          }
        </div>
      </section>
    `;
  }

  function renderAll(isBackground = false) {
    renderHeader();
    const active = document.activeElement;
    const editingQuotaForm = Boolean(
      isBackground &&
        active &&
        active.closest &&
        (active.closest('#quota-anchor-form') ||
          active.closest('.anchor-edit-inline') ||
          active.closest('.calib-anchor-select') ||
          active.closest('[data-obs-gap-input="1"]'))
    );
    const editingSettingsInput = Boolean(
      isBackground && active && active.closest && active.closest('#settings-body input, #settings-body select')
    );
    if (!editingQuotaForm) renderGrid();
    if (!editingSettingsInput) renderSettings();
  }

  // =========================================================================
  // 19. Interactive Event Handlers & Clipboard
  // =========================================================================
  function openSettings() {
    dismissHelpPin();
    state.settingsOpen = true;
    dom.btnSettings.setAttribute('aria-expanded', 'true');
    dom.settingsBackdrop.classList.remove('hidden');
    dom.settingsDrawer.classList.remove('hidden');
    renderSettings();
    dom.settingsDrawer.focus();
    fetchUpdateStatus();
    if (!state.pricing.data && !state.pricing.loading && !state.pricing.prefetching) {
      state.pricing.prefetching = true;
      getJson('/api/pricing')
        .then((d) => {
          if (!state.pricing.data) {
            state.pricing.data = d;
            if (state.settingsOpen) renderSettings();
          }
        })
        .catch(() => {})
        .finally(() => {
          state.pricing.prefetching = false;
        });
    }
  }

  function closeSettings() {
    dismissHelpPin();
    state.settingsOpen = false;
    dom.btnSettings.setAttribute('aria-expanded', 'false');
    dom.settingsBackdrop.classList.add('hidden');
    dom.settingsDrawer.classList.add('hidden');
  }

  async function loadPricingList() {
    state.pricing.loading = true;
    state.pricing.error = '';
    renderSettings();
    try {
      state.pricing.data = await getJson('/api/pricing');
    } catch (err) {
      state.pricing.error = err.message;
    } finally {
      state.pricing.loading = false;
      renderSettings();
    }
  }

  async function copyTextWithFallback(text) {
    if (!text) return false;
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      try {
        await navigator.clipboard.writeText(text);
        return true;
      } catch (_) {}
    }
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.cssText = 'position:fixed;top:-9999px;left:-9999px;opacity:0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return Boolean(ok);
    } catch (_) {
      return false;
    }
  }

  // Header Controls
  dom.refreshSelect.addEventListener('change', async (e) => {
    const val = Number(e.target.value);
    state.config.refreshSec = Number.isFinite(val) ? val : 30;
    resetRefreshTimer();
    if (state.settingsOpen) renderSettings();
    await saveConfigPatch({ refreshSec: state.config.refreshSec });
  });

  dom.btnRefresh.addEventListener('click', () => refreshAll(true));
  if (dom.btnThemeToggle) {
    dom.btnThemeToggle.addEventListener('click', () => {
      if (typeof window.__AGY_LENS_SET_THEME__ !== 'function') return;
      const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
      window.__AGY_LENS_SET_THEME__(next);
    });
  }
  dom.btnSettings.addEventListener('click', openSettings);
  dom.btnOpenSettingsEmpty.addEventListener('click', openSettings);
  dom.btnCloseSettings.addEventListener('click', closeSettings);
  dom.settingsBackdrop.addEventListener('click', closeSettings);
  dom.sourcesBadge.addEventListener('click', openSettings);

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (state.pinnedHelpEl || !dom.chartTooltip.classList.contains('hidden')) {
        dismissHelpPin();
        return;
      }
      if (state.settingsOpen) closeSettings();
    }
  });

  // Range Pills
  dom.rangeBar.addEventListener('click', async (e) => {
    const btn = e.target.closest('.range-pill');
    if (!btn) return;
    const r = btn.dataset.range;
    if (!r) return;
    state.rangeKey = r;
    if (r === 'custom') {
      if (!state.customTo) state.customTo = fmtLocalDateStr(new Date());
      if (!state.customFrom) {
        const d = new Date();
        d.setDate(d.getDate() - 6);
        state.customFrom = fmtLocalDateStr(d);
      }
      dom.customFrom.value = state.customFrom;
      dom.customTo.value = state.customTo;
      renderHeader();
      return;
    }
    renderHeader();
    await saveConfigPatch({ defaultRange: r });
    refreshAll(true);
  });

  dom.btnApplyCustom.addEventListener('click', () => {
    state.customFrom = dom.customFrom.value;
    state.customTo = dom.customTo.value;
    if (state.customFrom && state.customTo) refreshAll(true);
  });

  // Modules Grid Click Delegation
  dom.modulesGrid.addEventListener('click', async (e) => {
    if (e.target.closest('.help-tip')) return;
    const stopEl = e.target.closest('[data-stop-card]');
    const actionEl = e.target.closest('[data-action]');

    if (actionEl) {
      const action = actionEl.dataset.action;

      if (action === 'toggle-card') {
        if (stopEl) return;
        const mod = actionEl.dataset.module;
        const next = !isCardExpandedForView(mod);
        if (state.query.expandAll || state.query.expandSet) {
          state.localExpandedOverrides.set(mod, next);
          renderGrid();
          return;
        }
        state.config.expanded[mod] = next;
        renderGrid();
        await saveConfigPatch({ expanded: { [mod]: next } });
        return;
      }

      if (action === 'toggle-ctx-cat') {
        const key = actionEl.dataset.cat;
        if (state.ctxOpenCategories.has(key)) state.ctxOpenCategories.delete(key);
        else state.ctxOpenCategories.add(key);
        renderGrid();
        return;
      }

      if (action === 'set-io-scope') {
        e.stopPropagation();
        const sc = actionEl.dataset.scope;
        if (sc && sc !== state.ioScope) {
          state.ioScope = sc;
          renderHeader();
          renderGrid();
          refreshAll(true);
        }
        return;
      }

      if (action === 'set-model-view') {
        state.modelView = actionEl.dataset.view;
        renderGrid();
        return;
      }

      if (action === 'set-model-sort') {
        state.modelSort = actionEl.dataset.sort;
        renderGrid();
        return;
      }

      if (action === 'set-cal-metric') {
        state.calMetric = actionEl.dataset.metric;
        renderGrid();
        return;
      }

      if (action === 'select-day') {
        const date = actionEl.dataset.date;
        if (!date) return;
        state.selectedDay = { date, loading: true, error: '', data: null };
        renderGrid();
        try {
          const srcs = encodeURIComponent(getActiveSourcesList().join(','));
          const data = await getJson(`/api/day?date=${encodeURIComponent(date)}&sources=${srcs}`);
          if (state.selectedDay && state.selectedDay.date === date) {
            state.selectedDay = { date, loading: false, error: '', data };
            renderGrid();
          }
        } catch (err) {
          if (state.selectedDay && state.selectedDay.date === date) {
            state.selectedDay = { date, loading: false, error: err.message, data: null };
            renderGrid();
          }
        }
        return;
      }

      if (action === 'close-day') {
        state.selectedDay = null;
        renderGrid();
        return;
      }

      if (action === 'toggle-obs-metric-menu') {
        e.stopPropagation();
        if (!state.obsMetricMenuOpen) {
          dismissObsCellPopover();
          state.obsGapMenuOpen = false;
        }
        state.obsMetricMenuOpen = !state.obsMetricMenuOpen;
        renderGrid();
        return;
      }

      if (action === 'toggle-obs-gap-menu') {
        e.stopPropagation();
        if (!state.obsGapMenuOpen) {
          dismissObsCellPopover();
          state.obsMetricMenuOpen = false;
          state.obsGapError = '';
        }
        state.obsGapMenuOpen = !state.obsGapMenuOpen;
        renderGrid();
        return;
      }

      if (action === 'toggle-obs-gap-preset') {
        e.stopPropagation();
        const sec = Math.round(Number(actionEl.dataset.sec));
        if (!Number.isFinite(sec) || sec < 1) return;
        const cur = sanitizeObsGapBreakpoints(state.config.obsGapBreakpointsSec);
        state.obsGapError = '';
        let next;
        if (cur.includes(sec)) {
          if (cur.length <= 1) {
            state.obsGapError = t('obs.gapErrMinOne');
            renderGrid();
            return;
          }
          next = cur.filter((x) => x !== sec);
        } else {
          if (cur.length >= 12) {
            state.obsGapError = t('obs.gapErrMax');
            renderGrid();
            return;
          }
          next = sanitizeObsGapBreakpoints([...cur, sec]);
        }
        state.config.obsGapBreakpointsSec = next;
        renderGrid();
        await saveConfigPatch({ obsGapBreakpointsSec: next });
        await refreshAll(true);
        return;
      }

      if (action === 'add-obs-gap-custom') {
        e.stopPropagation();
        const sec = parseGapDurationInput(state.obsGapDraft);
        if (!sec) {
          state.obsGapError = t('obs.gapErrInvalid');
          renderGrid();
          return;
        }
        const cur = sanitizeObsGapBreakpoints(state.config.obsGapBreakpointsSec);
        if (!cur.includes(sec) && cur.length >= 12) {
          state.obsGapError = t('obs.gapErrMax');
          renderGrid();
          return;
        }
        state.obsGapError = '';
        state.obsGapDraft = '';
        const next = sanitizeObsGapBreakpoints([...cur, sec]);
        state.config.obsGapBreakpointsSec = next;
        renderGrid();
        await saveConfigPatch({ obsGapBreakpointsSec: next });
        await refreshAll(true);
        return;
      }

      if (action === 'remove-obs-gap-custom') {
        e.stopPropagation();
        const sec = Math.round(Number(actionEl.dataset.sec));
        const cur = sanitizeObsGapBreakpoints(state.config.obsGapBreakpointsSec);
        if (cur.length <= 1) {
          state.obsGapError = t('obs.gapErrMinOne');
          renderGrid();
          return;
        }
        state.obsGapError = '';
        const next = cur.filter((x) => x !== sec);
        state.config.obsGapBreakpointsSec = next;
        renderGrid();
        await saveConfigPatch({ obsGapBreakpointsSec: next });
        await refreshAll(true);
        return;
      }

      if (action === 'reset-obs-gaps') {
        e.stopPropagation();
        state.obsGapError = '';
        state.obsGapDraft = '';
        const next = [...DEFAULT_OBS_GAP_BREAKPOINTS];
        state.config.obsGapBreakpointsSec = next;
        renderGrid();
        await saveConfigPatch({ obsGapBreakpointsSec: next });
        await refreshAll(true);
        return;
      }

      if (action === 'set-obs-primary') {
        e.stopPropagation();
        const metric = actionEl.dataset.metric;
        if (!OBS_MATRIX_METRIC_IDS.includes(metric)) return;
        const { primary: prevPrimary, subs: prevSubs } = getObsMatrixPrefs();
        if (metric === prevPrimary) return;
        const nextSubSet = new Set(prevSubs.filter((id) => id !== metric));
        nextSubSet.add(prevPrimary);
        const nextSubs = OBS_MATRIX_METRIC_IDS.filter((id) => nextSubSet.has(id));
        state.config.obsMatrixPrimary = metric;
        state.config.obsMatrixSubMetrics = nextSubs;
        renderGrid();
        await saveConfigPatch({
          obsMatrixPrimary: metric,
          obsMatrixSubMetrics: nextSubs
        });
        return;
      }

      if (action === 'toggle-obs-sub') {
        e.stopPropagation();
        const metric = actionEl.dataset.metric;
        if (!OBS_MATRIX_METRIC_IDS.includes(metric)) return;
        const { primary, subs } = getObsMatrixPrefs();
        if (metric === primary) return;
        const nextSubSet = new Set(subs);
        if (nextSubSet.has(metric)) {
          nextSubSet.delete(metric);
        } else {
          nextSubSet.add(metric);
        }
        const nextSubs = OBS_MATRIX_METRIC_IDS.filter((id) => nextSubSet.has(id));
        state.config.obsMatrixSubMetrics = nextSubs;
        renderGrid();
        await saveConfigPatch({ obsMatrixSubMetrics: nextSubs });
        return;
      }

      if (action === 'reset-obs-metrics') {
        e.stopPropagation();
        const nextPrimary = DEFAULT_CONFIG.obsMatrixPrimary;
        const nextSubs = [...DEFAULT_CONFIG.obsMatrixSubMetrics];
        state.config.obsMatrixPrimary = nextPrimary;
        state.config.obsMatrixSubMetrics = nextSubs;
        renderGrid();
        await saveConfigPatch({
          obsMatrixPrimary: nextPrimary,
          obsMatrixSubMetrics: nextSubs
        });
        return;
      }

      if (action === 'set-obs-filter') {
        state.obsModelFilter = actionEl.dataset.model || 'all';
        renderGrid();
        return;
      }

      if (action === 'toggle-obs-anomalies') {
        state.obsAnomaliesOpen = !state.obsAnomaliesOpen;
        renderGrid();
        return;
      }

      if (action === 'copy-obs-issue') {
        const md = state.analytics?.cacheObservatory?.issueMarkdown || '';
        const ok = await copyTextWithFallback(md);
        state.obsCopyStatus = ok ? 'copied' : 'failed';
        if (state.obsCopyTimer) clearTimeout(state.obsCopyTimer);
        renderGrid();
        state.obsCopyTimer = setTimeout(() => {
          state.obsCopyStatus = '';
          renderGrid();
        }, 2000);
        return;
      }

      if (action === 'set-quota-mode') {
        e.stopPropagation();
        const mode = actionEl.dataset.mode === 'used' ? 'used' : 'remaining';
        state.config.quotaDisplayMode = mode;
        renderGrid();
        await saveConfigPatch({ quotaDisplayMode: mode });
        return;
      }

      if (action === 'set-qa-offset') {
        const off = actionEl.dataset.offset;
        state.quotaForm.captureOffsetMin = off === 'custom' ? 'custom' : Number(off);
        if (off === 'custom' && !state.quotaForm.customCaptureAt) {
          const now = new Date();
          now.setMinutes(now.getMinutes() - now.getTimezoneOffset());
          state.quotaForm.customCaptureAt = now.toISOString().slice(0, 16);
        }
        renderGrid();
        return;
      }

      if (action === 'toggle-calib-lab') {
        const key = actionEl.dataset.key;
        if (!key) return;
        const currentlyOpen = actionEl.classList.contains('open');
        state.quotaLabOpenByKey.set(key, !currentlyOpen);
        renderGrid();
        return;
      }

      if (action === 'set-calib-auto') {
        state.config.quotaCalibMode = 'auto';
        renderGrid();
        await saveConfigPatch({ quotaCalibMode: 'auto' });
        await refreshQuotaOnly();
        return;
      }

      if (action === 'toggle-calib-factor') {
        if (actionEl.getAttribute('aria-disabled') === 'true') return;
        const factor = actionEl.dataset.factor;
        if (!['M', 'C', 'O'].includes(factor)) return;
        const pool = actionEl.dataset.pool;
        const wt = actionEl.dataset.wt;
        const matchedSum = (state.quotaData?.summaries || []).find(
          (s) => s.pool === pool && s.windowType === wt
        );
        const curActive = matchedSum?.estimation?.calibration?.activeFactors;
        const base = curActive
          ? { M: Boolean(curActive.M), C: Boolean(curActive.C), O: Boolean(curActive.O) }
          : { ...(state.config.quotaManualFactors || { M: false, C: false, O: false }) };
        const nextFactors = { ...base, [factor]: !base[factor] };
        state.config.quotaCalibMode = 'manual';
        state.config.quotaManualFactors = nextFactors;
        renderGrid();
        await saveConfigPatch({ quotaCalibMode: 'manual', quotaManualFactors: nextFactors });
        await refreshQuotaOnly();
        return;
      }

      if (action === 'toggle-older-anchors') {
        state.quotaOlderOpen = !state.quotaOlderOpen;
        renderGrid();
        return;
      }

      if (action === 'edit-anchor-reset') {
        if (isReadOnlyMode()) return;
        const id = Number(actionEl.dataset.id);
        if (!Number.isFinite(id)) return;
        const anchor = (state.quotaData?.anchors || []).find((a) => a.id === id);
        state.quotaEditingAnchorId = state.quotaEditingAnchorId === id ? null : id;
        const prefill =
          state.quotaEditingAnchorId != null && anchor?.resetAt != null ? fmtTimeShort(anchor.resetAt) : '';
        state.quotaEditingResetInput = prefill;
        state.quotaEditingOriginalText = prefill;
        state.quotaEditingError = '';
        state.quotaEditingSaving = false;
        renderGrid();
        return;
      }

      if (action === 'cancel-anchor-reset') {
        state.quotaEditingAnchorId = null;
        state.quotaEditingResetInput = '';
        state.quotaEditingOriginalText = '';
        state.quotaEditingError = '';
        state.quotaEditingSaving = false;
        renderGrid();
        return;
      }

      if (action === 'clear-anchor-reset') {
        if (isReadOnlyMode()) return;
        const id = Number(actionEl.dataset.id);
        if (!Number.isFinite(id)) return;
        state.quotaEditingSaving = true;
        state.quotaEditingError = '';
        renderGrid();
        try {
          state.quotaData = await postJson('/api/quota/anchors/update', { id, resetAt: null });
          state.quotaEditingAnchorId = null;
          state.quotaEditingResetInput = '';
          state.quotaEditingOriginalText = '';
        } catch (err) {
          state.quotaEditingError = t('quota.updateFailed', { msg: err.message });
        } finally {
          state.quotaEditingSaving = false;
          renderGrid();
        }
        return;
      }

      if (action === 'save-anchor-reset') {
        if (isReadOnlyMode()) return;
        const id = Number(actionEl.dataset.id);
        if (!Number.isFinite(id)) return;
        const anchor = (state.quotaData?.anchors || []).find((a) => a.id === id);
        if (!anchor) return;
        const rawVal = String(state.quotaEditingResetInput || '').trim();
        // Require non-empty modified text to save; clearing must use the explicit Clear button (I4/M4).
        if (!rawVal || rawVal === state.quotaEditingOriginalText) return;
        const cap = num(anchor.capturedAt ?? anchor.captured_at, Date.now());
        const wt = anchor.windowType ?? anchor.window_type ?? '7d';
        const parsed = parseResetInput(rawVal, cap, wt);
        if (!parsed.ok) {
          state.quotaEditingError = parsed.preview;
          renderGrid();
          return;
        }
        state.quotaEditingSaving = true;
        state.quotaEditingError = '';
        renderGrid();
        try {
          state.quotaData = await postJson('/api/quota/anchors/update', {
            id,
            resetAt: parsed.ts,
            resetPrecisionMs: parsed.precisionMs,
          });
          state.quotaEditingAnchorId = null;
          state.quotaEditingResetInput = '';
          state.quotaEditingOriginalText = '';
        } catch (err) {
          state.quotaEditingError = t('quota.updateFailed', { msg: err.message });
        } finally {
          state.quotaEditingSaving = false;
          renderGrid();
        }
        return;
      }

      if (action === 'delete-anchor') {
        if (isReadOnlyMode()) return;
        const id = Number(actionEl.dataset.id);
        if (!Number.isFinite(id)) return;
        try {
          state.quotaData = await postJson('/api/quota/anchors/delete', { id });
          if (state.quotaEditingAnchorId === id) {
            state.quotaEditingAnchorId = null;
            state.quotaEditingResetInput = '';
          }
          renderGrid();
        } catch (err) {
          state.quotaForm.error = t('quota.deleteFailed', { msg: err.message });
          renderGrid();
        }
        return;
      }
    }
  });

  // Preserve Quota Form & Gap Breakpoint input values across light edits
  dom.modulesGrid.addEventListener('input', (e) => {
    const tgt = e.target;
    if (tgt.dataset?.obsGapInput === '1') {
      state.obsGapDraft = tgt.value;
      return;
    }
    if (tgt.dataset?.editResetInput === '1') {
      state.quotaEditingResetInput = tgt.value;
      state.quotaEditingError = '';
      const id = Number(tgt.dataset.id);
      const anchor = (state.quotaData?.anchors || []).find((a) => a.id === id);
      const wrap = tgt.closest('.anchor-edit-inline');
      if (anchor && wrap) {
        const trimmedVal = String(tgt.value || '').trim();
        const p = parseResetInput(
          trimmedVal,
          num(anchor.capturedAt ?? anchor.captured_at, Date.now()),
          anchor.windowType ?? anchor.window_type ?? '7d'
        );
        const saveBtn = wrap.querySelector('[data-action="save-anchor-reset"]');
        if (saveBtn) {
          saveBtn.disabled =
            state.quotaEditingSaving ||
            !trimmedVal ||
            trimmedVal === state.quotaEditingOriginalText ||
            !p.ok;
        }
        let hint = wrap.querySelector('.field-hint');
        if (!hint && tgt.value) {
          hint = document.createElement('div');
          hint.className = 'field-hint';
          wrap.appendChild(hint);
        }
        if (hint) {
          hint.textContent = tgt.value ? p.preview : '';
          hint.style.color = tgt.value ? (p.ok ? 'var(--ok)' : 'var(--bad)') : '';
        }
      }
      return;
    }
    if (tgt.id === 'qa-pool') state.quotaForm.pool = tgt.value;
    else if (tgt.id === 'qa-window') state.quotaForm.windowType = tgt.value;
    else if (tgt.id === 'qa-pct') state.quotaForm.remainingPct = tgt.value;
    else if (tgt.id === 'qa-reset') {
      state.quotaForm.resetInput = tgt.value;
      const hint = tgt.parentElement?.querySelector('.field-hint');
      if (hint) {
        const p = parseResetInput(tgt.value, getFormCapturedAtMs(), state.quotaForm.windowType);
        const inheritable = getInheritableResetAt(state.quotaForm.pool, state.quotaForm.windowType);
        const emptyHint = inheritable
          ? t('quota.resetInheritHint', { time: fmtResetClock(inheritable) })
          : t('quota.resetHint');
        hint.textContent = tgt.value ? p.preview : emptyHint;
        hint.style.color = tgt.value ? (p.ok ? 'var(--ok)' : 'var(--bad)') : '';
      }
    } else if (tgt.id === 'qa-custom-time') {
      state.quotaForm.customCaptureAt = tgt.value;
      const resetInputEl = dom.modulesGrid.querySelector('#qa-reset');
      if (resetInputEl && state.quotaForm.resetInput) {
        const hint = resetInputEl.parentElement?.querySelector('.field-hint');
        if (hint) {
          const p = parseResetInput(state.quotaForm.resetInput, getFormCapturedAtMs(), state.quotaForm.windowType);
          hint.textContent = p.preview;
          hint.style.color = p.ok ? 'var(--ok)' : 'var(--bad)';
        }
      }
    } else if (tgt.id === 'qa-note') state.quotaForm.note = tgt.value;
  });

  dom.modulesGrid.addEventListener('change', async (e) => {
    const tgt = e.target;
    if (tgt.id === 'qa-pool') {
      state.quotaForm.pool = tgt.value;
      renderGrid();
    } else if (tgt.id === 'qa-window') {
      state.quotaForm.windowType = tgt.value;
      if (tgt.value === '5h') {
        const has5h = (state.quotaData?.anchors || []).some((a) => (a.windowType ?? a.window_type) === '5h');
        if (has5h) state.quotaOlderOpen = true;
      }
      renderGrid();
    } else if (tgt.dataset?.action === 'select-session') {
      state.selectedConversationId = tgt.value || '';
      await refreshAll(true);
    } else if (tgt.dataset?.action === 'set-pool-anchor') {
      const pool = tgt.dataset.pool;
      const modelId = tgt.value;
      if (!pool || !modelId) return;
      const nextAnchors = { ...(state.config.quotaAnchorsByPool || {}), [pool]: modelId };
      state.config.quotaAnchorsByPool = nextAnchors;
      await saveConfigPatch({ quotaAnchorsByPool: nextAnchors });
      await refreshQuotaOnly();
    }
  });

  dom.modulesGrid.addEventListener('submit', async (e) => {
    if (e.target.id !== 'quota-anchor-form') return;
    e.preventDefault();
    if (isReadOnlyMode()) return;
    const f = state.quotaForm;
    const rawStr = String(f.remainingPct ?? '').trim();
    const pctVal = Number(rawStr);
    if (!rawStr || !Number.isFinite(pctVal) || pctVal < 0 || pctVal > 100) {
      f.error = t('quota.invalidPct');
      renderGrid();
      return;
    }

    const capturedAt = getFormCapturedAtMs(f);
    const parsedReset = parseResetInput(f.resetInput, capturedAt, f.windowType);
    if (!parsedReset.ok) {
      f.error = parsedReset.preview;
      renderGrid();
      return;
    }

    f.submitting = true;
    f.error = '';
    renderGrid();

    try {
      const res = await postJson('/api/quota/anchors', {
        pool: f.pool,
        windowType: f.windowType,
        remainingPct: Math.round(pctVal * 100) / 100,
        rawInput: rawStr,
        capturedAt,
        resetAt: parsedReset.ts,
        resetPrecisionMs: parsedReset.precisionMs,
        note: f.note.trim() || null
      });
      state.quotaData = res;
      f.remainingPct = '';
      f.note = '';
      f.resetInput = '';
      f.captureOffsetMin = 0;
    } catch (err) {
      f.error = t('quota.recordFailed', { msg: err.message });
    } finally {
      f.submitting = false;
      renderGrid();
    }
  });

  // Keyboard toggle on card headers
  dom.modulesGrid.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const head = e.target.closest('.card-head[data-action="toggle-card"]');
    if (head && e.target === head) {
      e.preventDefault();
      head.click();
    }
  });

  // Settings Drawer Delegation
  dom.settingsBody.addEventListener('click', async (e) => {
    if (e.target.closest('.help-tip')) return;
    const actionEl = e.target.closest('[data-action]');
    if (!actionEl) return;
    const action = actionEl.dataset.action;

    if (action === 'set-lang') {
      const nextLang = normalizeLang(actionEl.dataset.lang) || 'zh-CN';
      state.query.lang = null; // explicit user choice overrides query param in current view
      state.config.lang = nextLang;
      renderAll();
      await saveConfigPatch({ lang: nextLang });
      return;
    }

    if (action === 'set-update-mode') {
      if (isReadOnlyMode()) return;
      const mode = actionEl.dataset.mode;
      if (!['auto', 'notify', 'off'].includes(mode)) return;
      state.config.updateMode = mode;
      renderSettings();
      await saveConfigPatch({ updateMode: mode });
      fetchUpdateStatus();
      return;
    }

    if (action === 'check-update') {
      await triggerUpdateCheck();
      return;
    }

    if (action === 'apply-update') {
      await triggerUpdateApply();
      return;
    }

    if (action === 'rollback-update') {
      await triggerUpdateRollback();
      return;
    }

    if (action === 'move-module') {
      const mod = actionEl.dataset.module;
      const dir = Number(actionEl.dataset.dir);
      const arr = [...state.config.moduleOrder];
      const idx = arr.indexOf(mod);
      const nextIdx = idx + dir;
      if (idx < 0 || nextIdx < 0 || nextIdx >= arr.length) return;
      [arr[idx], arr[nextIdx]] = [arr[nextIdx], arr[idx]];
      state.config.moduleOrder = arr;
      renderAll();
      await saveConfigPatch({ moduleOrder: arr });
      return;
    }

    if (action === 'rebuild-index') {
      if (isReadOnlyMode()) return;
      state.rebuilding = true;
      state.rebuildMsg = '';
      renderSettings();
      try {
        const res = await postJson('/api/index/rebuild', {});
        if (res.indexStatus) state.indexStatus = res.indexStatus;
        state.rebuildMsg = t('settings.rebuildDone', {
          dbs: num(res.scannedDbs ?? res.indexStats?.scannedDbs, 0),
          ms: num(res.elapsedMs ?? res.indexStats?.elapsedMs, 0)
        });
        await refreshAll(true);
      } catch (err) {
        state.rebuildMsg = t('settings.rebuildFail', { msg: err.message });
      } finally {
        state.rebuilding = false;
        renderSettings();
      }
      return;
    }

    if (action === 'sync-pricing') {
      if (isReadOnlyMode()) return;
      state.pricing.syncing = true;
      state.pricing.syncMsg = '';
      renderSettings();
      try {
        const res = await postJson('/api/pricing/sync', {});
        if (res.pricing) state.pricing.data = res.pricing;
        if (res.syncedAt) state.pricingStatus.lastSyncedAt = res.syncedAt;
        state.pricing.syncMsg = res.ok
          ? res.remoteTotalCount != null && Number.isFinite(Number(res.remoteTotalCount))
            ? t('settings.syncOkFiltered', { total: num(res.remoteTotalCount, 0), n: num(res.matchedCount, 0) })
            : t('settings.syncOk', { n: num(res.matchedCount, 0) })
          : t('settings.syncErr', { msg: res.error || t('common.unknown') });
      } catch (err) {
        state.pricing.syncMsg = t('settings.syncFail', { msg: err.message });
      } finally {
        state.pricing.syncing = false;
        renderSettings();
      }
      return;
    }

    if (action === 'toggle-pricing-list') {
      state.pricing.expanded = !state.pricing.expanded;
      if (state.pricing.expanded && !state.pricing.data) {
        await loadPricingList();
      } else {
        renderSettings();
      }
      return;
    }

    if (action === 'toggle-edit-price') {
      if (isReadOnlyMode()) return;
      const id = actionEl.dataset.id;
      if (state.pricing.editingId === id) {
        state.pricing.editingId = null;
        state.pricing.draft = null;
      } else {
        const found = state.pricing.data?.models?.find((m) => m.canonicalId === id);
        state.pricing.editingId = id;
        state.pricing.draft = found ? { ...found } : null;
      }
      renderSettings();
      return;
    }

    if (action === 'reset-price-override') {
      if (isReadOnlyMode()) return;
      const id = actionEl.dataset.id;
      try {
        state.pricing.data = await postJson('/api/pricing/overrides', {
          canonicalId: id,
          override: null
        });
        state.pricing.editingId = null;
        renderSettings();
        refreshAll(true);
      } catch (err) {
        state.pricing.syncMsg = t('settings.restoreFail', { msg: err.message });
        renderSettings();
      }
      return;
    }
  });

  dom.settingsBody.addEventListener('change', async (e) => {
    const tgt = e.target;
    const action = tgt.dataset?.action;
    if (!action) return;

    if (action === 'set-refresh-sec') {
      const val = Number(tgt.value);
      state.config.refreshSec = Number.isFinite(val) ? val : 30;
      resetRefreshTimer();
      renderHeader();
      await saveConfigPatch({ refreshSec: state.config.refreshSec });
      return;
    }

    if (action === 'toggle-module') {
      const mod = tgt.dataset.module;
      state.config.modules[mod] = tgt.checked;
      renderAll();
      await saveConfigPatch({ modules: { [mod]: tgt.checked } });
      refreshAll(true);
      return;
    }

    if (action === 'toggle-source') {
      const src = tgt.dataset.source;
      state.config.sources[src] = tgt.checked;
      renderHeader();
      await saveConfigPatch({ sources: { [src]: tgt.checked } });
      refreshAll(true);
      return;
    }

    if (action === 'toggle-auto-sync') {
      if (isReadOnlyMode()) return;
      state.config.pricingAutoSync = tgt.checked;
      await saveConfigPatch({ pricingAutoSync: tgt.checked });
      return;
    }
  });

  dom.settingsBody.addEventListener('submit', async (e) => {
    const form = e.target.closest('form[data-action="save-price-override"]');
    if (!form) return;
    e.preventDefault();
    if (isReadOnlyMode()) return;
    const id = form.dataset.id;
    const fd = new FormData(form);
    const toNumOrNull = (v) => {
      const s = String(v ?? '').trim();
      if (!s) return null;
      const n = Number(s);
      return Number.isFinite(n) ? n : null;
    };
    const override = {
      inputPer1m: toNumOrNull(fd.get('inputPer1m')),
      outputPer1m: toNumOrNull(fd.get('outputPer1m')),
      cacheReadPer1m: toNumOrNull(fd.get('cacheReadPer1m')),
      longContextThreshold: toNumOrNull(fd.get('longContextThreshold')),
      inputAbovePer1m: toNumOrNull(fd.get('inputAbovePer1m')),
      outputAbovePer1m: toNumOrNull(fd.get('outputAbovePer1m')),
      cacheReadAbovePer1m: toNumOrNull(fd.get('cacheReadAbovePer1m'))
    };
    try {
      state.pricing.data = await postJson('/api/pricing/overrides', {
        canonicalId: id,
        override
      });
      state.pricing.editingId = null;
      state.pricing.draft = null;
      renderSettings();
      refreshAll(true);
    } catch (err) {
      state.pricing.syncMsg = t('settings.saveFail', { msg: err.message });
      renderSettings();
    }
  });

  // =========================================================================
  // 20. XSS-Safe Tooltip, Rich Matrix Popover, .help-tip & Resize Listeners
  // =========================================================================
  function resolveObsCellData(modelIdx, bucketKey) {
    const matrix = state.analytics?.cacheObservatory?.matrix;
    if (!Array.isArray(matrix)) return null;
    const row = matrix[Number(modelIdx)];
    if (!row) return null;
    if (bucketKey === '__total__') {
      return { row, entry: row, isTotal: true, bucketKey: '__total__' };
    }
    const b = (Array.isArray(row.buckets) ? row.buckets : []).find((x) => x.key === bucketKey);
    if (!b || num(b.total, 0) <= 0) return null;
    return { row, entry: b, isTotal: false, bucketKey };
  }

  function buildObsPopoverHtml(info, pinned) {
    const { row, entry, isTotal, bucketKey } = info;
    const { primary, subs } = getObsMatrixPrefs();
    const tagFor = (metricId) => {
      if (metricId === primary) {
        return `<span class="obs-pop-tag primary">${esc(t('obs.matrixPrimaryTag'))}</span>`;
      }
      if (subs.includes(metricId)) {
        return `<span class="obs-pop-tag sub">${esc(t('obs.matrixSubTag'))}</span>`;
      }
      return '';
    };

    const totalTurns = isTotal ? num(entry.followUpTurns, 0) : num(entry.total, 0);
    const hits = num(entry.hits, 0);
    const keepStr = entry.hitRate != null ? `${fmtPct(entry.hitRate, 1)} (${hits}/${totalTurns})` : '—';
    const weightedStr = entry.weightedHitRatio != null ? fmtPct(entry.weightedHitRatio, 1) : '—';
    const turnAvgSub = entry.avgHitRatio != null
      ? ` <span class="obs-pop-muted">(${esc(t('obs.popTurnAvgSub', { pct: fmtPct(entry.avgHitRatio, 1) }))})</span>`
      : '';

    const fullMiss = num(entry.unexpectedFullMisses, 0);
    const cuts = num(entry.boundaryCuts, 0);
    const bounces = num(entry.bounceBacks, 0);
    const anomParts = [];
    if (fullMiss > 0) anomParts.push(t('obs.popAnomFullMiss', { n: fullMiss }));
    if (cuts > 0) anomParts.push(t('obs.popAnomBoundary', { n: cuts }));
    if (bounces > 0) anomParts.push(t('obs.popAnomBounce', { n: bounces }));
    const anomHtml = anomParts.length > 0
      ? `<span class="obs-pop-val ${fullMiss > 0 ? 'bad' : 'warn'}">${esc(anomParts.join(' · '))}</span>`
      : `<span class="obs-pop-val ok">${esc(t('obs.popAnomNone'))}</span>`;

    const avgCostStr = fmtUsd(entry.avgCostUsd);
    const totalCostStr = fmtUsd(entry.costUsd);
    const penTotal = num(entry.missPenaltyUsd, 0);
    const penAvg = num(entry.avgMissPenaltyUsd, 0);
    const penStr = penTotal > 0
      ? `${fmtUsd(penTotal)} <span class="obs-pop-muted">(${esc(t('obs.popPerTurn', { usd: fmtUsd(penAvg) }))})</span>`
      : '$0.00';
    const savedStr = fmtUsd(entry.cacheSavedUsd);
    const avgCtxStr = fmtTokens(entry.avgContextTokens);
    const crVsInStr = `${fmtTokens(entry.cacheReadSum)} / ${fmtTokens(entry.totalInSum)}`;
    const wastedTok = num(entry.wastedTokens, 0);
    const unbucketed = isTotal ? num(row.unbucketedTurns, 0) : 0;
    const scopeLabel = isTotal ? t('obs.colTotal') : bucketKey;

    return `
      <div class="obs-pop-head">
        <div class="obs-pop-title-wrap">
          <span class="obs-pop-model truncate">${esc(row.displayName || row.canonicalId)}</span>
          <span class="obs-pop-sep">·</span>
          <span class="obs-pop-bucket mono">${esc(scopeLabel)}</span>
        </div>
        <div class="obs-pop-head-right">
          <span class="obs-pop-turns num">${esc(t('obs.popTurns', { n: totalTurns }))}${tagFor('turns')}</span>
          ${pinned ? `<button type="button" class="obs-pop-close" data-obs-pop-close="1" aria-label="${esc(t('obs.popClose'))}">×</button>` : ''}
        </div>
      </div>
      <div class="obs-pop-group">
        <div class="obs-pop-row">
          <span class="obs-pop-lbl">${esc(t('obs.popWeightedHit'))}${tagFor('weightedHit')}</span>
          <span class="obs-pop-val mono">${esc(weightedStr)}${turnAvgSub}</span>
        </div>
        <div class="obs-pop-row">
          <span class="obs-pop-lbl">${esc(t('obs.popKeepRate'))}${tagFor('keepRate')}</span>
          <span class="obs-pop-val mono">${esc(keepStr)}</span>
        </div>
        <div class="obs-pop-row">
          <span class="obs-pop-lbl">${esc(t('obs.popAnomalies'))}</span>
          ${anomHtml}
        </div>
      </div>
      <div class="obs-pop-group">
        <div class="obs-pop-row">
          <span class="obs-pop-lbl">${esc(t('obs.popAvgCost'))}${tagFor('avgCost')}</span>
          <span class="obs-pop-val mono">${esc(avgCostStr)}</span>
        </div>
        <div class="obs-pop-row">
          <span class="obs-pop-lbl">${esc(t('obs.popTotalCost'))}${tagFor('totalCost')}</span>
          <span class="obs-pop-val mono">${esc(totalCostStr)}</span>
        </div>
        <div class="obs-pop-row">
          <span class="obs-pop-lbl">${esc(t('obs.popMissPenalty'))}${tagFor('missPenalty')}</span>
          <span class="obs-pop-val mono ${penTotal > 0 ? 'bad' : ''}">${penStr}</span>
        </div>
        <div class="obs-pop-row">
          <span class="obs-pop-lbl">${esc(t('obs.popCacheSaved'))}</span>
          <span class="obs-pop-val mono ok">${esc(savedStr)}</span>
        </div>
      </div>
      <div class="obs-pop-group">
        <div class="obs-pop-row">
          <span class="obs-pop-lbl">${esc(t('obs.popAvgCtx'))}</span>
          <span class="obs-pop-val mono">${esc(avgCtxStr)}</span>
        </div>
        <div class="obs-pop-row">
          <span class="obs-pop-lbl">${esc(t('obs.popCacheVsIn'))}</span>
          <span class="obs-pop-val mono">${esc(crVsInStr)}</span>
        </div>
        ${
          wastedTok > 0
            ? `<div class="obs-pop-row">
                <span class="obs-pop-lbl">${esc(t('obs.popWastedTok'))}</span>
                <span class="obs-pop-val mono bad">${esc(fmtTokens(wastedTok))}</span>
              </div>`
            : ''
        }
      </div>
      ${unbucketed > 0 ? `<div class="obs-pop-foot">${esc(t('obs.popUnbucketed', { n: unbucketed }))}</div>` : ''}
      ${!pinned ? `<div class="obs-pop-foot">${esc(t('obs.popPinHint'))}</div>` : ''}
    `;
  }

  function positionObsPopover(anchorEl) {
    if (!anchorEl || !dom.obsCellPopover) return;
    const pad = 10;
    const aRect = anchorEl.getBoundingClientRect();
    const pRect = dom.obsCellPopover.getBoundingClientRect();
    let x = aRect.left + aRect.width / 2 - pRect.width / 2;
    let y = aRect.top - pRect.height - 8;
    if (y < pad) {
      y = aRect.bottom + 8;
    }
    if (y + pRect.height > window.innerHeight - pad) {
      y = Math.max(pad, window.innerHeight - pRect.height - pad);
    }
    if (x + pRect.width > window.innerWidth - pad) {
      x = window.innerWidth - pRect.width - pad;
    }
    if (x < pad) x = pad;
    dom.obsCellPopover.style.left = `${Math.round(x)}px`;
    dom.obsCellPopover.style.top = `${Math.round(y)}px`;
  }

  function showObsCellPopover(cellEl, pinned) {
    if (!cellEl || !dom.obsCellPopover) return;
    const modelIdx = Number(cellEl.dataset.modelIdx);
    const bucketKey = cellEl.dataset.bucketKey;
    const info = resolveObsCellData(modelIdx, bucketKey);
    if (!info) return;
    dom.obsCellPopover.innerHTML = buildObsPopoverHtml(info, pinned);
    dom.obsCellPopover.classList.toggle('is-pinned', Boolean(pinned));
    dom.obsCellPopover.classList.remove('hidden');
    positionObsPopover(cellEl);
  }

  function hideObsCellPopover() {
    if (!dom.obsCellPopover) return;
    dom.obsCellPopover.classList.add('hidden');
    dom.obsCellPopover.classList.remove('is-pinned');
  }

  function dismissObsCellPopover() {
    if (state.obsPinnedCell) {
      const prev = dom.modulesGrid.querySelector('.heat-cell.is-pinned');
      if (prev) prev.classList.remove('is-pinned');
      state.obsPinnedCell = null;
    }
    hideObsCellPopover();
  }

  function syncPinnedObsPopover() {
    if (!state.obsPinnedCell) {
      hideObsCellPopover();
      return;
    }
    const { modelIdx, bucketKey } = state.obsPinnedCell;
    const cellEl = dom.modulesGrid.querySelector(
      `[data-obs-cell="1"][data-model-idx="${modelIdx}"][data-bucket-key="${CSS.escape(bucketKey)}"]`
    );
    if (!cellEl) {
      state.obsPinnedCell = null;
      hideObsCellPopover();
      return;
    }
    showObsCellPopover(cellEl, true);
  }

  function positionTooltip(clientX, clientY) {
    const pad = 10;
    const rect = dom.chartTooltip.getBoundingClientRect();
    let x = clientX + 12;
    let y = clientY - rect.height - 10;
    if (x + rect.width > window.innerWidth - pad) x = window.innerWidth - rect.width - pad;
    if (x < pad) x = pad;
    if (y < pad) y = Math.min(window.innerHeight - rect.height - pad, clientY + 16);
    if (y < pad) y = pad;
    dom.chartTooltip.style.left = `${Math.round(x)}px`;
    dom.chartTooltip.style.top = `${Math.round(y)}px`;
  }

  function showTooltip(target, clientX, clientY) {
    const raw = target?.dataset?.tip;
    if (!raw) return;
    dom.chartTooltip.innerHTML = esc(raw).replace(/\n/g, '<br>');
    dom.chartTooltip.classList.remove('hidden');
    positionTooltip(clientX, clientY);
  }

  function showTooltipAtElement(target) {
    const raw = target?.dataset?.tip;
    if (!raw || !target.getBoundingClientRect) return;
    const r = target.getBoundingClientRect();
    showTooltip(target, r.left + r.width / 2, r.top);
  }

  function hideTooltip() {
    dom.chartTooltip.classList.add('hidden');
  }

  function dismissHelpPin() {
    if (state.pinnedHelpEl) {
      state.pinnedHelpEl.classList.remove('active');
      state.pinnedHelpEl = null;
    }
    hideTooltip();
  }

  document.addEventListener('pointerover', (e) => {
    const obsCell = e.target.closest?.('[data-obs-cell="1"]');
    if (obsCell) {
      if (!state.obsPinnedCell && !state.obsMetricMenuOpen && !state.obsGapMenuOpen) {
        showObsCellPopover(obsCell, false);
      }
      return;
    }
    const tipEl = e.target.closest?.('[data-tip]');
    if (!tipEl) return;
    if (tipEl.classList.contains('help-tip')) {
      showTooltipAtElement(tipEl);
    } else {
      showTooltip(tipEl, e.clientX, e.clientY);
    }
  });

  document.addEventListener('pointermove', (e) => {
    const tipEl = e.target.closest?.('[data-tip]');
    if (!tipEl) {
      if (!state.pinnedHelpEl) hideTooltip();
      return;
    }
    if (!tipEl.classList.contains('help-tip')) {
      showTooltip(tipEl, e.clientX, e.clientY);
    }
  });

  document.addEventListener('pointerout', (e) => {
    const fromObs = e.target.closest?.('[data-obs-cell="1"]');
    if (fromObs) {
      const toObs = e.relatedTarget?.closest?.('[data-obs-cell="1"]');
      if (!toObs && !state.obsPinnedCell) {
        hideObsCellPopover();
      }
    }
    const fromTip = e.target.closest?.('[data-tip]');
    if (!fromTip) return;
    const toTip = e.relatedTarget?.closest?.('[data-tip]');
    if (!toTip) {
      if (state.pinnedHelpEl && document.contains(state.pinnedHelpEl)) {
        showTooltipAtElement(state.pinnedHelpEl);
      } else {
        dismissHelpPin();
      }
    }
  });

  document.addEventListener('focusin', (e) => {
    const tipEl = e.target.closest?.('.help-tip[data-tip]');
    if (tipEl) showTooltipAtElement(tipEl);
  });

  document.addEventListener('focusout', (e) => {
    const tipEl = e.target.closest?.('.help-tip[data-tip]');
    if (tipEl && state.pinnedHelpEl !== tipEl) {
      if (state.pinnedHelpEl && document.contains(state.pinnedHelpEl)) {
        showTooltipAtElement(state.pinnedHelpEl);
      } else {
        hideTooltip();
      }
    }
  });

  document.addEventListener('click', (e) => {
    if (e.target.closest?.('[data-obs-pop-close="1"]')) {
      e.preventDefault();
      e.stopPropagation();
      dismissObsCellPopover();
      return;
    }

    const obsCell = e.target.closest?.('[data-obs-cell="1"]');
    if (obsCell) {
      e.preventDefault();
      e.stopPropagation();
      if (state.obsMetricMenuOpen || state.obsGapMenuOpen) {
        state.obsMetricMenuOpen = false;
        state.obsGapMenuOpen = false;
        renderGrid();
      }
      const mIdx = Number(obsCell.dataset.modelIdx);
      const bk = obsCell.dataset.bucketKey;
      const same =
        state.obsPinnedCell &&
        state.obsPinnedCell.modelIdx === mIdx &&
        state.obsPinnedCell.bucketKey === bk;
      if (same) {
        dismissObsCellPopover();
      } else {
        const prev = dom.modulesGrid.querySelector('.heat-cell.is-pinned');
        if (prev) prev.classList.remove('is-pinned');
        state.obsPinnedCell = { modelIdx: mIdx, bucketKey: bk };
        const freshCell = dom.modulesGrid.querySelector(
          `[data-obs-cell="1"][data-model-idx="${mIdx}"][data-bucket-key="${CSS.escape(bk)}"]`
        );
        if (freshCell) {
          freshCell.classList.add('is-pinned');
          showObsCellPopover(freshCell, true);
        }
      }
      return;
    }

    if (state.obsPinnedCell && !e.target.closest?.('#obs-cell-popover')) {
      dismissObsCellPopover();
    }

    if ((state.obsMetricMenuOpen || state.obsGapMenuOpen) && !e.target.closest?.('.obs-matrix-ctrls')) {
      state.obsMetricMenuOpen = false;
      state.obsGapMenuOpen = false;
      renderGrid();
    }

    if (
      state.update.popoverOpen &&
      !e.target.closest?.('#update-popover') &&
      !e.target.closest?.('#btn-update-pill')
    ) {
      state.update.popoverOpen = false;
      renderUpdateUI();
    }

    const helpBtn = e.target.closest?.('.help-tip[data-tip]');
    if (helpBtn) {
      e.preventDefault();
      e.stopPropagation();
      if (state.pinnedHelpEl === helpBtn) {
        dismissHelpPin();
      } else {
        if (state.pinnedHelpEl) state.pinnedHelpEl.classList.remove('active');
        state.pinnedHelpEl = helpBtn;
        helpBtn.classList.add('active');
        showTooltipAtElement(helpBtn);
      }
      return;
    }
    if (state.pinnedHelpEl) {
      dismissHelpPin();
    }
  });

  if (dom.btnUpdatePill) {
    dom.btnUpdatePill.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      dismissObsCellPopover();
      state.update.popoverOpen = !state.update.popoverOpen;
      renderUpdateUI();
    });
  }

  if (dom.updatePopover) {
    dom.updatePopover.addEventListener('click', async (e) => {
      const actionEl = e.target.closest?.('[data-action]');
      if (!actionEl) return;
      const action = actionEl.dataset.action;
      if (action === 'close-update-popover') {
        state.update.popoverOpen = false;
        renderUpdateUI();
        return;
      }
      if (action === 'apply-update') {
        await triggerUpdateApply();
        return;
      }
      if (action === 'dismiss-update') {
        const ver = actionEl.dataset.ver || '';
        state.config.dismissedUpdateVersion = ver;
        state.update.popoverOpen = false;
        renderUpdateUI();
        await saveConfigPatch({ dismissedUpdateVersion: ver });
        return;
      }
      if (action === 'copy-update-cmd') {
        const cmd = 'git -C ~/.gemini/config/plugins/agy-lens pull --ff-only';
        const ok = await copyTextWithFallback(cmd);
        state.update.copyStatus = ok ? 'copied' : 'failed';
        renderUpdateUI();
        setTimeout(() => {
          state.update.copyStatus = '';
          renderUpdateUI();
        }, 2000);
        return;
      }
    });
  }

  if (dom.updateBanner) {
    dom.updateBanner.addEventListener('click', async (e) => {
      const actionEl = e.target.closest?.('[data-action]');
      if (!actionEl) return;
      const action = actionEl.dataset.action;
      if (action === 'reload-page') {
        window.location.reload();
        return;
      }
      if (action === 'ack-just-updated') {
        if (state.update.data) state.update.data.justUpdated = null;
        renderUpdateUI();
        if (isReadOnlyMode()) return;
        try {
          await postJson('/api/update/ack-updated', {});
        } catch {}
        return;
      }
    });
  }

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (state.obsPinnedCell) dismissObsCellPopover();
      if (state.obsMetricMenuOpen || state.obsGapMenuOpen) {
        state.obsMetricMenuOpen = false;
        state.obsGapMenuOpen = false;
        renderGrid();
      }
      if (state.update.popoverOpen) {
        state.update.popoverOpen = false;
        renderUpdateUI();
      }
      return;
    }
    if (e.key === 'Enter' && e.target?.matches?.('[data-obs-gap-input="1"]')) {
      e.preventDefault();
      const addBtn = dom.modulesGrid.querySelector('[data-action="add-obs-gap-custom"]');
      if (addBtn) addBtn.click();
      return;
    }
    if (e.key === 'Enter' || e.key === ' ') {
      const obsCell = e.target.closest?.('[data-obs-cell="1"]');
      if (obsCell) {
        e.preventDefault();
        obsCell.click();
      }
    }
  });

  window.addEventListener('resize', () => {
    if (state.obsPinnedCell) syncPinnedObsPopover();
    if (state.update.popoverOpen) positionUpdatePopover();
  });
  window.addEventListener('scroll', () => {
    if (state.obsPinnedCell) syncPinnedObsPopover();
  }, true);

  const mqWide = window.matchMedia('(min-width: 680px)');
  mqWide.addEventListener('change', (ev) => {
    if (state.widePane !== ev.matches) {
      state.widePane = ev.matches;
      renderGrid();
    }
  });

  if (window.sidecar && typeof window.sidecar.onWorkspaceChange === 'function') {
    try {
      window.sidecar.onWorkspaceChange(() => {
        if (document.visibilityState === 'visible') refreshAll(true);
      });
    } catch (_) {}
  }

  // =========================================================================
  // 21. Bootstrap
  // =========================================================================
  async function boot() {
    try {
      const cfgRes = await getJson('/api/config');
      normalizeConfigPayload(cfgRes);
      state.rangeKey = state.config.defaultRange || '7d';
    } catch (err) {
      state.globalError = t('header.configLoadErr', { msg: err.message });
    }

    dom.loadingShell.classList.add('hidden');
    dom.app.classList.remove('hidden');
    state.booted = true;
    renderAll();
    if (state.query.openSettings) openSettings();
    resetRefreshTimer();
    await refreshAll(true);
    fetchUpdateStatus();
  }

  boot();
})();
