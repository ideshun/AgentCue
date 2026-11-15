/** Native views. Dynamic text is escaped before it reaches HTML. */
type RouteName =
  'overview' | 'office' | 'board' | 'integrations' | 'adapters' | 'settings' | 'notifications';
interface AppState {
  setupDismissed?: boolean;
  setupToolId?: string;
  desktopPreferences?: DesktopPreferences;
  dataInfo?: DataInfo;
  playback?: PlaybackStatus;
  updateInfo?: UpdateInfo;
  diagnosticReport?: unknown;
  pronunciation?: Record<string, string>;
  integrationVerification?: { toolId: string; since: string; seen?: Record<string, string> };
  route: RouteName;
  overview: OverviewSummary | null;
  office: OfficeSnapshot | null;
  sessions: SessionSummary[];
  board: BoardResponse | null;
  boardQuery: BoardFilters;
  kokoroVoiceSearch: string;
  adapters: AdapterManifest[];
  tools: ToolSummary[];
  toolsLoading: boolean;
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
  if (title) {
    // Codex 有时把权限确认 JSON 当任务标题；在列表里表达用户关心的状态，不铺原始载荷。
    if (title.startsWith('{') && title.length <= 4096) {
      try {
        const value: unknown = JSON.parse(title);
        if (value && typeof value === 'object' && !Array.isArray(value)) {
          const data = value as Record<string, unknown>;
          const summary = ['title', 'summary', 'task_title', 'taskName'].find(
            (key) => typeof data[key] === 'string' && data[key].trim(),
          );
          if (summary) return (data[summary] as string).trim();
          if ('user_authorization' in data) {
            const risk =
              data.risk_level === 'low'
                ? '低风险'
                : data.risk_level === 'mid' || data.risk_level === 'medium'
                  ? '中风险'
                  : data.risk_level === 'high'
                    ? '高风险'
                    : '';
            return `用户授权确认${risk ? ` · ${risk}` : ''}`;
          }
        }
      } catch {
        // 普通标题或非标题 JSON 保留原文，避免误删用户提供的信息。
      }
    }
    return title;
  }
  let hash = 2166136261;
  for (let index = 0; index < task.sessionId.length; index++)
    hash = Math.imul(hash ^ task.sessionId.charCodeAt(index), 16777619);
  const number = (hash >>> 0).toString(16).padStart(8, '0').toUpperCase();
  const toolId = task.toolId || (task.sessionId.includes(':') ? task.sessionId.split(':')[0] : '');
  const toolName =
    tools.find((tool) => tool.toolId === toolId)?.name.trim() || toolId || '未知工具';
  return `${toolName} · 任务 ${number}`;
}

/** @description: A task row names its originating tool and makes record-only actions explicit. */
function sessionRow(
  session: SessionSummary,
  withRelative = true,
  tools: ToolSummary[] = [],
  withActions = false,
): string {
  const quickEvent =
    session.currentState === 'waiting_human'
      ? 'human.responded'
      : session.currentState === 'failed' || session.currentState === 'timeout'
        ? 'task.retried'
        : null;
  const actions =
    withActions && quickEvent
      ? `<div class="session-actions"><button class="btn btn-small btn-ghost" type="button" data-task-event="${quickEvent}" data-task-id="${esc(session.sessionId)}">${quickEvent === 'human.responded' ? '标记已响应' : '标记已重试'}</button></div>`
      : '';
  return `<div class="session"><button class="session-main" type="button" data-session="${esc(session.sessionId)}"><span class="session-title">${esc(displayTaskTitle(session, tools))}</span>
      <span class="session-meta"><span>${esc(toolDisplayName(session.toolId, tools))}</span><span>${esc(withRelative ? fmtRelative(session.updatedAt) : fmtTime(session.updatedAt))}</span></span></button>
    <span class="badge" data-state="${esc(session.currentState)}">${esc(stateLabel(session.currentState))}</span>${actions}</div>`;
}

/** @description: Capability labels describe what the source can actually prove. */
function capabilityLabel(capability?: string): string {
  return capability === 'events'
    ? '已识别任务状态'
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
  return `<p class="hook-tool-status">${paused ? '现在暂停接收任务事件。' : ''}${esc(hookEventTime(tool.hookLastEventAt))}。<a class="text-link" href="#/settings">去设置里接入 ↗</a></p>`;
}

const TOOL_ICONS: Record<string, string> = {
  'claude-code': 'assets/office/icons/claude-code-orange.svg',
  codex: 'assets/office/icons/codex.png',
  cursor: 'assets/office/icons/cursor.svg',
  cline: 'assets/office/icons/cline.svg',
  codebuddy: 'assets/office/icons/codebuddy.svg',
};

/** Prefer bundled brand marks so the compact list does not depend on native icon URLs. */
function toolMark(source: { icon?: string | null; toolId?: string }): string {
  const icon = (source.toolId ? TOOL_ICONS[source.toolId] : undefined) || source.icon;
  return icon ? `<img class="tool-icon" src="${esc(icon)}" alt="" aria-hidden="true" />` : '';
}

/** @description: Prefer the human-facing tool name over its stable adapter id. */
function toolDisplayName(toolId: string, tools: ToolSummary[] = []): string {
  return tools.find((tool) => tool.toolId === toolId)?.name || toolId || '未知工具';
}

/** @description: Only claim event delivery after an event has actually arrived. */
function toolCoverage(tool: ToolSummary, settings: Settings | null) {
  if (tool.ignored) {
    return { kind: 'paused', label: '已忽略', detail: '此工具暂停读取', route: '#/adapters' };
  }
  if (settings?.privacy.sessionFileRead === false) {
    return {
      kind: 'paused',
      label: '读取已暂停',
      detail: '本机任务读取已关闭',
      route: '#/settings',
    };
  }
  if (tool.hookSupported) {
    const received = !!tool.hookLastEventAt && Number.isFinite(Date.parse(tool.hookLastEventAt));
    return received
      ? {
          kind: 'received',
          label: '已收到任务事件',
          detail: `最近 ${fmtRelative(tool.hookLastEventAt!)}`,
          route: '#/integrations',
        }
      : {
          kind: 'waiting',
          label: '等待首次事件',
          detail: '点击“接入”，开始配置',
          route: '#/integrations',
        };
  }
  if (tool.sessionCapability === 'events') {
    return tool.sessionCount > 0
      ? {
          kind: 'reading',
          label: '读取到任务状态',
          detail: `${tool.sessionCount} 个活跃任务`,
          route: '#/adapters',
        }
      : {
          kind: 'available',
          label: '支持本机任务读取',
          detail: '目前没有活跃任务',
          route: '#/adapters',
        };
  }
  if (tool.sessionCapability === 'metadata') {
    return {
      kind: 'history',
      label: '仅显示历史',
      detail: '历史记录不参与实时提醒',
      route: '#/adapters',
    };
  }
  return {
    kind: 'detect-only',
    label: '仅识别安装',
    detail: '暂时不能提供任务事件',
    route: '#/integrations',
  };
}

/** A source is connected once it has delivered a real task event, even if no task is active now. */
function hasObservedTaskEvent(tool: ToolSummary): boolean {
  const lifecycleEvents = new Set(['task.started', 'task.waiting_human', 'task.completed']);
  const hasHookEvent = !!tool.hookLastEventAt && Number.isFinite(Date.parse(tool.hookLastEventAt));
  const hasLifecycleEvent = (tool.milestones ?? []).some(
    (event) => lifecycleEvents.has(event.eventType) && Number.isFinite(Date.parse(event.ts)),
  );
  return hasHookEvent || hasLifecycleEvent || tool.sessionCount > 0;
}

/** @description: Compact tool coverage summary shared by the overview. */
function toolRow(tool: ToolSummary, settings: Settings | null): string {
  const coverage = toolCoverage(tool, settings);
  const icon = toolMark(tool);
  const iconSlot = icon || '<span class="tool-icon-slot" aria-hidden="true"></span>';
  const hasReceivedEvents = coverage.kind === 'received' || coverage.kind === 'reading';
  const needsIntegration = coverage.kind === 'waiting' || coverage.kind === 'detect-only';
  const href = hasReceivedEvents ? '#/board' : coverage.route;
  const action = needsIntegration ? '接入' : '查看';
  return `<div class="tool-row tool-row--icon" data-source-state="${coverage.kind}">${iconSlot}
    <div class="tool-info"><strong>${esc(tool.name)}</strong>${tool.host ? `<span>${esc(`${tool.host} 扩展`)}</span>` : !tool.version ? `<span>${esc(capabilityLabel(tool.sessionCapability))}</span>` : ''}${tool.version ? `<span class="tool-version">v${esc(tool.version)}</span>` : ''}</div>
    <div class="tool-coverage"><span class="source-badge" data-state="${coverage.kind}">${esc(coverage.label)}</span><span class="muted">${esc(coverage.detail)}</span></div>
    <a class="tool-open-link" href="${href}">${action}</a></div>`;
}

/** @description: A resumable inline introduction never claims a connection passed without evidence. */
function renderOnboarding(state: AppState): string {
  if (!window.awm?.desktopFeature || state.setupDismissed) return '';
  const tools = state.tools.filter(
    (t) =>
      !t.ignored &&
      ['installed', 'running'].includes(t.detectStatus) &&
      (t.hookSupported || t.sessionCapability === 'events'),
  );
  const needsSetup = tools.filter((tool) => !hasObservedTaskEvent(tool));
  if (!needsSetup.length) return '';
  return `<section class="panel onboarding" data-region="onboarding"><div class="section-head"><div><h2>接入一个工具</h2><p class="muted">选择需要接入任务事件的工具，配置完成后开启一个新任务试试。</p></div><button class="text-link" type="button" data-feature="skip-setup">稍后设置</button></div><ol class="onboarding-steps"><li>选择工具</li><li>配置事件来源</li><li>新建任务验证</li><li>确认播报和通知</li></ol><div class="control-row"><label class="sr-only" for="setup-tool">选择要接入的工具</label><select id="setup-tool" class="control-select" data-draft>${needsSetup.map((tool) => `<option value="${esc(tool.toolId)}">${esc(tool.name)}</option>`).join('')}</select><button type="button" class="btn btn-primary btn-small" data-feature="begin-setup">开始接入</button><a class="text-link" href="#/integrations">查看接入说明</a></div></section>`;
}

/** @description: Overview puts actionable tasks first and distinguishes an empty queue from an unconnected source. */
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
    (tool) => tool.detectStatus === 'installed' || tool.detectStatus === 'running',
  );
  const scan = summary?.lastScan;
  const pending = state.boardLoading && !state.board;
  const value = (count: number | undefined): string =>
    pending && count === undefined ? '…' : String(count ?? '—');
  const waiting = summary?.counts.waiting_human;
  const receivedHooks = installed.filter(
    (tool) =>
      tool.hookSupported &&
      tool.hookLastEventAt &&
      Number.isFinite(Date.parse(tool.hookLastEventAt)),
  ).length;
  const waitingHooks = installed.filter(
    (tool) => tool.hookSupported && !tool.hookLastEventAt && !tool.ignored,
  ).length;
  const eventCapable = installed.filter(
    (tool) => tool.hookSupported || tool.sessionCapability === 'events',
  ).length;
  const sourceStatus =
    state.settings?.privacy.sessionFileRead === false
      ? '本机任务读取已关闭'
      : receivedHooks
        ? `${receivedHooks} 个工具收到过任务事件`
        : waitingHooks
          ? `${waitingHooks} 个工具等待首次任务事件`
          : eventCapable
            ? `${eventCapable} 个工具支持读取任务状态`
            : '尚无可确认的任务事件来源';
  let emptyTitle = '目前没有待处理任务';
  let emptyCopy = '任务状态会按来源显示在右侧；“支持读取”不代表一直在线。';
  let emptyLink = '';
  if (pending) {
    emptyTitle = '正在同步任务状态';
    emptyCopy = '任务列表加载完成后会显示需要你处理的内容。';
  } else if (state.sectionErrors.board) {
    emptyTitle = '任务列表暂时没更新';
    emptyCopy = '保留上次数据；检查连接后可以重试。';
  } else if (state.sectionErrors.tools) {
    emptyTitle = '工具状态暂时不可用';
    emptyCopy = '当前无法判断有哪些任务来源；检查连接后重新扫描。';
  } else if (state.settings?.privacy.sessionFileRead === false) {
    emptyTitle = '本机任务读取已暂停';
    emptyCopy = '打开读取开关后，AgentCue 才会汇总任务记录和接收 Hooks 事件。';
    emptyLink = '<a class="btn btn-ghost btn-small" href="#/settings">查看隐私设置</a>';
  } else if (!installed.length) {
    emptyTitle = '还没发现本机 AI 工具';
    emptyCopy = '扫描工具后会显示安装情况和可用的任务来源。';
  } else if (!eventCapable) {
    emptyTitle = '还没有可用的任务事件来源';
    emptyCopy = '有些工具只能识别安装情况，不能触发任务提醒。';
    emptyLink = '<a class="btn btn-ghost btn-small" href="#/integrations">查看接入方式</a>';
  } else if (!receivedHooks && waitingHooks && installed.every((tool) => !tool.sessionCount)) {
    emptyTitle = '正在等第一个任务事件';
    emptyCopy = '在播报接入中配置 Hooks，再运行一个新任务；收到事件后这里会明确显示。';
    emptyLink = '<a class="btn btn-ghost btn-small" href="#/integrations">配置 Hooks</a>';
  }
  const attentionContent = attention.length
    ? `<p class="task-action-note">只会修改 AgentCue 的记录，不会影响原工具。收到新事件后，记录不能撤回。</p><div class="session-list">${attention.map((item) => sessionRow(item, true, state.tools, true)).join('')}</div>`
    : `<div class="overview-empty"><strong>${emptyTitle}</strong><p>${state.sectionErrors.board ? '任务列表加载失败，请重试。' : emptyCopy}</p>${emptyLink}</div>`;
  const runningGroup =
    running?.items.filter(
      (item): item is BoardItem & { currentState: TaskState } => item.currentState !== null,
    ) ?? [];
  const metrics: Array<[string, string, string]> = [
    ['等你处理', value(waiting), 'waiting_human'],
    ['进行中', value(summary?.counts.running), 'running'],
    ['已完成', value(summary?.counts.completed), 'completed'],
  ];
  return `${renderOnboarding(state)}<section class="overview-summary" data-region="overview-stats"><div class="overview-summary-copy"><h2>${(waiting ?? 0) > 0 ? `有 ${value(waiting)} 个任务需要你介入` : '任务状态'}</h2><p>${esc(sourceStatus)}</p></div><div class="overview-metrics">${metrics.map(([label, count, stateName]) => `<div class="overview-metric"><span class="overview-metric-value" data-state="${stateName}">${count}</span><span>${label}</span></div>`).join('')}</div></section>
    <section class="panel overview-priority" data-region="overview-attention"><div class="section-head"><div><h2>需要处理</h2><p class="muted">需要确认、失败或超时的任务。</p></div><a class="text-link" href="#/board">查看全部任务 ↗</a></div>${sectionError(state, 'board')}${attentionContent}</section>
    <div class="overview-grid"><section class="panel overview-running" data-region="overview-running"><div class="section-head"><div><h2>进行中</h2><p class="muted">正在运行的任务，实时更新。</p></div><span class="count-pill">${running?.total ?? (pending ? '…' : '—')}</span></div>${runningGroup.length ? `<div class="session-list">${runningGroup.map((item) => sessionRow(item, true, state.tools)).join('')}</div>` : `<div class="overview-empty overview-empty--compact"><strong>${pending ? '正在同步' : '目前没有进行中的任务'}</strong><p>${pending ? '正在读取当前状态。' : '开始运行后会自动出现在这里。'}</p></div>`}</section>
    <section class="panel overview-tools" data-region="overview-tools"><div class="section-head"><div><h2>任务来源</h2><p class="muted">识别到的工具及其接入状态。</p></div><a class="text-link" href="#/adapters">工具详情 ↗</a></div>${sectionError(state, 'tools')}${installed.length ? `<div class="source-list">${installed.map((tool) => toolRow(tool, state.settings)).join('')}</div>` : `<div class="overview-empty overview-empty--compact"><strong>${state.sectionErrors.tools ? '工具状态暂时不可用' : state.toolsLoading ? '正在检查本机工具' : '还没发现本机工具'}</strong><p>${state.sectionErrors.tools ? '稍后刷新再试。' : state.toolsLoading ? '检查完成后会显示可用的任务来源。' : '点击右上角“扫描工具”检查。'}</p></div>`}<div class="panel-foot"><span>识别到 ${installed.length} 个工具</span><span>${scan ? `最近扫描 ${esc(fmtTime(scan.finishedAt))}` : '尚未扫描'}</span></div></section></div>`;
}

/** @description: Board cards expose record actions without claiming to control another app. */
function boardCard(item: BoardItem, tools: ToolSummary[] = []): string {
  const metadata = item.kind === 'history';
  const heading = `<span class="task-tool">${esc(toolDisplayName(item.toolId, tools))}</span><span class="session-title">${esc(displayTaskTitle(item, tools))}</span><span class="session-meta"><span>${esc(fmtRelative(item.updatedAt))}</span>${metadata ? '<span>仅历史索引</span>' : ''}</span>`;
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
  return `<button class="btn btn-small btn-ghost" type="button" data-task-event="${event}" data-task-id="${esc(sessionId)}" title="只改 AgentCue 的记录；任务本身要去原工具里处理">${label}</button>${currentState === 'failed' || currentState === 'timeout' ? `<button class="btn btn-small btn-ghost" type="button" data-task-event="task.archived" data-task-id="${esc(sessionId)}">归档</button>` : ''}`;
}

/** @description: Per-column counts and cursors remain independent. */
function renderBoard(state: AppState): string {
  const columns: Array<{ id: BoardGroupId; title: string; hint: string; tone: string }> = [
    { id: 'attention', title: '等你处理', hint: '需要你确认', tone: 'attention' },
    { id: 'running', title: '进行中', hint: '正在运行的任务', tone: 'running' },
    { id: 'failed', title: '有问题', hint: '失败或超时的任务', tone: 'failed' },
    { id: 'completed', title: '已结束', hint: '已完成、取消或归档的任务', tone: 'ok' },
  ];
  const renderColumn = (id: BoardGroupId, title: string, hint: string, tone: string): string => {
    const group = state.board?.groups.find((item) => item.id === id);
    const pending = !group && state.boardLoading && !state.sectionErrors.board;
    return `<section class="column${id === 'history' ? ' history-column' : ''}" data-region="board-${id}" data-tone="${tone}"><header class="column-head"><span class="column-dot" data-tone="${tone}" aria-hidden="true"></span><div><h2>${title}<span class="count-pill">${group?.total ?? (pending ? '…' : '—')}</span></h2>${hint ? `<p>${hint}</p>` : ''}</div></header><div class="column-body" data-scroll-key="board-${id}">${group?.items.length ? group.items.map((item) => boardCard(item, state.tools)).join('') : `<div class="column-empty">${group ? '暂无任务' : state.sectionErrors.board ? '列表加载失败' : '正在加载…'}</div>`}</div>${group?.nextCursor ? `<button class="btn btn-more" type="button" data-load-group="${id}" data-cursor="${esc(group.nextCursor)}" aria-label="加载更多，已显示 ${group.items.length} 条，共 ${group.total} 条"><span>加载更多</span><span class="btn-more-count">${group.items.length} / ${group.total}</span></button>` : ''}</section>`;
  };
  return `<div class="board-filterbar" data-region="board-toolbar"><div class="search-control"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><circle cx="7" cy="7" r="4.5" /><path d="M10.5 10.5 14 14" /></svg><input id="board-search" data-draft type="search" aria-label="搜索任务" placeholder="搜索任务标题、工具或 ID" value="${esc(state.boardQuery.q)}" /></div><span class="filterbar-sep" aria-hidden="true"></span><select id="board-tool" data-draft aria-label="筛选工具"><option value="">全部工具</option>${state.tools.map((tool) => `<option value="${esc(tool.toolId)}" ${state.boardQuery.toolId === tool.toolId ? 'selected' : ''}>${esc(tool.name)}</option>`).join('')}</select><button class="btn btn-ghost btn-small" type="button" data-action="clear-board">重置筛选</button></div><div class="board-secondary" data-region="board-secondary">${renderBoardDatePicker('from', state.boardQuery.from ?? '', '开始日期')}${renderBoardDatePicker('to', state.boardQuery.to ?? '', '结束日期')}<label class="sr-only" for="board-order">排序</label><select id="board-order" data-draft><option value="desc" ${state.boardQuery.order !== 'asc' ? 'selected' : ''}>最近更新优先</option><option value="asc" ${state.boardQuery.order === 'asc' ? 'selected' : ''}>较早更新优先</option></select><button class="btn btn-ghost btn-small" type="button" data-feature="archive-ended">归档已结束的任务</button></div>
    <div data-region="board-feedback">${sectionError(state, 'board')}<p class="board-hint">当前操作只会更改 AgentCue 里的记录，不会影响原工具。</p></div>
    <div class="board">${columns.map((column) => renderColumn(column.id, column.title, column.hint, column.tone)).join('')}</div>
    ${renderColumn('history', '历史记录', '', 'neutral')}`;
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
  return `<section class="panel" data-region="adapters-list"><div class="section-head"><div><h2>已识别工具</h2><p class="muted">每个工具的安装状态和播报消息。</p></div><span class="count-pill">${state.adapters.length}</span></div>${sectionError(state, 'adapters')}${sectionError(state, 'tools')}${sectionError(state, 'settings')}${
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
            return `<article class="adapter">${toolMark({ ...tool, toolId: adapter.id })}<div class="adapter-info"><div class="adapter-name">${esc(adapter.name)}${tool?.host ? `<span class="muted">${esc(tool.host)} 扩展</span>` : ''}<span class="badge" data-state="${status === 'running' ? 'running' : 'idle'}">${esc(detectLabel(status))}</span>${ignored ? '<span class="badge">已忽略</span>' : ''}</div><div class="capability-label">${esc(capabilityLabel(capability))}${tool?.version ? ` · v${esc(tool.version)}` : ''}</div><p class="muted">${esc(tool?.capabilityReason ?? (capability === 'metadata' ? '只能看到历史记录，看不到当前状态。' : capability === 'detect-only' ? '这个工具暂时无法读取任务。' : '正在读取这个工具的任务记录。'))}</p>${tool ? toolHookStatus({ ...tool, ignored }, state.settings) : ''}<details data-disclosure-key="adapter-path-${esc(adapter.id)}"><summary>查看检测路径</summary><code class="adapter-path">${esc(adapterPath(adapter))}</code></details></div><button class="btn btn-ghost" type="button" data-toggle-ignore="${esc(adapter.id)}" data-ignored="${ignored}">${ignored ? '恢复扫描' : '忽略'}</button></article>`;
          })
          .join('')
      : '<div class="empty">工具列表还没加载好，请重新扫描。</div>'
  }</section>
    <section class="panel" data-region="adapters-custom"><div class="section-head"><div><h2>自定义工具</h2><p class="muted">填写工具路径，检查 AgentCue 接入状态。</p></div></div><div class="custom-form"><input id="custom-id" data-draft aria-label="工具 ID" placeholder="工具 ID（小写字母和连字符）" /><input id="custom-name" data-draft aria-label="显示名" placeholder="显示名" /><input id="custom-path" data-draft aria-label="配置路径" placeholder="配置路径，如 ~/.my-tool" /><button class="btn btn-primary" type="button" data-action="add-custom-tool">添加工具</button></div>${(state.settings?.scan.customTools ?? []).map((tool) => `<div class="tool-row"><div class="tool-info"><strong>${esc(tool.name)}</strong><code>${esc(tool.configPath)}</code></div><button class="btn btn-ghost" type="button" data-remove-custom="${esc(tool.id)}">移除</button></div>`).join('')}</section>`;
}

/**
 * @description: 统一字段行。宽面板时标签/说明在左、控件在右，窄面板自动收成一栏。
 * 有 id 时用 label 关联控件，并替换控件里的 __ID__；无 id 时标签只是分组标题。
 */
function fieldRow(
  id: string | null,
  label: string,
  hint: string,
  control: string,
  labelAction = '',
): string {
  const labelHtml = id
    ? `<label class="field-label" for="${id}">${label}</label>`
    : `<div class="field-label">${label}</div>`;
  const body = id ? control.replace(/__ID__/g, id) : control;
  const hintHtml = hint ? `<p class="field-hint">${hint}</p>` : '';
  return `<div class="field"><div class="field-heading"><div class="field-heading-row">${labelHtml}${labelAction}</div>${hintHtml}</div><div class="field-control">${body}</div></div>`;
}

/** @description: Accessible setting row with a stable control identity. */
function settingRow(
  path: string,
  label: string,
  hint: string,
  control: string,
  labelAction = '',
): string {
  return fieldRow(`setting-${path.replace(/\./g, '-')}`, label, hint, control, labelAction);
}

/** @description: 无标签的说明行，内容与控件列对齐；用于字段下方的就绪/限制说明。 */
function fieldNote(html: string): string {
  return `<div class="field-note">${html}</div>`;
}

/** @description: 只有分组标签、没有单一控件的字段行。 */
function fieldGroup(labelId: string, label: string, hint: string, control: string): string {
  return `<div class="field"><div class="field-heading"><div class="field-heading-row"><div class="field-label" id="${labelId}">${label}</div></div>${hint ? `<p class="field-hint">${hint}</p>` : ''}</div><div class="field-control">${control}</div></div>`;
}
function toggle(path: string, checked: boolean): string {
  return `<input id="__ID__" class="toggle" type="checkbox" data-setting="${path}" ${checked ? 'checked' : ''} />`;
}
function settingsSection(
  id: string,
  title: string,
  description: string,
  body: string,
  active: boolean,
): string {
  return `<section id="settings-${id}" class="panel settings-panel" data-region="settings-${id}" role="tabpanel" aria-labelledby="settings-tab-${id}" tabindex="0"${active ? '' : ' hidden'}><div class="section-head"><div><h2 id="settings-heading-${id}">${title}</h2><p class="muted">${description}</p></div></div>${body}</section>`;
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
    ? '已开启全部静音。任务提醒只显示通知，不会语音播报。'
    : !settings.voice.enabled
      ? '自动播报已关闭。任务提醒仍会显示通知。'
      : quiet
        ? settings.quiet.waitingHumanOverride
          ? '现在是免打扰时段，等待确认任务仍会播报，其他提醒只显示通知。'
          : '现在是免打扰时段，提醒只显示通知。'
        : '现在不在免打扰时段，按下面的规则提醒。';
  const events = [
    ['task.started', '开始'],
    ['task.waiting_human', '等待确认'],
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
      } else if (!broadcastScopeAllows(settings.voice.scope, event)) {
        action = 'notify';
        reason = '未选择此播报事件';
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
    notify: '通知',
    mute: '静音',
  };
  const time = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  return `<aside class="voice-policy" aria-label="当前自动播报策略"><div class="voice-policy-head"><strong>提醒效果</strong><span>${time} · ${policy.quiet ? '免打扰时段' : '免打扰时段外'}</span></div><p>${esc(policy.status)}</p>${state.sectionErrors.rules ? '<p class="is-error">规则加载失败。刷新后再检查每类事件的提醒方式。</p>' : `<ul class="voice-policy-events" aria-label="各事件的当前处理方式">${policy.items.map((item) => `<li><span>${item.label}</span><strong>${labels[item.action]}</strong>${item.reason ? `<small>${item.reason}</small>` : ''}</li>`).join('')}</ul>`}</aside>`;
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

/** @description: All voices remain selectable; search narrows the native list without hiding the current choice. */
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
  const query = state.kokoroVoiceSearch.trim().toLocaleLowerCase();
  const matches = query
    ? KOKORO_VOICES.filter((voice) => {
        const label = `${names.get(voice.profile) ?? ''} ${voice.lang} ${voice.gender} ${voice.code} ${voice.profile}`;
        return label.toLocaleLowerCase().includes(query);
      })
    : KOKORO_VOICES;
  const option = (voice: (typeof KOKORO_VOICES)[number]): string =>
    `<option value="${voice.profile}" ${voice.profile === selected.profile ? 'selected' : ''}>${esc(names.get(voice.profile) ? `${names.get(voice.profile)} · ${voice.lang}${voice.gender} ${voice.code}` : `${voice.lang}${voice.gender} · ${voice.code}`)}</option>`;
  const group = (label: string, voices: typeof KOKORO_VOICES): string =>
    voices.length ? `<optgroup label="${label}">${voices.map(option).join('')}</optgroup>` : '';
  const options = query
    ? group(`搜索结果 · ${matches.length}`, matches) +
      (!matches.some((voice) => voice.profile === selected.profile)
        ? group('当前选择', [selected])
        : '')
    : group(
        '常用音色',
        KOKORO_VOICES.filter((voice) => names.has(voice.profile)),
      ) +
      group(
        '普通话女声',
        KOKORO_VOICES.filter(
          (voice) =>
            voice.lang === '普通话' && voice.gender === '女声' && !names.has(voice.profile),
        ),
      ) +
      group(
        '普通话男声',
        KOKORO_VOICES.filter(
          (voice) =>
            voice.lang === '普通话' && voice.gender === '男声' && !names.has(voice.profile),
        ),
      ) +
      group(
        '英语音色',
        KOKORO_VOICES.filter((voice) => voice.lang === '英语' && !names.has(voice.profile)),
      );
  const nameId = `kokoro-voice-name-${selected.profile.slice(7)}`;
  const searchStatus = query
    ? matches.length
      ? `找到 ${matches.length} 个音色；当前选择会保留在列表中。`
      : '没有匹配项；当前音色仍保留，清空搜索可浏览全部。'
    : `共 ${KOKORO_VOICES.length} 个本地音色（100 个普通话、3 个英语）。收藏会排在最前面。`;
  return `<div class="voice-picker"><div class="control-stack">
      <label class="sr-only" for="kokoro-voice-search">搜索音色名称、语言或编号</label><input id="kokoro-voice-search" class="control-input" type="search" data-draft value="${esc(state.kokoroVoiceSearch)}" placeholder="搜索音色名称、语言或编号" autocomplete="off" />
      <select id="__ID__" class="control-select" data-setting="voice.voiceProfile" aria-describedby="kokoro-voices-status">${options}</select>
      <div class="control-row"><input id="${nameId}" class="control-input control-grow" data-draft maxlength="32" aria-label="音色名称" value="${esc(currentName)}" placeholder="起个名字，如：清亮女声" /><button class="btn btn-primary" type="button" data-action="save-kokoro-voice">${currentName ? '保存名字' : '收藏'}</button>${currentName ? '<button class="text-link" type="button" data-action="remove-kokoro-voice">取消收藏</button>' : ''}</div>
      <div id="kokoro-voices-status" class="control-stack" role="status">${selected.profile !== profile ? `<p class="control-note is-error">原来选的「${esc(profile)}」不在本地音色里，现在用的是普通话女声 zf_001。</p>` : ''}<p class="control-note">${searchStatus}</p><p class="control-note">Kokoro 支持普通话和英语；试听使用列表中当前选中的音色。粤语请选「系统自带」。</p></div>
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
  return `${settingRow('voice.cloudEnabled', '允许使用云服务', '开启并填入 API Key，播报的内容会发给服务商；不开启则完全不联网。', toggle('voice.cloudEnabled', voice.cloudEnabled))}
    ${settingRow(
      'voice.cloudApiKey',
      'API Key',
      hasKey ? '已保存，如需修改请输入，留空则保留原有内容。' : '只存在这台电脑上，不会上传。',
      `<div class="control-row"><input id="__ID__" type="password" class="control-input control-grow" autocomplete="off" spellcheck="false" data-setting="voice.cloudApiKey" placeholder="${hasKey ? '已保存，留空表示不修改' : '粘贴 MiMo API Key'}" /><button class="btn btn-ghost btn-small" type="button" data-action="clear-cloud-key"${hasKey ? '' : ' disabled'}>清除</button></div>`,
      `<a class="field-label-action" href="${CLOUD_KEY_URL}" target="_blank" rel="noreferrer noopener">获取 API Key ↗</a>`,
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
      '不填默认使用 mimo-v2.5-tts。',
      `<input id="__ID__" class="control-input" data-setting="voice.cloudModel" value="${esc(voice.cloudModel)}" placeholder="mimo-v2.5-tts" />`,
    )}
    ${settingRow(
      'voice.cloudVoice',
      '音色',
      '无需安装。中文音色适合整句中文；Mia / Chloe / Milo / Dean 是英文音色，可试听工具名读音，但中文部分可能不够自然。',
      `<select id="__ID__" class="control-select" data-setting="voice.cloudVoice">${cloudVoiceOptions}${customCloudVoice}</select>`,
    )}
    <p class="cloud-disclosure">云服务需要联网，播报的文字会发送给服务商，MiMo 目前限时免费。</p>`;
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
  if (modelState === 'ready')
    return fieldRow(
      null,
      '模型管理',
      `${status?.directoryName ?? meta.name} · ${formatBytes(status?.installedBytes ?? 0)}。文件校验比对本机 SHA-256 记录，不替代发布者签名。`,
      `<div class="control-row"><button type="button" class="btn btn-ghost btn-small" data-feature="verify-model" data-model-kind="${kind}">文件校验</button><button type="button" class="btn btn-ghost btn-small" data-feature="redownload-model" data-model-kind="${kind}">重新下载</button><button type="button" class="btn btn-ghost btn-small" data-feature="import-model" data-model-kind="${kind}">本地导入</button><button type="button" class="btn btn-ghost btn-small" data-feature="remove-model" data-model-kind="${kind}">删除模型</button></div>`,
    );
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
      `<div class="control-stack model-status" role="status"><p class="model-status-title">${meta.name} 正在解压或导入检查…</p></div>`,
    );
  const error = modelState === 'error' ? status?.error : undefined;
  return fieldRow(
    null,
    '模型',
    '下载后保存在本机；仅点击时出网。',
    `<div class="control-stack model-status${error ? ' is-error' : ''}" role="status"><p class="model-status-title">${error ? `上次没下载成功：${esc(error)}。` : modelState === 'error' ? '上次没下载成功。' : `还没下载 ${meta.name} 模型。`}</p><p class="control-note">${meta.size}，从 github.com 下载，断了可以接着下。只有你点下载时才联网，文件存在这台电脑上。${meta.manual}</p><button class="btn btn-primary btn-small" type="button" data-action="download-model" data-model-kind="${kind}">${error ? '再试一次' : '下载模型'}</button><button class="btn btn-ghost btn-small" type="button" data-feature="import-model" data-model-kind="${kind}">从本地目录导入</button></div>`,
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

/** @description: Native preferences and maintenance controls share the settings draft lifecycle. */
function renderAppSettings(state: AppState): string {
  const prefs = state.desktopPreferences;
  const native = !!window.awm?.desktopFeature;
  const info = state.dataInfo;
  const backupOptions =
    info?.backups
      .map(
        (b) =>
          `<option value="${esc(b.id)}">${esc(new Date(b.createdAt).toLocaleString('zh-CN'))} · ${formatBytes(b.bytes)}</option>`,
      )
      .join('') ?? '';
  return `${sectionError(state, 'desktop')}${sectionError(state, 'maintenance')}
    <div class="panel-note">应用选项与保留期限可用顶部“保存”一起保存；备份、恢复和清理使用各自按钮。</div>
    ${fieldRow('app-autostart', '登录时启动', '仅为当前用户注册，下次登录生效。', `<input id="__ID__" class="toggle" data-draft type="checkbox" ${prefs?.autostart ? 'checked' : ''} ${native ? '' : 'disabled'} />`)}
    ${fieldRow('app-start-hidden', '启动时隐藏窗口', '启动后从菜单栏或托盘打开。', `<input id="__ID__" class="toggle" data-draft type="checkbox" ${prefs?.startHidden ? 'checked' : ''} ${native ? '' : 'disabled'} />`)}
    ${fieldRow('app-close-tray', '关闭窗口后继续监控', '关闭此项后，关窗口就退出应用。', `<input id="__ID__" class="toggle" data-draft type="checkbox" ${prefs?.closeToTray !== false ? 'checked' : ''} ${native ? '' : 'disabled'} />`)}
    <div class="settings-actions"><button class="btn btn-primary btn-small" type="button" data-feature="save-desktop" ${native && prefs ? '' : 'disabled'}>保存应用选项</button></div>
    <div class="settings-actions"><button class="text-link" type="button" data-feature="reopen-setup">重新打开使用引导</button></div><div class="advanced-divider"><h3>本机数据</h3><p class="muted">备份含任务数据库和设置，保存在本机；不包含语音模型和云 API Key。恢复会保留当前云服务配置。</p></div>
    ${info ? `<dl class="diagnostic-facts"><div><dt>数据库与写入日志</dt><dd>${formatBytes(info.databaseBytes)}</dd></div><div><dt>语音模型</dt><dd>${formatBytes(info.modelBytes)}</dd></div><div><dt>备份占用</dt><dd>${formatBytes(info.backupBytes)}</dd></div><div><dt>任务记录</dt><dd>${info.sessions}</dd></div></dl><p class="data-path">${esc(info.dataDir)}</p>` : '<p class="muted">正在获取本机存储信息…</p>'}
    <div class="settings-actions"><button class="btn btn-ghost btn-small" type="button" data-feature="open-data" ${native ? '' : 'disabled'}>打开数据目录</button><button class="btn btn-ghost btn-small" type="button" data-feature="backup-data">创建本机备份</button><button class="btn btn-ghost btn-small" type="button" data-feature="refresh-data">刷新占用</button></div>
    ${fieldRow('restore-backup', '恢复备份', '先自动备份当前数据，再安排下次启动时恢复；已有任务记录将被所选备份替换。', `<div class="control-row"><select id="__ID__" class="control-select" aria-label="选择备份" ${backupOptions ? '' : 'disabled'}>${backupOptions || '<option>还没有备份</option>'}</select><button class="btn btn-ghost btn-small" type="button" data-feature="restore-data" ${backupOptions ? '' : 'disabled'}>安排恢复</button></div>`)}
    ${info?.restoreResult ? `<p class="${info.restoreResult.ok ? 'panel-note' : 'inline-error'}" role="status">${esc(info.restoreResult.message)}</p>` : ''}
    ${info?.restorePending ? '<div class="panel-note" role="status">已安排下次启动恢复。<button type="button" class="text-link" data-feature="restart-app">重启并恢复</button> · <button type="button" class="text-link" data-feature="cancel-restore">取消恢复</button></div>' : ''}
    ${fieldRow('retention-days', '历史保留天数', '0 为永久保留；7–3650 天。自动清理只删除过期的完成、取消或归档任务，保留进行中、等待确认、失败和超时任务。', `<div class="control-row"><input id="__ID__" class="control-input control-input--short" type="number" min="0" max="3650" step="1" data-draft value="${info?.preferences.retentionDays ?? 0}"/><button class="btn btn-ghost btn-small" type="button" data-feature="save-retention">保存期限</button><button class="btn btn-ghost btn-small" type="button" data-feature="cleanup-data">预览并清理</button></div>`)}
    <div class="advanced-divider"><h3>问题报告</h3><p class="muted">仅包含版本、平台、工具识别状态、关键事件时间和计数；不含标题、路径、会话正文、API Key 或服务器命令。先预览，再自行导出。</p></div>
    <div class="settings-actions"><button class="btn btn-ghost btn-small" type="button" data-feature="preview-report">生成脱敏报告</button>${state.diagnosticReport ? '<button class="btn btn-ghost btn-small" type="button" data-feature="export-report">导出报告</button>' : ''}</div>
    ${state.diagnosticReport ? `<details open><summary>报告预览</summary><pre class="code-block">${esc(JSON.stringify(state.diagnosticReport, null, 2))}</pre></details>` : ''}
    <div class="advanced-divider"><h3>版本更新</h3><p class="muted">点击后连接 AgentCue 的 GitHub Releases；不发送任务或设置，不自动下载安装。</p></div>
    <button class="btn btn-ghost btn-small" type="button" data-feature="check-update" ${native ? '' : 'disabled'}>检查更新</button> <a class="text-link" target="_blank" rel="noreferrer" href="https://github.com/ideshun/AgentCue/releases/latest">打开发布页 ↗</a>
    ${state.updateInfo ? `<div class="update-result" role="status"><p>${state.updateInfo.available ? `发现新版本 ${esc(state.updateInfo.latest)}` : `当前 ${esc(state.updateInfo.current)}，未发现更新的正式版`} · 检查于 ${esc(fmtTime(state.updateInfo.checkedAt))}</p><div class="settings-actions">${state.updateInfo.available && state.updateInfo.downloadUrl ? `<a class="btn btn-primary btn-small" target="_blank" rel="noreferrer" href="${esc(state.updateInfo.downloadUrl)}">下载当前平台安装包</a>` : ''}<a class="text-link" target="_blank" rel="noreferrer" href="${esc(state.updateInfo.releaseUrl)}">查看发布页</a></div><details><summary>更新说明</summary><pre class="code-block">${esc(state.updateInfo.notes)}</pre></details></div>` : ''}`;
}
function formatBytes(bytes: number): string {
  return bytes >= 1024 * 1024 * 1024
    ? `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`
    : bytes >= 1024 * 1024
      ? `${(bytes / 1024 / 1024).toFixed(1)} MB`
      : `${Math.ceil(bytes / 1024)} KB`;
}
function renderPlayback(state: AppState): string {
  if (!window.awm?.desktopFeature) return '';
  const status = state.playback;
  return `<div class="playback-status" role="status"><span>${status?.playing ? `正在播报 · ${esc(status.text ?? '')}` : status?.ok === false ? `上次播报失败：${esc(status.errors?.join('；') ?? '')}` : '当前没有语音播放'}</span>${status?.playing ? '<button class="btn btn-ghost btn-small" type="button" data-feature="stop-voice">停止播放与排队</button>' : ''}${status?.ok === false && !status.playing ? '<button class="btn btn-ghost btn-small" type="button" data-feature="retry-voice">手动重试</button>' : ''}</div>`;
}
function renderPronunciation(state: AppState): string {
  if (!window.awm?.desktopFeature) return '';
  const entries = state.pronunciation ?? {};
  return `<details class="pronunciation-editor" data-disclosure-key="pronunciation"><summary>自定义读音</summary><p class="muted">格式：原词 = 读法，多条用换行分隔。云语音使用发音提示，系统和本地语音按读法替换；任务标题不变。启用云语音时，读音表也会发送给服务商。</p><label class="sr-only" for="pronunciation-text">原词与读法</label><textarea id="pronunciation-text" class="control-input" rows="5" data-draft placeholder="Git = git&#10;重构 = chóng gòu">${esc(
    Object.entries(entries)
      .map(([key, value]) => `${key} = ${value}`)
      .join('\n'),
  )}</textarea><button class="btn btn-ghost btn-small" type="button" data-feature="save-pronunciation">保存读音表</button></details>`;
}

/** @description: Group settings into independent, responsive panels. */
function renderSettings(
  state: AppState,
  voiceProfile = state.settings?.voice.voiceProfile ?? 'system-default',
  // 预览副本：设置页显示的是待保存的值，规则表叠加待保存的规则动作。
  settings: Settings | null = state.settings,
  rules: VoiceRule[] = state.rules,
  activeSection = 'voice',
): string {
  if (!settings)
    return `<div data-region="settings-empty">${errorBlock(state.sectionErrors.settings ?? '设置尚未加载')}</div>`;
  const backend = settings.voice.backend;
  const localEngine = settings.voice.localEngine;
  const rate = `<div class="control-row"><input id="__ID__" type="range" min="0.5" max="2" step="0.1" data-setting="voice.rate" value="${settings.voice.rate}" aria-label="语速" ${backend === 'cloud' ? 'disabled' : ''}/><output id="rate-value" for="__ID__">${backend === 'cloud' ? '平台控制' : `${settings.voice.rate.toFixed(1)}×`}</output></div>`;
  const audition = `<div class="control-stack"><div class="control-row"><input id="speak-text" class="control-input control-grow" data-draft aria-label="试听文本" value="重构登录模块，等你确认" /><button class="btn btn-primary" type="button" data-action="speak-test">试听</button></div><div id="speak-result" class="action-result ${state.speakResult?.ok === false ? 'is-error' : ''}" role="status">${state.speakResult ? esc(state.speakResult.ok ? `播放完成 · ${backendLabel(state.speakResult.usedBackend, localEngine)}` : `播放失败：${state.speakResult.errors.join('；')}`) : ''}</div></div>`;
  // 当前播报状态只在「播报规则」里展示一次：那里才需要对照规则看结果。
  // 兼容旧版 all：自动播报始终只允许开始、等待确认、完成三类事件。
  const scope = settings.voice.scope === 'all' ? 'milestones' : settings.voice.scope;
  const scopeEvents = new Set(
    scope === 'milestones'
      ? ['started', 'attention', 'completed']
      : scope === 'attention'
        ? ['attention']
        : scope === 'none'
          ? []
          : scope.split('_'),
  );
  const broadcastEvents = `<div class="event-checkboxes" role="group" aria-label="播报事件">
    <label class="event-checkbox"><input id="scope-started" type="checkbox" data-scope-event="started" ${scopeEvents.has('started') ? 'checked' : ''}/>任务开始</label>
    <label class="event-checkbox"><input id="scope-attention" type="checkbox" data-scope-event="attention" ${scopeEvents.has('attention') ? 'checked' : ''}/>等待确认</label>
    <label class="event-checkbox"><input id="scope-completed" type="checkbox" data-scope-event="completed" ${scopeEvents.has('completed') ? 'checked' : ''}/>任务完成</label>
  </div>`;
  const content = settings.voice.content;
  const voice = `${sectionError(state, 'settings')}${settingRow('voice.enabled', '自动语音播报', '关闭后不再语音播报，仍会在通知中显示。', toggle('voice.enabled', settings.voice.enabled))}
    ${settingRow('voice.scope', '播报事件', '选择需要播报的事件', broadcastEvents)}
    ${settingRow('voice.content', '播报内容', content === 'title' ? '播报精简后的任务标题，代码和链接会略过。' : '按任务标题原文播报。', `<select id="__ID__" class="control-select" data-setting="voice.content"><option value="title" ${content === 'title' ? 'selected' : ''}>标题（精简）</option><option value="prompt" ${content === 'prompt' ? 'selected' : ''}>标题原文</option></select>`)}
    ${settingRow('voice.backend', '语音引擎', backend === 'local' ? '在本机合成，不用联网，但要先下载模型。' : backend === 'cloud' ? '用小米 MiMo 的云服务，需要填 API Key，播报内容会发出去。' : '用系统自带的声音。', `<select id="__ID__" class="control-select" data-setting="voice.backend"><option value="native" ${backend === 'native' ? 'selected' : ''}>系统自带</option><option value="local" ${backend === 'local' ? 'selected' : ''}>本机模型（Kokoro / ZipVoice）</option><option value="cloud" ${backend === 'cloud' ? 'selected' : ''}>云服务 · 小米 MiMo</option><option value="piper" disabled ${backend === 'piper' ? 'selected' : ''}>Piper · 旧配置</option></select>`)}
    ${backend === 'piper' ? '<div class="inline-error">这个后端已不可用，请换回「系统自带」「本机模型」或「云服务」。</div>' : ''}
    ${backend === 'local' ? renderLocalSettings(state, settings, voiceProfile) : ''}
    ${backend === 'cloud' ? renderCloudSettings(settings) : ''}
    ${backend === 'native' ? settingRow('voice.voiceProfile', '音色', '用系统的中文音色；更好听的增强音色要在系统设置里下载。', renderNativeVoicePicker(state, voiceProfile)) : ''}
    ${settingRow('voice.rate', '语速', backend === 'cloud' ? '设置本机和系统声音的语速，云服务不支持调整语速。' : '1.0× 是正常速度。', rate)}
    ${fieldRow('speak-text', '试听', '点击“试听”播放语音，需要先保存设置再试听。', audition)}`;
  const quietRanges = `<div class="control-stack quiet-ranges" role="group" aria-labelledby="quiet-ranges-label">${settings.quiet.ranges.map((range, index) => `<div class="control-row range-row"><label class="sr-only" for="quiet-from-${index}">时段 ${index + 1} 开始</label><input id="quiet-from-${index}" type="time" data-setting="quiet.ranges.${index}.from" value="${esc(range.from)}" /><span class="muted">至</span><label class="sr-only" for="quiet-to-${index}">时段 ${index + 1} 结束</label><input id="quiet-to-${index}" type="time" data-setting="quiet.ranges.${index}.to" value="${esc(range.to)}" /><button class="icon-btn" type="button" data-remove-range="${index}" aria-label="删除时段 ${index + 1}">×</button></div>`).join('')}<button class="btn btn-ghost btn-small" type="button" data-action="add-range">＋ 添加时段</button></div>`;
  const quiet = `${settingRow('quiet.globalMute', '全部静音', '开启后只显示通知，不会语音播报。', toggle('quiet.globalMute', settings.quiet.globalMute))}${fieldGroup('quiet-ranges-label', '免打扰时段', '设置一段不想被打扰的时间，可以跨天。', quietRanges)}${settingRow('quiet.waitingHumanOverride', '等待确认任务例外', '免打扰时段里，等待确认任务仍会播报；开启“全部静音”后例外也会关闭。', toggle('quiet.waitingHumanOverride', settings.quiet.waitingHumanOverride))}`;
  const privacy = `${settingRow('scan.autoIntervalHours', '多久重新扫描一次', '单位：小时。任务状态不受影响，仍然实时更新。', `<input id="__ID__" class="control-input control-input--short" type="number" min="1" max="24" data-setting="scan.autoIntervalHours" value="${settings.scan.autoIntervalHours}" />`)}${settingRow('privacy.sessionFileRead', '读取本机任务记录', '关掉以后 AgentCue 不再读取任务数据，已保存的历史也会藏起来。', toggle('privacy.sessionFileRead', settings.privacy.sessionFileRead))}${settingRow('privacy.auditLog', '记录操作日志', '日志只记操作本身，不含对话内容和密码。', toggle('privacy.auditLog', settings.privacy.auditLog))}<div class="panel-note">任务记录和设置默认保存在本机。只有启用并配置云语音后，播报文字才会发送给所选服务；不会自动上传完整会话内容。扫描只读取已声明的本机来源。</div><div class="settings-actions"><button class="btn btn-ghost btn-small" type="button" data-action="export-events">导出事件记录</button><span class="muted">最多 500 条，只有时间和原因，没有对话内容。</span></div>`;
  // 四个互斥分区减少长页查找；低频外部 MCP 配置归入「隐私与高级」。
  return `<nav class="settings-nav" aria-label="设置分区" data-region="settings-nav"><div class="settings-nav-inner"><div class="settings-tablist" role="tablist" aria-label="设置分区">${[
    ['voice', '语音'],
    ['quiet', '免打扰'],
    ['rules', '播报规则'],
    ['advanced', '隐私与高级'],
    ...(window.awm?.desktopFeature ? [['app', '应用与数据']] : []),
  ]
    .map(
      ([id, label]) =>
        `<button id="settings-tab-${id}" class="btn btn-ghost btn-small${id === activeSection ? ' is-active' : ''}" type="button" role="tab" aria-selected="${id === activeSection}" tabindex="${id === activeSection ? 0 : -1}" aria-controls="settings-${id}" data-settings-section="${id}">${label}</button>`,
    )
    .join(
      '',
    )}</div><span class="settings-save-group"><span id="settings-save-status" class="muted" role="status"></span><button id="settings-save" class="btn btn-primary btn-small" type="button" data-action="save-settings" disabled>保存</button></span></div></nav>
    ${settingsSection('voice', '语音播报', '任务开始、需要你确认或完成时，AgentCue 会播报。', voice + renderPlayback(state) + renderPronunciation(state), activeSection === 'voice')}
    ${settingsSection('app', '应用与数据', '管理后台运行、备份、历史保留和版本更新。', renderAppSettings(state), activeSection === 'app')}
    ${settingsSection('quiet', '免打扰', '设定时间段，决定哪些提醒先不播报。', quiet, activeSection === 'quiet')}
    ${settingsSection('rules', '播报规则', '分别设置每类事件要播报、发通知，还是不提醒。', sectionError(state, 'rules') + renderVoicePolicy(state, new Date(), settings, rules) + renderRuleMatrix(rules), activeSection === 'rules')}
    ${settingsSection('advanced', '扫描与隐私', '决定 AgentCue 能读哪些本机数据。', `${privacy}<div class="advanced-divider"><h3>外部 MCP 服务</h3><p class="muted">连接外部服务并查看它提供的工具；这不会接入任务状态或播报事件。</p></div>${sectionError(state, 'servers')}${renderExternalMcp(state)}`, activeSection === 'advanced')}`;
}

/** @description: Show observed evidence independently from installation and MCP connectivity. */
function renderIntegrationDiagnostics(state: AppState, id: string, hook?: HookIntegration): string {
  const tool = state.tools.find((item) => item.toolId === id);
  const manifest = state.adapters.find((item) => item.id === id);
  const fileEvents = !!manifest && Object.keys(manifest.eventMapping ?? {}).length > 0;
  const ignored = tool?.ignored === true || state.settings?.scan.ignoredToolIds.includes(id);
  const enabled = state.settings?.privacy.sessionFileRead === true && !ignored;
  const installed = tool?.detectStatus === 'installed' || tool?.detectStatus === 'running';
  const source = fileEvents
    ? hook
      ? '本机会话文件 / Hooks'
      : '本机会话文件'
    : hook
      ? 'Hooks 推送'
      : tool?.sessionCapability === 'metadata'
        ? '仅历史索引'
        : '仅安装探测';
  const milestones = enabled ? (tool?.milestones ?? []) : [];
  const latest = milestones.slice().sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts))[0];
  const issue = state.overview?.lastScan?.degraded.find((item) => item.toolId === id);
  const verification =
    state.integrationVerification?.toolId === id ? state.integrationVerification : null;
  const canVerify =
    enabled &&
    Array.isArray(tool?.milestones) &&
    (fileEvents || !!hook?.commandReady) &&
    !state.sectionErrors.tools &&
    !state.sectionErrors.adapters;
  const events = [
    ['task.started', '任务开始'],
    ['task.waiting_human', '需要确认'],
    ['task.completed', '任务完成'],
  ];
  const observed = events
    .map(([eventType, label]) => {
      const event = milestones.find((item) => item.eventType === eventType);
      const received =
        !!event &&
        Number.isFinite(Date.parse(event.ts)) &&
        (!verification ||
          (Date.parse(event.ts) > Date.parse(verification.since) &&
            verification.seen?.[eventType] !== event.ts));
      return `<li><span>${label}</span><span class="${received ? 'diagnostic-received' : 'muted'}">${received ? `已收到 · ${esc(fmtTime(event.ts))}` : verification ? '尚未收到' : '暂无记录'}</span></li>`;
    })
    .join('');
  return `<div class="integration-diagnostics">
    <dl class="diagnostic-facts">
      <div><dt>本机识别</dt><dd>${state.sectionErrors.tools ? '状态读取失败' : installed ? '已识别' : tool?.detectStatus === 'unknown' ? '尚未确认' : '未识别到安装'}${tool?.version ? ` · ${esc(tool.version)}` : ''}</dd></div>
      <div><dt>事件来源</dt><dd>${source}</dd></div>
      <div><dt>采集开关</dt><dd>${!state.settings ? '设置尚未加载' : ignored ? '此工具已忽略' : enabled ? '已开启' : '已关闭读取'}${!enabled ? ' · <a href="#/settings">前往设置</a>' : ''}</dd></div>
      <div><dt>最近关键事件</dt><dd>${!enabled ? '采集暂停，历史证据已隐藏' : latest ? esc(fmtTime(latest.ts)) : '尚未收到'}</dd></div>
    </dl>
    ${issue ? `<p class="inline-error">最近扫描报告：${esc(issue.reason)}。<a href="#/adapters">查看工具状态</a></p>` : ''}
    ${!fileEvents && hook && !hook.commandReady ? '<p class="inline-error">Hooks 启动入口不可用。请确认使用当前平台支持的安装版，再刷新接入状态。</p>' : ''}
    <details class="integration-verification" data-disclosure-key="verify-${esc(id)}" ${verification || state.setupToolId === id ? 'open' : ''}>
      <summary>接入引导与真实事件验证</summary>
      <ol class="setup-steps"><li>${fileEvents ? '打开本机任务记录读取后会自动采集。也可以按下方说明配置 Hooks。' : '展开下方 Hooks 接入，复制配置并合并到原工具，再按说明重新加载。'}</li><li>点“开始验证”，然后回到原工具新建一个任务。</li><li>检查任务开始和完成事件。只有工具会发送等待确认事件时，才能验证这一项。</li><li>到<a href="#/settings">语音设置</a>试听，再确认自动播报规则。任务事件和播报要分别核对。</li></ol>
      <div class="diagnostic-verification-head"><button id="verify-${esc(id)}" type="button" class="btn btn-ghost btn-small" data-verify-integration="${esc(id)}" ${canVerify ? '' : 'disabled'}>${verification ? '重新开始验证' : '开始验证'}</button><span class="muted">${verification ? `只核验 ${esc(fmtTime(verification.since))} 之后的事件` : canVerify ? '不会发送模拟事件，也不会修改原工具任务' : '请先开启采集，并确认事件来源可用'}</span></div>
      <ul class="diagnostic-events" aria-label="${esc(tool?.name ?? id)}关键事件接收情况" aria-live="polite">${observed}</ul>
      <p class="muted">按工具汇总，各项可能来自不同任务。到<a href="#/board">任务看板</a>核对同一任务的完整流程；收到过事件不代表当前仍连接。</p>
    </details>
  </div>`;
}

/** @description: Group both connection methods by tool, preserving provider order and partial data. */
function renderIntegrations(state: AppState): string {
  const tools = new Map<string, { name: string; hook?: HookIntegration; mcp?: McpSnippet }>();
  for (const hook of state.hookIntegrations) tools.set(hook.id, { name: hook.name, hook });
  for (const mcp of state.mcpSnippets) {
    const tool = tools.get(mcp.id) ?? { name: mcp.name };
    tools.set(mcp.id, { ...tool, mcp });
  }
  const intro = `<section class="panel integration-intro" data-region="integrations-intro"><div class="section-head"><div><h2>按工具接入</h2><p class="muted">选择任务事件或客户端工具连接。</p></div><button class="btn btn-ghost btn-small" type="button" data-action="refresh-hooks">刷新接入状态</button></div>${sectionError(state, 'hooks')}${sectionError(state, 'snippets')}${sectionError(state, 'tools')}${sectionError(state, 'adapters')}${sectionError(state, 'overview')}<div class="integration-explainer"><p><strong>Hooks</strong><span>由 AI 工具把任务开始、等待确认和完成等事件推送给 AgentCue 播报，可以在看板查看记录。</span></p><p><strong>MCP</strong><span>通过 AI 客户端连接 AgentCue 并调用它提供的工具。</span></p></div><p class="muted">将 AgentCue 相关配置添加到工具的配置中，注意不要直接覆盖原始配置文件。MCP 验证成功不代表任务事件已接通，收到过事件证明调用成功过。是否播报，需要看语音开关、免打扰和播报规则。</p></section>`;
  return (
    intro +
    (state.setupToolId
      ? `<section class="panel" data-region="setup-progress"><div class="section-head"><p>正在设置 ${esc(tools.get(state.setupToolId)?.name ?? state.setupToolId)}。按下方引导核对真实事件，再到语音设置试听。</p><button class="btn btn-ghost btn-small" type="button" data-feature="finish-setup">完成使用引导</button></div></section>`
      : '') +
    `<section class="panel integration-policy" data-region="integration-policy"><details data-disclosure-key="integration-policy"><summary>提醒规则 & 效果</summary>${sectionError(state, 'settings')}${renderVoicePolicy(state)}<a class="text-link" href="#/settings">调整语音与规则</a></details></section>` +
    (tools.size
      ? Array.from(tools)
          .sort(([a], [b]) => Number(b === state.setupToolId) - Number(a === state.setupToolId))
          .map(([id, tool]) => {
            const missingHooks = state.sectionErrors.hooks ? '加载失败' : '未提供';
            const missingMcp = state.sectionErrors.snippets ? '加载失败' : '未提供';
            return `<section class="panel integration-tool" data-region="integration-${esc(id)}" aria-labelledby="integration-title-${esc(id)}"><div class="section-head"><h2 id="integration-title-${esc(id)}">${esc(tool.name)}</h2></div>
          ${renderIntegrationDiagnostics(state, id, tool.hook)}
          <details class="integration-method" data-disclosure-key="integration-${esc(id)}-hooks"><summary><span class="integration-method-name">Hooks 接入</span><span class="integration-method-description">推送任务事件</span>${tool.hook ? renderHookStatus(tool.hook) : `<span class="badge">${missingHooks}</span>`}</summary><div class="integration-method-body">${tool.hook ? renderHookIntegration(tool.hook) : `<p class="muted">${state.sectionErrors.hooks ? 'Hooks 配置未能加载，请刷新后重试。' : '当前未提供此工具的 Hooks 接入配置。'}</p>`}</div></details>
          <details class="integration-method" data-disclosure-key="integration-${esc(id)}-mcp"><summary><span class="integration-method-name">MCP 接入</span><span class="integration-method-description">连接 AgentCue 工具</span><span class="badge" ${tool.mcp?.commandReady === false ? 'data-state="failed"' : ''}>${tool.mcp ? (tool.mcp.commandReady === false ? '入口不可用' : '配置指引') : missingMcp}</span></summary><div class="integration-method-body">${tool.mcp ? renderMcpSnippet(tool.mcp, state.mcpValidation) : `<p class="muted">${state.sectionErrors.snippets ? 'MCP 配置未能加载，请刷新后重试。' : '当前未提供此工具的 MCP 接入配置。'}</p>`}</div></details>
        </section>`;
          })
          .join('')
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
        restricted ? '这类事件不能语音播报，只能发通知' : '',
        `<select id="__ID__" class="control-select control-select--compact" data-rule-event="${event}">${[
          ['mute', '不提醒'],
          ['notify', '发通知'],
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
    '复制下面的配置。',
    '打开客户端的 MCP 设置，粘贴并保存，然后重载客户端。',
    '点下面的按钮验证连接。',
  ];
  return `<p class="control-note">${esc(snippet.hint)}</p>${snippet.commandReady === false ? '<div class="inline-error">本机的连接入口还没就绪，粘贴配置后先验证一下。</div>' : ''}<ol class="setup-steps">${steps.map((step) => `<li>${esc(step)}</li>`).join('')}</ol><div class="hook-file"><div class="hook-file-head"><span class="muted">${snippet.format === 'toml' ? 'TOML' : 'JSON'} 配置</span><button class="btn btn-ghost btn-small" type="button" data-action="copy-mcp" data-mcp-id="${esc(snippet.id)}" aria-label="复制 ${esc(snippet.name)} MCP 配置">复制配置</button></div><pre class="code-block">${esc(snippet.json)}</pre></div><div class="settings-actions"><button class="btn btn-primary btn-small" type="button" data-action="validate-mcp">验证 AgentCue 桥接</button><span class="muted">只检查 AgentCue 桥接并枚举工具，不代表客户端已连上，也不会接入任务事件。</span></div><div class="action-result ${validation && !validation.ok ? 'is-error' : ''}" role="status">${validation ? esc(validation.ok ? `AgentCue 桥接可用 · 发现 ${validation.tools.length} 个工具 · ${fmtTime(validation.lastValidatedAt)}` : `桥接验证失败：${validation.lastError ?? '握手没有成功'}`) : ''}</div>`;
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
  return level === 'attention' ? '需要处理' : '普通';
}

function renderNotifications(state: AppState): string {
  const filter = state.noticeLevelFilter;
  const shown = filter
    ? state.notifications.filter((n) => n.level === filter)
    : state.notifications;
  const unread = state.notifications.filter((n) => !n.read).length;
  const chips: Array<['' | 'attention' | 'info', string]> = [
    ['', '全部'],
    ['attention', '需要处理'],
    ['info', '普通'],
  ];
  // 头部操作区：级别筛选与「全部已读」（复用主进程已有的批量已读端点）。
  return `<section class="panel" data-region="notifications"><div class="section-head"><div><h2>最近通知${unread ? `<span class="count-pill">${unread} 未读</span>` : ''}</h2></div><div class="section-head-actions"><select id="notice-level-filter" aria-label="按级别筛选">${chips.map(([v, l]) => `<option value="${v}" ${filter === v ? 'selected' : ''}>${l}</option>`).join('')}</select>${unread ? `<button class="btn btn-ghost btn-small" type="button" data-action="mark-all-read">全部标为已读</button>` : ''}</div></div>${sectionError(state, 'notifications')}${shown.length ? shown.map((item) => `<article class="notice${item.read ? ' is-read' : ''}" data-notice-level="${esc(item.level)}"><span class="notice-dot" aria-hidden="true"></span><div><div class="notice-meta"><span>${esc(fmtRelative(item.ts))}</span><span>${item.read ? '已读' : '未读'}</span><span class="badge" data-level="${esc(item.level)}">${esc(noticeLevelLabel(item.level))}</span></div><h3>${esc(item.title)}</h3><p>${esc(item.body)}</p>${item.sessionId ? `<button class="text-link" type="button" data-session="${esc(item.sessionId)}">查看</button>` : ''}</div>${item.read ? '' : `<button class="btn btn-ghost btn-small" type="button" data-read-notice="${esc(item.notificationId)}">标为已读</button>`}</article>`).join('') : `<div class="empty">${filter ? '这个类别下没有通知。' : '还没有通知。任务需要你时会出现在这里。'}</div>`}${state.noticeHasMore ? `<button class="btn btn-more" type="button" data-action="load-notices">加载更多（已显示 ${state.notifications.length} 条）</button>` : ''}</section>`;
}

/** @description: The drawer uses descriptive recording actions and an append-only timeline. */
function renderTimeline(records: TransitionRecord[], session: SessionSummary | null): string {
  const actions = session ? taskActions(session.sessionId, session.currentState) : '';
  return `<div class="drawer-actions">${actions}<button class="btn btn-ghost btn-small" type="button" data-action="copy-timeline" data-copy-session="${esc(session?.sessionId ?? '')}">复制时间线</button></div>${actions ? '<p class="panel-note">这些按钮只改 AgentCue 记录，任务本身要去原工具处理；刚写入的标记可以撤回。</p>' : ''}${
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
