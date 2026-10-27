/**
 * Electron 主进程入口。
 *
 * 装配顺序（顺序有意义，不可随意调整）：
 * 1. 设置 → 2. 引擎（建库）→ 3. 监控服务（加载适配器）→ 4. 播报服务
 * → 5. 控制 API（拿到真实端口）→ 6. 写 runtime.json 供 awm-mcp 握手
 * → 7. 主窗口与托盘 → 8. 启动定时任务与首轮扫描
 */
import { mkdirSync } from 'node:fs';
import { copyFile, mkdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { app, dialog, ipcMain, Notification } from 'electron';
import { APP_DISPLAY_NAME, defaultDataDir, writeRuntimeInfo, type ModelStatus } from '@awm/core';
import { getSession, listTools, setToolIgnored } from '@awm/store';
import { desktopMcpLaunch } from './mcp-launch';
import { KOKORO_SPEC, LocalModelManager, ZIPVOICE_SPEC } from './model-manager';
import { createTtsChain } from './tts-chain';
import { startApiServer, generateToken, type ApiServerHandle } from './api-server';
import { ensureDefaultVoiceRules } from './defaults';
import { Engine } from './engine-host';
import { DesktopFacade } from './facade';
import { MonitorService } from './monitor-service';
import { SettingsStore } from './settings-store';
import { createTray, type TrayHandle } from './tray';
import { APP_ICON_PATH } from './branding';
import { VoiceService, type VoiceNotice } from './voice-service';
import {
  createMainWindow,
  getMainWindow,
  markQuitting,
  sendToRenderer,
  setCloseDecision,
  showMainWindow,
} from './window';

// 品牌可更名；数据与单实例锁继续使用历史目录，避免丢失设置或与旧版同时写库。
app.setName(APP_DISPLAY_NAME);
try {
  const dataDir = defaultDataDir();
  mkdirSync(dataDir, { recursive: true });
  app.setPath('userData', dataDir);
} catch (error) {
  dialog.showErrorBox(`${APP_DISPLAY_NAME} 启动失败`, String(error));
  app.exit(1);
}

/** 应用装配后的运行时对象 */
interface Runtime {
  /** 设置仓库 */
  settings: SettingsStore;
  /** 监控引擎 */
  engine: Engine;
  /** 监控服务 */
  monitor: MonitorService;
  /** 播报服务 */
  voice: VoiceService;
  /** 控制 API */
  api: ApiServerHandle;
  /** 控制 API token */
  apiToken: string;
  /** 引擎门面 */
  facade: DesktopFacade;
  /** 托盘 */
  tray: TrayHandle;
  updateSettings: (patch: Record<string, unknown>) => ReturnType<SettingsStore['get']>;
}

/** 运行时对象，ready 之前为 null */
let runtime: Runtime | null = null;

/**
 * 退出流程阶段：idle → asking（等渲染层确认未保存设置）→ shutting（真正停服务）。
 * 重复的 Cmd+Q 在 asking 阶段被忽略，避免叠加询问。
 */
type QuitPhase = 'idle' | 'asking' | 'shutting';
let quitPhase: QuitPhase = 'idle';

/** 待渲染层答复的关闭请求；requestId 由主进程递增，答复按 id 匹配。 */
const closeDecisions = new Map<number, (proceed: boolean) => void>();
let closeRequestId = 0;

/** 渲染层无响应时按「直接继续」处理，避免窗口关不掉或退出卡死。 */
const CLOSE_TIMEOUT_MS = 15_000;
const QUIT_TIMEOUT_MS = 8_000;

/**
 * 询问渲染层能否关闭/退出（是否还有未保存设置）。
 * @param reason close = 关闭窗口（隐藏），quit = 退出应用
 * @param timeoutMs 无响应时的等待上限
 * @returns true 表示可以继续
 */
function requestCloseDecision(reason: 'close' | 'quit', timeoutMs: number): Promise<boolean> {
  const window = getMainWindow();
  if (!window || window.isDestroyed() || window.webContents.isDestroyed()) return Promise.resolve(true);
  const requestId = ++closeRequestId;
  return new Promise((resolve) => {
    let timer: NodeJS.Timeout | null = null;
    let settled = false;
    const finish = (proceed: boolean): void => {
      if (settled) return;
      settled = true;
      closeDecisions.delete(requestId);
      if (timer) clearTimeout(timer);
      resolve(proceed);
    };
    timer = setTimeout(() => finish(true), timeoutMs);
    closeDecisions.set(requestId, finish);
    window.webContents.send('awm:confirm-close', { requestId, reason });
  });
}

/** 托盘刷新节流句柄 */
let trayTimer: NodeJS.Timeout | null = null;

/**
 * 读取控制 API 连接信息。
 * @returns 端口与 token；未就绪时返回 null
 */
function apiConfig(): { apiPort: number; token: string } | null {
  if (!runtime) {
    return null;
  }
  // token 由启动时生成并保存在进程内，渲染层只能通过 IPC 取得
  return { apiPort: runtime.api.port, token: runtime.apiToken };
}

/**
 * 装配全部服务。
 */
async function bootstrap(): Promise<void> {
  const dataDir = app.getPath('userData');
  const settings = new SettingsStore(path.join(dataDir, 'settings.json'));
  const engine = new Engine(dataDir);
  // 将旧数据库中的忽略标记一次性并入设置，之后只以设置为真源。
  const legacyIgnored = listTools(engine.database).filter((item) => item.ignored);
  if (legacyIgnored.length) {
    settings.update({
      scan: {
        ignoredToolIds: [
          ...new Set([
            ...settings.get().scan.ignoredToolIds,
            ...legacyIgnored.map((item) => item.toolId),
          ]),
        ],
      },
    });
    for (const item of legacyIgnored) setToolIgnored(engine.database, item.toolId, false);
  }
  engine.shouldAudit = () => settings.get().privacy.auditLog;
  const monitor = new MonitorService({
    db: engine.database,
    engine,
    getSettings: () => settings.get(),
    resourcesDir: path.join(__dirname, '../resources/adapters'),
    onCaptureComplete: () => {
      runtime?.api.broadcast('board.updated', {});
    },
    onScanComplete: (summary) => {
      runtime?.api.broadcast('tools.updated', {});
      runtime?.api.broadcast('scan.completed', { scanId: summary.scanId });
      scheduleTrayRefresh();
    },
  });

  const upgradeVoiceDefaults = settings.get().voice.rulesRevision < 3;
  ensureDefaultVoiceRules(engine.database, { upgradeDefaults: upgradeVoiceDefaults });
  if (upgradeVoiceDefaults) settings.update({ voice: { rulesRevision: 3 } });

  // 本地模型：仅在用户显式触发时下载，进度经 SSE 广播；瞬态不进 settings。
  const modelRoot = path.join(dataDir, 'models');
  const modelOptions = {
    modelRoot,
    onProgress: (status: ModelStatus) => {
      runtime?.api.broadcast('model.progress', status);
    },
  };
  const kokoroModel = new LocalModelManager(KOKORO_SPEC, modelOptions);
  const zipvoiceModel = new LocalModelManager(ZIPVOICE_SPEC, modelOptions);
  const modelFor = (kind: 'kokoro' | 'zipvoice' = 'kokoro') =>
    kind === 'zipvoice' ? zipvoiceModel : kokoroModel;
  let ttsChain = createTtsChain(settings.get(), {
    kokoroModelDir: kokoroModel.modelDir,
    zipvoiceModelDir: zipvoiceModel.modelDir,
  });
  const voice = new VoiceService({
    db: engine.database,
    getChain: () => ttsChain,
    getSettings: () => settings.get(),
    onNotify: (notice) => {
      showNotice(notice);
    },
  });

  const updateSettings = (patch: Record<string, unknown>): ReturnType<SettingsStore['get']> => {
    const previous = settings.get();
    const next = settings.update(patch);
    const playbackChanged = (
      [
        'enabled',
        'backend',
        'voiceProfile',
        'rate',
        'volume',
        'cloudEnabled',
        'cloudProvider',
        'cloudEndpoint',
        'cloudModel',
        'cloudVoice',
        'cloudApiKey',
        'localEngine',
        'zipvoiceReferencePath',
        'zipvoiceReferenceText',
      ] as const
    ).some((key) => previous.voice[key] !== next.voice[key]);
    const policyChanged =
      previous.voice.scope !== next.voice.scope || previous.voice.content !== next.voice.content;
    if (playbackChanged || policyChanged || 'quiet' in patch) {
      voice.reconfigure();
      if (playbackChanged)
        ttsChain = createTtsChain(next, {
          kokoroModelDir: kokoroModel.modelDir,
          zipvoiceModelDir: zipvoiceModel.modelDir,
        });
    }
    if ('scan' in patch || 'privacy' in patch) monitor.reconfigure();
    runtime?.api.broadcast('settings.changed', {});
    scheduleTrayRefresh();
    return next;
  };
  const facade = new DesktopFacade(engine, monitor, {
    getSettings: () => settings.get(),
    updateSettings,
  });
  const token = generateToken();

  const api = await startApiServer({
    port: 0,
    token,
    facade,
    engine,
    getSettings: () => settings.get(),
    updateSettings,
    getAdapters: () => monitor.adapters,
    triggerScan: async () => {
      const summary = await monitor.scan();
      return summary.scanId;
    },
    speakTest: (text) => voice.speakText(text),
    getMcpLaunch: () =>
      desktopMcpLaunch({
        executablePath: process.execPath,
        appPath: app.getAppPath(),
        isPackaged: app.isPackaged,
      }),
    onVoiceRulesChanged: () => voice.reconfigure(),
    getModelState: (kind) => modelFor(kind).status(),
    // 下载任务后台推进，进度经 onProgress → model.progress SSE 广播。
    startModelDownload: (kind) => {
      void modelFor(kind).download();
    },
    cancelModelDownload: (kind) => {
      modelFor(kind).cancel();
    },
  });

  // API 已监听、runtime.json 即将落盘：此后任一步失败都要回滚已启动的服务，
  // 避免残留监听端口或让 runtime.json 指向将死进程。
  try {
    writeRuntimeInfo(dataDir, {
      apiPort: api.port,
      token,
      pid: process.pid,
      startedAt: new Date().toISOString(),
    });

  // 迁移三路分发：SSE 推送 / 播报编排 / 界面刷新
  engine.onTransition = (result, event, delivery) => {
    const session = getSession(engine.database, event.sessionId);
    const title = session?.title?.trim() || event.payload.taskTitle?.trim() || null;
    const toolName =
      listTools(engine.database).find((tool) => tool.toolId === event.toolId)?.name ?? event.toolId;
    api.broadcast('state.transition', {
      ...result,
      toolId: event.toolId,
      toolName,
      title,
    });
    sendToRenderer('awm:refresh');
    if (delivery?.announce !== false)
      void voice
        .announce({
          eventId: event.eventId,
          toolId: event.toolId,
          toolName,
          eventType: event.eventType,
          sessionId: event.sessionId,
          title,
        })
        .catch((error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          process.stderr.write(`播报编排失败（${event.sessionId}）：${message}\n`);
        });
    scheduleTrayRefresh();
  };

  const tray = createTray({
    onOpen: () => {
      showMainWindow();
    },
    onScan: () => {
      void monitor
        .scan()
        .then(() => {
          scheduleTrayRefresh();
        })
        .catch((error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          process.stderr.write(`手动扫描失败：${message}\n`);
          dialog.showErrorBox('扫描失败', message);
        });
    },
    onToggleMute: () => {
      toggleMute();
    },
    onQuit: () => {
      app.quit();
    },
  });

  runtime = {
    settings,
    engine,
    monitor,
    voice,
    api,
    apiToken: token,
    facade,
    tray,
    updateSettings,
  };

  createMainWindow();
  monitor.start(settings.get().scan.autoIntervalHours);
  scheduleTrayRefresh();

  // 首轮扫描延后 2s，先让窗口立起来
  setTimeout(() => {
    void monitor
      .scan()
      .then(() => {
        scheduleTrayRefresh();
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        process.stderr.write(`首轮扫描失败：${message}\n`);
      });
  }, 2_000);
  } catch (error) {
    monitor.stop();
    voice.stop();
    await engine.stop().catch(() => undefined);
    await api.close().catch(() => undefined);
    throw error;
  }
}

/**
 * 显示系统通知。
 * @param notice 通知内容
 */
function showNotice(notice: VoiceNotice): void {
  runtime?.facade.appendNotice({
    title: notice.title,
    body: notice.body,
    level: notice.attention ? 'attention' : 'info',
    sessionId: notice.sessionId,
  });
  if (Notification.isSupported()) {
    new Notification({
      title: notice.title,
      body: notice.body,
      icon: APP_ICON_PATH,
      silent: true,
    }).show();
  }
  runtime?.api.broadcast('notify', notice);
  scheduleTrayRefresh();
}

/**
 * 节流刷新托盘状态，避免高频迁移时反复重建菜单。
 */
function scheduleTrayRefresh(): void {
  if (trayTimer) {
    return;
  }
  trayTimer = setTimeout(() => {
    trayTimer = null;
    void refreshTray();
  }, 500);
}

/**
 * 读取总览并刷新托盘与渲染层。
 */
async function refreshTray(): Promise<void> {
  const current = runtime;
  if (!current) {
    return;
  }
  const overview = await current.facade.getOverview();
  current.tray.update({
    attention: overview.attention,
    running: overview.counts.running,
    muted: current.settings.get().quiet.globalMute,
  });
}

/**
 * 切换全局静音。
 * @returns 切换后的静音状态
 */
function toggleMute(): boolean {
  const current = runtime;
  if (!current) {
    return false;
  }
  const muted = !current.settings.get().quiet.globalMute;
  current.updateSettings({ quiet: { globalMute: muted } });
  current.api.broadcast('settings.changed', { muted });
  sendToRenderer('awm:refresh');
  scheduleTrayRefresh();
  return muted;
}

/**
 * 注册渲染层 IPC 处理器。
 */
function registerIpc(): void {
  ipcMain.handle('awm:config', () => {
    const config = apiConfig();
    if (!config) {
      throw new Error('控制 API 尚未就绪');
    }
    return config;
  });

  ipcMain.handle('awm:scan', async () => {
    await runtime?.monitor.scan();
    scheduleTrayRefresh();
  });

  ipcMain.handle('awm:set-muted', (_event, muted: unknown) => {
    const current = runtime;
    if (!current) {
      return;
    }
    const value = muted === true;
    current.updateSettings({ quiet: { globalMute: value } });
    current.api.broadcast('settings.changed', { muted: value });
    scheduleTrayRefresh();
  });

  // 退出/关闭确认：渲染层答复后放行；窗口被隐藏时先显示出来。
  ipcMain.on('awm:respond-close', (_event, payload: unknown) => {
    const data = payload as { requestId?: unknown; proceed?: unknown } | null;
    const requestId = Number(data?.requestId);
    const finish = closeDecisions.get(requestId);
    if (!finish) return;
    closeDecisions.delete(requestId);
    finish(data?.proceed === true);
  });

  ipcMain.handle('awm:show-window', () => {
    showMainWindow();
  });

  ipcMain.handle('awm:pick-reference-audio', async () => {
    const result = await dialog.showOpenDialog({
      title: '选择 ZipVoice 参考音频',
      properties: ['openFile'],
      filters: [{ name: 'WAV 音频', extensions: ['wav'] }],
    });
    const source = result.filePaths[0];
    if (result.canceled || !source) return null;
    const info = await stat(source);
    if (!info.isFile()) throw new Error('请选择一个 WAV 音频文件');
    if (info.size > 20 * 1024 * 1024) throw new Error('参考音频不能超过 20MB');
    const directory = path.join(app.getPath('userData'), 'voice-references');
    await mkdir(directory, { recursive: true });
    const target = path.join(directory, 'reference-' + String(Date.now()) + '.wav');
    await copyFile(source, target);
    return target;
  });

  ipcMain.handle('awm:speak-test', async (_event, text: unknown) => {
    const current = runtime;
    if (!current) {
      return { ok: false, errors: ['应用尚未就绪'] };
    }
    const content = typeof text === 'string' && text.trim() !== '' ? text : '这是一条测试播报';
    // 与 API 试听同界：长文本生成+播放超过播放超时。
    return current.voice.speakText(content.slice(0, 200));
  });
}

/**
 * 优雅退出：停定时任务、关 API、排空事件队列。
 */
async function shutdown(): Promise<void> {
  markQuitting();
  const current = runtime;
  runtime = null;
  if (!current) {
    app.quit();
    return;
  }
  current.monitor.stop();
  current.voice.stop();
  await current.engine.stop();
  await current.api.close();
  // API 关闭后不再有查询进来，最后释放 sqlite 句柄。
  current.engine.close();
  app.quit();
}

// 单实例锁：保证只有一个引擎实例与单一数据库写者
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    showMainWindow();
  });

  // 关闭所有窗口不退出，保持托盘常驻
  app.on('window-all-closed', () => {
    // 菜单栏常驻应用，此处刻意不调用 app.quit()
  });

  app.on('before-quit', (event) => {
    // shutdown() 内部会 app.quit()，那一轮直接放行。
    if (quitPhase === 'shutting') return;
    event.preventDefault();
    // 已经在询问：忽略重复的 Cmd+Q / 托盘退出。
    if (quitPhase === 'asking') return;
    quitPhase = 'asking';
    void (async () => {
      // 托盘退出时窗口可能是隐藏的；渲染层确认前要先显示出来。
      const proceed = await requestCloseDecision('quit', QUIT_TIMEOUT_MS);
      if (!proceed) {
        quitPhase = 'idle';
        return;
      }
      quitPhase = 'shutting';
      await shutdown();
    })();
  });

  void app.whenReady().then(async () => {
    app.dock?.setIcon(APP_ICON_PATH);
    registerIpc();
    // 关闭窗口只是隐藏；隐藏前同样确认是否有未保存的设置。
    setCloseDecision(() => requestCloseDecision('close', CLOSE_TIMEOUT_MS));
    try {
      await bootstrap();
    } catch (error) {
      const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
      dialog.showErrorBox(`${APP_DISPLAY_NAME} 启动失败`, message);
      // 启动失败没有可保存的设置，跳过退出确认直接退出。
      quitPhase = 'shutting';
      app.quit();
    }
  });
}
