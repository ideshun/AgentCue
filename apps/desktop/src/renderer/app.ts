/** Native renderer orchestration. Task state remains authoritative in the main process. */
const state: AppState = {
  route: 'overview',
  overview: null,
  office: null,
  sessions: [],
  board: null,
  boardQuery: { q: '', toolId: '' },
  adapters: [],
  tools: [],
  settings: null,
  rules: [],
  notifications: [],
  noticeHasMore: false,
  boardLoading: false,
  noticeLevelFilter: '',
  mcpSnippets: [],
  mcpServers: [],
  hookIntegrations: [],
  externalTransport: 'stdio',
  nativeVoices: null,
  nativeVoicesLoading: false,
  modelStatus: null,
  zipvoiceModelStatus: null,
  speakResult: null,
  mcpValidation: null,
  sectionErrors: {},
  error: null,
};
let stream: EventSource | null = null;
let refreshTimer: number | null = null;
let searchTimer: number | null = null;
let loadSequence = 0;
type RefreshKey =
  | 'board'
  | 'overview'
  | 'office'
  | 'tools'
  | 'adapters'
  | 'notifications'
  | 'settings'
  | 'rules'
  | 'snippets'
  | 'servers'
  | 'hooks';
const refreshTtl: Record<RefreshKey, number> = {
  board: 30_000,
  overview: 30_000,
  office: 30_000,
  notifications: 30_000,
  tools: 60_000,
  settings: 60_000,
  rules: 60_000,
  servers: 60_000,
  hooks: 60_000,
  adapters: 300_000,
  snippets: 300_000,
};
const refreshVersions = new Map<RefreshKey, number>();
const refreshCache = new Map<RefreshKey, { at: number; version: number }>();
let refreshesInFlight = 0;
let backgroundRefreshAt = 0;
let boardLoadsInFlight = 0;
let boardWindowVersion = 0;
let drawerSequence = 0;
let nativeVoicesSequence = 0;
let renderedRoute: RouteName | null = null;
let activeSessionId = '';
let returnFocus: HTMLElement | null = null;
let settingsSaveTail: Promise<void> = Promise.resolve();
let settingsSaveCount = 0;
let draftRevision = 0;
/** 设置页的待保存副本；null 表示预览与已保存设置一致。 */
let pendingSettings: Settings | null = null;
/** 待保存字段，如 voice.rate；时段的所有 from/to 归并为 quiet.ranges。 */
const pendingPaths = new Set<string>();
/** 待保存的播报规则：事件 → 新动作与原来的通用动作。 */
const pendingRules = new Map<string, { action: string; original: string }>();
/** 正在把 hash 还原到设置页，避免还原动作再次触发离开确认。 */
let restoringHash = false;
const pendingActions = new Map<string, string>();
const disclosureStates = new Map<string, boolean>();
interface ControlDraft {
  value: string;
  checked: boolean;
  revision: number;
}
const drafts = new Map<RouteName, Map<string, ControlDraft>>();
const ROUTE_META: Record<RouteName, { title: string; subtitle: string }> = {
  overview: { title: '总览', subtitle: '任务、工具与提醒，尽在本机。' },
  office: { title: '办公室', subtitle: '在每一个工位，看见工作的进展。' },
  board: { title: '任务看板', subtitle: '从需要介入，到完成归档。' },
  notifications: { title: '通知中心', subtitle: '需要你关注的每一条进展。' },
  integrations: { title: '播报接入', subtitle: '按工具配置 Hooks 与 MCP，接收任务进展。' },
  adapters: { title: '工具与扩展', subtitle: '看清安装状态，也看清监控能力。' },
  settings: { title: '设置', subtitle: '按你的节奏，安排监控与提醒。' },
};

function currentRoute(): RouteName {
  const raw = window.location.hash.replace(/^#\/?/, '');
  return raw === 'board' ||
    raw === 'office' ||
    raw === 'integrations' ||
    raw === 'adapters' ||
    raw === 'settings' ||
    raw === 'notifications'
    ? raw
    : 'overview';
}
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
function routeDrafts(route: RouteName): Map<string, ControlDraft> {
  const values = drafts.get(route) ?? new Map<string, ControlDraft>();
  drafts.set(route, values);
  return values;
}
function rememberControl(
  control: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement,
): number {
  if (!control.id) return 0;
  const revision = ++draftRevision;
  routeDrafts(state.route).set(control.id, {
    value: control.value,
    checked: control instanceof HTMLInputElement && control.checked,
    revision,
  });
  return revision;
}

/** @description: Retain form drafts; saved setting controls continue to follow server values. */
function captureDrafts(): void {
  if (!renderedRoute) return;
  const values = routeDrafts(renderedRoute);
  for (const control of qs<HTMLElement>('#view').querySelectorAll<
    HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement
  >('[data-draft]')) {
    if (control.id)
      values.set(control.id, {
        value: control.value,
        checked: control instanceof HTMLInputElement && control.checked,
        revision: values.get(control.id)?.revision ?? 0,
      });
  }
}
function captureDisclosures(root: HTMLElement): void {
  for (const details of root.querySelectorAll<HTMLDetailsElement>('details[data-disclosure-key]'))
    if (details.dataset.disclosureKey)
      disclosureStates.set(details.dataset.disclosureKey, details.open);
}
function restoreDisclosures(root: HTMLElement): void {
  for (const details of root.querySelectorAll<HTMLDetailsElement>('details[data-disclosure-key]')) {
    if (!details.dataset.disclosureKey) continue;
    const open = disclosureStates.get(details.dataset.disclosureKey);
    if (open !== undefined) details.open = open;
  }
}
function restoreDrafts(): void {
  for (const [id, draft] of routeDrafts(state.route)) {
    const control = document.getElementById(id);
    if (!(
      control instanceof HTMLInputElement ||
      control instanceof HTMLSelectElement ||
      control instanceof HTMLTextAreaElement
    ))
      continue;
    if (control instanceof HTMLInputElement && control.type === 'checkbox')
      control.checked = draft.checked;
    else if (
      control instanceof HTMLSelectElement &&
      (id === 'setting-voice-voiceProfile' ||
        id === 'setting-voice-cloudVoice' ||
        control.dataset.ruleEvent) &&
      !Array.from(control.options).some((option) => option.value === draft.value)
    )
      continue;
    else control.value = draft.value;
  }
  const rate = document.querySelector<HTMLInputElement>('[data-setting="voice.rate"]');
  const label = document.getElementById('rate-value');
  if (rate && label) label.textContent = `${Number(rate.value).toFixed(1)}×`;
}

/** @description: Patch named regions, leaving an actively edited region untouched until blur. */
function render(force = false): void {
  const view = qs<HTMLElement>('#view');
  captureDrafts();
  captureDisclosures(view);
  const active =
    document.activeElement instanceof HTMLElement && view.contains(document.activeElement)
      ? document.activeElement
      : null;
  const activeId = active?.id;
  const selection =
    (active instanceof HTMLInputElement && ['text', 'search', 'url'].includes(active.type)) ||
    active instanceof HTMLTextAreaElement
      ? ([active.selectionStart, active.selectionEnd] as const)
      : null;
  const scrollTop = view.scrollTop;
  const columnScroll = new Map(
    Array.from(view.querySelectorAll<HTMLElement>('[data-scroll-key]')).map((node) => [
      node.dataset.scrollKey,
      node.scrollTop,
    ]),
  );
  const content =
    state.route === 'overview'
      ? renderOverview(state)
      : state.route === 'office'
        ? renderOffice(state)
        : state.route === 'board'
          ? renderBoard(state)
          : state.route === 'adapters'
            ? renderAdapters(state)
            : state.route === 'integrations'
              ? renderIntegrations(state)
              : state.route === 'notifications'
                ? renderNotifications(state)
                : renderSettings(
                    state,
                    routeDrafts('settings').get('setting-voice-voiceProfile')?.value ??
                      workingSettings()?.voice.voiceProfile,
                    workingSettings(),
                    previewRules(),
                  );
  const template = document.createElement('template');
  // 标记当前路由：设置页据此去掉画布顶部留白，吸顶导航紧贴页头上沿
  view.dataset.route = state.route;
  template.innerHTML = `<div class="view-feedback" data-region="view-feedback">${state.error ? `<div class="inline-error" role="alert">${esc(state.error)}</div>` : ''}</div>${content}`;
  const incoming = Array.from(template.content.querySelectorAll<HTMLElement>('[data-region]'));
  const existing = Array.from(view.querySelectorAll<HTMLElement>('[data-region]'));
  const samePage = renderedRoute === state.route;
  if (
    !samePage ||
    incoming.length !== existing.length ||
    incoming.some((node) => !existing.some((old) => old.dataset.region === node.dataset.region))
  ) {
    view.replaceChildren(template.content);
  } else {
    for (const node of incoming) {
      const old = existing.find((candidate) => candidate.dataset.region === node.dataset.region);
      if (!old) continue;
      // 动效开关等纯类名状态不一定改变内容，也需要同步。
      old.className = node.className;
      if (old.innerHTML === node.innerHTML) continue;
      if (
        !force &&
        active &&
        old.contains(active) &&
        (active instanceof HTMLInputElement ||
          active instanceof HTMLTextAreaElement ||
          active instanceof HTMLSelectElement)
      )
        continue;
      old.innerHTML = node.innerHTML;
    }
  }
  renderedRoute = state.route;
  restoreDisclosures(view);
  restoreDrafts();
  if (samePage) {
    // 相同值的 scrollTop 赋值也会中断进行中的平滑滚动：点击分区导航后 focusout
    // 触发的 0ms 重绘会把 scrollTo({behavior:'smooth'}) 吞掉，表现为要点两次。
    // 因此仅在确实偏移（内容重建导致布局变化）时才恢复滚动位置。
    if (view.scrollTop !== scrollTop) view.scrollTop = scrollTop;
    for (const node of view.querySelectorAll<HTMLElement>('[data-scroll-key]')) {
      const restore = columnScroll.get(node.dataset.scrollKey);
      if (restore !== undefined && node.scrollTop !== restore) node.scrollTop = restore;
    }
    if (activeId && !active?.isConnected) {
      const replacement = document.getElementById(activeId);
      replacement?.focus({ preventScroll: true });
      if (
        selection &&
        (replacement instanceof HTMLInputElement || replacement instanceof HTMLTextAreaElement)
      )
        replacement.setSelectionRange(selection[0], selection[1]);
    }
  } else view.scrollTop = 0;
  renderChrome();
  applyPending();
  if (state.route === 'office') positionOfficePopover();
}

let settingsSectionId = '';

/** @description: 吸顶的分区导航只标记当前分区，点击与滚动都走同一处状态。 */
function paintSettingsNav(): void {
  for (const button of document.querySelectorAll<HTMLElement>(
    '.settings-nav [data-settings-section]',
  )) {
    const active = button.dataset.settingsSection === settingsSectionId;
    if (active) button.setAttribute('aria-current', 'true');
    else button.removeAttribute('aria-current');
  }
}

function settingsPanels(): HTMLElement[] {
  const view = document.getElementById('view');
  return view ? Array.from(view.querySelectorAll<HTMLElement>('.settings-panel')) : [];
}

// 跳转落点与「当前分区」判定共用同一条基准线，否则高亮会差一个分区。
const SETTINGS_NAV_GAP = 12;

function settingsNavLine(): number {
  const nav = document.querySelector<HTMLElement>('.settings-nav');
  return (nav?.getBoundingClientRect().bottom ?? 0) + SETTINGS_NAV_GAP;
}

/**
 * @description: 当前分区 = 占据视口上部阅读区的那个分区。
 * 判定线取「导航下沿」与「视口上方 28%」中更靠下的一条：跳转落点贴着导航，
 * 而滚动时用户看到的分区标题往往已在导航下方一段距离，太贴边会让高亮慢一拍。
 */
function syncSettingsNav(): void {
  if (state.route !== 'settings') {
    settingsSectionId = '';
    return;
  }
  const panels = settingsPanels();
  const view = document.getElementById('view');
  if (!panels.length || !view) return;
  const viewBox = view.getBoundingClientRect();
  const line = Math.max(settingsNavLine(), viewBox.top + viewBox.height * 0.28);
  // 滚到底时最后一个分区进不了判定线，直接认定它，避免高亮卡在倒数第二个。
  const atEnd = view.scrollTop + view.clientHeight >= view.scrollHeight - 2;
  let current = panels[0]!.id.replace(/^settings-/, '');
  if (atEnd) current = panels[panels.length - 1]!.id.replace(/^settings-/, '');
  else
    for (const panel of panels)
      if (panel.getBoundingClientRect().top <= line) current = panel.id.replace(/^settings-/, '');
  settingsSectionId = current;
  // 区域重建会丢掉属性，所以每次都画，不做「值未变就跳过」。
  paintSettingsNav();
}

function jumpToSettingsSection(section: string): void {
  const view = document.getElementById('view');
  const target = document.getElementById(`settings-${section}`);
  if (!view || !target) return;
  const top = view.scrollTop + target.getBoundingClientRect().top - settingsNavLine();
  const distance = Math.abs(top - view.scrollTop);
  // 分区很长，平滑滚动会持续一秒以上；长距离直接落位，短距离保留过渡。
  const smooth =
    distance < view.clientHeight * 1.5 &&
    !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  view.scrollTo({ top, behavior: smooth ? 'smooth' : 'instant' });
  settingsSectionId = section;
  paintSettingsNav();
}

function renderChrome(): void {
  const meta = ROUTE_META[state.route];
  qs<HTMLElement>('#page-title').textContent = meta.title;
  qs<HTMLElement>('#page-subtitle').textContent = meta.subtitle;
  for (const button of document.querySelectorAll<HTMLElement>('.nav-item')) {
    if (button.dataset.route === state.route) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  }
  // 分区导航随区域重建，属性会丢；按当前分区补画一次。
  syncSettingsNav();
  const badge = document.getElementById('nav-notice-badge');
  if (badge) {
    const unread = state.notifications.filter((item) => !item.read).length;
    badge.textContent = String(unread);
    badge.hidden = !unread;
  }
  const muted = state.settings?.quiet.globalMute === true;
  const mute = qs<HTMLElement>('#mute-toggle');
  mute.dataset.muted = String(muted);
  mute.textContent = muted ? '已静音 · 点击恢复' : '静音自动播报';
  qs<HTMLElement>('#runtime-hint').textContent = state.settings
    ? '本地引擎已连接 · 每 5 秒采集'
    : '正在连接本地引擎…';
  // 设置页手动保存：状态文案与右上角按钮同步，未保存时按钮才可用。
  const save = document.getElementById('settings-save-status');
  const saveButton = document.getElementById('settings-save') as HTMLButtonElement | null;
  const pending = pendingChangeCount();
  if (save)
    save.textContent = settingsSaveCount
      ? '正在保存…'
      : pending > 0
        ? `${String(pending)} 项未保存`
        : state.sectionErrors.settings
          ? '保存失败，修改仍保留'
          : '全部已保存';
  if (saveButton) {
    saveButton.disabled = settingsSaveCount > 0 || pending === 0;
    saveButton.textContent = pending > 0 ? `保存（${String(pending)}）` : '保存';
  }
}
/** 动作期间被临时禁用的按钮，记录它们在临时禁用前的真实状态。 */
const pendingDisabled = new WeakMap<HTMLButtonElement, boolean>();

function applyPending(): void {
  for (const selector of pendingActions.values()) {
    for (const node of document.querySelectorAll<HTMLButtonElement>(selector)) {
      if (!pendingDisabled.has(node)) pendingDisabled.set(node, node.disabled);
      node.disabled = true;
      node.setAttribute('aria-busy', 'true');
    }
  }
}

/** 动作结束：回到按钮自己的渲染结果，而不是一律启用。 */
function releasePending(selector: string): void {
  for (const node of document.querySelectorAll<HTMLButtonElement>(selector)) {
    node.removeAttribute('aria-busy');
    const disabled = pendingDisabled.get(node);
    if (disabled === undefined) continue;
    pendingDisabled.delete(node);
    node.disabled = disabled;
  }
  // 还有别的动作在跑时，它们的按钮继续保持禁用。
  applyPending();
}

function scheduleRefresh(delay = 650): void {
  if (document.hidden || refreshTimer !== null) return;
  refreshTimer = window.setTimeout(
    () => {
      refreshTimer = null;
      void refresh(true);
    },
    Math.max(delay, backgroundRefreshAt - Date.now()),
  );
}
function invalidateResources(...keys: RefreshKey[]): void {
  for (const key of keys) refreshVersions.set(key, (refreshVersions.get(key) ?? 0) + 1);
}
function boardUrl(group?: BoardGroupId, cursor?: string, limit?: number): string {
  const params = new URLSearchParams({
    limit: String(limit ?? (state.route === 'overview' ? 8 : 20)),
  });
  if (state.route === 'board') {
    if (state.boardQuery.q) params.set('q', state.boardQuery.q);
    if (state.boardQuery.toolId) params.set('toolId', state.boardQuery.toolId);
  }
  if (group) params.set('group', group);
  if (cursor) params.set('cursor', cursor);
  return `/api/v1/board?${params}`;
}

/** 通知刷新取「当前已加载数量」为上限（100–500）：后台刷新不把已展开的更早记录截断。 */
function noticeRequestLimit(): number {
  return Math.min(Math.max(state.notifications.length, 100), 500);
}
function notificationsUrl(): string {
  return `/api/v1/notifications?limit=${noticeRequestLimit()}`;
}

/** @description: 从新游标重读已展开的各列，移除已迁移/归档的记录，保留加载深度。 */
async function refreshBoard(
  sequence: number,
  get: (url: string) => Promise<BoardResponse>,
): Promise<BoardResponse> {
  const route = state.route;
  const query = JSON.stringify(state.boardQuery);
  const current = (): boolean =>
    sequence === loadSequence &&
    route === currentRoute() &&
    query === JSON.stringify(state.boardQuery);
  const targets = new Map(state.board?.groups.map((group) => [group.id, group.items.length]));
  const response = await get(boardUrl());
  if (route !== 'board' || !current()) return response;
  for (const group of response.groups) {
    const target = targets.get(group.id) ?? 20;
    while (group.nextCursor && group.items.length < Math.min(target, group.total)) {
      if (!current()) return response;
      const cursor = group.nextCursor;
      const page = await get(
        boardUrl(group.id, cursor, Math.min(100, target - group.items.length)),
      );
      if (!current()) return response;
      const incoming = page.groups.find((item) => item.id === group.id);
      if (!incoming || incoming.nextCursor === cursor) throw new Error('看板分页响应无效，请重试');
      const unique = new Map(
        [...group.items, ...incoming.items].map((item) => [`${item.kind}:${item.sessionId}`, item]),
      );
      group.items = Array.from(unique.values());
      group.total = incoming.total;
      group.nextCursor = incoming.nextCursor;
    }
  }
  return response;
}
function synchronizeSessions(): void {
  state.sessions = (state.board?.groups ?? [])
    .flatMap((group) => group.items)
    .filter(
      (item): item is BoardItem & { currentState: TaskState } =>
        item.kind === 'session' && item.currentState !== null,
    )
    .map((item) => ({
      sessionId: item.sessionId,
      toolId: item.toolId,
      title: item.title,
      currentState: item.currentState,
      updatedAt: item.updatedAt,
    }));
}

/** @description: Independent sections retain successful data and report their own failed requests. */
async function refresh(background = false): Promise<void> {
  // 自动刷新不与手动刷新/路由加载叠加；变更版本会保留到下一次成功读取。
  if (
    background &&
    (refreshesInFlight > 0 || boardLoadsInFlight > 0 || Date.now() < backgroundRefreshAt)
  ) {
    scheduleRefresh();
    return;
  }
  refreshesInFlight += 1;
  let requestCount = 0;
  try {
    const route = currentRoute();
    if (route !== state.route) captureDrafts();
    const changedRoute = route !== state.route;
    if (changedRoute) {
      ++nativeVoicesSequence;
      state.nativeVoicesLoading = false;
    }
    state.route = route;
    if (changedRoute && (route === 'board' || route === 'overview')) state.board = null;
    state.boardLoading = (route === 'board' || route === 'overview') && state.board === null;
    if (renderedRoute !== route) render();
    const sequence = ++loadSequence;
    const windowVersion = boardWindowVersion;
    const requests: Array<{
      key: RefreshKey;
      version: number;
      promise: Promise<unknown>;
      commit: (value: unknown) => void;
    }> = [];
    const get = <T>(path: string): Promise<T> => {
      requestCount += 1;
      return Api.get<T>(path);
    };
    const add = <T>(key: RefreshKey, path: string, commit: (value: T) => void): void => {
      const version = refreshVersions.get(key) ?? 0;
      const cached = refreshCache.get(key);
      if (
        background &&
        !changedRoute &&
        !state.sectionErrors[key] &&
        cached?.version === version &&
        Date.now() - cached.at < refreshTtl[key]
      )
        return;
      requests.push({
        key,
        version,
        promise: key === 'board' ? refreshBoard(sequence, get<BoardResponse>) : get<T>(path),
        commit: (value) => commit(value as T),
      });
    };
    if (route === 'overview' || route === 'board') {
      add<BoardResponse>('board', boardUrl(), (value) => {
        // 请求期间用户刚加载了更多记录：保留用户的新窗口，下轮按新深度重读。
        if (windowVersion !== boardWindowVersion) {
          invalidateResources('board');
          scheduleRefresh();
          return;
        }
        state.board = value;
        synchronizeSessions();
      });
      add<ToolSummary[]>('tools', '/api/v1/tools', (value) => {
        state.tools = value;
      });
      if (route === 'overview')
        add<OverviewSummary>('overview', '/api/v1/overview', (value) => {
          state.overview = value;
        });
    }
    if (route === 'office') {
      add<OfficeSnapshot>('office', '/api/v1/office', (value) => {
        state.office = value;
        state.sessions = value.workstations.flatMap((item) => item.tasks)
          .filter((item): item is BoardItem & { currentState: TaskState } => item.currentState !== null)
          .map((item) => ({ sessionId: item.sessionId, toolId: item.toolId, title: item.title,
            currentState: item.currentState, updatedAt: item.updatedAt }));
      });
      add<ToolSummary[]>('tools', '/api/v1/tools', (value) => { state.tools = value; });
    }
    if (route === 'adapters') {
      add<AdapterManifest[]>('adapters', '/api/v1/adapters', (value) => {
        state.adapters = value;
      });
      add<ToolSummary[]>('tools', '/api/v1/tools', (value) => {
        state.tools = value;
      });
    }
    if (route === 'notifications')
      add<ToolSummary[]>('tools', '/api/v1/tools', (value) => {
        state.tools = value;
      });
    add<NotificationItem[]>('notifications', notificationsUrl(), (value) => {
      state.notifications = value;
      // 拉满请求条数视为还有更早记录；不足则已到底。
      state.noticeHasMore = value.length >= noticeRequestLimit();
    });
    add<Settings>('settings', '/api/v1/settings', (value) => {
      // 设置页可能有未保存的预览：服务端的新值作为基准，未保存字段覆盖回去。
      if (!settingsSaveCount) rebasePendingSettings(value);
    });
    if (route === 'settings') {
      if (state.nativeVoices === null && !state.nativeVoicesLoading && !state.sectionErrors.voices)
        void loadNativeVoices();
      if (settingsNeedModel(state.settings)) {
        // 两套本地模型状态都取一次：切换引擎时不必等待网络往返。
        if (state.modelStatus === null) void loadModelState('kokoro');
        if (state.zipvoiceModelStatus === null) void loadModelState('zipvoice');
      }
      add<VoiceRule[]>('rules', '/api/v1/voice/rules', (value) => {
        state.rules = value;
      });
      add<McpServerItem[]>('servers', '/api/v1/mcp/servers', (value) => {
        state.mcpServers = value;
      });
    }
    if (route === 'integrations') {
      add<McpSnippet[]>('snippets', '/api/v1/mcp/snippets', (value) => {
        state.mcpSnippets = value;
      });
      add<HookIntegration[]>('hooks', '/api/v1/integrations/hooks', (value) => {
        state.hookIntegrations = value;
      });
    }
    const results = await Promise.allSettled(requests.map((item) => item.promise));
    if (sequence !== loadSequence || route !== currentRoute()) return;
    results.forEach((result, index) => {
      const request = requests[index];
      if (result.status === 'fulfilled') {
        request.commit(result.value);
        refreshCache.set(request.key, { at: Date.now(), version: request.version });
        delete state.sectionErrors[request.key];
      } else state.sectionErrors[request.key] = errorMessage(result.reason);
    });
    if (route === 'office') syncOfficeSelection(state);
    state.boardLoading = false;
    render();
  } finally {
    refreshesInFlight -= 1;
    // 自动读取最多约 40 次/分钟，给 Hooks、手动操作和 MCP 留出限流余量。
    // 多页看板按实际请求数延长间隔，避免深分页抵消局部刷新的收益。
    if (requestCount > 0)
      backgroundRefreshAt = Math.max(
        backgroundRefreshAt,
        Date.now() + Math.max(5_000, requestCount * 1_500),
      );
  }
}

const MODEL_STATES = ['missing', 'downloading', 'extracting', 'ready', 'error'] as const;

/** @description: 模型状态只在本地后端的设置界面需要。 */
function settingsNeedModel(settings: Settings | null): boolean {
  return settings?.voice.backend === 'local';
}

/** @description: 校验并规整外部传入的模型状态；不识别的负载返回 null。 */
function normalizeModelStatus(value: unknown): ModelStatus | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const stateName = MODEL_STATES.find((name) => raw.state === name);
  if (!stateName) return null;
  const count = (input: unknown): number | undefined =>
    typeof input === 'number' && Number.isFinite(input) && input >= 0 ? input : undefined;
  return {
    state: stateName,
    percent: count(raw.percent),
    bytes: count(raw.bytes),
    totalBytes: count(raw.totalBytes),
    error: typeof raw.error === 'string' ? raw.error.slice(0, 400) : undefined,
  };
}

/** @description: 两套本地模型各自保存状态；SSE 与 GET 都按 kind 写入。 */
function applyModelStatus(kind: ModelKind, status: ModelStatus | null): void {
  if (!status) return;
  if (kind === 'zipvoice') state.zipvoiceModelStatus = status;
  else state.modelStatus = status;
}

/** @description: 模型状态只在本地后端界面使用；GET 取初始快照，之后的变化经 SSE 推送。 */
async function loadModelState(kind: ModelKind): Promise<void> {
  try {
    const status = normalizeModelStatus(
      await Api.get<ModelStatus>(`/api/v1/voice/model?kind=${kind}`),
    );
    // SSE 可能先于 GET 到达；不覆盖更新鲜的状态。
    if (status && (kind === 'zipvoice' ? state.zipvoiceModelStatus : state.modelStatus) === null) {
      applyModelStatus(kind, status);
      if (state.route === 'settings') render();
    }
  } catch {
    // 读取失败不阻塞设置页：界面按"未下载"呈现；试听会显示本地后端错误，不切换音色。
  }
}

/** @description: Voice enumeration is cached separately from polling and rejects stale route responses. */
async function loadNativeVoices(): Promise<void> {
  if (state.route !== 'settings' || currentRoute() !== 'settings') return;
  const sequence = ++nativeVoicesSequence;
  state.nativeVoicesLoading = true;
  delete state.sectionErrors.voices;
  render();
  const isCurrent = (): boolean =>
    sequence === nativeVoicesSequence &&
    state.route === 'settings' &&
    currentRoute() === 'settings';
  try {
    const result = await Api.get<NativeVoiceList>('/api/v1/voice/voices');
    if (!isCurrent()) return;
    if (
      !Array.isArray(result.voices) ||
      result.voices.some(
        (voice) =>
          !voice ||
          typeof voice.id !== 'string' ||
          !voice.id ||
          typeof voice.name !== 'string' ||
          typeof voice.language !== 'string',
      )
    )
      throw new Error('服务返回了不可识别的音色列表');
    state.nativeVoices = Array.from(
      new Map(result.voices.map((voice) => [voice.id, voice])).values(),
    );
    if (result.error) state.sectionErrors.voices = result.error;
  } catch (error) {
    if (isCurrent()) state.sectionErrors.voices = errorMessage(error);
  } finally {
    if (sequence === nativeVoicesSequence) {
      state.nativeVoicesLoading = false;
      if (isCurrent()) render();
    }
  }
}

/** @description: A cursor request is discarded after a filter or route change. */
async function loadBoardGroup(groupId: BoardGroupId, cursor: string): Promise<void> {
  boardLoadsInFlight += 1;
  try {
    const sequence = loadSequence;
    const query = JSON.stringify(state.boardQuery);
    const response = await Api.get<BoardResponse>(boardUrl(groupId, cursor));
    if (
      sequence !== loadSequence ||
      state.route !== 'board' ||
      query !== JSON.stringify(state.boardQuery)
    )
      return;
    const incoming = response.groups.find((group) => group.id === groupId);
    const current = state.board?.groups.find((group) => group.id === groupId);
    if (!incoming || !current) return;
    const unique = new Map(
      [...current.items, ...incoming.items].map((item) => [`${item.kind}:${item.sessionId}`, item]),
    );
    current.items = Array.from(unique.values());
    current.total = incoming.total;
    current.nextCursor = incoming.nextCursor;
    boardWindowVersion += 1;
    synchronizeSessions();
    render();
  } finally {
    boardLoadsInFlight -= 1;
  }
}

/** @description: Capture drawer identity and focus to reject stale timeline responses. */
async function openTimeline(sessionId: string): Promise<void> {
  const sequence = ++drawerSequence;
  activeSessionId = sessionId;
  const session = state.sessions.find((item) => item.sessionId === sessionId) ?? null;
  const drawer = qs<HTMLElement>('#drawer');
  const body = qs<HTMLElement>('#drawer-body');
  if (drawer.hidden)
    returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  qs<HTMLElement>('#drawer-title').textContent = displayTaskTitle(
    session ?? { sessionId },
    state.tools,
  );
  qs<HTMLElement>('#drawer-subtitle').textContent =
    `${session?.toolId ? `${session.toolId} · ` : ''}${sessionId}`;
  body.innerHTML = '<div class="empty">正在读取时间线…</div>';
  drawer.hidden = false;
  qs<HTMLElement>('#app').inert = true;
  drawer.querySelector<HTMLButtonElement>('button[data-close]')?.focus();
  try {
    const records = await Api.get<TransitionRecord[]>(
      `/api/v1/sessions/${encodeURIComponent(sessionId)}/timeline?limit=100`,
    );
    if (sequence !== drawerSequence || activeSessionId !== sessionId || drawer.hidden) return;
    body.innerHTML = renderTimeline(records, session);
    const copy = body.querySelector<HTMLElement>('[data-copy-session]');
    if (copy) copy.dataset.copySession = sessionId;
  } catch (error) {
    if (sequence === drawerSequence && !drawer.hidden)
      body.innerHTML = errorBlock(errorMessage(error));
  }
}
function closeDrawer(): void {
  const drawer = qs<HTMLElement>('#drawer');
  if (drawer.hidden) return;
  ++drawerSequence;
  drawer.hidden = true;
  // 确认弹窗可能还叠在上面：inert 要保留到它也关掉。
  if (!isConfirmOpen()) qs<HTMLElement>('#app').inert = false;
  if (returnFocus?.isConnected) returnFocus.focus({ preventScroll: true });
  else {
    const replacement = Array.from(document.querySelectorAll<HTMLElement>('[data-session]')).find(
      (node) => node.dataset.session === activeSessionId,
    );
    (replacement ?? qs<HTMLElement>('#view')).focus({ preventScroll: true });
  }
  returnFocus = null;
}

/** 设置补丁：顶层 section → 字段 → 值。 */
type SettingsPatch = Record<string, Record<string, unknown>>;

/** @description: Typed setting patches preserve additional quiet ranges. */
function buildPatch(
  path: string,
  value: unknown,
  // 基准取预览副本：连续两次编辑（如两个时段、两次收藏）必须叠加，不能互相覆盖。
  settings: Settings | null = workingSettings(),
): SettingsPatch {
  const [section, field] = path.split('.');
  if (path === 'voice.rate' || path === 'voice.volume' || path === 'scan.autoIntervalHours') {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) throw new Error('请输入有效数字');
    return { [section]: { [field]: numeric } };
  }
  if (
    [
      'voice.enabled',
      'voice.cloudEnabled',
      'privacy.sessionFileRead',
      'privacy.auditLog',
      'quiet.globalMute',
      'quiet.waitingHumanOverride',
    ].includes(path)
  )
    return { [section]: { [field]: value === true } };
  if (
    section === 'voice' &&
    [
      'backend',
      'voiceProfile',
      'cloudEndpoint',
      'cloudModel',
      'cloudVoice',
      'cloudApiKey',
    ].includes(field)
  ) {
    const text = String(value);
    // 密钥输入框不回填；留空表示保持已保存的值，避免每次保存都被空字符串覆盖。
    if (field === 'cloudApiKey' && !text.trim()) return {};
    // 接口地址始终保存实际值：清空后回到官方地址，而不是留下一个空输入框。
    if (field === 'cloudEndpoint') {
      return { voice: { cloudEndpoint: text.trim() || CLOUD_ENDPOINT_DEFAULT } };
    }
    return { voice: { [field]: text } };
  }
  if (section === 'voice' && (field === 'scope' || field === 'content')) {
    // 枚举值由下拉框给出；只接受 schema 允许的项，避免把未知值写进设置。
    const allowed = field === 'scope' ? ['attention', 'milestones', 'all'] : ['title', 'prompt'];
    if (!allowed.includes(String(value))) return {};
    return { voice: { [field]: String(value) } };
  }
  if (section === 'voice' && field === 'localEngine') {
    const engine = String(value);
    if (engine !== 'kokoro' && engine !== 'zipvoice') return {};
    return { voice: { localEngine: engine } };
  }
  if (section === 'voice' && field === 'zipvoiceReferenceText') {
    const text = String(value);
    if (text.length > 500) throw new Error('录音原文不能超过 500 字');
    return { voice: { zipvoiceReferenceText: text } };
  }
  if (section === 'voice' && field === 'zipvoiceReferencePath') {
    return { voice: { zipvoiceReferencePath: String(value).slice(0, 500) } };
  }
  const rangeMatch = /^quiet\.ranges\.(\d+)\.(from|to)$/.exec(path);
  if (rangeMatch || path === 'quiet.from' || path === 'quiet.to') {
    const index = rangeMatch ? Number(rangeMatch[1]) : 0;
    const side = rangeMatch?.[2] ?? field;
    const ranges = (settings?.quiet.ranges ?? []).map((range) => ({ ...range }));
    if (!ranges[index]) ranges[index] = { from: '22:30', to: '08:30' };
    ranges[index] = { ...ranges[index], [side]: String(value) };
    return { quiet: { ranges } };
  }
  return {};
}

/** @description: 深拷贝设置；渲染层没有 structuredClone，vm 测试环境同样没有。 */
function cloneSettings(source: Settings): Settings {
  return JSON.parse(JSON.stringify(source)) as Settings;
}

/** 预览副本：设置页的渲染与补丁都以它为准。 */
function workingSettings(): Settings | null {
  return pendingSettings ?? state.settings;
}

/** 时段的多字段编辑归并成一条待保存项，避免出现写了一半的时段。 */
function pendingPathFor(path: string): string {
  return path === 'quiet.from' ||
    path === 'quiet.to' ||
    path === 'quiet.ranges' ||
    path.startsWith('quiet.ranges.')
    ? 'quiet.ranges'
    : path;
}

/** @description: 只输出相对最后一次保存真正变化的字段；改回原值会自动消失。 */
function collectPendingPatch(
  base: Settings | null,
  preview: Settings | null,
  paths: Iterable<string>,
): SettingsPatch {
  const patch: SettingsPatch = {};
  if (!base || !preview) return patch;
  const before = base as unknown as Record<string, Record<string, unknown>>;
  const after = preview as unknown as Record<string, Record<string, unknown>>;
  for (const path of paths) {
    const [section, field] = path.split('.');
    if (!section || !field) continue;
    const previous = before[section]?.[field];
    const next = after[section]?.[field];
    if (JSON.stringify(previous) === JSON.stringify(next)) continue;
    (patch[section] ??= {})[field] = next;
  }
  return patch;
}

/** 待保存的设置字段数 + 规则条数。 */
function pendingChangeCount(): number {
  const patch = collectPendingPatch(state.settings, pendingSettings, pendingPaths);
  const fields = Object.values(patch).reduce(
    (sum, section) => sum + Object.keys(section).length,
    0,
  );
  return fields + pendingRules.size;
}

function hasPendingChanges(): boolean {
  return pendingChangeCount() > 0;
}

/** 待保存规则叠加到已保存规则上，供规则表与策略摘要预览。 */
function previewRules(): VoiceRule[] {
  if (!pendingRules.size) return state.rules;
  const rules = state.rules.map((rule) => ({ ...rule }));
  for (const [event, entry] of pendingRules) {
    const index = rules.findIndex((rule) => !rule.scopeTool && rule.scopeEvent === event);
    if (index >= 0) rules[index] = { ...rules[index], action: entry.action } as VoiceRule;
    else
      rules.push({
        ruleId: `pending:${event}`,
        scopeTool: null,
        scopeEvent: event,
        action: entry.action,
      } as VoiceRule);
  }
  return rules;
}

/** @description: 暂存一次修改；空补丁（如留空的 API Key）不登记，避免空保存。 */
function stagePatch(patch: SettingsPatch, paths: Iterable<string> = []): boolean {
  const sections = Object.entries(patch).filter(([, fields]) => Object.keys(fields).length > 0);
  if (!sections.length) return false;
  const preview = cloneSettings(pendingSettings ?? state.settings!);
  const target = preview as unknown as Record<string, Record<string, unknown>>;
  for (const [section, fields] of sections) {
    target[section] = { ...(target[section] ?? {}), ...fields };
    for (const field of Object.keys(fields)) pendingPaths.add(`${section}.${field}`);
  }
  for (const path of paths) pendingPaths.add(path);
  pendingSettings = preview;
  render();
  return true;
}

/** 暂存播报规则；选回原值时从待保存里移除。 */
function stageRule(event: string, action: string): void {
  const original = String(genericVoiceAction(state.rules, event));
  if (action === original) pendingRules.delete(event);
  else pendingRules.set(event, { action, original });
  render();
}

/**
 * 服务端设置前进后重新对齐预览：待保存字段覆盖到新基准上，其余字段跟随服务端。
 */
function rebasePendingSettings(next: Settings): void {
  const preview = pendingSettings;
  state.settings = next;
  if (!preview) return;
  const merged = cloneSettings(next);
  const target = merged as unknown as Record<string, Record<string, unknown>>;
  const source = preview as unknown as Record<string, Record<string, unknown>>;
  for (const path of pendingPaths) {
    const [section, field] = path.split('.');
    if (!section || !field) continue;
    const value = source[section]?.[field];
    if (value === undefined) continue;
    target[section] = { ...(target[section] ?? {}), [field]: value };
  }
  pendingSettings = merged;
}

/** 丢弃全部未保存修改，连同这些控件的草稿。 */
function clearPendingState(): void {
  pendingSettings = null;
  pendingPaths.clear();
  pendingRules.clear();
  const values = routeDrafts('settings');
  // 只清设置与规则控件；试听文本等纯界面输入保留。
  for (const id of Array.from(values.keys()))
    if (id.startsWith('setting-') || id.startsWith('rule-')) values.delete(id);
  delete state.sectionErrors.settings;
}

/** @description: Serialize setting saves so later changes build from the last committed settings. */
function saveSettings(
  patch: Record<string, unknown> | (() => Record<string, unknown>),
  draft?: { id: string; revision: number },
): Promise<void> {
  ++settingsSaveCount;
  renderChrome();
  const operation = settingsSaveTail.then(async () => {
    const body = typeof patch === 'function' ? patch() : patch;
    if (!Object.keys(body).length) return;
    // 设置页的预览副本以旧值为基准；服务端前进后要重新叠加，否则预览会把新值冲掉。
    rebasePendingSettings(await Api.put<Settings>('/api/v1/settings', body));
    delete state.sectionErrors.settings;
    if (draft && routeDrafts('settings').get(draft.id)?.revision === draft.revision)
      routeDrafts('settings').delete(draft.id);
  });
  settingsSaveTail = operation.catch(() => undefined);
  return operation
    .catch((error: unknown) => {
      state.sectionErrors.settings = errorMessage(error);
      throw error;
    })
    .finally(() => {
      --settingsSaveCount;
      render();
    });
}

/** 规则保存成功后同步到本地列表，避免规则表要等下一次刷新才变。 */
function applySavedRule(event: string, action: string): void {
  const index = state.rules.findIndex((rule) => !rule.scopeTool && rule.scopeEvent === event);
  if (index >= 0)
    state.rules[index] = { ...state.rules[index], action: action as VoiceRule['action'] } as VoiceRule;
  else
    state.rules.push({
      ruleId: `event:${event}`,
      scopeTool: null,
      scopeEvent: event,
      action: action as VoiceRule['action'],
    } as VoiceRule);
}

/** 保存成功后清掉已提交字段的草稿；保存期间又被改过的草稿保留。 */
function releaseCommittedDrafts(revisions: Map<string, number>): void {
  const values = routeDrafts('settings');
  for (const [id, revision] of revisions) {
    if (!id.startsWith('setting-') && !id.startsWith('rule-')) continue;
    if (values.get(id)?.revision !== revision) continue;
    values.delete(id);
  }
}

/**
 * @description: 设置页的「保存」：一次 PUT 合并全部改动，播报规则再逐条提交。
 * 失败时保留待保存内容，状态栏提示可重试。
 */
function savePendingSettings(): Promise<boolean> {
  ++settingsSaveCount;
  renderChrome();
  const operation = settingsSaveTail.then(commitPendingSettings);
  settingsSaveTail = operation.then(
    () => undefined,
    () => undefined,
  );
  return operation.finally(() => {
    --settingsSaveCount;
    renderChrome();
  });
}

async function commitPendingSettings(): Promise<boolean> {
  const patch = collectPendingPatch(state.settings, pendingSettings, pendingPaths);
  const rules = Array.from(pendingRules);
  const revisions = new Map(
    Array.from(routeDrafts('settings')).map(([id, draft]) => [id, draft.revision]),
  );
  if (!Object.keys(patch).length && !rules.length) {
    render(true);
    return true;
  }
  try {
    if (Object.keys(patch).length) {
      rebasePendingSettings(await Api.put<Settings>('/api/v1/settings', patch));
      delete state.sectionErrors.settings;
    }
    const failed: string[] = [];
    for (const [event, entry] of rules) {
      try {
        await Api.post('/api/v1/voice/rules', { scopeEvent: event, action: entry.action });
        // 保存期间又被改过的规则保留为待保存，不能被这次结果覆盖。
        if (pendingRules.get(event)?.action === entry.action) pendingRules.delete(event);
        applySavedRule(event, entry.action);
      } catch {
        failed.push(eventLabel(event));
      }
    }
    releaseCommittedDrafts(revisions);
    if (!hasPendingChanges()) clearPendingState();
    if (failed.length) {
      toast(`设置已保存，播报规则未保存：${failed.join('、')}`);
      return false;
    }
    toast('设置已保存');
    return true;
  } catch (error) {
    state.sectionErrors.settings = errorMessage(error);
    toast(`保存失败：${errorMessage(error)}`);
    return false;
  } finally {
    render(true);
  }
}

/** 放弃全部未保存修改；已保存的设置本身没有被改动，无需重新拉取。 */
function discardPendingSettings(): void {
  clearPendingState();
  render(true);
}

/** @description: 离开设置页前确认；设置页内的分区跳转只是滚动，不经过这里。 */
async function requestLeaveSettings(targetHash: string): Promise<void> {
  await settingsSaveTail;
  if (!hasPendingChanges()) {
    window.location.hash = targetHash;
    return;
  }
  const count = pendingChangeCount();
  const choice = await openConfirm({
    title: '离开设置前保存修改？',
    body: `有 ${count} 项设置尚未保存，离开后会丢失。`,
    saveLabel: '保存并离开',
    discardLabel: '不保存',
    cancelLabel: '取消',
  });
  if (choice === 'cancel') return;
  if (choice === 'save') {
    if (!(await savePendingSettings())) return;
  } else discardPendingSettings();
  window.location.hash = targetHash;
}

interface CloseRequest {
  requestId: number;
  reason: 'close' | 'quit';
}

/** @description: 主进程在关闭窗口/退出前询问；返回值决定它是否继续。 */
async function handleConfirmClose(request: CloseRequest): Promise<void> {
  const respond = (proceed: boolean): void => {
    window.awm?.respondClose(request.requestId, proceed);
  };
  try {
    // 已有确认框时把新请求按取消处理，避免两个流程互相覆盖。
    if (isConfirmOpen()) {
      respond(false);
      return;
    }
    await settingsSaveTail;
    if (!hasPendingChanges()) {
      respond(true);
      return;
    }
    const quitting = request.reason === 'quit';
    // 托盘退出时窗口可能是隐藏的：先显示出来，用户才能做选择。
    if (quitting) await window.awm?.showWindow();
    const choice = await openConfirm({
      title: quitting ? '退出前保存设置？' : '关闭窗口前保存设置？',
      body: `有 ${pendingChangeCount()} 项设置尚未保存，${quitting ? '退出' : '关闭窗口'}后会丢失。`,
      saveLabel: quitting ? '保存并退出' : '保存并关闭',
      discardLabel: quitting ? '直接退出' : '不保存',
      cancelLabel: '取消',
    });
    if (choice === 'save') {
      respond(await savePendingSettings());
      return;
    }
    if (choice === 'discard') discardPendingSettings();
    respond(choice === 'discard');
  } catch (error) {
    state.sectionErrors.settings = errorMessage(error);
    respond(false);
  }
}

/**
 * @description: 试听与保存解耦：只等正在进行的保存落盘，始终播放上次保存的后端与音色。
 */
async function waitForSavedVoice(): Promise<void> {
  let tail: Promise<void>;
  do {
    tail = settingsSaveTail;
    await tail;
  } while (tail !== settingsSaveTail);
}

/** @description: 后端内部名转用户可读标签；本地后端按当前引擎区分 Kokoro 与 ZipVoice。 */
function backendLabel(name?: string, localEngine?: string): string {
  return name === 'local'
    ? localEngine === 'zipvoice'
      ? '本地 ZipVoice'
      : '本地 Kokoro'
    : name === 'cloud'
      ? '云 TTS（MiMo）'
      : '系统原生';
}

async function auditionVoice(text: string): Promise<void> {
  if (!window.awm) throw new Error('桌面桥接尚未就绪');
  state.speakResult = null;
  await waitForSavedVoice();
  state.speakResult = await window.awm.speakTest(text || '这是一条测试播报');
  // 结果内联在试听按钮下方；再用 toast 会叠一层浮层，不额外提示。
  // 试听期间可能正在选音色：不强制重绘，避免下拉被重建后收起。
  const active = document.activeElement;
  const editing =
    active instanceof HTMLSelectElement ||
    (active instanceof HTMLElement && !!active.closest('.voice-picker'));
  render(!editing);
  if (editing) {
    const result = document.getElementById('speak-result');
    if (result) {
      result.textContent = state.speakResult.ok
        ? `播放完成 · ${backendLabel(state.speakResult.usedBackend, state.settings?.voice.localEngine)}`
        : `播放失败：${state.speakResult.errors.join('；')}`;
      result.classList.toggle('is-error', !state.speakResult.ok);
    }
  }
}

/** 回退到安全音色是一次设置修改，和其它字段一起等待「保存」。 */
function useSafeVoiceProfile(): void {
  // 旧音色的草稿会让下拉回到不可用的值，暂存后必须一并清掉。
  routeDrafts('settings').delete('setting-voice-voiceProfile');
  stagePatch(buildPatch('voice.voiceProfile', 'system-default'));
  toast('已设为自动普通话音色，保存后生效');
}

/** @description: 暂存用户亲自试听后的名称；按 profile 合并，保留其他声音的备注。 */
function saveKokoroVoiceName(remove = false): void {
  const settings = workingSettings();
  if (!settings || settings.voice.backend !== 'local') throw new Error('请先选择本地 Kokoro');
  const selected = selectedKokoroVoice(settings.voice.voiceProfile);
  const id = `kokoro-voice-name-${selected.profile.slice(7)}`;
  const name = inputValue(id);
  if (!remove && (!name || name.length > 32)) throw new Error('请输入 1–32 字的音色名称');
  stagePatch({
    voice: {
      savedVoices: [
        ...(settings.voice.savedVoices ?? []).filter((voice) => voice.profile !== selected.profile),
        ...(!remove ? [{ profile: selected.profile, name }] : []),
      ],
    },
  });
  toast(remove ? '已移出常用音色，保存后生效' : '音色名称已加入常用，保存后生效');
}

async function copyHookFile(integrationId: string, filePath: string): Promise<void> {
  const integration = state.hookIntegrations.find((item) => item.id === integrationId);
  if (!integration?.commandReady) throw new Error('任务事件接收入口不可用，请刷新后再复制');
  const file = integration.files.find((item) => item.path === filePath);
  if (!file) throw new Error('配置文件已更新，请刷新后重新复制');
  await navigator.clipboard.writeText(file.content);
}

/** @description: Copy the selected tool's original config, independent of rendered markup. */
async function copyMcpSnippet(toolId: string): Promise<void> {
  const snippet = state.mcpSnippets.find((item) => item.id === toolId);
  if (!snippet) throw new Error('MCP 配置已更新，请刷新后重新复制');
  await navigator.clipboard.writeText(snippet.json);
}

/** @description: Every async user action has pending state and a visible failure. */
async function perform(key: string, selector: string, action: () => Promise<void>): Promise<void> {
  if (pendingActions.has(key)) return;
  pendingActions.set(key, selector);
  state.error = null;
  document.querySelector('[data-region="view-feedback"]')?.replaceChildren();
  applyPending();
  try {
    await action();
  } catch (error) {
    state.error = errorMessage(error);
    toast(state.error);
    render();
  } finally {
    pendingActions.delete(key);
    releasePending(selector);
    // 按钮的真实可用状态由设置页状态决定；临时禁用恢复后要重新画一次。
    renderChrome();
  }
}
function inputValue(id: string): string {
  const input = document.getElementById(id);
  return input instanceof HTMLInputElement ||
    input instanceof HTMLTextAreaElement ||
    input instanceof HTMLSelectElement
    ? input.value.trim()
    : '';
}
function parseMcpArgs(raw: string): string[] {
  if (!raw.trim()) return [];
  const parsed: unknown = raw.trim().startsWith('[')
    ? JSON.parse(raw)
    : raw
        .split(/\r?\n/)
        .map((item) => item.trim())
        .filter(Boolean);
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== 'string'))
    throw new Error('参数应为 JSON 字符串数组，或每行一个参数');
  return parsed as string[];
}
async function updateTask(button: HTMLElement): Promise<void> {
  const id = button.dataset.taskId;
  const event = button.dataset.taskEvent;
  if (!id || !event) return;
  await perform(`task:${id}`, `[data-task-id="${CSS.escape(id)}"]`, async () => {
    await Api.post(`/api/v1/tasks/${encodeURIComponent(id)}/state`, { event });
    toast('AgentCue 记录已更新');
    closeDrawer();
    await refresh();
  });
}

/** @description: Delegation survives region replacement and handles nested button icons. */
function bindEvents(): void {
  qs<HTMLElement>('#nav').addEventListener('click', (event) => {
    const button = (event.target as HTMLElement).closest<HTMLElement>('[data-route]');
    const route = button?.dataset.route as RouteName | undefined;
    if (!route) return;
    navigateTo(route);
  });
  // 键盘快捷键：Cmd/Ctrl+1..6 切页，/ 聚焦看板搜索；弹层打开或正在输入时不生效。
  document.addEventListener('keydown', (event) => {
    if (!qs<HTMLElement>('#confirm').hidden || !qs<HTMLElement>('#drawer').hidden) return;
    const active = document.activeElement;
    const typing =
      active instanceof HTMLInputElement ||
      active instanceof HTMLTextAreaElement ||
      active instanceof HTMLSelectElement;
    const key = event.key;
    if ((event.metaKey || event.ctrlKey) && !event.altKey && key >= '1' && key <= '6') {
      const routes: RouteName[] = [
        'overview',
        'board',
        'notifications',
        'integrations',
        'adapters',
        'settings',
      ];
      const target = routes[Number(key) - 1];
      if (!target || target === state.route) return;
      event.preventDefault();
      navigateTo(target);
      return;
    }
    if (key === '/' && !event.metaKey && !event.ctrlKey && !event.altKey && !typing) {
      event.preventDefault();
      if (state.route !== 'board') navigateTo('board');
      // 路由切换经 hashchange 异步渲染，稍候聚焦；已在看板则立即聚焦。
      window.setTimeout(() => {
        const input = document.getElementById('board-search');
        if (input instanceof HTMLInputElement) input.focus();
      }, state.route === 'board' ? 0 : 150);
    }
  });
  qs<HTMLElement>('#btn-refresh').addEventListener('click', () => {
    state.error = null;
    void refresh();
  });
  qs<HTMLElement>('#btn-scan').addEventListener(
    'click',
    () =>
      void perform('scan', '#btn-scan', async () => {
        await window.awm?.scanNow();
        toast('安装清单已更新');
        await refresh();
      }),
  );
  qs<HTMLElement>('#mute-toggle').addEventListener(
    'click',
    () =>
      void perform('mute', '#mute-toggle', async () => {
        const next = !(state.settings?.quiet.globalMute ?? false);
        await window.awm?.setMuted(next);
        if (state.settings) state.settings.quiet.globalMute = next;
        render();
      }),
  );
  const view = qs<HTMLElement>('#view');
  bindOfficeInteractions(view);
  view.addEventListener('click', (event) => {
    const target = event.target as HTMLElement;
    const dismiss = target.closest<HTMLElement>('[data-office-dismiss]');
    if (dismiss?.dataset.officeDismiss) {
      dismissOfficeMessage(dismiss.dataset.officeDismiss, event.detail === 0);
      return;
    }
    if (target.closest('[data-office-close]')) {
      closeOfficePopover();
      return;
    }
    const employee = target.closest<HTMLElement>('[data-office-select]');
    if (employee?.dataset.officeSelect) {
      const toolId = employee.dataset.officeSelect;
      if (officeUi.openToolId === toolId) {
        closeOfficePopover();
        return;
      }
      officeUi.selectedToolId = toolId;
      officeUi.openToolId = toolId;
      officeUi.suppressedToolId = '';
      const selected = officeEmployees(state).find((item) => item.tool.toolId === officeUi.selectedToolId);
      officeUi.tab = officeDefaultTab(selected);
      render(true);
      document.getElementById('office-close')?.focus({ preventScroll: true });
      return;
    }
    const officeFilter = target.closest<HTMLElement>('[data-office-filter]');
    if (officeFilter && ['all', 'working', 'attention'].includes(officeFilter.dataset.officeFilter ?? '')) {
      officeUi.filter = officeFilter.dataset.officeFilter as OfficeFilter;
      syncOfficeSelection(state, true);
      render(true);
      return;
    }
    const officeTab = target.closest<HTMLElement>('[data-office-tab]');
    if (officeTab && ['active', 'issues', 'ended'].includes(officeTab.dataset.officeTab ?? '')) {
      officeUi.tab = officeTab.dataset.officeTab as OfficeTaskTab;
      render(true);
      return;
    }
    if (target.closest('[data-office-reset]')) {
      officeUi.filter = 'all';
      officeUi.query = '';
      syncOfficeSelection(state, true);
      routeDrafts('office').delete('office-search');
      render(true);
      document.getElementById('office-search')?.focus({ preventScroll: true });
      return;
    }
    if (target.closest('[data-office-motion]')) {
      officeUi.motion = !officeUi.motion;
      render(true);
      return;
    }
    const officeBoard = target.closest<HTMLElement>('[data-office-board]');
    if (officeBoard?.dataset.officeBoard) {
      state.boardQuery = { q: '', toolId: officeBoard.dataset.officeBoard };
      state.board = null;
      routeDrafts('board').delete('board-search');
      routeDrafts('board').delete('board-tool');
      navigateTo('board');
      return;
    }
    const task = target.closest<HTMLElement>('[data-task-event]');
    if (task) {
      void updateTask(task);
      return;
    }
    const session = target.closest<HTMLElement>('[data-session]');
    if (session?.dataset.session) {
      void openTimeline(session.dataset.session);
      return;
    }
    const section = target.closest<HTMLElement>('[data-settings-section]');
    if (section?.dataset.settingsSection) {
      jumpToSettingsSection(section.dataset.settingsSection);
      return;
    }
    const more = target.closest<HTMLElement>('[data-load-group]');
    if (more?.dataset.loadGroup && more.dataset.cursor) {
      void perform(
        `more:${more.dataset.loadGroup}`,
        `[data-load-group="${more.dataset.loadGroup}"]`,
        () => loadBoardGroup(more.dataset.loadGroup as BoardGroupId, more.dataset.cursor!),
      );
      return;
    }
    const ignore = target.closest<HTMLElement>('[data-toggle-ignore]');
    if (ignore?.dataset.toggleIgnore) {
      const id = ignore.dataset.toggleIgnore;
      void perform(`ignore:${id}`, `[data-toggle-ignore="${CSS.escape(id)}"]`, async () => {
        await Api.post(`/api/v1/tools/${encodeURIComponent(id)}/ignored`, {
          ignored: ignore.dataset.ignored !== 'true',
        });
        await refresh();
      });
      return;
    }
    const remove = target.closest<HTMLElement>('[data-remove-custom]');
    if (remove?.dataset.removeCustom) {
      void perform('remove-custom', '[data-remove-custom]', async () => {
        await saveSettings(() => ({
          scan: {
            customTools:
              state.settings?.scan.customTools.filter(
                (tool) => tool.id !== remove.dataset.removeCustom,
              ) ?? [],
          },
        }));
        await window.awm?.scanNow();
        await refresh();
      });
      return;
    }
    const range = target.closest<HTMLElement>('[data-remove-range]');
    if (range) {
      void perform('remove-range', '[data-remove-range]', async () => {
        const ranges = workingSettings()?.quiet.ranges ?? [];
        stagePatch({
          quiet: {
            ranges: ranges.filter((_item, index) => index !== Number(range.dataset.removeRange)),
          },
        });
      });
      return;
    }
    const server = target.closest<HTMLElement>('[data-validate-server]');
    if (server?.dataset.validateServer) {
      const item = state.mcpServers.find(
        (candidate) => candidate.serverId === server.dataset.validateServer,
      );
      if (item)
        void perform(
          `server:${item.serverId}`,
          `[data-validate-server="${CSS.escape(item.serverId)}"]`,
          async () => {
            const result = await Api.post<McpServerItem>('/api/v1/mcp/servers', {
              ...item,
              args: Array.isArray(item.args) ? item.args : parseMcpArgs(item.args ?? ''),
            });
            toast(
              result.validationStatus === 'verified'
                ? '验证通过'
                : `验证失败：${result.lastError ?? '请检查配置'}`,
            );
            await refresh();
          },
        );
      return;
    }
    const deleteServer = target.closest<HTMLElement>('[data-delete-mcp]');
    if (deleteServer?.dataset.deleteMcp) {
      void perform('delete-server', '[data-delete-mcp]', async () => {
        await Api.request(
          `/api/v1/mcp/servers/${encodeURIComponent(deleteServer.dataset.deleteMcp!)}`,
          'DELETE',
        );
        await refresh();
      });
      return;
    }
    const notice = target.closest<HTMLElement>('[data-read-notice]');
    if (notice?.dataset.readNotice) {
      void perform('read-notice', '[data-read-notice]', async () => {
        await Api.post('/api/v1/notifications/read', { notificationId: notice.dataset.readNotice });
        await refresh();
      });
      return;
    }
    const hookFile = target.closest<HTMLElement>('[data-copy-hook]');
    if (hookFile?.dataset.copyHook && hookFile.dataset.hookPath) {
      const id = hookFile.dataset.copyHook,
        path = hookFile.dataset.hookPath;
      void perform(
        `copy-hook:${id}:${path}`,
        `[data-copy-hook="${CSS.escape(id)}"][data-hook-path="${CSS.escape(path)}"]`,
        async () => {
          await copyHookFile(id, path);
          toast('配置内容已复制；请手动粘贴并保留已有配置');
        },
      );
      return;
    }
    const actionNode = target.closest<HTMLElement>('[data-action]');
    const action = actionNode?.dataset.action;
    if (!action) return;
    // 模型按钮区分引擎；其他动作没有 data-model-kind，仍按原 action 选择。
    const modelKind: ModelKind =
      actionNode?.dataset.modelKind === 'zipvoice' ? 'zipvoice' : 'kokoro';
    const actionKey =
      action === 'download-model' || action === 'cancel-model'
        ? `${action}:${modelKind}`
        : action;
    const actionSelector =
      action === 'download-model' || action === 'cancel-model'
        ? `[data-action="${action}"][data-model-kind="${modelKind}"]`
        : `[data-action="${action}"]`;
    void perform(actionKey, actionSelector, async () => {
      if (action === 'save-settings') {
        // 失败提示与状态在 commitPendingSettings 里统一给出，不抛给 perform。
        await savePendingSettings();
      } else if (action === 'speak-test') {
        await auditionVoice(inputValue('speak-text'));
      } else if (action === 'save-kokoro-voice' || action === 'remove-kokoro-voice') {
        saveKokoroVoiceName(action === 'remove-kokoro-voice');
      } else if (action === 'refresh-voices') {
        await loadNativeVoices();
      } else if (action === 'refresh-hooks') {
        await refresh();
      } else if (action === 'download-model') {
        // 即启即返：下载进度经 model.progress SSE 更新界面。
        const status = normalizeModelStatus(
          await Api.post<ModelStatus>('/api/v1/voice/model/download', { kind: modelKind }),
        );
        applyModelStatus(modelKind, status);
        toast(
          `已开始下载 ${modelKind === 'zipvoice' ? 'ZipVoice' : 'Kokoro'} 模型；进度在本页更新`,
        );
        render();
      } else if (action === 'cancel-model') {
        const status = normalizeModelStatus(
          await Api.post<ModelStatus>('/api/v1/voice/model/cancel', { kind: modelKind }),
        );
        applyModelStatus(modelKind, status);
        toast('已取消模型下载');
        render();
      } else if (action === 'pick-zipvoice-reference') {
        // 主进程负责格式与大小校验，并把录音复制到本机数据目录。
        const picked = await window.awm?.pickReferenceAudio();
        if (!picked) return;
        stagePatch(buildPatch('voice.zipvoiceReferencePath', picked));
        toast('参考音频已复制到本机数据目录，保存后生效');
      } else if (action === 'clear-zipvoice-reference') {
        stagePatch({ voice: { zipvoiceReferencePath: '' } });
        toast('已停用参考音频，保存后生效');
      } else if (action === 'clear-cloud-key') {
        // 清空密钥必须显式暂存空串：buildPatch 会把空输入当作「保持原值」。
        stagePatch({ voice: { cloudApiKey: '' } });
        toast('已清除云 TTS API Key，保存后生效');
      } else if (action === 'reset-cloud-endpoint') {
        stagePatch({ voice: { cloudEndpoint: CLOUD_ENDPOINT_DEFAULT } });
        toast('已恢复小米 MiMo 默认接口地址，保存后生效');
      } else if (action === 'use-safe-voice') {
        useSafeVoiceProfile();
      } else if (action === 'add-range') {
        stagePatch({
          quiet: {
            ranges: [...(workingSettings()?.quiet.ranges ?? []), { from: '22:30', to: '08:30' }],
          },
        });
      } else if (action === 'add-custom-tool') {
        const id = inputValue('custom-id'),
          name = inputValue('custom-name'),
          configPath = inputValue('custom-path');
        if (!id || !name || !configPath) throw new Error('请填写工具 ID、显示名和路径');
        if (state.settings?.scan.customTools.some((tool) => tool.id === id))
          throw new Error('该工具 ID 已存在');
        await saveSettings(() => ({
          scan: {
            customTools: [...(state.settings?.scan.customTools ?? []), { id, name, configPath }],
          },
        }));
        for (const key of ['custom-id', 'custom-name', 'custom-path'])
          routeDrafts('adapters').delete(key);
        for (const key of ['custom-id', 'custom-name', 'custom-path']) {
          const input = document.getElementById(key);
          if (input instanceof HTMLInputElement) input.value = '';
        }
        await window.awm?.scanNow();
        await refresh();
      } else if (action === 'copy-mcp') {
        await copyMcpSnippet(actionNode?.dataset.mcpId ?? '');
        toast('已复制 MCP 配置');
      } else if (action === 'validate-mcp') {
        state.mcpValidation = await Api.post<McpValidation>('/api/v1/mcp/validate');
        render(true);
      } else if (action === 'add-mcp') {
        const name = inputValue('mcp-name');
        const transport = state.externalTransport;
        const command = inputValue('mcp-command'),
          url = inputValue('mcp-url');
        if (!name || (transport === 'stdio' ? !command : !url))
          throw new Error(
            transport === 'stdio' ? '请填写名称和可执行文件' : '请填写名称和 Server URL',
          );
        const result = await Api.post<McpServerItem>('/api/v1/mcp/servers', {
          name,
          transport,
          ...(transport === 'stdio'
            ? { command, args: parseMcpArgs(inputValue('mcp-args')) }
            : { url }),
        });
        toast(
          result.validationStatus === 'verified'
            ? '配置已保存，验证通过'
            : `配置已保存，验证失败：${result.lastError ?? '请检查服务'}`,
        );
        await refresh();
      } else if (action === 'mark-all-read') {
        await Api.post('/api/v1/notifications/read', {});
        await refresh();
      } else if (action === 'load-notices') {
        // 向后翻一页更早的通知：按 id 去重后追加；不足一页说明已到底。
        const page = 50;
        const more = await Api.get<NotificationItem[]>(
          `/api/v1/notifications?limit=${page}&offset=${state.notifications.length}`,
        );
        const known = new Set(state.notifications.map((item) => item.notificationId));
        const appended = more.filter((item) => !known.has(item.notificationId));
        state.notifications = [...state.notifications, ...appended];
        state.noticeHasMore = more.length >= page;
        render(true);
      } else if (action === 'export-events') {
        // 主进程带 Content-Disposition；这里用带鉴权的 fetch 转 blob 下载。
        if (!Api.config) throw new Error('控制 API 尚未初始化');
        const response = await fetch(Api.url('/api/v1/events?download=1'), {
          headers: { Authorization: `Bearer ${Api.config.token}` },
          signal: AbortSignal.timeout(20_000),
        });
        if (!response.ok) throw new Error(`导出失败（HTTP ${response.status}）`);
        const url = URL.createObjectURL(await response.blob());
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = 'awm-events.json';
        anchor.click();
        URL.revokeObjectURL(url);
        toast('事件已导出为 JSON');
      } else if (action === 'clear-board') {
        state.boardQuery = { q: '', toolId: '' };
        routeDrafts('board').delete('board-search');
        routeDrafts('board').delete('board-tool');
        for (const id of ['board-search', 'board-tool']) {
          const control = document.getElementById(id);
          if (control instanceof HTMLInputElement || control instanceof HTMLSelectElement)
            control.value = '';
        }
        state.board = null;
        await refresh();
      }
    });
  });
  // 滚动只更新吸顶导航的当前分区，不触发重绘。
  view.addEventListener('scroll', syncSettingsNav, { passive: true });
  view.addEventListener('input', (event) => {
    const control = event.target;
    if (!(
      control instanceof HTMLInputElement ||
      control instanceof HTMLTextAreaElement ||
      control instanceof HTMLSelectElement
    ))
      return;
    if (control.hasAttribute('data-draft') || control.dataset.setting) rememberControl(control);
    if (control.dataset.setting === 'voice.rate') {
      const label = document.getElementById('rate-value');
      if (label) label.textContent = `${Number(control.value).toFixed(1)}×`;
    }
    if (control.id === 'office-search') {
      officeUi.query = control.value;
      syncOfficeSelection(state);
      render();
      return;
    }
    if (control.id === 'board-search') {
      state.boardQuery.q = control.value;
      ++loadSequence;
      if (searchTimer !== null) window.clearTimeout(searchTimer);
      searchTimer = window.setTimeout(() => {
        searchTimer = null;
        state.board = null;
        void refresh();
      }, 300);
    }
  });
  view.addEventListener('change', (event) => {
    const control = event.target;
    if (!(
      control instanceof HTMLInputElement ||
      control instanceof HTMLSelectElement ||
      control instanceof HTMLTextAreaElement
    ))
      return;
    rememberControl(control);
    if (control.id === 'board-tool') {
      state.boardQuery.toolId = control.value;
      state.board = null;
      void refresh();
      return;
    }
    if (control.id === 'notice-level-filter') {
      state.noticeLevelFilter =
        control.value === 'attention' || control.value === 'info' ? control.value : '';
      render(true);
      return;
    }
    if (control.id === 'mcp-transport') {
      state.externalTransport = control.value === 'streamable-http' ? 'streamable-http' : 'stdio';
      render(true);
      return;
    }
    if (control.dataset.ruleEvent) {
      // 播报规则和设置一起等「保存」；选回原值时自动从待保存里移除。
      stageRule(control.dataset.ruleEvent, control.value);
      routeDrafts('settings').delete(control.id);
      return;
    }
    const path = control.dataset.setting;
    if (!path) return;
    const value =
      control instanceof HTMLInputElement && control.type === 'checkbox'
        ? control.checked
        : control.value;
    // 试听结果记录的是上一次实际使用的后端；换后端或本地引擎后不再代表当前配置。
    if (path === 'voice.backend' || path === 'voice.localEngine') state.speakResult = null;
    let patch: SettingsPatch;
    try {
      patch = buildPatch(path, value);
    } catch (error) {
      toast(errorMessage(error));
      return;
    }
    if (!stagePatch(patch, [pendingPathFor(path)])) return;
    // 密钥框不清草稿：保存后输入框仍要显示用户这次填的 Key，直到重新加载设置。
    if (path !== 'voice.cloudApiKey') routeDrafts('settings').delete(control.id);
    // 下面这些字段会换掉整块面板，预览态就要切过去，不能等保存。
    if (path === 'voice.voiceProfile') render(true);
    if (path === 'voice.backend') {
      // 切换后端会换一整套音色来源：原生列表按需加载，本地音色是常量表，
      // 不刷新就会沿用上一个后端的音色，列表看起来"没反应"。
      state.nativeVoices = null;
      delete state.sectionErrors.voices;
      render(true);
      const settings = workingSettings();
      if (settingsNeedModel(settings)) {
        if (state.modelStatus === null) void loadModelState('kokoro');
        if (state.zipvoiceModelStatus === null) void loadModelState('zipvoice');
      }
      if (settings?.voice.backend !== 'local') void loadNativeVoices();
    }
    // 切换本地引擎会换模型卡与音色区，需要立即重绘。
    if (path === 'voice.localEngine') render(true);
  });
  view.addEventListener('focusout', () =>
    window.setTimeout(() => {
      if (renderedRoute === state.route) render();
    }, 0),
  );
  qs<HTMLElement>('#drawer').addEventListener('click', (event) => {
    const target = event.target as HTMLElement;
    if (target.closest('[data-close]')) {
      closeDrawer();
      return;
    }
    const action = target.closest<HTMLElement>('[data-task-event]');
    if (action) {
      void updateTask(action);
      return;
    }
    const copy = target.closest<HTMLElement>('[data-copy-session]');
    if (copy?.dataset.copySession)
      void perform('copy-timeline', '[data-copy-session]', async () => {
        const records = await Api.get<TransitionRecord[]>(
          `/api/v1/sessions/${encodeURIComponent(copy.dataset.copySession!)}/timeline?limit=100`,
        );
        await navigator.clipboard.writeText(JSON.stringify(records, null, 2));
        toast('已复制时间线');
      });
  });
  qs<HTMLElement>('#confirm').addEventListener('click', (event) => {
    const target = event.target as HTMLElement;
    // 遮罩等于「取消」：不改 hash、不保存、不丢弃。
    const choice = target.closest<HTMLElement>('[data-confirm]')?.dataset.confirm;
    if (choice === 'save' || choice === 'discard' || choice === 'cancel')
      resolveConfirm(choice);
  });
  document.addEventListener('keydown', (event) => {
    // 确认弹窗叠在抽屉之上时优先处理它；两者互斥，同一时刻只有一个焦点陷阱。
    const confirm = qs<HTMLElement>('#confirm');
    const layer = confirm.hidden ? qs<HTMLElement>('#drawer') : confirm;
    if (layer.hidden) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      if (layer === confirm) resolveConfirm('cancel');
      else closeDrawer();
      return;
    }
    if (event.key !== 'Tab') return;
    const items = Array.from(
      layer.querySelectorAll<HTMLElement>(
        'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), [tabindex="0"]',
      ),
    );
    const first = items[0],
      last = items[items.length - 1];
    if (
      event.shiftKey &&
      (document.activeElement === first || !layer.contains(document.activeElement))
    ) {
      event.preventDefault();
      last?.focus();
    } else if (
      !event.shiftKey &&
      (document.activeElement === last || !layer.contains(document.activeElement))
    ) {
      event.preventDefault();
      first?.focus();
    }
  });
  window.addEventListener('hashchange', () => {
    // 还原 hash 时触发的那次事件：已经停在设置页，不需要重新加载。
    if (restoringHash) {
      restoringHash = false;
      return;
    }
    const target = window.location.hash || '#/overview';
    // 兜底历史前进后退、手改地址等不经过左侧导航的离开方式。
    if (state.route === 'settings' && currentRoute() !== 'settings' && hasPendingChanges()) {
      restoringHash = true;
      window.location.hash = '#/settings';
      void requestLeaveSettings(target);
      return;
    }
    state.error = null;
    void refresh();
  });
}

/** 统一的路由跳转：离开设置页且有未保存修改时先确认。 */
function navigateTo(route: RouteName): void {
  if (state.route === 'settings' && route !== 'settings' && hasPendingChanges()) {
    void requestLeaveSettings(`#/${route}`);
    return;
  }
  window.location.hash = `#/${route}`;
}

function connectStream(): void {
  void openStream();
}

/** SSE 断开后的退避时长；连接成功后归零。 */
let streamBackoffMs = 0;
let streamRetryTimer: number | null = null;

function scheduleStreamRetry(): void {
  if (streamRetryTimer !== null) return;
  streamBackoffMs = streamBackoffMs ? Math.min(streamBackoffMs * 2, 15_000) : 500;
  streamRetryTimer = window.setTimeout(() => {
    streamRetryTimer = null;
    void openStream();
  }, streamBackoffMs);
}

/**
 * @description: 连接票据是一次性的：先换票再建 EventSource；断开后必须换新票重建，
 * EventSource 自带重连会拿已消耗的旧票得到 401。
 */
async function openStream(): Promise<void> {
  stream?.close();
  stream = null;
  if (streamRetryTimer !== null) {
    window.clearTimeout(streamRetryTimer);
    streamRetryTimer = null;
  }
  let ticket: string;
  try {
    ticket = await Api.createStreamTicket();
  } catch {
    qs<HTMLElement>('#runtime-hint').textContent = '实时连接暂时中断 · 正在自动重连';
    scheduleStreamRetry();
    return;
  }
  stream = Api.stream(ticket, (type, data) => {
    if (type === 'notify') {
      const notice = data as { title?: string; body?: string };
      toast(`${notice.title ?? '通知'}：${notice.body ?? ''}`);
    }
    if (type === 'model.progress') {
      // 下载进度高频到达：只更新状态并重绘，不得触发整页 refresh（会打爆 API 限流）。
      const kind: ModelKind =
        (data as { kind?: unknown } | null)?.kind === 'zipvoice' ? 'zipvoice' : 'kokoro';
      const status = normalizeModelStatus(data);
      if (status) {
        applyModelStatus(kind, status);
        if (state.route === 'settings') render();
      }
      return;
    }
    if (type === 'state.transition') {
      invalidateResources('board', 'overview', 'hooks', 'office');
      if (state.route === 'office') invalidateResources('tools');
    }
    else if (type === 'board.updated') invalidateResources('board', 'overview', 'office');
    else if (type === 'notify') invalidateResources('notifications');
    else if (type === 'settings.changed') invalidateResources('settings', 'rules', 'office');
    else if (type === 'tools.updated' || type === 'scan.completed')
      invalidateResources('tools', 'board', 'overview', 'hooks', 'office');
    scheduleRefresh();
  });
  stream.onopen = () => {
    streamBackoffMs = 0;
    renderChrome();
  };
  stream.onerror = () => {
    stream?.close();
    stream = null;
    qs<HTMLElement>('#runtime-hint').textContent = '实时连接暂时中断 · 正在自动重连';
    scheduleStreamRetry();
  };
}
async function main(): Promise<void> {
  // macOS 用隐藏式标题栏：标记平台，让侧栏顶部给红绿灯让出高度。
  document.documentElement.dataset.platform = window.awm?.platform ?? 'unknown';
  bindEvents();
  try {
    await Api.init();
  } catch (error) {
    qs<HTMLElement>('#view').innerHTML = errorBlock(errorMessage(error));
    return;
  }
  await refresh();
  connectStream();
  window.awm?.onRefresh(() => scheduleRefresh(350));
  window.awm?.onConfirmClose((request) => {
    void handleConfirmClose(request);
  });
  window.setInterval(() => {
    if (!document.hidden) scheduleRefresh(0);
  }, 30_000);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) scheduleRefresh(300);
  });
  window.addEventListener('beforeunload', () => stream?.close());
}
if (document.readyState === 'loading')
  document.addEventListener('DOMContentLoaded', () => {
    void main();
  });
else void main();
