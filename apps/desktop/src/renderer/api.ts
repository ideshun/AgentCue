/** Desktop bridge and view-only transport contracts. Runtime stays in the main process. */
interface ApiConfig {
  apiPort: number;
  token: string;
}
interface AwmBridge {
  platform: string;
  getConfig(): Promise<ApiConfig>;
  scanNow(): Promise<void>;
  setMuted(muted: boolean): Promise<void>;
  speakTest(text: string): Promise<{ ok: boolean; usedBackend?: string; errors: string[] }>;
  /** 选择 ZipVoice 参考音频，主进程复制到本机数据目录后返回存放路径。 */
  pickReferenceAudio(): Promise<string | null>;
  onRefresh(handler: () => void): () => void;
  /** 关闭窗口或退出前，主进程询问渲染层是否有未保存设置。 */
  onConfirmClose(handler: (request: { requestId: number; reason: 'close' | 'quit' }) => void): () => void;
  /** 把用户选择交回主进程；true 表示可以继续关闭/退出。 */
  respondClose(requestId: number, proceed: boolean): void;
  /** 退出流程需要用户确认时，先把隐藏的窗口显示出来。 */
  showWindow(): Promise<void>;
}
interface Window {
  awm?: AwmBridge;
}
type TaskState = import('@awm/schema').TaskState;
type Settings = import('@awm/schema').Settings;
type AdapterManifest = import('@awm/schema').AdapterManifest;
type SessionSummary = import('@awm/core').SessionSummary;
type TransitionRecord = import('@awm/core').TransitionRecord;
type VoiceRule = import('@awm/core').VoiceRule;
type NativeVoice = import('@awm/core').NativeVoice;
type NativeVoiceList = import('@awm/core').NativeVoiceList;
type ModelStatus = import('@awm/core').ModelStatus;
type ModelKind = 'kokoro' | 'zipvoice';
interface Envelope<T> {
  success: boolean;
  data?: T;
  error?: { code: string; message: string };
}
type CoreToolSummary = import('@awm/core').ToolSummary;
interface ToolSummary extends CoreToolSummary {
  sessionCapability?: 'events' | 'metadata' | 'detect-only';
  capabilityReason?: string;
  host?: string;
  ignored?: boolean;
  hookSupported?: boolean;
  hookLastEventAt?: string | null;
}
interface HookIntegration {
  id: string;
  name: string;
  files: Array<{ path: string; content: string; executable?: boolean }>;
  steps: string[];
  commandReady: boolean;
  lastEventAt: string | null;
  enabled: boolean;
  capabilityReason: string;
}
type BoardGroupId = import('@awm/schema').BoardGroupId;
type BoardItem = import('@awm/schema').BoardItem;
type BoardPage = import('@awm/schema').BoardPage;
type BoardResponse = import('@awm/schema').BoardResponse;
interface NotificationItem {
  notificationId: string;
  ts: string;
  title: string;
  body: string;
  level: string;
  read: number;
  sessionId?: string | null;
}
interface McpSnippet {
  id: string;
  name: string;
  hint: string;
  json: string;
  steps?: string[];
  commandReady?: boolean;
}
interface McpServerItem {
  serverId: string;
  name: string;
  transport: string;
  command?: string | null;
  args?: string | string[] | null;
  url?: string | null;
  status: string;
  tools?: string | null;
  lastValidatedAt?: string | null;
  lastError?: string | null;
  validationStatus?: 'unverified' | 'verified' | 'error';
}
interface McpValidation {
  ok: boolean;
  status: string;
  validationStatus: string;
  tools: Array<{ name: string; description?: string }>;
  lastValidatedAt?: string;
  lastError?: string;
}
interface ScanSummary {
  scanId: string;
  ingestedEvents: number;
  startedAt: string;
  finishedAt: string;
  tools: Array<{ toolId: string; status: string }>;
  degraded: Array<{ toolId: string; reason: string }>;
}
interface OverviewSummary {
  counts: Record<TaskState, number>;
  tools: { total: number; running: number };
  attention: number;
  adapters: number;
  lastScan: ScanSummary | null;
  generatedAt: string;
}
type QuietRange = Settings['quiet']['ranges'][number];

/** 控制 API 客户端 */
const Api = {
  /** 连接信息，init 之后可用 */
  config: null as ApiConfig | null,

  /**
   * 初始化连接信息。
   * @throws preload 未注入时抛出，界面给出「请在桌面应用内打开」提示
   */
  async init(): Promise<void> {
    if (!window.awm) {
      throw new Error('未检测到桌面桥接，请在 AI Workflow Monitor 应用内打开本页面');
    }
    Api.config = await window.awm.getConfig();
  },

  /**
   * 拼接请求地址。
   * @param path API 路径
   * @returns 完整 URL
   */
  url(path: string): string {
    if (!Api.config) {
      throw new Error('控制 API 尚未初始化');
    }
    return `http://127.0.0.1:${Api.config.apiPort}${path}`;
  },

  /**
   * 发起请求并解包 envelope。
   * @param path API 路径
   * @param method HTTP 方法
   * @param body 请求体
   * @returns 业务数据
   * @throws 网络失败或 success=false 时抛出，message 直接可展示
   */
  async request<T>(path: string, method: string, body?: unknown): Promise<T> {
    if (!Api.config) {
      throw new Error('控制 API 尚未初始化');
    }
    const response = await fetch(Api.url(path), {
      method,
      headers: {
        Authorization: `Bearer ${Api.config.token}`,
        'Content-Type': 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });
    let payload: Envelope<T>;
    try {
      payload = (await response.json()) as Envelope<T>;
    } catch {
      throw new Error(`服务返回了不可识别的响应（HTTP ${response.status}）`);
    }
    if (!response.ok || !payload.success) {
      throw new Error(payload.error?.message ?? `请求失败（HTTP ${response.status}）`);
    }
    return payload.data as T;
  },

  /**
   * GET 请求。
   * @param path API 路径
   * @returns 业务数据
   */
  get<T>(path: string): Promise<T> {
    return Api.request<T>(path, 'GET');
  },

  /**
   * POST 请求。
   * @param path API 路径
   * @param body 请求体
   * @returns 业务数据
   */
  post<T>(path: string, body?: unknown): Promise<T> {
    return Api.request<T>(path, 'POST', body ?? {});
  },

  /**
   * PUT 请求。
   * @param path API 路径
   * @param body 请求体
   * @returns 业务数据
   */
  put<T>(path: string, body: unknown): Promise<T> {
    return Api.request<T>(path, 'PUT', body);
  },

  /**
   * 建立 SSE 连接。
   * @param onEvent 事件回调
   * @returns EventSource 实例，调用方负责关闭
   */
  stream(onEvent: (type: string, data: unknown) => void): EventSource {
    if (!Api.config) {
      throw new Error('控制 API 尚未初始化');
    }
    const source = new EventSource(Api.url(`/api/v1/stream?token=${Api.config.token}`));
    for (const type of [
      'state.transition',
      'notify',
      'settings.changed',
      'tools.updated',
      'board.updated',
      'scan.completed',
      'model.progress',
    ]) {
      source.addEventListener(type, (event) => {
        try {
          const parsed = JSON.parse((event as MessageEvent<string>).data) as { data: unknown };
          onEvent(type, parsed.data);
        } catch {
          // 单条消息解析失败不影响后续消息
        }
      });
    }
    return source;
  },
};
