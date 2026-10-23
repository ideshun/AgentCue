/** 安装识别与事件采集分开调度；来源位置仅在消费事务成功后推进。 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { lstat, open, readFile } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';
import {
  createStandardEvent,
  detectProcess,
  HeartbeatMonitor,
  ScanOrchestrator,
  type DetectResult,
  type ScanReport,
} from '@awm/core';
import {
  AdapterRegistry,
  discoverSessionFilesAsync,
  expandPatternPath,
  extractSourceBatch,
  extractSessionTitle,
  loadManifestFromText,
  parseJsonl,
  parseMetadataIndex,
  sessionCapability,
} from '@awm/adapters';
import {
  getSession,
  getSourceCheckpoint,
  listSessions,
  listTools,
  upsertTool,
  type AppDb,
} from '@awm/store';
import type {
  AdapterManifest,
  BoardItem,
  StandardEvent,
  Settings,
  SourceTaskContext,
} from '@awm/schema';
import type { Engine } from './engine-host';

const HEARTBEAT_TICK_MS = 30_000;
export const CAPTURE_INTERVAL_MS = 5_000;
export const WAITING_TIMEOUT_MS = 30 * 60_000;
const FIRST_SCAN_WINDOW_MS = 6 * 60 * 60_000;
const MAX_SESSION_FILES = 500;
const READ_BUDGET = 4 * 1024 * 1024;
const MAX_INDEX_SIZE = 16 * 1024 * 1024;
const TITLE_READ_BUDGET = 512 * 1024;

export interface ScanSummary {
  scanId: string;
  tools: DetectResult[];
  degraded: Array<{ toolId: string; reason: string }>;
  ingestedEvents: number;
  startedAt: string;
  finishedAt: string;
}
export interface MonitorServiceDeps {
  db: AppDb;
  engine: Engine;
  getSettings: () => Settings;
  resourcesDir: string;
  onScanComplete?: (summary: ScanSummary) => void;
  onCaptureComplete?: () => void;
}
interface Observation {
  mtimeMs: number;
  size: number;
}
interface TrackedFile {
  file: string;
  toolId: string;
}

function platformPath(entry: { mac?: string; win?: string; linux?: string }): string | undefined {
  return process.platform === 'win32'
    ? entry.win
    : process.platform === 'darwin'
      ? entry.mac
      : entry.linux;
}
function digest(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

/** @description: 以首部和消费边界辨识同 inode 覆盖写，避免把心跳当消费进度。 */
async function fingerprint(
  handle: FileHandle,
  end: number,
  canRead: () => boolean,
): Promise<string> {
  if (!canRead()) return '';
  const head = Buffer.alloc(Math.min(256, end));
  const tail = Buffer.alloc(Math.min(256, end));
  await handle.read(head, 0, head.length, 0);
  if (!canRead()) return '';
  await handle.read(tail, 0, tail.length, Math.max(0, end - tail.length));
  return digest(Buffer.concat([head, tail]));
}

export class MonitorService {
  private readonly registry = new AdapterRegistry();
  private readonly heartbeat = new HeartbeatMonitor();
  private readonly observations = new Map<string, Observation>();
  private readonly sessionFiles = new Map<string, TrackedFile>();
  private readonly metadata = new Map<string, BoardItem[]>();
  private readonly indexCache = new Map<string, { observation: Observation; items: BoardItem[] }>();
  private readonly sourceIssues = new Map<string, string>();
  private readonly sourceTitles = new Map<
    string,
    {
      identity: string;
      title: string | null;
      context: SourceTaskContext;
      titles: Array<{ sessionId: string; title: string | null }>;
      contextOffset: number | null;
      repaired: boolean;
    }
  >();
  private titleRevision = 0;
  private readonly adapterErrors: Array<{ file: string; message: string }> = [];
  private readonly deps: MonitorServiceDeps;
  private readonly orchestrator: ScanOrchestrator;
  private timers: NodeJS.Timeout[] = [];
  private pendingScan: Promise<ScanSummary> | null = null;
  private pendingCapture: Promise<number> | null = null;
  private lastScan: ScanSummary | null = null;
  private generation = 0;
  /** 启动或重配前的记录只补采；跨文件、跨读取批次共用同一通知基线。 */
  private announcementBaselineAt = Date.now();
  private active = false;
  private intervalHours = 0;

  constructor(deps: MonitorServiceDeps) {
    this.deps = deps;
    this.loadAdapters(deps.resourcesDir);
    this.orchestrator = new ScanOrchestrator(this.registry.list());
  }
  private loadAdapters(dir: string): void {
    let files: string[];
    try {
      files = readdirSync(dir).filter((name) => /\.ya?ml$/.test(name));
    } catch {
      this.adapterErrors.push({ file: dir, message: '适配器目录不存在或不可读' });
      return;
    }
    for (const name of files) {
      const full = path.join(dir, name);
      try {
        this.registry.register(loadManifestFromText(readFileSync(full, 'utf8'), full));
      } catch (error) {
        this.adapterErrors.push({
          file: full,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
  get adapters(): AdapterManifest[] {
    return this.registry.list();
  }
  get loadErrors(): Array<{ file: string; message: string }> {
    return this.adapterErrors;
  }
  get lastSummary(): ScanSummary | null {
    return this.lastScan;
  }
  get historyTasks(): BoardItem[] {
    if (!this.deps.getSettings().privacy.sessionFileRead) return [];
    return [...this.metadata.values()].flat().filter((item) => this.allowed(item.toolId));
  }
  sourceReason(toolId: string): string | undefined {
    return this.sourceIssues.get(toolId);
  }
  private allowed(toolId: string): boolean {
    const settings = this.deps.getSettings();
    return settings.privacy.sessionFileRead && !settings.scan.ignoredToolIds.includes(toolId);
  }

  /** @description: 设置变化立即撤销旧读取资格，清理观察器并更新安装识别间隔。 */
  reconfigure(): void {
    this.generation += 1;
    this.announcementBaselineAt = Date.now();
    for (const [sessionId, tracked] of this.sessionFiles) {
      if (!this.allowed(tracked.toolId)) {
        this.heartbeat.unregister(sessionId);
        this.sessionFiles.delete(sessionId);
        this.observations.delete(tracked.file);
      }
    }
    for (const toolId of this.metadata.keys())
      if (!this.allowed(toolId)) this.metadata.delete(toolId);
    this.indexCache.clear();
    this.sourceTitles.clear();
    this.sourceIssues.clear();
    if (this.active && this.intervalHours !== this.deps.getSettings().scan.autoIntervalHours)
      this.start(this.deps.getSettings().scan.autoIntervalHours);
    this.deps.onCaptureComplete?.();
  }
  async scan(): Promise<ScanSummary> {
    if (this.pendingScan) return this.pendingScan;
    this.pendingScan = this.runScan();
    try {
      return await this.pendingScan;
    } finally {
      this.pendingScan = null;
    }
  }
  private async runScan(): Promise<ScanSummary> {
    const generation = this.generation;
    const startedAt = new Date().toISOString();
    const report: ScanReport = await this.orchestrator.scan({
      ignoredToolIds: this.deps.getSettings().scan.ignoredToolIds,
    });
    const summarize = (ingestedEvents: number): ScanSummary => ({
      scanId: `scan_${Date.now().toString(36)}`,
      tools: report.results,
      degraded: [
        ...report.degraded,
        ...[...this.sourceIssues].map(([toolId, reason]) => ({ toolId, reason })),
      ],
      ingestedEvents,
      startedAt,
      finishedAt: new Date().toISOString(),
    });
    if (generation !== this.generation) return summarize(0);
    for (const result of report.results) {
      if (this.deps.getSettings().scan.ignoredToolIds.includes(result.toolId)) continue;
      const manifest = this.registry.get(result.toolId);
      if (!manifest) continue;
      upsertTool(this.deps.db, {
        toolId: manifest.id,
        name: manifest.name,
        adapterId: manifest.id,
        detectStatus: result.status,
        version: result.version,
        configPath: result.configPath,
        executablePath: result.executablePath,
      });
    }
    for (const custom of this.deps.getSettings().scan.customTools) {
      if (this.deps.getSettings().scan.ignoredToolIds.includes(custom.id)) continue;
      const configPath = expandPatternPath(custom.configPath);
      upsertTool(this.deps.db, {
        toolId: custom.id,
        name: custom.name,
        adapterId: 'custom',
        detectStatus: existsSync(configPath) ? 'installed' : 'not_installed',
        configPath,
      });
    }
    const ingestedEvents = await this.capture();
    const summary = summarize(ingestedEvents);
    if (generation !== this.generation) return summary;
    this.lastScan = summary;
    this.deps.onScanComplete?.(summary);
    return summary;
  }

  /** @description: 高频消费共用单一在途批次，不重入、不触发安装识别。 */
  async capture(): Promise<number> {
    if (this.pendingCapture) return this.pendingCapture;
    this.pendingCapture = this.runCapture();
    try {
      return await this.pendingCapture;
    } finally {
      this.pendingCapture = null;
    }
  }
  private async runCapture(): Promise<number> {
    const generation = this.generation;
    const titleRevision = this.titleRevision;
    const before = JSON.stringify({ metadata: [...this.metadata], issues: [...this.sourceIssues] });
    let count = 0;
    const knownTools = new Set(listTools(this.deps.db).map((item) => item.toolId));
    for (const manifest of this.registry.list()) {
      if (!this.allowed(manifest.id) || generation !== this.generation) continue;
      const capability = sessionCapability(manifest);
      if (capability === 'detect-only') continue;
      this.sourceIssues.delete(manifest.id);
      try {
        if (capability === 'metadata' && manifest.sessionSource.type === 'json-index') {
          await this.readIndexes(manifest, generation);
          continue;
        }
        if (manifest.sessionSource.type !== 'jsonl' && manifest.sessionSource.type !== 'dir-watch')
          continue;
        if (!Object.keys(manifest.eventMapping).length || !manifest.sessionSource.pathPattern)
          continue;
        const files = new Set(
          await discoverSessionFilesAsync(manifest.sessionSource.pathPattern, {
            limit: MAX_SESSION_FILES,
          }),
        );
        for (const tracked of this.sessionFiles.values())
          if (tracked.toolId === manifest.id) files.add(tracked.file);
        for (const file of files) {
          if (!this.allowed(manifest.id) || generation !== this.generation) break;
          if (!knownTools.has(manifest.id)) {
            upsertTool(this.deps.db, {
              toolId: manifest.id,
              name: manifest.name,
              adapterId: manifest.id,
              detectStatus: 'installed',
            });
            knownTools.add(manifest.id);
          }
          try {
            count += await this.readEvents(manifest, file, generation);
          } catch {
            this.sourceIssues.set(manifest.id, '会话来源暂不可读或超过读取预算；下轮将重试');
          }
        }
      } catch {
        this.sourceIssues.set(manifest.id, '来源读取失败；下轮将重试');
      }
    }
    if (
      count > 0 ||
      titleRevision !== this.titleRevision ||
      before !== JSON.stringify({ metadata: [...this.metadata], issues: [...this.sourceIssues] })
    )
      this.deps.onCaptureComplete?.();
    return count;
  }

  /** @description: 仅读白名单索引，缓存未变化的内容，绝不跟随索引内路径。 */
  private async readIndexes(manifest: AdapterManifest, generation: number): Promise<void> {
    const records = new Map<string, BoardItem>();
    let supported = 0;
    let invalid = false;
    for (const index of manifest.sessionSource.indexes ?? []) {
      for (const entry of index.paths) {
        const raw = platformPath(entry);
        if (!raw || !this.allowed(manifest.id) || generation !== this.generation) continue;
        const file = expandPatternPath(raw);
        try {
          const info = await lstat(file);
          if (!this.allowed(manifest.id) || generation !== this.generation) return;
          if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_INDEX_SIZE) continue;
          const cached = this.indexCache.get(file);
          const rows =
            cached &&
            cached.observation.mtimeMs === info.mtimeMs &&
            cached.observation.size === info.size
              ? cached.items
              : parseMetadataIndex(
                  JSON.parse(await readFile(file, 'utf8')),
                  index.format,
                  manifest.id,
                );
          if (!this.allowed(manifest.id) || generation !== this.generation) return;
          this.indexCache.set(file, {
            observation: { mtimeMs: info.mtimeMs, size: info.size },
            items: rows,
          });
          supported += 1;
          for (const row of rows) {
            const previous = records.get(row.sessionId);
            if (!previous || row.updatedAt > previous.updatedAt) records.set(row.sessionId, row);
          }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') invalid = true;
        }
      }
    }
    if (!this.allowed(manifest.id) || generation !== this.generation) return;
    this.metadata.set(manifest.id, [...records.values()]);
    if (!supported)
      this.sourceIssues.set(
        manifest.id,
        invalid
          ? '索引不可读或格式尚不支持；未读取对话正文'
          : '未发现受支持的历史索引；未读取对话正文',
      );
  }

  private async readEvents(
    manifest: AdapterManifest,
    file: string,
    generation: number,
  ): Promise<number> {
    const canCommit = (): boolean => this.allowed(manifest.id) && generation === this.generation;
    if (!canCommit()) return 0;
    const info = await lstat(file);
    if (!canCommit()) return 0;
    if (!info.isFile() || info.isSymbolicLink()) return 0;
    const handle = await open(file, 'r');
    try {
      if (!canCommit()) return 0;
      const stat = await handle.stat();
      if (!canCommit()) return 0;
      const previous = getSourceCheckpoint(this.deps.db, file);
      const identity = `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`;
      let offset = previous?.offset ?? 0;
      const unchanged =
        previous?.fileIdentity === identity &&
        stat.size >= offset &&
        (await fingerprint(handle, offset, canCommit)) === previous.prefixHash;
      if (!canCommit()) return 0;
      const reset =
        !unchanged ||
        (previous &&
          stat.size === offset &&
          Math.trunc(stat.mtimeMs) !== Date.parse(previous.updatedAt));
      if (reset) {
        offset = 0;
        this.sourceTitles.delete(file);
      }
      const project = path.basename(path.dirname(file));
      const sessionKey = path.basename(file, path.extname(file));
      const sessionId = `${manifest.id}:${project}:${sessionKey}`;
      let inspected = this.sourceTitles.get(file);
      if (!inspected || inspected.identity !== identity) {
        const head = Buffer.alloc(Math.min(stat.size, TITLE_READ_BUDGET));
        const { bytesRead } = await handle.read(head, 0, head.length, 0);
        if (!canCommit()) return 0;
        const end = head.subarray(0, bytesRead).lastIndexOf(0x0a) + 1;
        const { rows } = parseJsonl(head.subarray(0, end).toString('utf8'));
        const metadata = extractSourceBatch(rows, manifest, {
          toolId: manifest.id,
          project,
          sessionKey,
          sourcePath: file,
        });
        const consumedContext =
          offset > 0 && offset <= end
            ? extractSourceBatch(
                parseJsonl(head.subarray(0, offset).toString('utf8')).rows,
                manifest,
                { toolId: manifest.id, project, sessionKey, sourcePath: file },
              ).context
            : {};
        inspected = {
          identity,
          title: metadata.context.excluded ? null : (extractSessionTitle(rows) ?? null),
          context: metadata.context.excluded
            ? { excluded: true }
            : {
                ...consumedContext,
                ...(metadata.context.excluded === undefined
                  ? {}
                  : { excluded: metadata.context.excluded }),
              },
          titles: metadata.titles.filter((item) => !!item.title),
          contextOffset: offset <= end ? offset : null,
          repaired: false,
        };
        if (!canCommit()) return 0;
        this.sourceTitles.set(file, inspected);
      }
      let title = inspected.title;
      let context =
        !reset && previous
          ? inspected.contextOffset === offset
            ? inspected.context
            : previous.context
          : undefined;
      if (inspected.context.excluded !== undefined)
        context = inspected.context.excluded ? { excluded: true } : { ...context, excluded: false };
      if (context?.excluded) title = null;
      else if (context?.taskId) {
        const canonical = inspected.titles.find(
          (item) => item.sessionId === `${sessionId}:turn:${context?.taskId}`,
        );
        if (canonical?.title) context = { ...context, title: canonical.title };
      }
      if (!inspected.repaired) {
        const revised =
          previous &&
          !reset &&
          (previous.title !== title || JSON.stringify(previous.context) !== JSON.stringify(context))
            ? { ...previous, title, context }
            : undefined;
        if (!canCommit()) return 0;
        if (
          this.deps.engine.repairSourceTitles(
            context?.excluded ? [] : [{ sessionId, title }, ...inspected.titles],
            revised,
            canCommit,
            { baseSessionId: sessionId, visible: !context?.excluded },
          )
        )
          this.titleRevision += 1;
        inspected.repaired = true;
      }
      const track = (taskId: string): void => {
        const task = getSession(this.deps.db, taskId);
        if (
          !task ||
          task.visible === 0 ||
          !['running', 'waiting_human'].includes(task.currentState)
        ) {
          this.heartbeat.unregister(taskId);
          this.sessionFiles.delete(taskId);
          return;
        }
        this.sessionFiles.set(taskId, { file, toolId: manifest.id });
        if (!this.heartbeat.has(taskId))
          this.heartbeat.register({
            sessionId: taskId,
            intervalSec: manifest.heartbeat.intervalSec,
            probe: manifest.heartbeat.probe,
          });
      };
      for (const taskId of new Set([sessionId, ...inspected.titles.map((item) => item.sessionId)]))
        track(taskId);
      if (context?.taskId) track(`${sessionId}:turn:${context.taskId}`);
      for (const [taskId, tracked] of this.sessionFiles) if (tracked.file === file) track(taskId);
      if (stat.size === offset) return 0;
      const bytes = Buffer.alloc(Math.min(READ_BUDGET, stat.size - offset));
      const { bytesRead } = await handle.read(bytes, 0, bytes.length, offset);
      if (!canCommit()) return 0;
      const newline = bytes.subarray(0, bytesRead).lastIndexOf(0x0a);
      if (newline < 0) {
        if (bytesRead === READ_BUDGET) throw new Error('记录超过读取预算');
        return 0;
      }
      const consumed = bytes.subarray(0, newline + 1);
      const { rows, badLineNumbers } = parseJsonl(consumed.toString('utf8'));
      if (!context?.excluded) title ??= extractSessionTitle(rows) ?? null;
      if (title) inspected.title = title;
      const extracted = extractSourceBatch(rows, manifest, {
        toolId: manifest.id,
        project,
        sessionKey,
        sourcePath: file,
        title,
        context,
      });
      if (extracted.context.excluded) {
        title = null;
        inspected.title = null;
        inspected.context = { excluded: true };
        inspected.titles = [];
      }
      const events = extracted.events
        .filter((event) => {
          if (previous) return true;
          const existing = getSession(this.deps.db, event.sessionId);
          return (
            Date.now() - Date.parse(event.occurredAt) <= FIRST_SCAN_WINDOW_MS &&
            (!existing || event.occurredAt > existing.updatedAt)
          );
        })
        .sort((left, right) => Date.parse(left.occurredAt) - Date.parse(right.occurredAt));
      const batch: StandardEvent[] = [];
      const bootstrapIds = new Set<string>();
      const seen = new Set<string>();
      for (const event of events) {
        if (!seen.has(event.sessionId)) {
          seen.add(event.sessionId);
          if (!getSession(this.deps.db, event.sessionId) && event.eventType !== 'task.started') {
            const eventId = `evt_${digest(`${file}:${event.sessionId}:bootstrap`)}`;
            bootstrapIds.add(eventId);
            batch.push({
              ...createStandardEvent({
                sessionId: event.sessionId,
                toolId: manifest.id,
                eventType: 'task.started',
                occurredAt: event.occurredAt,
                actor: 'tool',
                payload: { taskTitle: event.payload.taskTitle, reason: '扫描补全起始事件' },
              }),
              eventId,
            });
          }
        }
        batch.push(event);
      }
      if (!this.allowed(manifest.id) || generation !== this.generation) return 0;
      const nextOffset = offset + consumed.length;
      const titles = extracted.context.excluded
        ? []
        : [
            ...(title ? [{ sessionId, title }] : []),
            ...extracted.titles.filter((item) => !!item.title),
          ];
      const titleChanged = titles.some((item) => {
        const existing = getSession(this.deps.db, item.sessionId);
        return existing && existing.title !== item.title;
      });
      const processed = await this.deps.engine.consumeSourceBatch(
        batch,
        {
          sourcePath: file,
          toolId: manifest.id,
          fileIdentity: identity,
          offset: nextOffset,
          prefixHash: await fingerprint(handle, nextOffset, canCommit),
          title,
          context: extracted.context,
          updatedAt: new Date(stat.mtimeMs).toISOString(),
        },
        canCommit,
        titles,
        { baseSessionId: sessionId, visible: !extracted.context.excluded },
        (event) =>
          !bootstrapIds.has(event.eventId) &&
          Date.parse(event.occurredAt) >= this.announcementBaselineAt,
      );
      if (!this.allowed(manifest.id) || generation !== this.generation) return 0;
      inspected.context = extracted.context;
      inspected.contextOffset = nextOffset;
      if (titleChanged || previous?.context?.excluded !== extracted.context.excluded)
        this.titleRevision += 1;
      for (const taskId of new Set([sessionId, ...events.map((event) => event.sessionId)]))
        track(taskId);
      for (const [taskId, tracked] of this.sessionFiles) if (tracked.file === file) track(taskId);
      if (badLineNumbers.length)
        this.sourceIssues.set(manifest.id, '已跳过格式错误的完整行；未记录行内容');
      const newIds = new Set(processed);
      return events.filter((event) => newIds.has(event.eventId)).length;
    } finally {
      await handle.close();
    }
  }

  start(autoIntervalHours: number): void {
    for (const timer of this.timers) clearInterval(timer);
    this.timers = [];
    this.active = true;
    this.intervalHours = autoIntervalHours;
    const schedule = (action: () => Promise<unknown>, ms: number): void => {
      const timer = setInterval(() => {
        void action().catch(() => {
          process.stderr.write('后台监控任务失败；下轮将重试\n');
        });
      }, ms);
      timer.unref();
      this.timers.push(timer);
    };
    if (autoIntervalHours > 0) schedule(() => this.scan(), autoIntervalHours * 3_600_000);
    schedule(() => this.capture(), CAPTURE_INTERVAL_MS);
    schedule(() => this.tick(), HEARTBEAT_TICK_MS);
  }
  stop(): void {
    this.active = false;
    this.generation += 1;
    for (const timer of this.timers) clearInterval(timer);
    this.timers = [];
    for (const sessionId of this.sessionFiles.keys()) this.heartbeat.unregister(sessionId);
    this.sessionFiles.clear();
    this.observations.clear();
    this.metadata.clear();
    this.indexCache.clear();
    this.sourceTitles.clear();
  }

  /** @description: 心跳只观察；被忽略或关闭读取的来源不做文件 I/O。 */
  private async tick(): Promise<void> {
    const generation = this.generation;
    if (!this.deps.getSettings().privacy.sessionFileRead) return;
    const sessions = listSessions(this.deps.db, {
      states: ['running', 'waiting_human'],
      limit: 10000,
    });
    for (const session of sessions) {
      if (!this.allowed(session.toolId)) continue;
      const manifest = this.registry.get(session.toolId);
      if (!manifest || sessionCapability(manifest) !== 'events') continue;
      if (!this.heartbeat.has(session.sessionId))
        this.heartbeat.register({
          sessionId: session.sessionId,
          intervalSec: manifest.heartbeat.intervalSec,
          probe: manifest.heartbeat.probe,
        });
      const tracked = this.sessionFiles.get(session.sessionId);
      if (!tracked) continue;
      try {
        const stat = await lstat(tracked.file);
        if (!this.allowed(session.toolId) || generation !== this.generation) continue;
        const seen = this.observations.get(tracked.file);
        if (!seen || seen.mtimeMs !== stat.mtimeMs || seen.size !== stat.size) {
          this.observations.set(tracked.file, { mtimeMs: stat.mtimeMs, size: stat.size });
          this.heartbeat.markAlive(session.sessionId);
        }
      } catch {
        /* 消失的来源交由心跳判定。 */
      }
    }
    for (const sessionId of this.heartbeat.collectLost()) {
      const session = sessions.find((item) => item.sessionId === sessionId);
      if (!session || !this.allowed(session.toolId)) {
        this.heartbeat.unregister(sessionId);
        continue;
      }
      const manifest = this.registry.get(session.toolId);
      if (!manifest) continue;
      const alive = await detectProcess(manifest.detect.processNames).catch(() => ({
        running: false,
      }));
      if (!this.allowed(session.toolId) || generation !== this.generation) continue;
      if (alive.running)
        this.heartbeat.register({
          sessionId,
          intervalSec: manifest.heartbeat.intervalSec,
          probe: manifest.heartbeat.probe,
        });
      else
        this.deps.engine.ingest(
          createStandardEvent({
            sessionId,
            toolId: session.toolId,
            eventType: 'heartbeat.lost',
            actor: 'system',
            payload: { reason: '连续 3 个周期无信号且进程已退出' },
          }),
        );
    }
    for (const session of sessions) {
      if (
        generation !== this.generation ||
        session.currentState !== 'waiting_human' ||
        !this.allowed(session.toolId) ||
        Date.now() - Date.parse(session.updatedAt) < WAITING_TIMEOUT_MS
      )
        continue;
      this.deps.engine.ingest(
        createStandardEvent({
          sessionId: session.sessionId,
          toolId: session.toolId,
          eventType: 'task.timeout',
          actor: 'system',
          payload: { reason: '等待用户超过 30 分钟' },
        }),
      );
    }
  }
}
