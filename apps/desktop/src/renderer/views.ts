/** Native views. Dynamic text is escaped before it reaches HTML. */
type RouteName = 'overview' | 'office' | 'board' | 'integrations' | 'adapters' | 'settings' | 'notifications';
interface AppState {
  route: RouteName;
  overview: OverviewSummary | null;
  office: OfficeSnapshot | null;
  sessions: SessionSummary[];
  board: BoardResponse | null;
  boardQuery: { q: string; toolId: string };
  adapters: AdapterManifest[];
  tools: ToolSummary[];
  settings: Settings | null;
  rules: VoiceRule[];
  notifications: NotificationItem[];
  /** 通知首页之外还有更早的记录可加载。 */
  noticeHasMore: boolean;
  boardLoading: boolean;
  noticeLevelFilter: '' | 'attention' | 'info';
  mcpSnippets: McpSnippet[];
  mcpServers: McpServerItem[];
  hookIntegrations: HookIntegration[];
  externalTransport: 'stdio' | 'streamable-http';
  nativeVoices: NativeVoice[] | null;
  nativeVoicesLoading: boolean;
  modelStatus: ModelStatus | null;
  zipvoiceModelStatus: ModelStatus | null;
  speakResult: { ok: boolean; usedBackend?: string; errors: string[] } | null;
  mcpValidation: McpValidation | null;
  sectionErrors: Record<string, string>;
  error: string | null;
}

/** @description: Keep stale section data visible with an explicit error. */
function sectionError(state: AppState, key: string): string {
  const message = state.sectionErrors[key];
  return message
    ? `<div class="inline-error" role="alert">${key === 'settings' ? `设置未能更新：${esc(message)}。未保存的输入已保留，请检查后重试。` : `更新失败：${esc(message)}。当前显示上次成功的数据。`}</div>`
    : '';
}

/** @description: Empty titles use a stable task number; valid code and JSON remain task titles. */
function displayTaskTitle(
  task: { title?: string | null; toolId?: string; sessionId: string },
  tools: ToolSummary[] = [],
): string {
  const title = task.title?.trim();
  if (title) return title;
  let hash = 2166136261;
  for (let index = 0; index < task.sessionId.length; index++)
    hash = Math.imul(hash ^ task.sessionId.charCodeAt(index), 16777619);
  const number = (hash >>> 0).toString(16).padStart(8, '0').toUpperCase();
  const toolId = task.toolId || (task.sessionId.includes(':') ? task.sessionId.split(':')[0] : '');
  const toolName =
    tools.find((tool) => tool.toolId === toolId)?.name.trim() || toolId || '未知工具';
  return `${toolName} · 任务 ${number}`;
}

/** @description: A session row opens a timeline via its title button; attention rows may carry one inline record action. */
function sessionRow(
  session: SessionSummary,
  withRelative = true,
  tools: ToolSummary[] = [],
  withActions = false,
): string {
  // 总览行只给主快捷操作（已响应 / 已重试）；归档等次操作在看板卡与时间线抽屉里。
  const quickEvent =
    session.currentState === 'waiting_human'
      ? 'human.responded'
      : session.currentState === 'failed' || session.currentState === 'timeout'
        ? 'task.retried'
        : null;
  const actions =
    withActions && quickEvent
      ? `<div class="session-actions"><button class="btn btn-small btn-ghost" type="button" data-task-event="${quickEvent}" data-task-id="${esc(session.sessionId)}" title="只更新 AgentCue 记录；实际操作请在原工具中完成">${quickEvent === 'human.responded' ? '标记已响应' : '标记已重试'}</button></div>`
      : '';
  return `<div class="session"><button class="session-main" type="button" data-session="${esc(session.sessionId)}"><span class="session-title">${esc(displayTaskTitle(session, tools))}</span>
      <span class="session-meta"><span>${esc(session.toolId)}</span><span>${esc(withRelative ? fmtRelative(session.updatedAt) : fmtTime(session.updatedAt))}</span></span></button>
    <span class="badge" data-state="${esc(session.currentState)}">${esc(stateLabel(session.currentState))}</span>${actions}</div>`;
}

/** @description: Capability labels describe what the source can actually prove. */
function capabilityLabel(capability?: string): string {
  return capability === 'events'
    ? '任务状态监控'
    : capability === 'metadata'
      ? '只读历史索引'
      : '仅检测安装';
}

/** @description: A previous delivery is evidence of an event, never a persistent connection. */
function hookEventTime(value: string | null | undefined): string {
  if (!value || !Number.isFinite(Date.parse(value))) return '等待首次任务事件';
  return `最近收到 ${new Date(value).toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  })}`;
}

function toolHookStatus(tool: ToolSummary, settings: Settings | null): string {
  if (!tool.hookSupported) return '';
  const paused = tool.ignored || settings?.privacy.sessionFileRead === false;
  return `<p class="hook-tool-status">已安装不代表任务事件已接入。${paused ? '暂停接收任务事件。' : ''}${esc(hookEventTime(tool.hookLastEventAt))}。<a class="text-link" href="#/settings">在设置中查看任务播报接入 ↗</a></p>`;
}

/**
 * 工具图标：仅展示真实图标（data URL 或本机 API 地址），缺失时不渲染占位字符，
 * 由加粗的工具名承担视觉锚点。
 */
function toolMark(source: { icon?: string | null }): string {
  return source.icon
    ? `<img class="tool-icon" src="${esc(source.icon)}" alt="" aria-hidden="true" loading="lazy" />`
    : '';
}

/** @description: Compact installed-tool list shared by the overview. */
function toolRow(tool: ToolSummary): string {
  return `<div class="tool-row">${toolMark(tool)}
    <div class="tool-info"><strong>${esc(tool.name)}</strong><span class="muted">${esc(tool.host ? `${tool.host} 扩展 · ` : '')}${esc(capabilityLabel(tool.sessionCapability))}${tool.version ? ` · ${esc(tool.version)}` : ''}</span></div>
    <span class="tool-count">${tool.sessionCount} 个活跃任务</span><span class="badge" data-state="${tool.detectStatus === 'running' ? 'running' : 'idle'}">${esc(detectLabel(tool.detectStatus))}</span></div>`;
}

/** @description: Overview lists come from complete per-state queries, not a truncated mixed list. */
function renderOverview(state: AppState): string {
  const summary = state.overview;
  const attention = (state.board?.groups ?? [])
    .filter((group) => group.id === 'attention' || group.id === 'failed')
    .flatMap((group) => group.items)
    .filter((item): item is BoardItem & { currentState: TaskState } => item.currentState !== null)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, 8);
  const running = state.board?.groups.find((group) => group.id === 'running');
  const installed = state.tools.filter(
    (tool) =>
      !tool.ignored && (tool.detectStatus === 'installed' || tool.detectStatus === 'running'),
  );
  const scan = summary?.lastScan;
  const boardPending = state.boardLoading && !state.board;
  const statsValue = (value: number | undefined): string =>
    boardPending && value === undefined ? '…' : String(value ?? '—');
  const waiting = summary?.counts.waiting_human;
  const metrics: Array<[string, string, string]> = [
    ['进行中', statsValue(summary?.counts.running), 'running'],
    ['已完成', statsValue(summary?.counts.completed), 'completed'],
    ['需要关注', statsValue(summary?.attention), 'failed'],
  ];
  // 信号面板：主读数是等待用户拍板的任务数，有待办时整块进入注意态。
  // 注意态用类名表达：app.ts 的区域差分只同步 className，不同步 dataset。
  return `<section class="signal-panel${(waiting ?? 0) > 0 ? ' is-attention' : ''}" data-region="overview-stats">${sectionError(state, 'overview')}<div class="signal-hero"><span class="signal-value">${statsValue(waiting)}</span><span class="signal-label">等你拍板</span></div><div class="signal-divider" aria-hidden="true"></div><div class="signal-metrics">${metrics.map(([label, value, tone]) => `<div class="signal-metric"><span class="signal-dot" data-state="${tone}"></span><span class="signal-metric-value">${value}</span><span class="signal-metric-label">${label}</span></div>`).join('')}</div></section>
    <div class="overview-grid"><section class="panel" data-region="overview-attention"><div class="section-head"><h2>需要你处理</h2><a class="text-link" href="#/board">查看看板 ↗</a></div>${sectionError(state, 'board')}${attention.length ? `<div class="session-list">${attention.map((item) => sessionRow(item, true, state.tools, true)).join('')}</div>` : `<div class="empty">${state.sectionErrors.board ? '任务列表暂不可用，请重试。' : boardPending ? '正在读取任务…' : '暂时没有需要介入的任务。'}</div>`}</section><div class="overview-side">
    <section class="panel" data-region="overview-running"><div class="section-head"><h2>进行中</h2><span class="count-pill">${running?.total ?? (boardPending ? '…' : '—')}</span></div>${
      running?.items.length
        ? `<div class="session-list">${running.items
            .filter(
              (item): item is BoardItem & { currentState: TaskState } => item.currentState !== null,
            )
            .map((item) => sessionRow(item, true, state.tools))
            .join('')}</div>`
        : `<div class="empty">${boardPending ? '正在读取任务…' : '当前没有运行中的任务。'}</div>`
    }</section>
    <section class="panel" data-region="overview-tools"><div class="section-head"><h2>工具与扩展</h2><a class="text-link" href="#/adapters">管理工具 ↗</a></div>${sectionError(state, 'tools')}${installed.length ? installed.map(toolRow).join('') : '<div class="empty">还没有识别到已安装工具，点击「扫描工具」更新清单。</div>'}<div class="panel-foot">${scan ? `上次安装扫描 ${esc(fmtTime(scan.finishedAt))} · ${scan.degraded.length ? `${scan.degraded.length} 个来源需要检查` : '来源正常'}` : '安装清单尚未扫描'}<span>会话变化每 5 秒采集</span></div></section></div></div>`;
}

/** @description: Board cards expose record actions without claiming to control another app. */
function boardCard(item: BoardItem, tools: ToolSummary[] = []): string {
  const metadata = item.kind === 'history';
  const heading = `<span class="task-tool">${esc(item.toolId)}</span><span class="session-title">${esc(displayTaskTitle(item, tools))}</span><span class="session-meta"><span>${esc(fmtRelative(item.updatedAt))}</span>${metadata ? '<span>仅历史索引</span>' : ''}</span>`;
  const actions = metadata ? '' : taskActions(item.sessionId, item.currentState);
  return `<article class="task-card">${metadata ? `<div class="task-open">${heading}</div>` : `<button class="task-open" type="button" data-session="${esc(item.sessionId)}">${heading}</button>`}<div class="task-card-foot"><span class="badge" data-state="${esc(item.currentState ?? 'unknown')}">${esc(item.currentState ? stateLabel(item.currentState) : '状态未知')}</span>${actions ? `<div class="task-actions">${actions}</div>` : ''}</div></article>`;
}

/** @description: These are AgentCue record updates, not execution commands for the monitored tool. */
function taskActions(sessionId: string, currentState: TaskState | null): string {
  const event =
    currentState === 'waiting_human'
      ? 'human.responded'
      : currentState === 'failed' || currentState === 'timeout'
        ? 'task.retried'
        : currentState === 'completed' || currentState === 'cancelled'
          ? 'task.archived'
          : null;
  if (!event) return '';
  const label =
    event === 'human.responded' ? '标记已响应' : event === 'task.retried' ? '标记已重试' : '归档';
  return `<button class="btn btn-small btn-ghost" type="button" data-task-event="${event}" data-task-id="${esc(sessionId)}" title="只更新 AgentCue 记录；实际操作请在原工具中完成">${label}</button>${currentState === 'failed' || currentState === 'timeout' ? `<button class="btn btn-small btn-ghost" type="button" data-task-event="task.archived" data-task-id="${esc(sessionId)}">归档</button>` : ''}`;
}

/** @description: Per-column counts and cursors remain independent. */
function renderBoard(state: AppState): string {
  const columns: Array<{ id: BoardGroupId; title: string; hint: string; tone: string }> = [
    { id: 'attention', title: '待介入', hint: '等待你的响应', tone: 'attention' },
    { id: 'running', title: '执行中', hint: '持续跟踪进展', tone: 'running' },
    { id: 'failed', title: '需要检查', hint: '失败与超时', tone: 'failed' },
    { id: 'completed', title: '已结束', hint: '完成、取消与已归档', tone: 'ok' },
  ];
  const renderColumn = (id: BoardGroupId, title: string, hint: string, tone: string): string => {
    const group = state.board?.groups.find((item) => item.id === id);
    const pending = !group && state.boardLoading && !state.sectionErrors.board;
    return `<section class="column${id === 'history' ? ' history-column' : ''}" data-region="board-${id}" data-tone="${tone}"><header class="column-head"><span class="column-dot" data-tone="${tone}" aria-hidden="true"></span><div><h2>${title}<span class="count-pill">${group?.total ?? (pending ? '…' : '—')}</span></h2><p>${hint}</p></div></header><div class="column-body" data-scroll-key="board-${id}">${group?.items.length ? group.items.map((item) => boardCard(item, state.tools)).join('') : `<div class="column-empty">${group ? '暂无任务' : state.sectionErrors.board ? '列表暂不可用' : '正在加载…'}</div>`}</div>${group?.nextCursor ? `<button class="btn btn-more" type="button" data-load-group="${id}" data-cursor="${esc(group.nextCursor)}">加载更多 · 已显示 ${group.items.length} / ${group.total}</button>` : ''}</section>`;
  };
  return `<div class="board-filterbar" data-region="board-toolbar"><div class="search-control"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><circle cx="7" cy="7" r="4.5" /><path d="M10.5 10.5 14 14" /></svg><input id="board-search" data-draft type="search" aria-label="搜索任务" placeholder="搜索任务标题、工具或 ID" value="${esc(state.boardQuery.q)}" /></div><span class="filterbar-sep" aria-hidden="true"></span><select id="board-tool" data-draft aria-label="筛选工具"><option value="">全部工具</option>${state.tools.map((tool) => `<option value="${esc(tool.toolId)}" ${state.boardQuery.toolId === tool.toolId ? 'selected' : ''}>${esc(tool.name)}</option>`).join('')}</select><button class="btn btn-ghost btn-small" type="button" data-action="clear-board">重置筛选</button></div>
    <div data-region="board-feedback">${sectionError(state, 'board')}<p class="board-hint">快捷操作仅更新 AgentCue 记录，实际任务请在原工具中处理。</p></div>
    <div class="board">${columns.map((column) => renderColumn(column.id, column.title, column.hint, column.tone)).join('')}</div>
    ${renderColumn('history', '历史 · 状态未知', '仅展示已验证索引中的标题与时间，不计入活跃任务', 'neutral')}`;
}

/** @description: Select platform paths without treating Linux as macOS. */
function adapterPath(adapter: AdapterManifest): string {
  const platform = window.awm?.platform;
  const key = platform === 'win32' ? 'win' : platform === 'linux' ? 'linux' : 'mac';
  return (
    adapter.detect.configPaths.map((entry) => entry[key]).find((entry) => Boolean(entry)) ??
    '通过已声明的扩展目录检测'
  );
}

/** @description: Adapter installation and session support are separate signals. */
function renderAdapters(state: AppState): string {
  return `<section class="panel" data-region="adapters-list"><div class="section-head"><div><h2>已识别工具</h2><p class="muted">安装状态、来源能力与任务事件接入分别展示。</p></div><span class="count-pill">${state.adapters.length}</span></div>${sectionError(state, 'adapters')}${sectionError(state, 'tools')}${sectionError(state, 'settings')}${
    state.adapters.length
      ? state.adapters
          .map((adapter) => {
            const tool = state.tools.find((item) => item.toolId === adapter.id);
            const ignored =
              tool?.ignored ?? state.settings?.scan.ignoredToolIds.includes(adapter.id) ?? false;
            const status = tool?.detectStatus ?? 'unknown';
            const capability =
              tool?.sessionCapability ??
              adapter.sessionCapability ??
              (Object.keys(adapter.eventMapping).length ? 'events' : 'detect-only');
            return `<article class="adapter">${toolMark(tool ?? {})}<div class="adapter-info"><div class="adapter-name">${esc(adapter.name)}${tool?.host ? `<span class="muted">${esc(tool.host)} 扩展</span>` : ''}<span class="badge" data-state="${status === 'running' ? 'running' : 'idle'}">${esc(detectLabel(status))}</span>${ignored ? '<span class="badge">已忽略</span>' : ''}</div><div class="capability-label">${esc(capabilityLabel(capability))}${tool?.version ? ` · v${esc(tool.version)}` : ''}</div><p class="muted">${esc(tool?.capabilityReason ?? (capability === 'metadata' ? '历史元数据不代表实时任务状态。' : capability === 'detect-only' ? '尚无经过验证的本地任务来源。' : '从本地已声明来源读取任务事件。'))}</p>${tool ? toolHookStatus({ ...tool, ignored }, state.settings) : ''}<details data-disclosure-key="adapter-path-${esc(adapter.id)}"><summary>查看检测路径</summary><code class="adapter-path">${esc(adapterPath(adapter))}</code></details></div><button class="btn btn-ghost" type="button" data-toggle-ignore="${esc(adapter.id)}" data-ignored="${ignored}">${ignored ? '恢复扫描' : '忽略'}</button></article>`;
          })
          .join('')
      : '<div class="empty">尚未加载工具契约，请重新扫描。</div>'
  }</section>
    <section class="panel" data-region="adapters-custom"><div class="section-head"><div><h2>自定义工具</h2><p class="muted">登记一个本地路径，只检测安装状态。</p></div></div><div class="custom-form"><input id="custom-id" data-draft aria-label="工具 ID" placeholder="工具 ID（小写字母与连字符）" /><input id="custom-name" data-draft aria-label="显示名" placeholder="显示名" /><input id="custom-path" data-draft aria-label="配置路径" placeholder="配置路径，如 ~/.my-tool" /><button class="btn btn-primary" type="button" data-action="add-custom-tool">添加工具</button></div>${(state.settings?.scan.customTools ?? []).map((tool) => `<div class="tool-row"><div class="tool-info"><strong>${esc(tool.name)}</strong><code>${esc(tool.configPath)}</code></div><button class="btn btn-ghost" type="button" data-remove-custom="${esc(tool.id)}">移除</button></div>`).join('')}</section>`;
}

/**
 * @description: 统一字段行。宽面板时标签/说明在左、控件在右，窄面板自动收成一栏。
 * 有 id 时用 label 关联控件，并替换控件里的 __ID__；无 id 时标签只是分组标题。
 */
function fieldRow(id: string | null, label: string, hint: string, control: string): string {
  // 说明文字独立成行：窄容器下紧跟标题，宽容器下横跨整行，避免被窄列折成多行。
  const labelHtml = id
    ? `<label class="field-label" for="${id}">${label}</label>`
    : `<div class="field-label">${label}</div>`;
  const body = id ? control.replace(/__ID__/g, id) : control;
  const hintHtml = hint ? `<p class="field-hint">${hint}</p>` : '';
  return `<div class="field">${labelHtml}<div class="field-control">${body}</div>${hintHtml}</div>`;
}

/** @description: Accessible setting row with a stable control identity. */
function settingRow(path: string, label: string, hint: string, control: string): string {
  return fieldRow(`setting-${path.replace(/\./g, '-')}`, label, hint, control);
}

/** @description: 无标签的说明行，内容与控件列对齐；用于字段下方的就绪/限制说明。 */
function fieldNote(html: string): string {
  return `<div class="field-note">${html}</div>`;
}

/** @description: 只有分组标签、没有单一控件的字段行。 */
function fieldGroup(labelId: string, label: string, hint: string, control: string): string {
  return `<div class="field"><div class="field-label" id="${labelId}">${label}${hint ? `<small>${hint}</small>` : ''}</div><div class="field-control">${control}</div></div>`;
}
function toggle(path: string, checked: boolean): string {
  return `<input id="__ID__" class="toggle" type="checkbox" data-setting="${path}" ${checked ? 'checked' : ''} />`;
}
function settingsSection(id: string, title: string, description: string, body: string): string {
  return `<section id="settings-${id}" class="panel settings-panel" data-region="settings-${id}"><div class="section-head"><div><h2>${title}</h2><p class="muted">${description}</p></div></div>${body}</section>`;
}

/** @description: Generic selectors follow the engine's exact-event, wildcard, then speak fallback. */
function genericVoiceAction(rules: VoiceRule[], event: string): VoiceRule['action'] {
  return (
    rules.find((rule) => !rule.scopeTool && rule.scopeEvent === event)?.action ??
    rules.find((rule) => !rule.scopeTool && rule.scopeEvent === '*')?.action ??
    'speak'
  );
}

function voiceEventCanSpeak(event: string): boolean {
  return ['task.started', 'task.waiting_human', 'task.completed'].includes(event);
}

/** @description: Match core's local-time ranges, including both endpoints and overnight periods. */
function inQuietPeriod(ranges: QuietRange[], now: Date): boolean {
  const minutes = now.getHours() * 60 + now.getMinutes();
  const parse = (value: string): number | null => {
    if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value)) return null;
    const [hour, minute] = value.split(':').map(Number);
    return hour * 60 + minute;
  };
  return ranges.some((range) => {
    const from = parse(range.from),
      to = parse(range.to);
    if (from === null || to === null) return false;
    return from <= to ? minutes >= from && minutes <= to : minutes >= from || minutes <= to;
  });
}

/** @description: Explain saved settings without changing rules or claiming every adapter emits events. */
function deriveVoicePolicy(settings: Settings, rules: VoiceRule[], now = new Date()) {
  const quiet = inQuietPeriod(settings.quiet.ranges, now);
  const status = settings.quiet.globalMute
    ? '全局静音已开启；设为播报的事件仅发通知。'
    : !settings.voice.enabled
      ? '自动语音已关闭；设为播报的事件仅发通知。'
      : quiet
        ? settings.quiet.waitingHumanOverride
          ? '当前处于免打扰时段；仅待确认事件可按播报规则出声，其他播报转为通知。'
          : '当前处于免打扰时段，自动播报转为通知。'
        : '当前不在免打扰时段，按事件规则播报或通知。';
  const events = [
    ['task.started', '开始'],
    ['task.waiting_human', '待确认'],
    ['task.completed', '完成'],
  ] as const;
  const items = events.map(([event, label]) => {
    const ruleAction = genericVoiceAction(rules, event);
    let action = ruleAction;
    let reason = '';
    if (ruleAction === 'speak') {
      if (settings.quiet.globalMute) {
        action = 'notify';
        reason = '全局静音';
      } else if (!settings.voice.enabled) {
        action = 'notify';
        reason = '语音已关闭';
      } else if (quiet) {
        if (event === 'task.waiting_human' && settings.quiet.waitingHumanOverride)
          reason = '免打扰例外';
        else {
          action = 'notify';
          reason = '免打扰时段';
        }
      }
    }
    return { event, label, ruleAction, action, reason };
  });
  return {
    quiet,
    status,
    items,
    hasToolOverrides: rules.some(
      (rule) =>
        !!rule.scopeTool &&
        (rule.scopeEvent === '*' || events.some(([event]) => event === rule.scopeEvent)),
    ),
  };
}

function renderVoicePolicy(
  state: AppState,
  now = new Date(),
  settings: Settings | null = state.settings,
  rules: VoiceRule[] = state.rules,
): string {
  if (!settings) return '';
  const policy = deriveVoicePolicy(settings, rules, now);
  const labels: Record<VoiceRule['action'], string> = {
    speak: '播报',
    notify: '仅通知',
    mute: '静音',
  };
  const time = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  return `<aside class="voice-policy" aria-label="当前自动播报策略"><div class="voice-policy-head"><strong>当前自动播报</strong><span>本机 ${time} · ${policy.quiet ? '免打扰时段内' : '免打扰时段外'}</span></div><p>${esc(policy.status)}</p>${state.sectionErrors.rules ? '<p class="is-error">规则暂不可用，请刷新后确认事件动作。</p>' : `<ul class="voice-policy-events" aria-label="当前通用事件动作">${policy.items.map((item) => `<li><span>${item.label}</span><strong>${labels[item.action]}</strong>${item.reason ? `<small>${item.reason}</small>` : ''}</li>`).join('')}</ul>`}<p>仅任务开始、待确认、完成可自动播报；其他事件只通知或静音。规则静音始终不提醒，通知规则始终不出声。${policy.hasToolOverrides ? '存在工具专属规则，实际动作以对应工具的规则为准。' : ''}</p><p>自动提醒需要适配器提供对应任务事件；仅检测安装或只读历史索引不会触发任务播报。试听是单次播放，不受自动语音开关、全局静音和免打扰时段影响。</p></aside>`;
}

/**
 * 白名单音色的中文标签；增强款只放行普通话语区（台湾语区变体字音不同，读错更多，
 * 见 ADR-19），列表末尾的英文音色按地区标注。
 */
const NATIVE_VOICE_LABELS: ReadonlyArray<[RegExp, string]> = [
  [/^(?:Sinji|善怡)/i, '善怡 · 粤语'],
  [/^(?:Tingting|婷婷)/i, '婷婷 · 普通话'],
  [/^(?:Meijia|美佳)/i, '美佳 · 台湾'],
  [/^Shelley/i, 'Shelley · 普通话（增强）'],
  [/^Sandy/i, 'Sandy · 普通话（增强）'],
  [/^Reed/i, 'Reed · 普通话（增强）'],
  [/^Rocko/i, 'Rocko · 普通话（增强）'],
  [/^Eddy/i, 'Eddy · 普通话（增强）'],
  [/^Flo/i, 'Flo · 普通话（增强）'],
  [/^Samantha/i, 'Samantha · 美式英语'],
  [/^Alex/i, 'Alex · 美式英语'],
  [/^Daniel/i, 'Daniel · 英式英语'],
  [/^Karen/i, 'Karen · 澳式英语'],
  [/^Moira/i, 'Moira · 爱尔兰英语'],
  [/^Tessa/i, 'Tessa · 南非英语'],
  [/^Rishi/i, 'Rishi · 印度英语'],
  [/^Aman/i, 'Aman · 印度英语'],
];

/** @description: 白名单音色的中文标签；未识别名称原样显示。 */
function nativeVoiceLabel(voice: NativeVoice): string {
  return NATIVE_VOICE_LABELS.find(([pattern]) => pattern.test(voice.name))?.[1] ?? voice.name;
}

/** @description: Native enumeration is authoritative; legacy or other-backend profiles show a notice. */
function renderNativeVoicePicker(state: AppState, profile: string): string {
  const voices = state.nativeVoices ?? [];
  const selected = voices.some((voice) => voice.id === profile) ? profile : 'system-default';
  const legacy = profile !== 'system-default' && selected === 'system-default';
  const error = state.sectionErrors.voices;
  return `<div class="voice-picker"><div class="control-stack"><div class="control-row"><select id="__ID__" class="control-select" data-setting="voice.voiceProfile" aria-describedby="native-voices-status"><option value="system-default" ${selected === 'system-default' ? 'selected' : ''}>自动（普通话增强音色优先）</option>${voices.map((voice) => `<option value="${esc(voice.id)}" ${selected === voice.id ? 'selected' : ''}>${esc(nativeVoiceLabel(voice))}</option>`).join('')}</select><button id="refresh-native-voices" class="btn btn-ghost btn-small" type="button" data-action="refresh-voices" ${state.nativeVoicesLoading ? 'disabled aria-busy="true"' : ''}>${error ? '重试音色列表' : '刷新音色'}</button></div><div id="native-voices-status" class="control-note ${error || (state.nativeVoices && !voices.length) ? 'is-error' : ''}" role="status">${state.nativeVoicesLoading ? '正在确认本机系统中文音色…' : error ? `读取音色失败：${esc(error)}。中文播报需本机安装系统中文音色。` : state.nativeVoices ? (voices.length ? `已确认 ${String(voices.length)} 个本机音色（含末尾英文音色）；增强款需在系统语音设置中另行下载。` : '未发现可用的系统中文音色，中文播报暂不可用。') : '打开设置后确认本机系统中文音色。'}</div>${legacy ? `<div class="control-note">原音色「${esc(profile)}」当前不在可用列表，播放已回退安全自动（普通话增强音色）。<button class="text-link" type="button" data-action="use-safe-voice">保存为自动音色</button></div>` : ''}</div></div>`;
}

// Kokoro v1.1-zh 官方 sid 映射。源编号不连续，不能把 sid 当作原始声音编号。
// 英文发音人 0=af_maple、1=af_sol、2=bf_vale，读英文更自然，读中文带英文腔但可懂。
// https://k2-fsa.github.io/sherpa/onnx/tts/all/Chinese-English/kokoro-multi-lang-v1_1.html
const KOKORO_VOICES = [
  ...[
    1, 2, 3, 4, 5, 6, 7, 8, 17, 18, 19, 21, 22, 23, 24, 26, 27, 28, 32, 36, 38, 39, 40, 42, 43, 44,
    46, 47, 48, 49, 51, 59, 60, 67, 70, 71, 72, 73, 74, 75, 76, 77, 78, 79, 83, 84, 85, 86, 87, 88,
    90, 92, 93, 94, 99,
  ].map((number, index) => ({
    profile: `kokoro:${index + 3}`,
    code: `zf_${String(number).padStart(3, '0')}`,
    gender: '女声',
    lang: '普通话',
  })),
  ...[
    9, 10, 11, 12, 13, 14, 15, 16, 20, 25, 29, 30, 31, 33, 34, 35, 37, 41, 45, 50, 52, 53, 54, 55,
    56, 57, 58, 61, 62, 63, 64, 65, 66, 68, 69, 80, 81, 82, 89, 91, 95, 96, 97, 98, 100,
  ].map((number, index) => ({
    profile: `kokoro:${index + 58}`,
    code: `zm_${String(number).padStart(3, '0')}`,
    gender: '男声',
    lang: '普通话',
  })),
  ...[
    { sid: 0, code: 'af_maple' },
    { sid: 1, code: 'af_sol' },
    { sid: 2, code: 'bf_vale' },
  ].map((voice) => ({
    profile: `kokoro:${voice.sid}`,
    code: voice.code,
    gender: '女声',
    lang: '英语',
  })),
];

function selectedKokoroVoice(profile: string): (typeof KOKORO_VOICES)[number] {
  return KOKORO_VOICES.find((voice) => voice.profile === profile) ?? KOKORO_VOICES[0];
}

/** @description: 全部音色始终可选，常用音色置顶，其余按语言与男女分组且不重复。 */
function renderKokoroVoicePicker(
  state: AppState,
  profile: string,
  settings: Settings | null = state.settings,
): string {
  const selected = selectedKokoroVoice(profile);
  const saved = (settings?.voice.savedVoices ?? []).filter((item) =>
    KOKORO_VOICES.some((voice) => voice.profile === item.profile),
  );
  const names = new Map(saved.map((item) => [item.profile, item.name]));
  const currentName = names.get(selected.profile) ?? '';
  const option = (voice: (typeof KOKORO_VOICES)[number]): string =>
    `<option value="${voice.profile}" ${voice.profile === selected.profile ? 'selected' : ''}>${esc(names.get(voice.profile) ? `${names.get(voice.profile)} · ${voice.lang}${voice.gender} ${voice.code}` : `${voice.lang}${voice.gender} · ${voice.code}`)}</option>`;
  const group = (label: string, voices: typeof KOKORO_VOICES): string =>
    voices.length ? `<optgroup label="${label}">${voices.map(option).join('')}</optgroup>` : '';
  const options =
    group(
      '常用音色',
      KOKORO_VOICES.filter((voice) => names.has(voice.profile)),
    ) +
    group(
      '普通话女声',
      KOKORO_VOICES.filter(
        (voice) => voice.lang === '普通话' && voice.gender === '女声' && !names.has(voice.profile),
      ),
    ) +
    group(
      '普通话男声',
      KOKORO_VOICES.filter(
        (voice) => voice.lang === '普通话' && voice.gender === '男声' && !names.has(voice.profile),
      ),
    ) +
    group(
      '英语音色',
      KOKORO_VOICES.filter((voice) => voice.lang === '英语' && !names.has(voice.profile)),
    );
  const nameId = `kokoro-voice-name-${selected.profile.slice(7)}`;
  // 音色下拉、名称与收藏同属一个控件组；外层的「音色」标签由 settingRow 提供。
  return `<div class="voice-picker"><div class="control-stack">
      <select id="__ID__" class="control-select" data-setting="voice.voiceProfile" aria-describedby="kokoro-voices-status">${options}</select>
      <div class="control-row"><input id="${nameId}" class="control-input control-grow" data-draft maxlength="32" aria-label="音色名称" value="${esc(currentName)}" placeholder="例如：清亮女声" /><button class="btn btn-primary" type="button" data-action="save-kokoro-voice">${currentName ? '保存名称' : '加入常用'}</button>${currentName ? '<button class="text-link" type="button" data-action="remove-kokoro-voice">移出常用</button>' : ''}</div>
      <div id="kokoro-voices-status" class="control-stack" role="status">${selected.profile !== profile ? `<p class="control-note is-error">原音色「${esc(profile)}」不是可用的本地音色，当前使用普通话女声 zf_001。</p>` : ''}<p class="control-note">全部 103 个本地音色（100 普通话 + 3 英语）均可直接选择。${saved.length ? `已保存 ${saved.length} 个常用音色，置于列表顶部。` : '试听后可命名并加入常用。'}</p><p class="control-note">「重构」「重写」等常见开发词的读音已修正。本地 Kokoro 只有普通话与英语；需要粤语时切到「系统原生」。</p></div>
    </div></div>`;
}

/** 小米 MiMo 开放平台默认接口地址；与 @awm/schema 的 DEFAULT_CLOUD_ENDPOINT 保持一致。 */
const CLOUD_ENDPOINT_DEFAULT = 'https://api.xiaomimimo.com/v1/chat/completions';

/** 创建 MiMo API Key 的入口：开放平台控制台的 API Keys 页面。 */
const CLOUD_KEY_URL = 'https://platform.xiaomimimo.com/console/api-keys';

/** MiMo 预置音色；与 @awm/core 的 MIMO_TTS_VOICES 保持一致（渲染层不能运行时 import 包）。 */
const CLOUD_VOICE_PRESETS: ReadonlyArray<{ id: string; label: string }> = [
  { id: 'mimo_default', label: 'mimo_default（MiMo 默认）' },
  { id: '冰糖', label: '冰糖（中文女声）' },
  { id: '茉莉', label: '茉莉（中文女声）' },
  { id: '苏打', label: '苏打（中文男声）' },
  { id: '白桦', label: '白桦（中文男声）' },
  { id: 'Mia', label: 'Mia（英文女声）' },
  { id: 'Chloe', label: 'Chloe（英文女声）' },
  { id: 'Milo', label: 'Milo（英文男声）' },
  { id: 'Dean', label: 'Dean（英文男声）' },
];

/**
 * @description: 云 TTS 配置区。只有选择云后端时才渲染；密钥输入框永不回填已保存的值。
 * 接口地址始终填入实际请求的地址，留空保存会回到默认值，也可以一键恢复默认。
 */
function renderCloudSettings(settings: Settings): string {
  const voice = settings.voice;
  const hasKey = voice.cloudApiKey.trim().length > 0;
  const endpoint = voice.cloudEndpoint.trim() || CLOUD_ENDPOINT_DEFAULT;
  const customEndpoint = endpoint !== CLOUD_ENDPOINT_DEFAULT;
  // 空值按 MiMo 默认音色呈现；已保存的自定义值额外给一个选项，避免静默改掉用户配置。
  const cloudVoice = (voice.cloudVoice || '').trim() || 'mimo_default';
  const knownCloudVoice = CLOUD_VOICE_PRESETS.some((preset) => preset.id === cloudVoice);
  const cloudVoiceOptions = CLOUD_VOICE_PRESETS.map(
    (preset) =>
      `<option value="${esc(preset.id)}"${preset.id === cloudVoice ? ' selected' : ''}>${esc(preset.label)}</option>`,
  ).join('');
  const customCloudVoice = knownCloudVoice
    ? ''
    : `<option value="${esc(cloudVoice)}" selected>${esc(cloudVoice)}（自定义）</option>`;
  return `${settingRow('voice.cloudEnabled', '允许云 TTS 出网', '关闭时不发任何请求；开启并填写 Key 后，播报文本会发送到服务商。', toggle('voice.cloudEnabled', voice.cloudEnabled))}
    ${settingRow(
      'voice.cloudApiKey',
      'API Key',
      hasKey ? '已保存，仅存于本机设置；留空保存不会覆盖。' : '仅存于本机设置，不写入仓库或审计日志。',
      `<div class="control-row"><input id="__ID__" type="password" class="control-input control-grow" autocomplete="off" spellcheck="false" data-setting="voice.cloudApiKey" placeholder="${hasKey ? '已保存，留空不修改' : '粘贴 MiMo API Key'}" /><button class="btn btn-ghost btn-small" type="button" data-action="clear-cloud-key"${hasKey ? '' : ' disabled'}>清除</button><a class="text-link" href="${CLOUD_KEY_URL}" target="_blank" rel="noreferrer noopener">获取 Key ↗</a></div>`,
    )}
    ${settingRow(
      'voice.cloudEndpoint',
      '接口地址',
      '默认使用小米 MiMo 官方接口；也可填文档里的基础地址（…/v1），保存时会补全成 …/v1/chat/completions。',
      `<div class="control-row"><input id="__ID__" class="control-input control-fill" data-setting="voice.cloudEndpoint" value="${esc(endpoint)}" placeholder="${CLOUD_ENDPOINT_DEFAULT}" /><button class="btn btn-ghost btn-small" type="button" data-action="reset-cloud-endpoint"${customEndpoint ? '' : ' disabled'}>恢复默认</button></div>`,
    )}
    ${settingRow(
      'voice.cloudModel',
      '模型',
      '留空使用 mimo-v2.5-tts。',
      `<input id="__ID__" class="control-input" data-setting="voice.cloudModel" value="${esc(voice.cloudModel)}" placeholder="mimo-v2.5-tts" />`,
    )}
    ${settingRow(
      'voice.cloudVoice',
      '云音色',
      '默认 mimo_default（随集群自动选音色）；中文可选 冰糖 / 茉莉 / 苏打 / 白桦，英文可选 Mia / Chloe / Milo / Dean。',
      `<select id="__ID__" class="control-select" data-setting="voice.cloudVoice">${cloudVoiceOptions}${customCloudVoice}</select>`,
    )}
    <div class="panel-note">云 TTS 需联网，播报文本会发送到服务商；失败时显示具体原因，不会改播系统或其他音色。MiMo TTS 目前处于限时免费阶段，转收费后由你决定是否继续使用。</div>`;
}

/** @description: 本地引擎由 localEngine 决定要展示哪套模型与音色配置。 */
function localModelKind(settings: Settings): ModelKind {
  return settings.voice.localEngine === 'zipvoice' ? 'zipvoice' : 'kokoro';
}

/** @description: 两套模型各自维护状态；缺省都按未下载呈现。 */
function localModelStatus(state: AppState, kind: ModelKind): ModelStatus | null {
  return kind === 'zipvoice' ? state.zipvoiceModelStatus : state.modelStatus;
}

const LOCAL_MODEL_META: Record<
  ModelKind,
  { name: string; size: string; manual: string }
> = {
  kokoro: {
    name: 'Kokoro',
    size: '约 348MB',
    manual:
      '也可手动下载 kokoro-multi-lang-v1_1 解压到数据目录的 models 文件夹（含 model.onnx、voices.bin、tokens.txt、lexicon-*.txt 与 espeak-ng-data），重启后自动识别。',
  },
  zipvoice: {
    name: 'ZipVoice',
    size: '约 162MB',
    manual:
      '模型包、声码器与英文词典会先后下载；也可手动解压 sherpa-onnx-zipvoice-distill-int8-zh-en-emilia 到 models 文件夹，并补入 vocos_24khz.onnx 与 lexicon-en-us.txt，重启后自动识别。',
  },
};

/** @description: 模型状态行：missing 提供显式下载与出网说明，downloading 显示进度与取消，error 提供重试。 */
function renderModelStatusCard(state: AppState, kind: ModelKind): string {
  const status = localModelStatus(state, kind);
  const meta = LOCAL_MODEL_META[kind];
  const modelState = status?.state ?? 'missing';
  // ready 由引擎选择行内联展示，这里不再占一行。
  if (modelState === 'ready') return '';
  if (modelState === 'downloading') {
    const percent = Math.max(0, Math.min(100, Math.round(status?.percent ?? 0)));
    const received = (status?.bytes ?? 0) / 1024 / 1024;
    const total = (status?.totalBytes ?? 0) / 1024 / 1024;
    const size =
      total > 0 ? ` ${received.toFixed(1)} / ${total.toFixed(0)} MB` : ` ${received.toFixed(1)} MB`;
    return fieldRow(
      null,
      '模型',
      '下载后保存在本机；仅点击时出网。',
      `<div class="control-stack model-status" role="status"><p class="model-status-title">正在下载 ${meta.name} 模型 · ${String(percent)}%${esc(size)}</p><div class="control-row"><progress class="model-progress" value="${String(percent)}" max="100"></progress><button class="btn btn-ghost btn-small" type="button" data-action="cancel-model" data-model-kind="${kind}">取消下载</button></div></div>`,
    );
  }
  if (modelState === 'extracting')
    return fieldRow(
      null,
      '模型',
      '下载后保存在本机；仅点击时出网。',
      `<div class="control-stack model-status" role="status"><p class="model-status-title">${meta.name} 下载完成，正在解压校验…</p></div>`,
    );
  const error = modelState === 'error' ? status?.error : undefined;
  return fieldRow(
    null,
    '模型',
    '下载后保存在本机；仅点击时出网。',
    `<div class="control-stack model-status${error ? ' is-error' : ''}" role="status"><p class="model-status-title">${error ? `上次下载失败：${esc(error)}。` : modelState === 'error' ? '上次下载失败。' : `尚未下载 ${meta.name} 模型。`}</p><p class="control-note">下载${meta.size}，将从 github.com 获取（支持断点续传）；仅在点击后出网，模型文件保存在本机数据目录。${meta.manual}</p><button class="btn btn-primary btn-small" type="button" data-action="download-model" data-model-kind="${kind}">${error ? '重试下载' : '下载模型'}</button></div>`,
  );
}

/** @description: ZipVoice 没有预置音色：参考录音及其逐字原文共同决定音色。 */
function renderZipvoiceReference(settings: Settings): string {
  const path = settings.voice.zipvoiceReferencePath;
  const file = path ? (path.split(/[\\/]/).pop() ?? path) : '';
  const ready = Boolean(path) && Boolean(settings.voice.zipvoiceReferenceText.trim());
  return `<div class="voice-picker">${fieldRow(
    'zipvoice-reference-path',
    '参考录音',
    '5–15 秒安静 WAV；选择后复制到本机数据目录。',
    `<div class="control-row"><input id="__ID__" class="control-input control-fill" readonly value="${esc(file)}" placeholder="尚未选择 WAV" /><button class="btn btn-ghost btn-small" type="button" data-action="pick-zipvoice-reference">选择 WAV</button>${path ? '<button class="text-link" type="button" data-action="clear-zipvoice-reference">移除</button>' : ''}</div>`,
  )}${fieldRow(
    'zipvoice-reference-text',
    '录音原文',
    '逐字填写录音里说的话。',
    `<input id="__ID__" class="control-input control-fill" data-setting="voice.zipvoiceReferenceText" maxlength="500" value="${esc(settings.voice.zipvoiceReferenceText)}" placeholder="逐字填写录音里说的话" />`,
  )}${fieldNote(
    `<p class="control-note" role="status">${ready ? '参考录音与原文已就绪；更换录音或改动原文后建议重新试听。' : '需要一段 5–15 秒、安静的 WAV 录音，并逐字填写录音内容；两者不对应会明显影响音色。选择后会复制到本机数据目录，原文件可以移动。'}</p>`,
  )}</div>`;
}

/** @description: 本地后端区：引擎选择、对应模型状态、音色来源（预置或参考录音）。 */
function renderLocalSettings(state: AppState, settings: Settings, voiceProfile: string): string {
  const kind = localModelKind(settings);
  const status = localModelStatus(state, kind);
  const engineRow = settingRow(
    'voice.localEngine',
    '本地引擎',
    kind === 'zipvoice'
      ? '用一段参考录音决定音色；需要模型与录音都就绪。'
      : '预置普通话与英语音色，模型下载后可完全离线使用。',
    `<div class="control-row"><select id="__ID__" class="control-select" data-setting="voice.localEngine"><option value="kokoro" ${kind === 'kokoro' ? 'selected' : ''}>Kokoro · 预置音色</option><option value="zipvoice" ${kind === 'zipvoice' ? 'selected' : ''}>ZipVoice · 参考录音复刻</option></select>${(status?.state ?? 'missing') === 'ready' ? '<span class="control-note is-ok">模型已就绪</span>' : ''}</div>`,
  );
  const picker =
    kind === 'zipvoice'
      ? renderZipvoiceReference(settings)
      : settingRow(
          'voice.voiceProfile',
          '音色',
          '100 个普通话音色与 3 个英语音色；可命名后加入常用。',
          renderKokoroVoicePicker(state, voiceProfile, settings),
        );
  const note = fieldNote(
    `<p class="control-note">${
      kind === 'zipvoice'
        ? `${(status?.state ?? 'missing') === 'ready' ? '约 162MB，仅在本机使用；参考录音只保存在本机数据目录。' : ''}试听严格使用本地 ZipVoice；模型、录音或播放失败时显示具体错误，不会改播系统音色。`
        : `${(status?.state ?? 'missing') === 'ready' ? '约 348MB，仅在本机使用；运行时与播放会在首次试听时验证。' : ''}试听严格使用本地 Kokoro。模型、运行时或播放失败时显示具体错误，不会改播系统音色。`
    }</p>`,
  );
  return `${engineRow}${renderModelStatusCard(state, kind)}${picker}${note}`;
}

/** @description: Group settings into independent, responsive panels. */
function renderSettings(
  state: AppState,
  voiceProfile = state.settings?.voice.voiceProfile ?? 'system-default',
  // 预览副本：设置页显示的是待保存的值，规则表叠加待保存的规则动作。
  settings: Settings | null = state.settings,
  rules: VoiceRule[] = state.rules,
): string {
  if (!settings)
    return `<div data-region="settings-empty">${errorBlock(state.sectionErrors.settings ?? '设置尚未加载')}</div>`;
  const backend = settings.voice.backend;
  const localEngine = settings.voice.localEngine;
  const rate = `<div class="control-row"><input id="__ID__" type="range" min="0.5" max="2" step="0.1" data-setting="voice.rate" value="${settings.voice.rate}" aria-label="语速" ${backend === 'cloud' ? 'disabled' : ''}/><output id="rate-value" for="__ID__">${backend === 'cloud' ? '平台控制' : `${settings.voice.rate.toFixed(1)}×`}</output></div>`;
  const audition = `<div class="control-stack"><div class="control-row"><input id="speak-text" class="control-input control-grow" data-draft aria-label="试听文本" value="重构登录模块，等你拍板" /><button class="btn btn-primary" type="button" data-action="speak-test">试听</button></div><div id="speak-result" class="action-result ${state.speakResult?.ok === false ? 'is-error' : ''}" role="status">${state.speakResult ? esc(state.speakResult.ok ? `播放完成 · ${backendLabel(state.speakResult.usedBackend, localEngine)}` : `播放失败：${state.speakResult.errors.join('；')}`) : ''}</div></div>`;
  // 当前播报状态只在「播报规则」里展示一次：那里才需要对照规则看结果。
  // 兼容旧版 all：自动播报始终只允许开始、待确认、完成三类事件。
  const scope = settings.voice.scope === 'all' ? 'milestones' : settings.voice.scope;
  const content = settings.voice.content;
  const voice = `${sectionError(state, 'settings')}${settingRow('voice.enabled', '启用自动播报', '关闭后保留系统通知；规则静音仍不提醒。', toggle('voice.enabled', settings.voice.enabled))}
    ${settingRow('voice.scope', '播报范围', '开始、待确认、完成可播报；其他事件按规则通知或静音。', `<select id="__ID__" class="control-select" data-setting="voice.scope"><option value="attention" ${scope === 'attention' ? 'selected' : ''}>仅待确认</option><option value="milestones" ${scope === 'milestones' ? 'selected' : ''}>待确认与开始/完成</option></select>`)}
    ${settingRow('voice.content', '播报内容', content === 'title' ? '读精简后的会话标题：去掉代码与链接，截到第一个句读，最多 24 字。' : '读会话标题原文：保留适配器给出的前 40 字。', `<select id="__ID__" class="control-select" data-setting="voice.content"><option value="title" ${content === 'title' ? 'selected' : ''}>会话标题（精简）</option><option value="prompt" ${content === 'prompt' ? 'selected' : ''}>标题原文</option></select>`)}
    ${settingRow('voice.backend', '播报后端', backend === 'local' ? '本地离线合成，需先下载模型；试听严格使用此后端。' : backend === 'cloud' ? '播报文本会发送到小米 MiMo；需开启并填写 API Key。' : '使用系统语音；中文音色需已安装。', `<select id="__ID__" class="control-select" data-setting="voice.backend"><option value="native" ${backend === 'native' ? 'selected' : ''}>系统原生</option><option value="local" ${backend === 'local' ? 'selected' : ''}>本地引擎（Kokoro / ZipVoice）</option><option value="cloud" ${backend === 'cloud' ? 'selected' : ''}>云 TTS · 小米 MiMo</option><option value="piper" disabled ${backend === 'piper' ? 'selected' : ''}>Piper · 历史配置</option></select>`)}
    ${backend === 'piper' ? '<div class="inline-error">当前保存的后端尚不可用，请切回「系统原生」、选择「本地引擎」或「云 TTS」。</div>' : ''}
    ${backend === 'local' ? renderLocalSettings(state, settings, voiceProfile) : ''}
    ${backend === 'cloud' ? renderCloudSettings(settings) : ''}
    ${backend === 'native' ? settingRow('voice.voiceProfile', '音色', '系统中文音色；增强款需在系统的语音设置中下载。', renderNativeVoicePicker(state, voiceProfile)) : ''}
    ${settingRow('voice.rate', '语速', backend === 'cloud' ? '云 TTS 的语速由平台控制；此处只影响本地与系统音色。' : '1.0× 为系统默认语速。', rate)}
    ${fieldRow('speak-text', '试听', '每次点击播放一次；使用上次保存的后端与音色，未保存的修改需先保存后才会用于试听。', audition)}`;
  const quietRanges = `<div class="control-stack quiet-ranges" role="group" aria-labelledby="quiet-ranges-label">${settings.quiet.ranges.map((range, index) => `<div class="control-row range-row"><label class="sr-only" for="quiet-from-${index}">时段 ${index + 1} 开始</label><input id="quiet-from-${index}" type="time" data-setting="quiet.ranges.${index}.from" value="${esc(range.from)}" /><span class="muted">至</span><label class="sr-only" for="quiet-to-${index}">时段 ${index + 1} 结束</label><input id="quiet-to-${index}" type="time" data-setting="quiet.ranges.${index}.to" value="${esc(range.to)}" /><button class="icon-btn" type="button" data-remove-range="${index}" aria-label="删除时段 ${index + 1}">×</button></div>`).join('')}<button class="btn btn-ghost btn-small" type="button" data-action="add-range">＋ 添加时段</button></div>`;
  const quiet = `${settingRow('quiet.globalMute', '全局静音', '优先于所有自动播报例外，任务提醒保留为通知。', toggle('quiet.globalMute', settings.quiet.globalMute))}${fieldGroup('quiet-ranges-label', '免打扰时段', '支持跨天与多个时段。', quietRanges)}${settingRow('quiet.waitingHumanOverride', '待审批任务突破免打扰时段', '仅突破时段设置，全局静音仍然生效。', toggle('quiet.waitingHumanOverride', settings.quiet.waitingHumanOverride))}`;
  const privacy = `${settingRow('scan.autoIntervalHours', '安装扫描间隔', '单位：小时。会话变化仍每 5 秒采集。', `<input id="__ID__" class="control-input control-input--short" type="number" min="1" max="24" data-setting="scan.autoIntervalHours" value="${settings.scan.autoIntervalHours}" />`)}${settingRow('privacy.sessionFileRead', '读取本地会话来源', '关闭后停止会话采集和心跳观察，历史快照随即隐藏。', toggle('privacy.sessionFileRead', settings.privacy.sessionFileRead))}${settingRow('privacy.auditLog', '记录操作审计', '审计不写入对话正文或凭据。', toggle('privacy.auditLog', settings.privacy.auditLog))}<div class="panel-note">会话内容保留在本机。扫描仅读取适配器声明的来源。</div><div class="settings-actions"><button class="btn btn-ghost btn-small" type="button" data-action="export-events">导出事件 JSON</button><span class="muted">导出状态事件记录（最多 500 条），只含元数据与原因，不含对话正文。</span></div>`;
  // 吸顶导航：外层通栏铺满（与页头连贯），内层与设置面板同宽对齐。
  return `<nav class="settings-nav" aria-label="设置分区" data-region="settings-nav"><div class="settings-nav-inner">${[
    ['voice', '语音'],
    ['quiet', '免打扰'],
    ['rules', '播报规则'],
    ['privacy', '扫描与隐私'],
    ['external', '外部服务'],
  ]
    .map(
      ([id, label]) =>
        `<button class="btn btn-ghost btn-small" type="button" data-settings-section="${id}">${label}</button>`,
    )
    .join('')}<span class="settings-save-group"><span id="settings-save-status" class="muted" role="status"></span><button id="settings-save" class="btn btn-primary btn-small" type="button" data-action="save-settings" disabled>保存</button></span></div></nav>
    ${settingsSection('voice', '语音播报', '听到进展，也能看清每次播放的结果。', voice)}
    ${settingsSection('quiet', '免打扰', '按你的工作节奏安排自动提醒。', quiet)}
    ${settingsSection('rules', '播报规则', '开始、待确认、完成可播报；其他事件仅通知或静音。', sectionError(state, 'rules') + renderVoicePolicy(state, new Date(), settings, rules) + renderRuleMatrix(rules))}
    ${settingsSection('privacy', '扫描与隐私', '控制本机数据的读取范围。', privacy)}
    ${settingsSection('external', '验证外部 MCP Server', '保存配置并枚举工具；验证完成后关闭连接。', sectionError(state, 'servers') + renderExternalMcp(state))}`;
}

/** @description: Group both connection methods by tool, preserving provider order and partial data. */
function renderIntegrations(state: AppState): string {
  const tools = new Map<string, { name: string; hook?: HookIntegration; mcp?: McpSnippet }>();
  for (const hook of state.hookIntegrations) tools.set(hook.id, { name: hook.name, hook });
  for (const mcp of state.mcpSnippets) {
    const tool = tools.get(mcp.id) ?? { name: mcp.name };
    tools.set(mcp.id, { ...tool, mcp });
  }
  const intro = `<section class="panel integration-intro" data-region="integrations-intro"><div class="section-head"><h2>按工具接入</h2><button class="btn btn-ghost btn-small" type="button" data-action="refresh-hooks">刷新接收状态</button></div>${sectionError(state, 'hooks')}${sectionError(state, 'snippets')}<p>展开对应工具的接入方式，复制配置并在客户端中合并保存。Hooks 接收任务事件；MCP 提供任务查询与状态标记。</p><p class="muted">仅安装工具或配置 MCP 不会自动接入任务事件。已有设置或同名脚本请合并，保留其他逻辑。接收时间只表示曾收到事件，不代表持续连接。收到事件后，是否出声仍取决于语音开关、全局静音、免打扰与事件规则。</p></section>`;
  return (
    intro +
    (tools.size
      ? Array.from(tools, ([id, tool]) => {
          const missingHooks = state.sectionErrors.hooks ? '加载失败' : '未提供';
          const missingMcp = state.sectionErrors.snippets ? '加载失败' : '未提供';
          return `<section class="panel integration-tool" data-region="integration-${esc(id)}" aria-labelledby="integration-title-${esc(id)}"><div class="section-head"><h2 id="integration-title-${esc(id)}">${esc(tool.name)}</h2></div>
          <details class="integration-method" data-disclosure-key="integration-${esc(id)}-hooks"><summary><span class="integration-method-name">Hooks 接入</span>${tool.hook ? renderHookStatus(tool.hook) : `<span class="badge">${missingHooks}</span>`}</summary><div class="integration-method-body">${tool.hook ? renderHookIntegration(tool.hook) : `<p class="muted">${state.sectionErrors.hooks ? 'Hooks 配置未能加载，请刷新后重试。' : '当前未提供此工具的 Hooks 接入配置。'}</p>`}</div></details>
          <details class="integration-method" data-disclosure-key="integration-${esc(id)}-mcp"><summary><span class="integration-method-name">MCP 接入</span><span class="badge" ${tool.mcp?.commandReady === false ? 'data-state="failed"' : ''}>${tool.mcp ? (tool.mcp.commandReady === false ? '入口不可用' : '配置指引') : missingMcp}</span></summary><div class="integration-method-body">${tool.mcp ? renderMcpSnippet(tool.mcp, state.mcpValidation) : `<p class="muted">${state.sectionErrors.snippets ? 'MCP 配置未能加载，请刷新后重试。' : '当前未提供此工具的 MCP 接入配置。'}</p>`}</div></details>
        </section>`;
        }).join('')
      : '<div class="empty" data-region="integrations-empty">接入配置尚未加载，请刷新后重试。</div>')
  );
}

function renderHookStatus(integration: HookIntegration): string {
  const received =
    !!integration.lastEventAt && Number.isFinite(Date.parse(integration.lastEventAt));
  const status = !integration.enabled
    ? '暂停接收'
    : !integration.commandReady
      ? '入口不可用'
      : received
        ? '已收到任务事件'
        : '等待首次任务事件';
  return `<span class="badge" data-state="${!integration.commandReady ? 'failed' : received && integration.enabled ? 'completed' : 'idle'}">${status}</span>`;
}

/** @description: Copyable files preserve exact source and never install or submit task events. */
function renderHookIntegration(integration: HookIntegration): string {
  return `<p class="hook-event-time">${esc(hookEventTime(integration.lastEventAt))}</p><p class="muted">${esc(integration.capabilityReason)}</p>${!integration.enabled ? '<p class="panel-note">当前暂停接收。请开启本地来源读取，并确认该工具未被忽略。</p>' : ''}${!integration.commandReady ? '<div class="inline-error">任务事件接收入口不可用，此配置暂不可运行。请检查当前应用安装后刷新。</div>' : ''}<ol class="setup-steps">${integration.steps.map((step) => `<li>${esc(step)}</li>`).join('')}</ol><div class="hook-files">${integration.files.map((file, index) => `<div class="hook-file"><div class="hook-file-head"><code>${esc(file.path)}</code><button id="copy-hook-${esc(integration.id)}-${index}" class="btn btn-ghost btn-small" type="button" data-copy-hook="${esc(integration.id)}" data-hook-path="${esc(file.path)}" data-copy-unavailable="${!integration.commandReady}" aria-label="复制 ${esc(integration.name)} 配置 ${index + 1}" ${integration.commandReady ? '' : 'disabled'}>复制内容</button></div>${file.executable ? '<p class="hook-file-note">保存后执行 chmod u+x，为该脚本赋予当前用户执行权限；已有同名脚本请合并调用。</p>' : ''}<details data-disclosure-key="hook-file-${esc(integration.id)}-${esc(file.path)}"><summary>查看配置内容</summary><pre class="code-block">${esc(file.content)}</pre></details></div>`).join('')}</div>`;
}

/** @description: One action selector per known event. */
function renderRuleMatrix(rules: VoiceRule[]): string {
  return [
    'task.waiting_human',
    'task.failed',
    'task.timeout',
    'task.completed',
    'task.started',
  ]
    .map((event) => {
      const configured = genericVoiceAction(rules, event);
      const restricted = !voiceEventCanSpeak(event) && configured === 'speak';
      const action = restricted ? 'notify' : configured;
      return fieldRow(
        `rule-${event}`,
        esc(eventLabel(event)),
        restricted ? '原播报规则现按仅通知执行' : '',
        `<select id="__ID__" class="control-select control-select--compact" data-rule-event="${event}">${[
          ['mute', '静音'],
          ['notify', '仅通知'],
          ...(voiceEventCanSpeak(event) ? [['speak', '播报']] : []),
        ]
          .map(
            ([value, label]) =>
              `<option value="${value}" ${action === value ? 'selected' : ''}>${label}</option>`,
          )
          .join('')}</select>`,
      );
    })
    .join('');
}

/** @description: Each tool owns its copy action; validation always refers to the shared local bridge. */
function renderMcpSnippet(snippet: McpSnippet, validation: McpValidation | null): string {
  const steps = snippet.steps ?? [
    '复制下方配置。',
    '打开客户端的 MCP 设置并粘贴，保存后重新加载客户端。',
    '点击下方按钮验证 AgentCue 桥接。',
  ];
  return `<p class="control-note">${esc(snippet.hint)}</p>${snippet.commandReady === false ? '<div class="inline-error">桥接入口尚未就绪，配置后请先验证。</div>' : ''}<ol class="setup-steps">${steps.map((step) => `<li>${esc(step)}</li>`).join('')}</ol><div class="hook-file"><div class="hook-file-head"><span class="muted">${snippet.format === 'toml' ? 'TOML' : 'JSON'} 配置</span><button class="btn btn-ghost btn-small" type="button" data-action="copy-mcp" data-mcp-id="${esc(snippet.id)}" aria-label="复制 ${esc(snippet.name)} MCP 配置">复制配置</button></div><pre class="code-block">${esc(snippet.json)}</pre></div><div class="settings-actions"><button class="btn btn-primary btn-small" type="button" data-action="validate-mcp">验证 AgentCue 桥接</button><span class="muted">仅验证本机 AgentCue 桥接，不代表此客户端已连接。</span></div><div class="action-result ${validation && !validation.ok ? 'is-error' : ''}" role="status">${validation ? esc(validation.ok ? `本机 AgentCue 桥接验证通过 · ${validation.tools.length} 个工具 · ${fmtTime(validation.lastValidatedAt)}` : `本机 AgentCue 桥接验证失败：${validation.lastError ?? '无法完成握手'}`) : ''}</div>`;
}

/** @description: External commands and arguments are separate values, never a shell command. */
function renderExternalMcp(state: AppState): string {
  const form = `${fieldRow(
    'mcp-name',
    '名称',
    '',
    `<input id="__ID__" class="control-input" data-draft placeholder="例如：项目文档工具" />`,
  )}${fieldRow(
    'mcp-transport',
    '传输方式',
    '',
    `<select id="__ID__" class="control-select" data-draft><option value="stdio" ${state.externalTransport === 'stdio' ? 'selected' : ''}>stdio · 本地进程</option><option value="streamable-http" ${state.externalTransport === 'streamable-http' ? 'selected' : ''}>Streamable HTTP</option></select>`,
  )}${
    state.externalTransport === 'stdio'
      ? `${fieldRow(
          'mcp-command',
          '可执行文件',
          '',
          `<input id="__ID__" class="control-input control-fill" data-draft placeholder="例如 npx，或可执行文件绝对路径" />`,
        )}${fieldRow(
          'mcp-args',
          '参数',
          '填写 JSON 字符串数组，或每行一个参数。',
          `<textarea id="__ID__" class="control-input control-fill" data-draft rows="2" placeholder='["-y", "@org/server"]'></textarea>`,
        )}`
      : fieldRow(
          'mcp-url',
          'Server URL',
          '',
          `<input id="__ID__" class="control-input control-fill" data-draft type="url" placeholder="http://127.0.0.1:3000/mcp" />`,
        )
  }<div class="settings-actions"><button class="btn btn-primary" type="button" data-action="add-mcp">保存并验证</button></div>`;
  return `${form}<div class="server-list">${state.mcpServers.length ? state.mcpServers.map((server) => `<article class="server-row"><div><strong>${esc(server.name)}</strong><span class="badge" data-state="${server.validationStatus === 'verified' ? 'completed' : server.validationStatus === 'error' ? 'failed' : 'unknown'}">${server.validationStatus === 'verified' ? '上次验证通过' : server.validationStatus === 'error' ? '验证失败' : '尚未验证'}</span><p class="muted">${esc(server.transport)} · ${esc(server.command ?? server.url ?? '')}</p><p class="muted">${server.lastValidatedAt ? `验证于 ${esc(fmtTime(server.lastValidatedAt))}` : '没有验证记录'} · 当前未保持连接</p>${server.lastError ? `<p class="server-error">${esc(server.lastError)}</p>` : ''}</div><div class="control-actions"><button class="btn btn-ghost btn-small" type="button" data-validate-server="${esc(server.serverId)}">重新验证</button><button class="btn btn-ghost btn-small" type="button" data-delete-mcp="${esc(server.serverId)}">移除</button></div></article>`).join('') : '<div class="empty">尚未保存外部 Server。验证只枚举工具，不执行工具。</div>'}</div>`;
}

/** 通知级别中文名。@param level attention / info */
function noticeLevelLabel(level: string): string {
  return level === 'attention' ? '需处理' : '信息';
}

function renderNotifications(state: AppState): string {
  const filter = state.noticeLevelFilter;
  const shown = filter
    ? state.notifications.filter((n) => n.level === filter)
    : state.notifications;
  const unread = state.notifications.filter((n) => !n.read).length;
  const chips: Array<['' | 'attention' | 'info', string]> = [
    ['', '全部级别'],
    ['attention', '需处理'],
    ['info', '信息'],
  ];
  // 头部操作区：级别筛选与「全部已读」（复用主进程已有的批量已读端点）。
  return `<section class="panel" data-region="notifications"><div class="section-head"><div><h2>最近通知${unread ? `<span class="count-pill">${unread} 未读</span>` : ''}</h2><p class="muted">全部播报与通知的历史。</p></div><div class="section-head-actions"><select id="notice-level-filter" aria-label="按级别筛选">${chips.map(([v, l]) => `<option value="${v}" ${filter === v ? 'selected' : ''}>${l}</option>`).join('')}</select>${unread ? `<button class="btn btn-ghost btn-small" type="button" data-action="mark-all-read">全部已读</button>` : ''}</div></div>${sectionError(state, 'notifications')}${shown.length ? shown.map((item) => `<article class="notice${item.read ? ' is-read' : ''}" data-notice-level="${esc(item.level)}"><span class="notice-dot" aria-hidden="true"></span><div><div class="notice-meta"><span>${esc(fmtRelative(item.ts))}</span><span>${item.read ? '已读' : '未读'}</span><span class="badge" data-level="${esc(item.level)}">${esc(noticeLevelLabel(item.level))}</span></div><h3>${esc(item.title)}</h3><p>${esc(item.body)}</p>${item.sessionId ? `<button class="text-link" type="button" data-session="${esc(item.sessionId)}">查看任务</button>` : ''}</div>${item.read ? '' : `<button class="btn btn-ghost btn-small" type="button" data-read-notice="${esc(item.notificationId)}">标为已读</button>`}</article>`).join('') : `<div class="empty">${filter ? '该级别下暂无通知。' : '还没有通知。任务需要你时会显示在这里。'}</div>`}${state.noticeHasMore ? `<button class="btn btn-more" type="button" data-action="load-notices">加载更早通知 · 已显示 ${state.notifications.length} 条</button>` : ''}</section>`;
}

/** @description: The drawer uses descriptive recording actions and an append-only timeline. */
function renderTimeline(records: TransitionRecord[], session: SessionSummary | null): string {
  const actions = session ? taskActions(session.sessionId, session.currentState) : '';
  return `<div class="drawer-actions">${actions}<button class="btn btn-ghost btn-small" type="button" data-action="copy-timeline" data-copy-session="${esc(session?.sessionId ?? '')}">复制时间线</button></div>${actions ? '<p class="panel-note">以上操作只更新 AgentCue 记录。请先在原工具中完成实际响应或重试。</p>' : ''}${
    records.length
      ? `<div class="timeline">${records
          .slice()
          .reverse()
          .map(
            (record) =>
              `<div class="timeline-item" data-tone="${stateTone(record.nextState ?? 'idle')}"><div class="timeline-time">${esc(fmtTime(record.ts))} · ${esc(record.actor)}</div><div class="timeline-text">${esc(eventLabel(record.eventType))}<span class="timeline-arrow">${esc(record.prevState ? stateLabel(record.prevState) : '开始')} → ${esc(record.nextState ? stateLabel(record.nextState) : '记录')}</span></div>${record.reason ? `<div class="muted">${esc(record.reason)}</div>` : ''}</div>`,
          )
          .join('')}</div>`
      : '<div class="empty">还没有状态迁移记录。</div>'
  }`;
}
