/**
 * 渲染层通用工具：转义、时间格式化、状态文案、Toast。
 * 所有插入 innerHTML 的动态文本都必须先过 esc()，任务标题来自被监控工具的会话内容。
 */

/**
 * HTML 转义。
 * @param value 任意值
 * @returns 可安全插入 innerHTML 的字符串
 */
function esc(value: unknown): string {
  const text = value === null || value === undefined ? '' : String(value);
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * 查询单个元素。
 * @param selector CSS 选择器
 * @returns 元素
 * @throws 元素不存在时抛出，避免后续空引用
 */
function qs<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) {
    throw new Error(`界面元素缺失：${selector}`);
  }
  return element;
}

/**
 * 格式化为时:分。
 * @param iso ISO 8601 时间
 * @returns 时:分，非法时间返回空串
 */
function fmtTime(iso: string | null | undefined): string {
  if (!iso) {
    return '';
  }
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return '';
  }
  return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
}

/**
 * 格式化为相对时间。
 * @param iso ISO 8601 时间
 * @returns 如「3 分钟前」
 */
function fmtRelative(iso: string | null | undefined): string {
  if (!iso) {
    return '';
  }
  const time = new Date(iso).getTime();
  if (Number.isNaN(time)) {
    return '';
  }
  const diff = Date.now() - time;
  if (diff < 60_000) {
    return '刚刚';
  }
  if (diff < 3_600_000) {
    return `${Math.floor(diff / 60_000)} 分钟前`;
  }
  if (diff < 86_400_000) {
    return `${Math.floor(diff / 3_600_000)} 小时前`;
  }
  return `${Math.floor(diff / 86_400_000)} 天前`;
}

/**
 * 状态中文名。
 * @param state 状态
 * @returns 中文名
 */
function stateLabel(state: string): string {
  const labels: Record<string, string | undefined> = {
    idle: '空闲',
    running: '进行中',
    waiting_human: '等你拍板',
    failed: '失败',
    completed: '已完成',
    cancelled: '已取消',
    timeout: '超时',
  };
  return labels[state] ?? state;
}

/**
 * 事件类型中文名。
 * @param eventType 事件类型
 * @returns 中文名
 */
function eventLabel(eventType: string): string {
  const labels: Record<string, string | undefined> = {
    'task.started': '任务开始',
    'task.waiting_human': '等待用户',
    'human.responded': '用户已响应',
    'task.failed': '任务失败',
    'task.completed': '任务完成',
    'task.retried': '重试',
    'task.archived': '归档',
    'task.timeout': '等待超时',
    'task.cancelled': '取消',
    'heartbeat.lost': '心跳丢失',
    'tool.detected': '发现工具',
    anomaly: '异常',
  };
  return labels[eventType] ?? eventType;
}

/**
 * 状态对应的视觉基调。
 * @param state 状态
 * @returns attention / ok / neutral
 */
function stateTone(state: string): 'attention' | 'ok' | 'neutral' {
  if (state === 'waiting_human' || state === 'failed' || state === 'timeout') {
    return 'attention';
  }
  if (state === 'completed') {
    return 'ok';
  }
  return 'neutral';
}

/**
 * 探测状态文案。
 * @param status 四态之一
 * @returns 中文描述
 */
function detectLabel(status: string): string {
  const labels: Record<string, string | undefined> = {
    running: '运行中',
    installed: '已安装',
    not_installed: '未安装',
    unknown: '未知',
  };
  return labels[status] ?? status;
}

/** Toast 定时器 */
let toastTimer: number | null = null;

/**
 * 显示一条短暂的界面提示。
 * @param message 提示内容
 */
function toast(message: string): void {
  const node = document.getElementById('toast');
  if (!node) {
    return;
  }
  node.textContent = message;
  node.hidden = false;
  if (toastTimer !== null) {
    window.clearTimeout(toastTimer);
  }
  toastTimer = window.setTimeout(() => {
    node.hidden = true;
    toastTimer = null;
  }, 2400);
}

/**
 * 渲染错误占位块。
 * @param message 错误信息
 * @returns HTML
 */
function errorBlock(message: string): string {
  return `<div class="empty">加载失败：${esc(message)}</div>`;
}

/** 三选一确认弹窗的选项。 */
type ConfirmChoice = 'save' | 'discard' | 'cancel';

/** 弹窗关闭时恢复焦点的位置；退出确认可能叠在时间线抽屉之上。 */
let confirmReturnFocus: HTMLElement | null = null;
let confirmResolver: ((choice: ConfirmChoice) => void) | null = null;

/** 确认弹窗是否打开；同一时间只允许一个流程询问用户。 */
function isConfirmOpen(): boolean {
  return confirmResolver !== null;
}

/**
 * 关闭确认弹窗并把选择交回调用方。
 * @param choice 用户选择
 */
function resolveConfirm(choice: ConfirmChoice): void {
  const resolver = confirmResolver;
  if (!resolver) return;
  confirmResolver = null;
  const modal = document.getElementById('confirm');
  if (modal) modal.hidden = true;
  // 抽屉仍开着时保持整页 inert，由抽屉自己的关闭逻辑负责恢复。
  const app = document.getElementById('app') as HTMLElement | null;
  const drawer = document.getElementById('drawer');
  if (app) app.inert = !drawer?.hidden;
  if (confirmReturnFocus?.isConnected) confirmReturnFocus.focus({ preventScroll: true });
  confirmReturnFocus = null;
  resolver(choice);
}

/**
 * 打开一个「保存 / 放弃 / 取消」确认弹窗。
 * 初始焦点落在「取消」，避免回车直接触发有副作用的按钮。
 * @param options 标题、正文与三个按钮文案
 * @returns 用户的选择
 */
function openConfirm(options: {
  title: string;
  body: string;
  saveLabel: string;
  discardLabel: string;
  cancelLabel: string;
}): Promise<ConfirmChoice> {
  const modal = qs<HTMLElement>('#confirm');
  const labels: Record<ConfirmChoice, string> = {
    save: options.saveLabel,
    discard: options.discardLabel,
    cancel: options.cancelLabel,
  };
  for (const button of modal.querySelectorAll<HTMLElement>('.modal-actions [data-confirm]'))
    button.textContent = labels[button.dataset.confirm as ConfirmChoice] ?? '';
  qs<HTMLElement>('#confirm-title').textContent = options.title;
  qs<HTMLElement>('#confirm-body').textContent = options.body;
  confirmReturnFocus =
    document.activeElement instanceof HTMLElement ? document.activeElement : null;
  modal.hidden = false;
  qs<HTMLElement>('#app').inert = true;
  modal.querySelector<HTMLButtonElement>('.modal-actions [data-confirm="cancel"]')?.focus();
  return new Promise<ConfirmChoice>((resolve) => {
    confirmResolver = resolve;
  });
}
