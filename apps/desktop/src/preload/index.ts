/**
 * 预加载脚本：contextBridge 暴露白名单 API（详细设计 5.6）。
 *
 * 渲染层拿不到 Node 能力，只拿到：
 * - 控制 API 的端口与 token（由主进程注入，避免写死在渲染层）
 * - 少量动作（扫描、静音、打开日志目录）
 * - 主进程推送的刷新信号
 */
import { contextBridge, ipcRenderer } from 'electron';

/** 控制 API 连接信息 */
export interface ApiConfig {
  /** 控制 API 端口 */
  apiPort: number;
  /** 访问 token */
  token: string;
}

/** 暴露给渲染层的桥接对象 */
const bridge = {
  /** 运行平台：darwin / win32 / linux */
  platform: process.platform,

  /**
   * 获取控制 API 连接信息。
   * @returns 端口与 token
   */
  getConfig: (): Promise<ApiConfig> => ipcRenderer.invoke('awm:config') as Promise<ApiConfig>,

  /**
   * 触发一次扫描。
   * @returns 扫描完成后的 Promise
   */
  scanNow: (): Promise<void> => ipcRenderer.invoke('awm:scan') as Promise<void>,

  /**
   * 设置全局静音。
   * @param muted 是否静音
   * @returns 更新后的设置
   */
  setMuted: (muted: boolean): Promise<void> =>
    ipcRenderer.invoke('awm:set-muted', muted) as Promise<void>,

  /**
   * 试听播报。
   * @param text 待朗读文本
   * @returns 播报结果描述
   */
  speakTest: (text: string): Promise<{ ok: boolean; usedBackend?: string; errors: string[] }> =>
    ipcRenderer.invoke('awm:speak-test', text) as Promise<{
      ok: boolean;
      usedBackend?: string;
      errors: string[];
    }>,

  /**
   * 选择 ZipVoice 参考音频；主进程校验并复制到本机数据目录。
   * @returns 复制后的 WAV 绝对路径；取消选择返回 null
   */
  pickReferenceAudio: (): Promise<string | null> =>
    ipcRenderer.invoke('awm:pick-reference-audio') as Promise<string | null>,

  /**
   * 订阅主进程刷新信号。
   * @param handler 回调
   * @returns 取消订阅函数
   */
  onRefresh: (handler: () => void): (() => void) => {
    const listener = (): void => {
      handler();
    };
    ipcRenderer.on('awm:refresh', listener);
    return () => {
      ipcRenderer.removeListener('awm:refresh', listener);
    };
  },

  /**
   * 订阅关闭/退出前的确认请求。
   * @param handler 回调，收到 requestId 与原因
   * @returns 取消订阅函数
   */
  onConfirmClose: (
    handler: (request: { requestId: number; reason: 'close' | 'quit' }) => void,
  ): (() => void) => {
    const listener = (_event: unknown, payload: unknown): void => {
      const request = payload as { requestId?: unknown; reason?: unknown };
      if (typeof request?.requestId !== 'number') return;
      handler({
        requestId: request.requestId,
        reason: request.reason === 'quit' ? 'quit' : 'close',
      });
    };
    ipcRenderer.on('awm:confirm-close', listener);
    return () => {
      ipcRenderer.removeListener('awm:confirm-close', listener);
    };
  },

  /**
   * 答复关闭/退出确认。
   * @param requestId 请求编号
   * @param proceed 是否继续关闭/退出
   */
  respondClose: (requestId: number, proceed: boolean): void => {
    ipcRenderer.send('awm:respond-close', { requestId, proceed });
  },

  /** 显示并聚焦主窗口（隐藏状态下渲染层收不到交互）。 */
  showWindow: (): Promise<void> => ipcRenderer.invoke('awm:show-window') as Promise<void>,
};

contextBridge.exposeInMainWorld('awm', bridge);
