/** Office scene: view-only employees, sourced from the same workflow records as the board. */
type OfficeStatus =
  'working' | 'waiting' | 'error' | 'done' | 'idle' | 'paused' | 'offline' | 'unknown';
type OfficeFilter = 'all' | 'working' | 'attention';
type OfficeTaskTab = 'active' | 'issues' | 'ended';
interface OfficeEmployee {
  tool: ToolSummary;
  workload?: OfficeWorkstation;
  status: OfficeStatus;
  label: string;
  primary?: BoardItem;
  color: number;
  seat: number;
}
const officeUi = {
  selectedToolId: '',
  openToolId: '',
  suppressedToolId: '',
  dismissedMessages: new Map<string, string>(),
  filter: 'all' as OfficeFilter,
  query: '',
  tab: 'active' as OfficeTaskTab,
  motion: true,
};

const OFFICE_STATUS_LABELS: Record<OfficeStatus, string> = {
  working: '工作中',
  waiting: '等你确认',
  error: '需要检查',
  done: '任务完成',
  idle: '空闲中',
  paused: '监控已暂停',
  offline: '未安装',
  unknown: '待接入',
};

function officeColor(id: string): number {
  let hash = 0;
  for (const character of id) hash = (Math.imul(hash, 31) + character.charCodeAt(0)) | 0;
  return (hash >>> 0) % OFFICE_DESK_STYLES.length;
}

/** @description: Installation, history indexes and paused capture never imply active work. */
function officeEmployees(state: AppState): OfficeEmployee[] {
  const workloads = new Map(state.office?.workstations.map((item) => [item.toolId, item]));
  return state.tools.map((tool, index) => {
    const workload = workloads.get(tool.toolId);
    const counts = workload?.counts;
    const tasks = workload?.tasks ?? [];
    let status: OfficeStatus;
    if (tool.ignored || state.settings?.privacy.sessionFileRead === false) status = 'paused';
    else if (tool.detectStatus === 'not_installed') status = 'offline';
    else if (!counts) status = 'unknown';
    else if (tool.sessionCapability !== 'events' && !tool.hookLastEventAt) status = 'unknown';
    else if (counts.waiting_human > 0) status = 'waiting';
    else if (counts.running > 0) status = 'working';
    else if (counts.failed + counts.timeout > 0) status = 'error';
    else {
      const latest = tasks.slice().sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
      const age = latest
        ? Date.parse(state.office?.generatedAt ?? '') - Date.parse(latest.updatedAt)
        : Infinity;
      status = latest?.currentState === 'completed' && age >= 0 && age < 180_000 ? 'done' : 'idle';
    }
    const preferred: TaskState[] =
      status === 'waiting'
        ? ['waiting_human', 'running']
        : status === 'working'
          ? ['running', 'waiting_human']
          : status === 'error'
            ? ['failed', 'timeout']
            : ['completed', 'running', 'waiting_human'];
    const primary = preferred
      .map((value) => tasks.find((task) => task.currentState === value))
      .find(Boolean);
    const label =
      status === 'unknown'
        ? !workload
          ? state.sectionErrors.office
            ? '同步失败'
            : '正在同步'
          : tool.detectStatus === 'unknown'
            ? '状态未知'
            : '待接入'
        : OFFICE_STATUS_LABELS[status];
    return {
      tool,
      workload,
      status,
      label,
      primary,
      color: officeColor(tool.toolId),
      seat: index + 1,
    };
  });
}

function officeWorking(employee: OfficeEmployee): boolean {
  return (
    ['working', 'waiting'].includes(employee.status) && (employee.workload?.counts.running ?? 0) > 0
  );
}

function officeNeedsAttention(employee: OfficeEmployee): boolean {
  const counts = employee.workload?.counts;
  return (
    !['paused', 'offline', 'unknown'].includes(employee.status) &&
    !!counts &&
    counts.waiting_human + counts.failed + counts.timeout > 0
  );
}

function officeVisibleEmployees(employees: OfficeEmployee[]): OfficeEmployee[] {
  const query = officeUi.query.trim().toLocaleLowerCase();
  return employees.filter((employee) => {
    const inFilter =
      officeUi.filter === 'all' ||
      (officeUi.filter === 'working' && officeWorking(employee)) ||
      (officeUi.filter === 'attention' && officeNeedsAttention(employee));
    return (
      inFilter &&
      (!query ||
        `${employee.tool.name} ${employee.tool.toolId} ${employee.tool.host ?? ''}`
          .toLocaleLowerCase()
          .includes(query))
    );
  });
}

function selectedOfficeEmployee(employees: OfficeEmployee[]): OfficeEmployee | undefined {
  return (
    employees.find((employee) => employee.tool.toolId === officeUi.selectedToolId) ??
    employees.find((employee) => employee.status === 'waiting') ??
    employees.find((employee) => employee.status === 'working') ??
    employees[0]
  );
}

function officeDefaultTab(employee: OfficeEmployee | undefined): OfficeTaskTab {
  if (!employee) return 'active';
  if (
    employee?.status === 'error' ||
    (officeUi.filter === 'attention' && (employee?.workload?.counts.waiting_human ?? 0) === 0)
  )
    return 'issues';
  return employee?.status === 'done' ? 'ended' : 'active';
}

/** @description: Keep a pinned bubble on a visible employee when data, search or filters change. */
function syncOfficeSelection(state: AppState, resetTab = false): void {
  const visible = officeVisibleEmployees(officeEmployees(state));
  const employee = selectedOfficeEmployee(visible);
  if (!visible.some((item) => item.tool.toolId === officeUi.openToolId)) officeUi.openToolId = '';
  if (!employee) {
    officeUi.selectedToolId = '';
    return;
  }
  if (resetTab || officeUi.selectedToolId !== employee.tool.toolId) {
    officeUi.selectedToolId = employee.tool.toolId;
    officeUi.tab = officeDefaultTab(employee);
  }
}

const OFFICE_TOOL_ICONS: Record<string, string> = {
  codex: 'assets/office/icons/codex.png',
  cursor: 'assets/office/icons/cursor.svg',
  'claude-code': 'assets/office/icons/claude-code-orange.svg',
  cline: 'assets/office/icons/cline.svg',
  codebuddy: 'assets/office/icons/codebuddy.svg',
};

const OFFICE_DESK_STYLES = [
  'desk-books-v5',
  'desk-creative-v5',
  'desk-tech-v7',
  'desk-focus-v6',
] as const;

/** @description: Real, bundled brand assets are never substituted with invented tool symbols. */
function officeIconUrl(tool: ToolSummary): string | null {
  return tool.icon || OFFICE_TOOL_ICONS[tool.toolId] || null;
}

function officeToolMark(tool: ToolSummary): string {
  const icon = officeIconUrl(tool);
  return icon ? `<img class="tool-icon" src="${esc(icon)}" alt="" aria-hidden="true" />` : '';
}

/** @description: Screen content stays inside the monitor; the real tool icon is a chair sticker. */
function officeDeskArt(employee: OfficeEmployee): string {
  const { tool, status, color } = employee;
  const asset = status === 'offline' ? 'desk-empty-v4' : OFFICE_DESK_STYLES[color];
  const icon = officeIconUrl(tool);
  const clipId = `office-screen-${encodeURIComponent(tool.toolId)}`;
  return `<span class="office-desk-art" aria-hidden="true">
    <img class="office-workstation-image" src="assets/office/${asset}.webp" alt="" draggable="false" decoding="async" width="1254" height="1254" />
    <svg class="office-art-overlay" viewBox="0 0 1280 1280" fill="none" focusable="false">
      <defs><clipPath id="${esc(clipId)}"><path d="M617 123 993 237 978 496 602 375Z" /></clipPath></defs>
      <g clip-path="url(#${esc(clipId)})">
        <path d="M617 123 993 237 978 496 602 375Z" fill="var(--office-screen)" />
        <g transform="matrix(1 .303 -.058 1 617 123)">
          <path d="M0 26h376M48 26v225" stroke="var(--office-screen-line)" stroke-width="2" />
          <circle cx="13" cy="13" r="3" fill="#cb8e7e" /><circle cx="25" cy="13" r="3" fill="#d4bb83" /><circle cx="37" cy="13" r="3" fill="#8caa91" />
          <path d="M13 47h20m-20 18h14m-14 18h20m-20 18h16m-16 18h19" stroke="var(--office-screen-line)" stroke-width="5" stroke-linecap="round" />
          <g class="office-monitor-code" stroke="var(--office-code)" stroke-width="5" stroke-linecap="round">
            <path d="M68 48h60m-60 21h133m-116 21h80m-80 21h174m-174 21h108m-125 21h68m-51 21h139m-139 21h91" />
            <path d="M143 48h90m-54 42h113m-77 42h76m-142 21h46m-5 42h94" opacity=".45" />
          </g>
          <path class="office-monitor-cursor" d="M70 218h12" stroke="var(--office-code)" stroke-width="5" stroke-linecap="round" />
          <circle class="office-monitor-status" cx="338" cy="14" r="4" fill="var(--office-code)" />
        </g>
      </g>
      <g transform="matrix(.78 .22 .10 .75 205 609)">
        ${icon ? `<image href="${esc(icon)}" x="11" y="1" width="56" height="56" preserveAspectRatio="xMidYMid meet" />` : `<text x="39" y="34" fill="#34423d" font-family="system-ui, sans-serif" font-size="11" font-weight="600" text-anchor="middle">${esc(tool.name)}</text>`}
      </g>
    </svg>
  </span>`;
}

function officeTaskText(employee: OfficeEmployee, tools: ToolSummary[]): string {
  if (employee.status === 'offline') return '尚未检测到安装，工位暂时空着。';
  if (employee.status === 'paused') return '监控已暂停，保留上次任务记录。';
  if (employee.status === 'unknown') return '接入任务事件后，可在这里查看工作进展。';
  if (employee.primary) return displayTaskTitle(employee.primary, tools);
  return employee.status === 'idle' ? '当前没有进行中的任务。' : '任务信息正在同步。';
}

/** @description: Refreshes and progress updates do not reopen a manually dismissed task message. */
function officeMessageKey(employee: OfficeEmployee): string {
  return JSON.stringify([
    employee.status,
    employee.primary?.sessionId ?? null,
    employee.primary?.currentState ?? null,
  ]);
}

function renderOfficeDesk(employee: OfficeEmployee, state: AppState, stale: boolean): string {
  const { tool, workload, status } = employee;
  const open = officeUi.openToolId === tool.toolId;
  const active = status === 'working' || status === 'waiting';
  const dismissed = officeUi.dismissedMessages.get(tool.toolId) === officeMessageKey(employee);
  const suppressed = officeUi.suppressedToolId === tool.toolId && dismissed;
  const counts = workload?.counts;
  const details =
    active && counts
      ? `${counts.running} 项进行中 · ${counts.waiting_human} 项待确认`
      : tool.host
        ? `${tool.host} 扩展 · ${capabilityLabel(tool.sessionCapability)}`
        : capabilityLabel(tool.sessionCapability);
  return `<article class="office-workstation is-${status}${active && !stale && !dismissed ? ' has-message' : ''}${open ? ' is-open' : ''}${suppressed ? ' is-tooltip-dismissed' : ''}" data-office-employee="${esc(tool.toolId)}">
    <button id="office-desk-${esc(tool.toolId)}" class="office-desk" type="button" data-office-select="${esc(tool.toolId)}" aria-controls="office-inspector" aria-expanded="${open}" aria-describedby="office-message-${esc(tool.toolId)}" aria-label="${esc(`${tool.name}，${employee.label}，展开任务详情`)}">${officeDeskArt(employee)}</button>
    <div class="office-bubble" id="office-bubble-${esc(tool.toolId)}" role="group" aria-label="${esc(tool.name)} 的任务消息">
      <div class="office-bubble-heading">${officeToolMark(tool)}<strong>${esc(tool.name)}</strong><span class="office-bubble-status"><i></i>${esc(employee.label)}</span><button class="office-bubble-close" id="office-message-close-${esc(tool.toolId)}" type="button" data-office-dismiss="${esc(tool.toolId)}" aria-label="关闭 ${esc(tool.name)} 的任务消息" title="关闭这条消息">×</button></div>
      <p class="office-bubble-task" id="office-message-${esc(tool.toolId)}">${esc(officeTaskText(employee, state.tools))}</p><span class="office-bubble-meta">${stale ? '上次同步的记录 · ' : ''}${esc(details)}</span>
    </div>
  </article>`;
}

function officeTasksForTab(employee: OfficeEmployee): { tasks: BoardItem[]; total: number } {
  const counts = employee.workload?.counts;
  const states: TaskState[] =
    officeUi.tab === 'active'
      ? ['waiting_human', 'running']
      : officeUi.tab === 'issues'
        ? ['failed', 'timeout']
        : ['completed', 'cancelled', 'idle'];
  return {
    tasks: (employee.workload?.tasks ?? [])
      .filter((task) => task.currentState && states.includes(task.currentState))
      .slice(0, 6),
    total: counts ? states.reduce((sum, value) => sum + counts[value], 0) : 0,
  };
}

function renderOfficeInspector(employee: OfficeEmployee, state: AppState): string {
  const { tool, workload, status } = employee;
  const counts = workload?.counts;
  const preview = officeTasksForTab(employee);
  const totals = {
    active: counts ? counts.running + counts.waiting_human : 0,
    issues: counts ? counts.failed + counts.timeout : 0,
    ended: counts ? counts.completed + counts.cancelled + counts.idle : 0,
  };
  return `<section id="office-inspector" class="office-dialog is-${status}" role="dialog" aria-modal="false" aria-labelledby="office-dialog-title" tabindex="-1" data-scroll-key="office-detail-${esc(tool.toolId)}">
    <div class="office-dialog-heading">${officeToolMark(tool)}<div><h2 id="office-dialog-title">${esc(tool.name)}</h2><span class="office-dialog-status">${esc(employee.label)} · 工位 ${String(employee.seat).padStart(2, '0')}</span></div><button class="office-dialog-close" id="office-close" type="button" data-office-close aria-label="关闭工位详情">×</button></div>
    <p class="office-dialog-description">${esc(tool.host ? `${tool.host} 扩展 · ${capabilityLabel(tool.sessionCapability)}` : capabilityLabel(tool.sessionCapability))}</p>
    ${status === 'paused' || status === 'offline' || status === 'unknown' ? `<p class="office-dialog-note">${esc(officeTaskText(employee, state.tools))}</p>` : ''}
    <div class="office-person-metrics"><span><strong>${counts ? counts.running : '—'}</strong>进行中</span><span><strong>${counts ? counts.waiting_human : '—'}</strong>待确认</span><span><strong>${counts ? counts.completed : '—'}</strong>已完成</span></div>
    <div class="office-task-tabs" role="group" aria-label="任务分组">${(
      [
        ['active', '当前'],
        ['issues', '需检查'],
        ['ended', '已结束'],
      ] as const
    )
      .map(
        ([id, label]) =>
          `<button type="button" id="office-task-tab-${id}" data-office-tab="${id}" aria-pressed="${officeUi.tab === id}">${label}<span>${counts ? totals[id] : '—'}</span></button>`,
      )
      .join('')}</div>
    <div class="office-task-list" data-scroll-key="office-tasks-${esc(tool.toolId)}-${officeUi.tab}">${preview.tasks.length ? preview.tasks.map((task) => `<button class="office-task" id="office-task-${esc(task.sessionId)}" type="button" data-session="${esc(task.sessionId)}"><span class="office-task-title">${esc(displayTaskTitle(task, state.tools))}</span><span class="office-task-meta"><span class="badge" data-state="${esc(task.currentState ?? 'unknown')}">${esc(stateLabel(task.currentState ?? 'unknown'))}</span><span>${esc(fmtRelative(task.updatedAt))}</span><span aria-hidden="true">↗</span></span></button>`).join('') : `<p class="office-task-empty">${!workload ? '任务信息尚未同步。' : officeUi.tab === 'active' ? '当前没有进行中或待确认的任务。' : officeUi.tab === 'issues' ? '没有需要检查的任务。' : '尚无已结束的任务。'}</p>`}</div>
    ${preview.total > preview.tasks.length ? `<p class="office-preview-note">已展示 ${preview.tasks.length} 项 / 共 ${preview.total} 项</p>` : ''}
    <div class="office-dialog-actions"><button class="btn btn-primary" type="button" id="office-board-${esc(tool.toolId)}" data-office-board="${esc(tool.toolId)}">在看板中查看 ↗</button><a class="btn btn-ghost" href="#/integrations">播报接入</a></div>
  </section>`;
}

function renderOffice(state: AppState): string {
  const employees = officeEmployees(state);
  const visible = officeVisibleEmployees(employees);
  const open = visible.find((employee) => employee.tool.toolId === officeUi.openToolId);
  const working = employees.filter(officeWorking).length;
  const waiting = employees.filter((employee) => employee.status === 'waiting').length;
  const attention = employees.filter(officeNeedsAttention).length;
  const stale = !!state.sectionErrors.office || !!state.sectionErrors.tools;
  const reduced =
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  return `<section class="office-command" data-region="office-command"><div class="office-command-heading"><span class="office-live-dot${stale || !state.office ? ' is-stale' : ''}" aria-hidden="true"></span><span>我的 AI 办公室</span><span class="office-command-meta">${employees.length} 个工位</span><span class="office-last-sync">${stale ? '展示上次记录' : state.office ? `同步于 ${esc(fmtTime(state.office.generatedAt))}` : '正在同步工位…'}</span></div>${sectionError(state, 'office')}${sectionError(state, 'tools')}<div class="office-controls"><div class="office-filters" role="group" aria-label="筛选工位">${(
    [
      ['all', '全部员工', employees.length],
      ['working', '工作中', working],
      ['attention', '等你处理', attention],
    ] as const
  )
    .map(
      ([id, label, total]) =>
        `<button type="button" id="office-filter-${id}" data-office-filter="${id}" aria-pressed="${officeUi.filter === id}">${label}<span>${total}</span></button>`,
    )
    .join(
      '',
    )}</div><div class="office-view-controls"><input class="control-input office-search" id="office-search" type="search" data-draft value="${esc(officeUi.query)}" aria-label="搜索办公室员工" placeholder="找一位员工…" /><button class="btn btn-ghost btn-small" type="button" id="office-motion" data-office-motion aria-pressed="${officeUi.motion}" ${reduced ? 'disabled title="系统已开启减少动态效果"' : ''}>${reduced ? '已减少动态效果' : officeUi.motion ? '暂停动效' : '开启动效'}</button></div></div></section>
    <section class="office-room${!officeUi.motion ? ' is-motion-paused' : ''}${stale ? ' is-stale' : ''}" data-region="office-room" aria-label="员工工位"><div class="office-room-caption"><span class="office-room-caption-title">WORKSPACE <b>01</b></span><span>${working} 位工作中 · ${waiting} 位等你确认</span></div><div class="office-floor">${visible.length ? visible.map((employee) => renderOfficeDesk(employee, state, stale)).join('') : `<div class="office-room-empty"><span aria-hidden="true">⌑</span><h2>${employees.length ? '这里暂时很安静' : '办公室等你入驻'}</h2><p>${employees.length ? '没有符合筛选条件的员工。' : !state.office ? '正在读取工具与工作状态。' : '扫描本机工具后，员工会出现在对应工位。'}</p>${employees.length ? '<button class="btn btn-ghost" type="button" id="office-reset" data-office-reset>显示全部员工</button>' : '<a class="btn btn-primary" href="#/adapters">查看工具与扩展</a>'}</div>`}</div><div class="office-room-footer"><span>悬浮查看消息 · 点击展开任务</span><span>仅进行中与待确认自动显示消息</span></div></section>
    <div class="office-popover-root" id="office-popover-root" data-region="office-popover">${open ? renderOfficeInspector(open, state) : ''}</div>`;
}

/** @description: Place the pinned NPC bubble inside the visible content area without clipping. */
function positionOfficePopover(): void {
  if (state.route !== 'office' || !officeUi.openToolId) return;
  const root = document.getElementById('office-popover-root');
  const dialog = document.getElementById('office-inspector');
  const anchor = document.getElementById(`office-desk-${officeUi.openToolId}`);
  const view = document.getElementById('view');
  if (!root || !dialog || !anchor || !view) return;
  const viewRect = view.getBoundingClientRect();
  const bounds = {
    left: Math.max(12, viewRect.left + 12),
    top: Math.max(12, viewRect.top + 12),
    right: Math.min(window.innerWidth - 12, viewRect.right - 12),
    bottom: Math.min(window.innerHeight - 12, viewRect.bottom - 12),
  };
  const rect = anchor.getBoundingClientRect();
  if (rect.bottom < bounds.top || rect.top > bounds.bottom) {
    closeOfficePopover(false);
    return;
  }
  const width = Math.min(350, Math.max(200, bounds.right - bounds.left));
  root.style.setProperty('--office-popup-width', `${width}px`);
  root.style.setProperty(
    '--office-popup-max-height',
    `${Math.max(120, bounds.bottom - bounds.top)}px`,
  );
  const height = dialog.getBoundingClientRect().height;
  const left = Math.max(
    bounds.left,
    Math.min(rect.left + rect.width * 0.48 - width / 2, bounds.right - width),
  );
  const above = rect.top - height - 8 >= bounds.top;
  const top = Math.max(
    bounds.top,
    Math.min(above ? rect.top - height - 8 : rect.top + rect.height * 0.16, bounds.bottom - height),
  );
  root.style.setProperty('--office-popup-left', `${left}px`);
  root.style.setProperty('--office-popup-top', `${top}px`);
  root.dataset.positioned = 'true';
}

function closeOfficePopover(restoreFocus = true): void {
  const toolId = officeUi.openToolId;
  if (!toolId) return;
  rememberOfficeMessageDismissal(toolId);
  officeUi.openToolId = '';
  officeUi.suppressedToolId = toolId;
  render(true);
  if (restoreFocus)
    document.getElementById(`office-desk-${toolId}`)?.focus({ preventScroll: true });
}

function rememberOfficeMessageDismissal(toolId: string): void {
  const employee = officeEmployees(state).find((item) => item.tool.toolId === toolId);
  if (employee) officeUi.dismissedMessages.set(toolId, officeMessageKey(employee));
}

function dismissOfficeMessage(toolId: string, restoreFocus = true): void {
  rememberOfficeMessageDismissal(toolId);
  officeUi.suppressedToolId = toolId;
  if (!restoreFocus && document.activeElement instanceof HTMLElement) {
    const worker = document.activeElement.closest<HTMLElement>('[data-office-employee]');
    if (worker?.dataset.officeEmployee === toolId) document.activeElement.blur();
  }
  render(true);
  if (restoreFocus)
    document.getElementById(`office-desk-${toolId}`)?.focus({ preventScroll: true });
}

/** @description: Hover messages are dismissible; keyboard and touch can pin the same information. */
function bindOfficeInteractions(view: HTMLElement): void {
  const clearDismissed = (event: MouseEvent | FocusEvent): void => {
    const employee = (event.target as Element | null)?.closest<HTMLElement>(
      '[data-office-employee]',
    );
    if (
      !employee ||
      (event.relatedTarget instanceof Node && employee.contains(event.relatedTarget))
    )
      return;
    if (event.type === 'pointerout' && employee.contains(document.activeElement)) return;
    if (event.type === 'focusout' && employee.matches(':hover')) return;
    if (officeUi.suppressedToolId === employee.dataset.officeEmployee) {
      officeUi.suppressedToolId = '';
      employee.classList.remove('is-tooltip-dismissed');
    }
  };
  view.addEventListener('pointerout', clearDismissed);
  view.addEventListener('focusout', clearDismissed);
  view.addEventListener('scroll', positionOfficePopover, { passive: true });
  window.addEventListener('resize', positionOfficePopover);
  document.addEventListener('focusin', (event) => {
    if (state.route !== 'office' || !officeUi.openToolId) return;
    const target = event.target as Element | null;
    if (!target?.closest('#office-inspector, [data-office-select], [data-office-dismiss]'))
      closeOfficePopover(false);
  });
  document.addEventListener('pointerdown', (event) => {
    if (state.route !== 'office' || !officeUi.openToolId) return;
    const target = event.target as Element | null;
    if (!target?.closest('#office-inspector, [data-office-select], [data-office-dismiss]'))
      closeOfficePopover(false);
  });
  document.addEventListener('keydown', (event) => {
    if (state.route !== 'office' || event.key !== 'Escape') return;
    if (!document.getElementById('drawer')?.hidden || !document.getElementById('confirm')?.hidden)
      return;
    if (officeUi.openToolId) {
      event.preventDefault();
      closeOfficePopover();
      return;
    }
    const employee =
      document.activeElement?.closest<HTMLElement>('[data-office-employee]') ??
      document.querySelector<HTMLElement>('.office-workstation:hover');
    if (employee?.dataset.officeEmployee) {
      dismissOfficeMessage(
        employee.dataset.officeEmployee,
        !!document.activeElement?.closest('[data-office-employee]'),
      );
    }
  });
}
