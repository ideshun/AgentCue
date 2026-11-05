/** Native views. Dynamic text is escaped before it reaches HTML. */
type RouteName =
  'overview' | 'office' | 'board' | 'integrations' | 'adapters' | 'settings' | 'notifications';
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
    ? `<div class="inline-error" role="alert">${key === 'settings' ? `设置没保存成功：${esc(message)}。你改的内容还在，检查一下再试。` : `没更新成功：${esc(message)}。现在显示的还是上次的数据。`}</div>`
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
      ? `<div class="session-actions"><button class="btn btn-small btn-ghost" type="button" data-task-event="${quickEvent}" data-task-id="${esc(session.sessionId)}" title="只改 AgentCue 的记录；任务本身要去原工具里处理">${quickEvent === 'human.responded' ? '我已处理' : '标记为已重试'}</button></div>`
      : '';
  return `<div class="session"><button class="session-main" type="button" data-session="${esc(session.sessionId)}"><span class="session-title">${esc(displayTaskTitle(session, tools))}</span>
      <span class="session-meta"><span>${esc(session.toolId)}</span><span>${esc(withRelative ? fmtRelative(session.updatedAt) : fmtTime(session.updatedAt))}</span></span></button>
    <span class="badge" data-state="${esc(session.currentState)}">${esc(stateLabel(session.currentState))}</span>${actions}</div>`;
}

/** @description: Capability labels describe what the source can actually prove. */
function capabilityLabel(capability?: string): string {
  return capability === 'events'
    ? '能看任务状态'
    : capability === 'metadata'
      ? '只能看历史'
      : '只能看装没装';
}

/** @description: A previous delivery is evidence of an event, never a persistent connection. */
function hookEventTime(value: string | null | undefined): string {
  if (!value || !Number.isFinite(Date.parse(value))) return '还没收到过任务事件';
  return `上次收到事件 ${new Date(value).toLocaleString('zh-CN', {
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
  return `<p class="hook-tool-status">装好了还不等于任务事件已接入。${paused ? '现在暂停接收任务事件。' : ''}${esc(hookEventTime(tool.hookLastEventAt))}。<a class="text-link" href="#/settings">去设置里接入 ↗</a></p>`;
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
    ['有失败', statsValue(summary?.attention), 'failed'],
  ];
  // 信号面板：主读数是等待用户确认的任务数，有待办时整块进入注意态。
  // 注意态用类名表达：app.ts 的区域差分只同步 className，不同步 dataset。
  return `<section class="signal-panel${(waiting ?? 0) > 0 ? ' is-attention' : ''}" data-region="overview-stats">${sectionError(state, 'overview')}<div class="signal-hero"><span class="signal-value">${statsValue(waiting)}</span><span class="signal-label">等你确认</span></div><div class="signal-divider" aria-hidden="true"></div><div class="signal-metrics">${metrics.map(([label, value, tone]) => `<div class="signal-metric"><span class="signal-dot" data-state="${tone}"></span><span class="signal-metric-value">${value}</span><span class="signal-metric-label">${label}</span></div>`).join('')}</div></section>
    <div class="overview-grid"><section class="panel" data-region="overview-attention"><div class="section-head"><h2>等你处理</h2><a class="text-link" href="#/board">查看看板 ↗</a></div>${sectionError(state, 'board')}${attention.length ? `<div class="session-list">${attention.map((item) => sessionRow(item, true, state.tools, true)).join('')}</div>` : `<div class="empty">${state.sectionErrors.board ? '任务列表加载失败，请重试。' : boardPending ? '正在加载任务…' : '没有在等你的任务。'}</div>`}</section><div class="overview-side">
    <section class="panel" data-region="overview-running"><div class="section-head"><h2>进行中</h2><span class="count-pill">${running?.total ?? (boardPending ? '…' : '—')}</span></div>${
      running?.items.length
        ? `<div class="session-list">${running.items
            .filter(
              (item): item is BoardItem & { currentState: TaskState } => item.currentState !== null,
            )
            .map((item) => sessionRow(item, true, state.tools))
            .join('')}</div>`
        : `<div class="empty">${boardPending ? '正在加载任务…' : '现在没有正在运行的任务。'}</div>`
    }</section>
    <section class="panel" data-region="overview-tools"><div class="section-head"><h2>本机工具</h2><a class="text-link" href="#/adapters">管理工具 ↗</a></div>${sectionError(state, 'tools')}${installed.length ? installed.map(toolRow).join('') : '<div class="empty">还没找到已安装的 AI 工具。点「扫描工具」重新检查。</div>'}<div class="panel-foot">${scan ? `上次扫描 ${esc(fmtTime(scan.finishedAt))} · ${scan.degraded.length ? `${scan.degraded.length} 个来源有问题` : '一切正常'}` : '还没扫描过'}<span>任务变化每 5 秒自动更新</span></div></section></div></div>`;
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
    event === 'human.responded' ? '我已处理' : event === 'task.retried' ? '标记为已重试' : '归档';
  return `<button class="btn btn-small btn-ghost" type="button" data-task-event="${event}" data-task-id="${esc(sessionId)}" title="只改 AgentCue 的记录；任务本身要去原工具里处理">${label}</button>${currentState === 'failed' || currentState === 'timeout' ? `<button class="btn btn-small btn-ghost" type="button" data-task-event="task.archived" data-task-id="${esc(sessionId)}">归档</button>` : ''}`;
}

/** @description: Per-column counts and cursors remain independent. */
function renderBoard(state: AppState): string {
  const columns: Array<{ id: BoardGroupId; title: string; hint: string; tone: string }> = [
    { id: 'attention', title: '等你处理', hint: '需要你回应', tone: 'attention' },
    { id: 'running', title: '进行中', hint: '正在运行的任务', tone: 'running' },
    { id: 'failed', title: '有问题', hint: '失败或超时', tone: 'failed' },
    { id: 'completed', title: '已结束', hint: '完成、取消或归档', tone: 'ok' },
  ];
  const renderColumn = (id: BoardGroupId, title: string, hint: string, tone: string): string => {
    const group = state.board?.groups.find((item) => item.id === id);
    const pending = !group && state.boardLoading && !state.sectionErrors.board;
    return `<section class="column${id === 'history' ? ' history-column' : ''}" data-region="board-${id}" data-tone="${tone}"><header class="column-head"><span class="column-dot" data-tone="${tone}" aria-hidden="true"></span><div><h2>${title}<span class="count-pill">${group?.total ?? (pending ? '…' : '—')}</span></h2><p>${hint}</p></div></header><div class="column-body" data-scroll-key="board-${id}">${group?.items.length ? group.items.map((item) => boardCard(item, state.tools)).join('') : `<div class="column-empty">${group ? '没有任务' : state.sectionErrors.board ? '列表加载失败' : '正在加载…'}</div>`}</div>${group?.nextCursor ? `<button class="btn btn-more" type="button" data-load-group="${id}" data-cursor="${esc(group.nextCursor)}">加载更多（已显示 ${group.items.length} / ${group.total}）</button>` : ''}</section>`;
  };
  return `<div class="board-filterbar" data-region="board-toolbar"><div class="search-control"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><circle cx="7" cy="7" r="4.5" /><path d="M10.5 10.5 14 14" /></svg><input id="board-search" data-draft type="search" aria-label="搜索任务" placeholder="搜索任务标题、工具或 ID" value="${esc(state.boardQuery.q)}" /></div><span class="filterbar-sep" aria-hidden="true"></span><select id="board-tool" data-draft aria-label="筛选工具"><option value="">全部工具</option>${state.tools.map((tool) => `<option value="${esc(tool.toolId)}" ${state.boardQuery.toolId === tool.toolId ? 'selected' : ''}>${esc(tool.name)}</option>`).join('')}</select><button class="btn btn-ghost btn-small" type="button" data-action="clear-board">重置筛选</button></div>
    <div data-region="board-feedback">${sectionError(state, 'board')}<p class="board-hint">这里的操作只改 AgentCue 的记录，任务本身要去原工具里处理。</p></div>
    <div class="board">${columns.map((column) => renderColumn(column.id, column.title, column.hint, column.tone)).join('')}</div>
    ${renderColumn('history', '历史记录', '只有标题和时间，不确定当前状态', 'neutral')}`;
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
  return `<section class="panel" data-region="adapters-list"><div class="section-head"><div><h2>已识别工具</h2><p class="muted">每个工具的安装状态和能提供的信息分别列出。</p></div><span class="count-pill">${state.adapters.length}</span></div>${sectionError(state, 'adapters')}${sectionError(state, 'tools')}${sectionError(state, 'settings')}${
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
            return `<article class="adapter">${toolMark(tool ?? {})}<div class="adapter-info"><div class="adapter-name">${esc(adapter.name)}${tool?.host ? `<span class="muted">${esc(tool.host)} 扩展</span>` : ''}<span class="badge" data-state="${status === 'running' ? 'running' : 'idle'}">${esc(detectLabel(status))}</span>${ignored ? '<span class="badge">已忽略</span>' : ''}</div><div class="capability-label">${esc(capabilityLabel(capability))}${tool?.version ? ` · v${esc(tool.version)}` : ''}</div><p class="muted">${esc(tool?.capabilityReason ?? (capability === 'metadata' ? '只能看到历史记录，看不到当前状态。' : capability === 'detect-only' ? '这个工具暂时无法读取任务。' : '正在读取这个工具的任务记录。'))}</p>${tool ? toolHookStatus({ ...tool, ignored }, state.settings) : ''}<details data-disclosure-key="adapter-path-${esc(adapter.id)}"><summary>查看检测路径</summary><code class="adapter-path">${esc(adapterPath(adapter))}</code></details></div><button class="btn btn-ghost" type="button" data-toggle-ignore="${esc(adapter.id)}" data-ignored="${ignored}">${ignored ? '恢复扫描' : '忽略'}</button></article>`;
          })
          .join('')
      : '<div class="empty">工具列表还没加载好，请重新扫描。</div>'
  }</section>
    <section class="panel" data-region="adapters-custom"><div class="section-head"><div><h2>自定义工具</h2><p class="muted">填一个本机路径，AgentCue 会检查它装没装。</p></div></div><div class="custom-form"><input id="custom-id" data-draft aria-label="工具 ID" placeholder="工具 ID（小写字母和连字符）" /><input id="custom-name" data-draft aria-label="显示名" placeholder="显示名" /><input id="custom-path" data-draft aria-label="配置路径" placeholder="配置路径，如 ~/.my-tool" /><button class="btn btn-primary" type="button" data-action="add-custom-tool">添加工具</button></div>${(state.settings?.scan.customTools ?? []).map((tool) => `<div class="tool-row"><div class="tool-info"><strong>${esc(tool.name)}</strong><code>${esc(tool.configPath)}</code></div><button class="btn btn-ghost" type="button" data-remove-custom="${esc(tool.id)}">移除</button></div>`).join('')}</section>`;
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
    ? '现在全部静音，要播报的事件也只弹通知。'
    : !settings.voice.enabled
      ? '自动语音关着，要播报的事件只弹通知。'
      : quiet
        ? settings.quiet.waitingHumanOverride
          ? '现在是免打扰时段，只有等你确认的任务会出声，其他都改弹通知。'
          : '现在是免打扰时段，一律改弹通知。'
        : '现在不在免打扰时段，按下面的规则来。';
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
    speak: '出声',
    notify: '弹通知',
    mute: '静音',
  };
  const time = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  return `<aside class="voice-policy" aria-label="当前自动播报策略"><div class="voice-policy-head"><strong>现在的实际效果</strong><span>现在 ${time} · ${policy.quiet ? '免打扰时段内' : '免打扰时段外'}</span></div><p>${esc(policy.status)}</p>${state.sectionErrors.rules ? '<p class="is-error">规则加载失败，刷新后确认每种事件的处理方式。</p>' : `<ul class="voice-policy-events" aria-label="各事件的当前处理方式">${policy.items.map((item) => `<li><span>${item.label}</span><strong>${labels[item.action]}</strong>${item.reason ? `<small>${item.reason}</small>` : ''}</li>`).join('')}</ul>`}<p>只有任务的开始、等你确认、完成这三类会出声，其他事件最多弹通知。选了静音的完全不提醒。${policy.hasToolOverrides ? '有针对个别工具的规则，以那些规则为准。' : ''}</p><p>能不能收到提醒还取决于工具有没有接入任务事件——只能看装没装的工具不会触发提醒。试听按钮不受这些开关影响，点了就放一次。</p></aside>`;
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
  return `<div class="voice-picker"><div class="control-stack"><div class="control-row"><select id="__ID__" class="control-select" data-setting="voice.voiceProfile" aria-describedby="native-voices-status"><option value="system-default" ${selected === 'system-default' ? 'selected' : ''}>自动（优先用普通话增强音色）</option>${voices.map((voice) => `<option value="${esc(voice.id)}" ${selected === voice.id ? 'selected' : ''}>${esc(nativeVoiceLabel(voice))}</option>`).join('')}</select><button id="refresh-native-voices" class="btn btn-ghost btn-small" type="button" data-action="refresh-voices" ${state.nativeVoicesLoading ? 'disabled aria-busy="true"' : ''}>${error ? '再试一次' : '刷新'}</button></div><div id="native-voices-status" class="control-note ${error || (state.nativeVoices && !voices.length) ? 'is-error' : ''}" role="status">${state.nativeVoicesLoading ? '正在检查系统里的中文音色…' : error ? `没读到音色：${esc(error)}。中文播报需要系统先装好中文音色。` : state.nativeVoices ? (voices.length ? `本机有 ${String(voices.length)} 个可用音色（末尾是英文音色）；更好听的增强音色要去系统设置里下载。` : '系统里没找到中文音色，暂时没法播中文。') : '打开设置后检查系统中文音色。'}</div>${legacy ? `<div class="control-note">原来选的音色「${esc(profile)}」现在不可用，已临时用自动模式（普通话增强音色）。<button class="text-link" type="button" data-action="use-safe-voice">改回自动</button></div>` : ''}</div></div>`;
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
      <div class="control-row"><input id="${nameId}" class="control-input control-grow" data-draft maxlength="32" aria-label="音色名称" value="${esc(currentName)}" placeholder="起个名字，如：清亮女声" /><button class="btn btn-primary" type="button" data-action="save-kokoro-voice">${currentName ? '保存名字' : '收藏'}</button>${currentName ? '<button class="text-link" type="button" data-action="remove-kokoro-voice">取消收藏</button>' : ''}</div>
      <div id="kokoro-voices-status" class="control-stack" role="status">${selected.profile !== profile ? `<p class="control-note is-error">原来选的「${esc(profile)}」不在本地音色里，现在用的是普通话女声 zf_001。</p>` : ''}<p class="control-note">103 个本地音色随便选（100 中文 + 3 英文）。${saved.length ? `收藏了 ${saved.length} 个，排在最上面。` : '试听后可以收藏常用的。'}</p><p class="control-note">「重构」「重写」这类开发词的读音已经修正过。本机模型只有普通话和英语；要粤语请换「系统自带」。</p></div>
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
  return `${settingRow('voice.cloudEnabled', '允许连云服务', '不开就完全不联网；开了并填了 Key，播报的文字会发给服务商。', toggle('voice.cloudEnabled', voice.cloudEnabled))}
    ${settingRow(
      'voice.cloudApiKey',
      'API Key',
      hasKey
        ? '已经保存好了，只存在这台电脑上。留空保存不会覆盖。'
        : '只存在这台电脑上，不会上传。',
      `<div class="control-row"><input id="__ID__" type="password" class="control-input control-grow" autocomplete="off" spellcheck="false" data-setting="voice.cloudApiKey" placeholder="${hasKey ? '已保存，留空表示不改' : '粘贴 MiMo API Key'}" /><button class="btn btn-ghost btn-small" type="button" data-action="clear-cloud-key"${hasKey ? '' : ' disabled'}>清除</button><a class="text-link" href="${CLOUD_KEY_URL}" target="_blank" rel="noreferrer noopener">去申请 Key ↗</a></div>`,
    )}
    ${settingRow(
      'voice.cloudEndpoint',
      '接口地址',
      '默认用小米官方接口。也可以填文档里的基础地址（…/v1），保存时会自动补全。',
      `<div class="control-row"><input id="__ID__" class="control-input control-fill" data-setting="voice.cloudEndpoint" value="${esc(endpoint)}" placeholder="${CLOUD_ENDPOINT_DEFAULT}" /><button class="btn btn-ghost btn-small" type="button" data-action="reset-cloud-endpoint"${customEndpoint ? '' : ' disabled'}>恢复默认</button></div>`,
    )}
    ${settingRow(
      'voice.cloudModel',
      '模型',
      '不填就用 mimo-v2.5-tts。',
      `<input id="__ID__" class="control-input" data-setting="voice.cloudModel" value="${esc(voice.cloudModel)}" placeholder="mimo-v2.5-tts" />`,
    )}
    ${settingRow(
      'voice.cloudVoice',
      '云音色',
      '默认自动选。中文有 冰糖 / 茉莉 / 苏打 / 白桦，英文有 Mia / Chloe / Milo / Dean。',
      `<select id="__ID__" class="control-select" data-setting="voice.cloudVoice">${cloudVoiceOptions}${customCloudVoice}</select>`,
    )}
    <div class="panel-note">云服务要联网，播报的文字会发给服务商。失败了会直接告诉你原因，不会偷偷换别的声音。MiMo 目前限免，以后收费了你再决定用不用。</div>`;
}

/** @description: 本地引擎由 localEngine 决定要展示哪套模型与音色配置。 */
function localModelKind(settings: Settings): ModelKind {
  return settings.voice.localEngine === 'zipvoice' ? 'zipvoice' : 'kokoro';
}

/** @description: 两套模型各自维护状态；缺省都按未下载呈现。 */
function localModelStatus(state: AppState, kind: ModelKind): ModelStatus | null {
  return kind === 'zipvoice' ? state.zipvoiceModelStatus : state.modelStatus;
}

const LOCAL_MODEL_META: Record<ModelKind, { name: string; size: string; manual: string }> = {
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
      `<div class="control-stack model-status" role="status"><p class="model-status-title">正在下载 ${meta.name} 模型 · ${String(percent)}%${esc(size)}</p><div class="control-row"><progress class="model-progress" value="${String(percent)}" max="100"></progress><button class="btn btn-ghost btn-small" type="button" data-action="cancel-model" data-model-kind="${kind}">取消</button></div></div>`,
    );
  }
  if (modelState === 'extracting')
    return fieldRow(
      null,
      '模型',
      '下载后保存在本机；仅点击时出网。',
      `<div class="control-stack model-status" role="status"><p class="model-status-title">${meta.name} 下好了，正在解压检查…</p></div>`,
    );
  const error = modelState === 'error' ? status?.error : undefined;
  return fieldRow(
    null,
    '模型',
    '下载后保存在本机；仅点击时出网。',
    `<div class="control-stack model-status${error ? ' is-error' : ''}" role="status"><p class="model-status-title">${error ? `上次没下载成功：${esc(error)}。` : modelState === 'error' ? '上次没下载成功。' : `还没下载 ${meta.name} 模型。`}</p><p class="control-note">${meta.size}，从 github.com 下载，断了可以接着下。只有你点下载时才联网，文件存在这台电脑上。${meta.manual}</p><button class="btn btn-primary btn-small" type="button" data-action="download-model" data-model-kind="${kind}">${error ? '再试一次' : '下载模型'}</button></div>`,
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
    '录 5–15 秒安静的人声（WAV 格式）。选好后会复制一份存进 AgentCue。',
    `<div class="control-row"><input id="__ID__" class="control-input control-fill" readonly value="${esc(file)}" placeholder="还没选录音文件" /><button class="btn btn-ghost btn-small" type="button" data-action="pick-zipvoice-reference">选一个 WAV</button>${path ? '<button class="text-link" type="button" data-action="clear-zipvoice-reference">移除</button>' : ''}</div>`,
  )}${fieldRow(
    'zipvoice-reference-text',
    '录音里说了什么',
    '录音里每个字都要写上。',
    `<input id="__ID__" class="control-input control-fill" data-setting="voice.zipvoiceReferenceText" maxlength="500" value="${esc(settings.voice.zipvoiceReferenceText)}" placeholder="照着录音一个字一个字填" />`,
  )}${fieldNote(
    `<p class="control-note" role="status">${ready ? '录音和原文都配好了。换了录音或改了原文，建议再试听一次。' : '要一段 5–15 秒的安静录音，再把录音里的话一字不差地填上——对不上的话，声音会不像。选好的文件会复制一份存起来，原文件随便你移动。'}</p>`,
  )}</div>`;
}

/** @description: 本地后端区：引擎选择、对应模型状态、音色来源（预置或参考录音）。 */
function renderLocalSettings(state: AppState, settings: Settings, voiceProfile: string): string {
  const kind = localModelKind(settings);
  const status = localModelStatus(state, kind);
  const engineRow = settingRow(
    'voice.localEngine',
    '用哪个本机模型',
    kind === 'zipvoice'
      ? '用你自己的录音当声音，模型和录音都要先准备好。'
      : '自带 100 个中文音色，模型下好后完全离线。',
    `<div class="control-row"><select id="__ID__" class="control-select" data-setting="voice.localEngine"><option value="kokoro" ${kind === 'kokoro' ? 'selected' : ''}>Kokoro · 现成音色</option><option value="zipvoice" ${kind === 'zipvoice' ? 'selected' : ''}>ZipVoice · 用我的录音</option></select>${(status?.state ?? 'missing') === 'ready' ? '<span class="control-note is-ok">模型已就绪</span>' : ''}</div>`,
  );
  const picker =
    kind === 'zipvoice'
      ? renderZipvoiceReference(settings)
      : settingRow(
          'voice.voiceProfile',
          '音色',
          '100 个中文音色和 3 个英文音色，可以收藏常用的。',
          renderKokoroVoicePicker(state, voiceProfile, settings),
        );
  const note = fieldNote(
    `<p class="control-note">${
      kind === 'zipvoice'
        ? `${(status?.state ?? 'missing') === 'ready' ? '约 162MB，只在本机使用；录音也只存在这台电脑上。' : ''}试听就是走本机 ZipVoice，坏了会直接说哪里坏，不会偷偷换系统声音。`
        : `${(status?.state ?? 'missing') === 'ready' ? '约 348MB，只在本机使用；第一次试听时会顺手检查运行时。' : ''}试听就是走本机 Kokoro，坏了会直接说哪里坏，不会偷偷换系统声音。`
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
  const volumePercent = Math.round(settings.voice.volume * 100);
  const volume = `<div class="control-row"><input id="__ID__" type="range" min="0" max="1" step="0.05" data-setting="voice.volume" value="${settings.voice.volume}" aria-label="播报音量" aria-valuetext="${volumePercent}%"/><output id="volume-value" for="__ID__">${volumePercent}%</output></div>`;
  const audition = `<div class="control-stack"><div class="control-row"><input id="speak-text" class="control-input control-grow" data-draft aria-label="试听文本" value="重构登录模块，等你拍板" /><button class="btn btn-primary" type="button" data-action="speak-test">试听</button></div><div id="speak-result" class="action-result ${state.speakResult?.ok === false ? 'is-error' : ''}" role="status">${state.speakResult ? esc(state.speakResult.ok ? `播放完成 · ${backendLabel(state.speakResult.usedBackend, localEngine)}` : `播放失败：${state.speakResult.errors.join('；')}`) : ''}</div></div>`;
  // 当前播报状态只在「播报规则」里展示一次：那里才需要对照规则看结果。
  // 兼容旧版 all：自动播报始终只允许开始、待确认、完成三类事件。
  const scope = settings.voice.scope === 'all' ? 'milestones' : settings.voice.scope;
  const content = settings.voice.content;
  const voice = `${sectionError(state, 'settings')}${settingRow('voice.enabled', '自动语音播报', '关了以后只弹通知，不出声。', toggle('voice.enabled', settings.voice.enabled))}
    ${settingRow('voice.scope', '播报哪些事件', '只读任务的关键节点，其他事件走通知。', `<select id="__ID__" class="control-select" data-setting="voice.scope"><option value="attention" ${scope === 'attention' ? 'selected' : ''}>只播等你确认的</option><option value="milestones" ${scope === 'milestones' ? 'selected' : ''}>开始、确认、完成都播</option></select>`)}
    ${settingRow('voice.content', '播报内容', content === 'title' ? '读任务标题的精简版，跳过代码和链接。' : '读完整任务标题。', `<select id="__ID__" class="control-select" data-setting="voice.content"><option value="title" ${content === 'title' ? 'selected' : ''}>标题（精简）</option><option value="prompt" ${content === 'prompt' ? 'selected' : ''}>标题原文</option></select>`)}
    ${settingRow('voice.backend', '用什么声音', backend === 'local' ? '在本机合成，不用联网，但要先下载模型。' : backend === 'cloud' ? '用小米 MiMo 的云服务，需要填 API Key，播报内容会发出去。' : '用系统自带的声音。', `<select id="__ID__" class="control-select" data-setting="voice.backend"><option value="native" ${backend === 'native' ? 'selected' : ''}>系统自带</option><option value="local" ${backend === 'local' ? 'selected' : ''}>本机模型（Kokoro / ZipVoice）</option><option value="cloud" ${backend === 'cloud' ? 'selected' : ''}>云服务 · 小米 MiMo</option><option value="piper" disabled ${backend === 'piper' ? 'selected' : ''}>Piper · 旧配置</option></select>`)}
    ${backend === 'piper' ? '<div class="inline-error">这个后端已不可用，请换回「系统自带」「本机模型」或「云服务」。</div>' : ''}
    ${backend === 'local' ? renderLocalSettings(state, settings, voiceProfile) : ''}
    ${backend === 'cloud' ? renderCloudSettings(settings) : ''}
    ${backend === 'native' ? settingRow('voice.voiceProfile', '音色', '用系统的中文音色；更好听的增强音色要在系统设置里下载。', renderNativeVoicePicker(state, voiceProfile)) : ''}
    ${settingRow('voice.rate', '语速', backend === 'cloud' ? '云服务自己定语速；这一项只管本机和系统的声音。' : '1.0× 是正常速度。', rate)}
    ${settingRow('voice.volume', '音量', '试听和自动播报都用这个音量。0% 等于静音。保存后生效。', volume)}
    ${fieldRow('speak-text', '试听', '点一下放一次，用的是上次保存的设置。改了设置要先保存再试听。', audition)}`;
  const quietRanges = `<div class="control-stack quiet-ranges" role="group" aria-labelledby="quiet-ranges-label">${settings.quiet.ranges.map((range, index) => `<div class="control-row range-row"><label class="sr-only" for="quiet-from-${index}">时段 ${index + 1} 开始</label><input id="quiet-from-${index}" type="time" data-setting="quiet.ranges.${index}.from" value="${esc(range.from)}" /><span class="muted">至</span><label class="sr-only" for="quiet-to-${index}">时段 ${index + 1} 结束</label><input id="quiet-to-${index}" type="time" data-setting="quiet.ranges.${index}.to" value="${esc(range.to)}" /><button class="icon-btn" type="button" data-remove-range="${index}" aria-label="删除时段 ${index + 1}">×</button></div>`).join('')}<button class="btn btn-ghost btn-small" type="button" data-action="add-range">＋ 添加时段</button></div>`;
  const quiet = `${settingRow('quiet.globalMute', '全部静音', '打开后所有提醒都只弹通知，不出声。', toggle('quiet.globalMute', settings.quiet.globalMute))}${fieldGroup('quiet-ranges-label', '免打扰时段', '这些时间段内不打扰你，可以跨天。', quietRanges)}${settingRow('quiet.waitingHumanOverride', '等你确认的任务例外', '免打扰时段里，等你确认的任务还是会有声音。全部静音不受影响。', toggle('quiet.waitingHumanOverride', settings.quiet.waitingHumanOverride))}`;
  const privacy = `${settingRow('scan.autoIntervalHours', '多久重新扫描一次', '单位：小时。任务状态不受影响，仍然实时更新。', `<input id="__ID__" class="control-input control-input--short" type="number" min="1" max="24" data-setting="scan.autoIntervalHours" value="${settings.scan.autoIntervalHours}" />`)}${settingRow('privacy.sessionFileRead', '读取本机任务记录', '关掉以后 AgentCue 不再读取任务数据，已保存的历史也会藏起来。', toggle('privacy.sessionFileRead', settings.privacy.sessionFileRead))}${settingRow('privacy.auditLog', '记录操作日志', '日志只记操作本身，不含对话内容和密码。', toggle('privacy.auditLog', settings.privacy.auditLog))}<div class="panel-note">所有数据都只存在这台电脑上，不会上传。扫描只读各工具自己的配置目录。</div><div class="settings-actions"><button class="btn btn-ghost btn-small" type="button" data-action="export-events">导出事件记录</button><span class="muted">最多 500 条，只有时间和原因，没有对话内容。</span></div>`;
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
    .join(
      '',
    )}<span class="settings-save-group"><span id="settings-save-status" class="muted" role="status"></span><button id="settings-save" class="btn btn-primary btn-small" type="button" data-action="save-settings" disabled>保存</button></span></div></nav>
    ${settingsSection('voice', '语音播报', '任务有关键进展时，用声音告诉你。', voice)}
    ${settingsSection('quiet', '免打扰', '指定时间段里不发声，只记通知。', quiet)}
    ${settingsSection('rules', '播报规则', '每种事件选择：出声、只通知，还是完全静音。', sectionError(state, 'rules') + renderVoicePolicy(state, new Date(), settings, rules) + renderRuleMatrix(rules))}
    ${settingsSection('privacy', '扫描与隐私', '决定 AgentCue 能读哪些本机数据。', privacy)}
    ${settingsSection('external', '外部 MCP 工具', '添加其他 MCP 工具，验证能不能连上。', sectionError(state, 'servers') + renderExternalMcp(state))}`;
}

/** @description: Group both connection methods by tool, preserving provider order and partial data. */
function renderIntegrations(state: AppState): string {
  const tools = new Map<string, { name: string; hook?: HookIntegration; mcp?: McpSnippet }>();
  for (const hook of state.hookIntegrations) tools.set(hook.id, { name: hook.name, hook });
  for (const mcp of state.mcpSnippets) {
    const tool = tools.get(mcp.id) ?? { name: mcp.name };
    tools.set(mcp.id, { ...tool, mcp });
  }
  const intro = `<section class="panel integration-intro" data-region="integrations-intro"><div class="section-head"><h2>按工具接入</h2><button class="btn btn-ghost btn-small" type="button" data-action="refresh-hooks">刷新状态</button></div>${sectionError(state, 'hooks')}${sectionError(state, 'snippets')}<p>展开你要接入的工具，把配置复制过去就能收到任务事件。装了工具不等于已接入——要复制了配置才算。</p><p class="muted">如果你之前改过这些配置文件，把新内容合并进去，别整份覆盖。收到过事件不代表工具一直在运行；之后出不出声，还看语音开关、免打扰和规则设置。</p></section>`;
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
  return `<p class="hook-event-time">${esc(hookEventTime(integration.lastEventAt))}</p><p class="muted">${esc(integration.capabilityReason)}</p>${!integration.enabled ? '<p class="panel-note">现在暂停接收。请打开「读取本机任务记录」，并确认这个工具没被忽略。</p>' : ''}${!integration.commandReady ? '<div class="inline-error">接收入口还没就绪，这份配置暂时跑不起来。请确认应用是最新安装后刷新。</div>' : ''}<ol class="setup-steps">${integration.steps.map((step) => `<li>${esc(step)}</li>`).join('')}</ol><div class="hook-files">${integration.files.map((file, index) => `<div class="hook-file"><div class="hook-file-head"><code>${esc(file.path)}</code><button id="copy-hook-${esc(integration.id)}-${index}" class="btn btn-ghost btn-small" type="button" data-copy-hook="${esc(integration.id)}" data-hook-path="${esc(file.path)}" data-copy-unavailable="${!integration.commandReady}" aria-label="复制 ${esc(integration.name)} 配置 ${index + 1}" ${integration.commandReady ? '' : 'disabled'}>复制内容</button></div>${file.executable ? '<p class="hook-file-note">保存后执行 chmod u+x 给脚本加执行权限。已有同名脚本的话，把调用合并进去。</p>' : ''}<details data-disclosure-key="hook-file-${esc(integration.id)}-${esc(file.path)}"><summary>查看配置内容</summary><pre class="code-block">${esc(file.content)}</pre></details></div>`).join('')}</div>`;
}

/** @description: One action selector per known event. */
function renderRuleMatrix(rules: VoiceRule[]): string {
  return ['task.waiting_human', 'task.failed', 'task.timeout', 'task.completed', 'task.started']
    .map((event) => {
      const configured = genericVoiceAction(rules, event);
      const restricted = !voiceEventCanSpeak(event) && configured === 'speak';
      const action = restricted ? 'notify' : configured;
      return fieldRow(
        `rule-${event}`,
        esc(eventLabel(event)),
        restricted ? '这类事件现在只能弹通知' : '',
        `<select id="__ID__" class="control-select control-select--compact" data-rule-event="${event}">${[
          ['mute', '不提醒'],
          ['notify', '弹通知'],
          ...(voiceEventCanSpeak(event) ? [['speak', '出声']] : []),
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
    '复制下面的配置。',
    '打开客户端的 MCP 设置，粘贴并保存，然后重载客户端。',
    '点下面的按钮验证连接。',
  ];
  return `<p class="control-note">${esc(snippet.hint)}</p>${snippet.commandReady === false ? '<div class="inline-error">本机的连接入口还没就绪，粘贴配置后先验证一下。</div>' : ''}<ol class="setup-steps">${steps.map((step) => `<li>${esc(step)}</li>`).join('')}</ol><div class="hook-file"><div class="hook-file-head"><span class="muted">${snippet.format === 'toml' ? 'TOML' : 'JSON'} 配置</span><button class="btn btn-ghost btn-small" type="button" data-action="copy-mcp" data-mcp-id="${esc(snippet.id)}" aria-label="复制 ${esc(snippet.name)} MCP 配置">复制配置</button></div><pre class="code-block">${esc(snippet.json)}</pre></div><div class="settings-actions"><button class="btn btn-primary btn-small" type="button" data-action="validate-mcp">验证连接</button><span class="muted">只检查 AgentCue 这边通不通，不代表客户端一定连上了。</span></div><div class="action-result ${validation && !validation.ok ? 'is-error' : ''}" role="status">${validation ? esc(validation.ok ? `连接正常，发现 ${validation.tools.length} 个工具 · ${fmtTime(validation.lastValidatedAt)}` : `连接失败：${validation.lastError ?? '握手没有成功'}`) : ''}</div>`;
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
    '连接方式',
    '',
    `<select id="__ID__" class="control-select" data-draft><option value="stdio" ${state.externalTransport === 'stdio' ? 'selected' : ''}>本地程序（stdio）</option><option value="streamable-http" ${state.externalTransport === 'streamable-http' ? 'selected' : ''}>网页地址（HTTP）</option></select>`,
  )}${
    state.externalTransport === 'stdio'
      ? `${fieldRow(
          'mcp-command',
          '启动命令',
          '',
          `<input id="__ID__" class="control-input control-fill" data-draft placeholder="例如 npx，或程序的完整路径" />`,
        )}${fieldRow(
          'mcp-args',
          '参数',
          '填 JSON 数组，或者一行一个。',
          `<textarea id="__ID__" class="control-input control-fill" data-draft rows="2" placeholder='["-y", "@org/server"]'></textarea>`,
        )}`
      : fieldRow(
          'mcp-url',
          '服务地址',
          '',
          `<input id="__ID__" class="control-input control-fill" data-draft type="url" placeholder="http://127.0.0.1:3000/mcp" />`,
        )
  }<div class="settings-actions"><button class="btn btn-primary" type="button" data-action="add-mcp">保存并验证</button></div>`;
  return `${form}<div class="server-list">${state.mcpServers.length ? state.mcpServers.map((server) => `<article class="server-row"><div><strong>${esc(server.name)}</strong><span class="badge" data-state="${server.validationStatus === 'verified' ? 'completed' : server.validationStatus === 'error' ? 'failed' : 'unknown'}">${server.validationStatus === 'verified' ? '上次验证通过' : server.validationStatus === 'error' ? '验证失败' : '还没验证过'}</span><p class="muted">${esc(server.transport)} · ${esc(server.command ?? server.url ?? '')}</p><p class="muted">${server.lastValidatedAt ? `上次验证 ${esc(fmtTime(server.lastValidatedAt))}` : '还没验证过'} · 平时不会一直连着</p>${server.lastError ? `<p class="server-error">${esc(server.lastError)}</p>` : ''}</div><div class="control-actions"><button class="btn btn-ghost btn-small" type="button" data-validate-server="${esc(server.serverId)}">重新验证</button><button class="btn btn-ghost btn-small" type="button" data-delete-mcp="${esc(server.serverId)}">移除</button></div></article>`).join('') : '<div class="empty">还没添加外部工具。验证只看它有哪些工具，不会去执行。</div>'}</div>`;
}

/** 通知级别中文名。@param level attention / info */
function noticeLevelLabel(level: string): string {
  return level === 'attention' ? '要处理' : '普通';
}

function renderNotifications(state: AppState): string {
  const filter = state.noticeLevelFilter;
  const shown = filter
    ? state.notifications.filter((n) => n.level === filter)
    : state.notifications;
  const unread = state.notifications.filter((n) => !n.read).length;
  const chips: Array<['' | 'attention' | 'info', string]> = [
    ['', '全部'],
    ['attention', '要处理'],
    ['info', '普通'],
  ];
  // 头部操作区：级别筛选与「全部已读」（复用主进程已有的批量已读端点）。
  return `<section class="panel" data-region="notifications"><div class="section-head"><div><h2>最近通知${unread ? `<span class="count-pill">${unread} 未读</span>` : ''}</h2><p class="muted">收到的所有提醒。</p></div><div class="section-head-actions"><select id="notice-level-filter" aria-label="按级别筛选">${chips.map(([v, l]) => `<option value="${v}" ${filter === v ? 'selected' : ''}>${l}</option>`).join('')}</select>${unread ? `<button class="btn btn-ghost btn-small" type="button" data-action="mark-all-read">全部标为已读</button>` : ''}</div></div>${sectionError(state, 'notifications')}${shown.length ? shown.map((item) => `<article class="notice${item.read ? ' is-read' : ''}" data-notice-level="${esc(item.level)}"><span class="notice-dot" aria-hidden="true"></span><div><div class="notice-meta"><span>${esc(fmtRelative(item.ts))}</span><span>${item.read ? '已读' : '未读'}</span><span class="badge" data-level="${esc(item.level)}">${esc(noticeLevelLabel(item.level))}</span></div><h3>${esc(item.title)}</h3><p>${esc(item.body)}</p>${item.sessionId ? `<button class="text-link" type="button" data-session="${esc(item.sessionId)}">查看任务</button>` : ''}</div>${item.read ? '' : `<button class="btn btn-ghost btn-small" type="button" data-read-notice="${esc(item.notificationId)}">标为已读</button>`}</article>`).join('') : `<div class="empty">${filter ? '这个类别下没有通知。' : '还没有通知。任务需要你时会出现在这里。'}</div>`}${state.noticeHasMore ? `<button class="btn btn-more" type="button" data-action="load-notices">加载更早的通知（已显示 ${state.notifications.length} 条）</button>` : ''}</section>`;
}

/** @description: The drawer uses descriptive recording actions and an append-only timeline. */
function renderTimeline(records: TransitionRecord[], session: SessionSummary | null): string {
  const actions = session ? taskActions(session.sessionId, session.currentState) : '';
  return `<div class="drawer-actions">${actions}<button class="btn btn-ghost btn-small" type="button" data-action="copy-timeline" data-copy-session="${esc(session?.sessionId ?? '')}">复制时间线</button></div>${actions ? '<p class="panel-note">这些按钮只改 AgentCue 的记录。任务本身要去原工具里操作。</p>' : ''}${
    records.length
      ? `<div class="timeline">${records
          .slice()
          .reverse()
          .map(
            (record) =>
              `<div class="timeline-item" data-tone="${stateTone(record.nextState ?? 'idle')}"><div class="timeline-time">${esc(fmtTime(record.ts))} · ${esc(record.actor)}</div><div class="timeline-text">${esc(eventLabel(record.eventType))}<span class="timeline-arrow">${esc(record.prevState ? stateLabel(record.prevState) : '开始')} → ${esc(record.nextState ? stateLabel(record.nextState) : '记录')}</span></div>${record.reason ? `<div class="muted">${esc(record.reason)}</div>` : ''}</div>`,
          )
          .join('')}</div>`
      : '<div class="empty">还没有任何记录。</div>'
  }`;
}
