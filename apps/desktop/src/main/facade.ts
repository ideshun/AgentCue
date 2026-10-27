/**
 * 引擎门面的桌面实现：把 core 的 EngineFacade 接到 store 与 Engine 上。
 * core 不依赖 store，宿主在此完成依赖注入。
 */
import {
  createStandardEvent,
  IllegalTransitionError,
  type EngineFacade,
  type SessionSummary,
  type ToolSummary,
  type TransitionRecord,
  type TransitionResult,
  type VoiceRule,
} from '@awm/core';
import {
  BOARD_GROUPS,
  TASK_STATES,
  updateTaskStateInputSchema,
  type BoardItem,
  type BoardPage,
  type BoardQuery,
  type BoardResponse,
  type OfficeSnapshot,
  type Settings,
  type TaskState,
} from '@awm/schema';
import { sessionCapability } from '@awm/adapters';
import {
  appendNotification,
  countActiveByTool,
  countByState,
  countSessions,
  deleteMcpServer,
  getSession,
  getLastHookEventAt,
  listEvents,
  listMcpServers,
  listNotifications,
  listSessions,
  listTimeline,
  listTools,
  listVoiceRules,
  markNotificationRead,
  upsertMcpServer,
  upsertVoiceRule,
  type McpServerRow,
  type NotificationRow,
  type StateEventRow,
} from '@awm/store';
import { listHttpMcpTools, listStdioMcpTools } from './mcp-client';
import { HOOK_TOOLS } from './hook-setup';
import type { Engine } from './engine-host';
import type { MonitorService, ScanSummary } from './monitor-service';

/** 总览页聚合数据（一次请求拿全，减少 UI 轮询次数） */
export interface OverviewSummary {
  /** 各状态会话数 */
  counts: Record<TaskState, number>;
  /** 工具统计 */
  tools: { total: number; running: number };
  /** 需要用户介入的会话数（waiting_human + failed + timeout） */
  attention: number;
  /** 已加载适配器数 */
  adapters: number;
  /** 最近一次扫描汇总 */
  lastScan: ScanSummary | null;
  /** 生成时间 */
  generatedAt: string;
}

/**
 * 把事件行转换为迁移记录。
 * @param row 事件行
 * @returns 迁移记录
 */
function toRecord(row: StateEventRow): TransitionRecord {
  return {
    eventId: row.eventId,
    sessionId: row.sessionId,
    eventType: row.eventType,
    prevState: row.prevState as TaskState | null,
    nextState: row.nextState as TaskState | null,
    actor: row.actor,
    reason: row.reason,
    ts: row.ts,
  };
}

/**
 * 桌面端引擎门面实现。
 */
export class DesktopFacade implements EngineFacade {
  /** 监控引擎 */
  private readonly engine: Engine;

  /** 监控服务，提供适配器与扫描信息，可为空（MCP 场景不需要） */
  private readonly monitor?: MonitorService;
  private readonly settingsControl?: {
    getSettings: () => Settings;
    updateSettings: (patch: Record<string, unknown>) => Settings;
  };

  /**
   * @param engine 监控引擎
   * @param monitor 监控服务
   */
  constructor(
    engine: Engine,
    monitor?: MonitorService,
    settingsControl?: {
      getSettings: () => Settings;
      updateSettings: (patch: Record<string, unknown>) => Settings;
    },
  ) {
    this.engine = engine;
    this.monitor = monitor;
    this.settingsControl = settingsControl;
  }

  /**
   * 列出工具及活跃会话数。
   * @returns 工具摘要列表
   */
  async listTools(): Promise<ToolSummary[]> {
    const db = this.engine.database;
    const tools = listTools(db);
    // 会话数按 SQL 聚合下推，不依赖 limit 截断后的列表
    const activeByTool = countActiveByTool(db);
    return tools.map((tool) => {
      const manifest = this.monitor?.adapters.find((item) => item.id === tool.toolId);
      const hookSupported = Object.hasOwn(HOOK_TOOLS, tool.toolId);
      const hookLastEventAt = hookSupported ? getLastHookEventAt(db, tool.toolId) : null;
      return {
        toolId: tool.toolId,
        name: tool.name,
        detectStatus: tool.detectStatus,
        version: tool.version,
        sessionCount: activeByTool.get(tool.toolId) ?? 0,
        ignored:
          this.settingsControl?.getSettings().scan.ignoredToolIds.includes(tool.toolId) ??
          !!tool.ignored,
        sessionCapability: hookLastEventAt
          ? 'events'
          : manifest
            ? sessionCapability(manifest)
            : 'detect-only',
        capabilityReason: hookSupported
          ? hookLastEventAt
            ? '已收到官方 Hooks 任务事件；接收状态以客户端配置和最近事件时间为准。'
            : '支持官方 Hooks 任务播报，等待首次事件；请在设置中配置「任务播报接入」。'
          : (this.monitor?.sourceReason(tool.toolId) ?? manifest?.capabilityReason),
        hookSupported,
        hookLastEventAt,
        host: manifest?.detect.extensions?.[0]?.host,
      };
    });
  }

  /** @description: 完整统计每个工位，分组限量取任务预览，避免近期历史挤掉活跃任务。 */
  async getOffice(): Promise<OfficeSnapshot> {
    const db = this.engine.database;
    const groups: TaskState[][] = [
      ['waiting_human'],
      ['running'],
      ['failed', 'timeout'],
      ['completed', 'cancelled', 'idle'],
    ];
    return {
      workstations: listTools(db).map((tool) => ({
        toolId: tool.toolId,
        counts: Object.fromEntries(
          TASK_STATES.map((state) => [state, countSessions(db, { toolId: tool.toolId, state })]),
        ) as Record<TaskState, number>,
        tasks: groups.flatMap((states) =>
          listSessions(db, { toolId: tool.toolId, states, limit: 4 }),
        ).map((row) => ({
          kind: 'session' as const,
          sessionId: row.sessionId,
          toolId: row.toolId,
          title: row.title,
          currentState: row.currentState as TaskState,
          updatedAt: row.updatedAt,
        })),
      })),
      generatedAt: new Date().toISOString(),
    };
  }

  /** @description: 按列查询和聚合，历史快照不写入 sessions 或状态机。 */
  async getBoard(query: BoardQuery): Promise<BoardResponse> {
    const stateGroups: Record<string, TaskState[]> = {
      attention: ['waiting_human'],
      running: ['running'],
      failed: ['failed', 'timeout'],
      completed: ['completed', 'cancelled', 'idle'],
    };
    let before: { updatedAt: string; sessionId: string } | undefined;
    if (query.cursor) {
      try {
        const value = JSON.parse(Buffer.from(query.cursor, 'base64url').toString('utf8')) as Record<
          string,
          unknown
        >;
        if (
          !query.group ||
          value.group !== query.group ||
          value.q !== (query.q ?? '') ||
          value.toolId !== (query.toolId ?? '') ||
          typeof value.updatedAt !== 'string' ||
          !Number.isFinite(Date.parse(value.updatedAt)) ||
          typeof value.sessionId !== 'string'
        )
          throw new Error();
        before = { updatedAt: value.updatedAt, sessionId: value.sessionId };
      } catch {
        throw new RangeError('分页游标无效，请刷新看板');
      }
    }
    const groups: BoardPage[] = [];
    for (const id of query.group ? [query.group] : BOARD_GROUPS) {
      let total: number;
      let items: BoardItem[];
      if (id === 'history') {
        const term = query.q?.trim().toLocaleLowerCase();
        const all = (this.monitor?.historyTasks ?? [])
          .filter(
            (item) =>
              (!query.toolId || item.toolId === query.toolId) &&
              (!term ||
                `${item.title ?? ''} ${item.toolId} ${item.sessionId}`
                  .toLocaleLowerCase()
                  .includes(term)),
          )
          .sort((left, right) =>
            left.updatedAt === right.updatedAt
              ? left.sessionId === right.sessionId
                ? 0
                : left.sessionId < right.sessionId
                  ? 1
                  : -1
              : left.updatedAt < right.updatedAt
                ? 1
                : -1,
          );
        total = all.length;
        items = all
          .filter(
            (item) =>
              !before ||
              item.updatedAt < before.updatedAt ||
              (item.updatedAt === before.updatedAt && item.sessionId < before.sessionId),
          )
          .slice(0, query.limit + 1);
      } else {
        const filter = {
          states: stateGroups[id],
          toolId: query.toolId,
          q: query.q,
          before,
          limit: query.limit + 1,
        };
        total = countSessions(this.engine.database, filter);
        items = listSessions(this.engine.database, filter).map((row) => ({
          kind: 'session',
          sessionId: row.sessionId,
          toolId: row.toolId,
          title: row.title,
          currentState: row.currentState as TaskState,
          updatedAt: row.updatedAt,
        }));
      }
      const hasMore = items.length > query.limit;
      items = items.slice(0, query.limit);
      const last = items.at(-1);
      groups.push({
        id,
        items,
        total,
        nextCursor:
          hasMore && last
            ? Buffer.from(
                JSON.stringify({
                  group: id,
                  q: query.q ?? '',
                  toolId: query.toolId ?? '',
                  updatedAt: last.updatedAt,
                  sessionId: last.sessionId,
                }),
              ).toString('base64url')
            : null,
      });
    }
    return { groups, generatedAt: new Date().toISOString() };
  }

  /**
   * 查询会话列表。
   * @param filter 过滤条件
   * @returns 会话摘要列表
   */
  async listSessions(filter: {
    state?: TaskState;
    toolId?: string;
    limit?: number;
  }): Promise<SessionSummary[]> {
    const rows = listSessions(this.engine.database, filter);
    return rows.map((row) => ({
      sessionId: row.sessionId,
      toolId: row.toolId,
      title: row.title,
      currentState: row.currentState as TaskState,
      updatedAt: row.updatedAt,
    }));
  }

  /**
   * 查询任务状态与最近 5 条迁移。
   * @param sessionId 会话 id
   * @returns 状态与迁移，不存在返回 null
   */
  async getTaskStatus(
    sessionId: string,
  ): Promise<{ state: TaskState; recent: TransitionRecord[] } | null> {
    const session = getSession(this.engine.database, sessionId);
    if (!session) {
      return null;
    }
    return {
      state: session.currentState as TaskState,
      recent: listTimeline(this.engine.database, sessionId, 5).map(toRecord),
    };
  }

  /**
   * 由外部（MCP / UI）注入状态变更事件。
   * 白名单事件仍可能被状态机判为非法迁移（如 completed 回跳 running），
   * 此时抛 IllegalTransitionError；只有会话不存在时返回 null。
   * @param input 更新入参
   * @returns 迁移结果；会话不存在返回 null
   */
  async updateTaskState(input: {
    sessionId: string;
    event: string;
    reason?: string;
  }): Promise<TransitionResult | null> {
    const parsed = updateTaskStateInputSchema.parse(input);
    const session = getSession(this.engine.database, parsed.sessionId);
    if (!session) {
      return null;
    }
    const event = createStandardEvent({
      sessionId: parsed.sessionId,
      toolId: session.toolId,
      eventType: parsed.event,
      actor: 'mcp',
      payload: { reason: parsed.reason },
    });
    const result = this.engine.applyEvent(event);
    if (!result) throw new IllegalTransitionError(session.currentState as TaskState, parsed.event);
    return result;
  }

  /**
   * 幂等写入播报规则。
   * @param input 规则入参
   * @returns 规则对象
   */
  async setVoiceRule(input: {
    scopeTool?: string;
    scopeEvent: string;
    action: string;
    template?: string;
    priority?: string;
  }): Promise<VoiceRule> {
    const existing = listVoiceRules(this.engine.database).find(
      (rule) =>
        rule.scopeTool === (input.scopeTool ?? null) && rule.scopeEvent === input.scopeEvent,
    );
    const row = upsertVoiceRule(this.engine.database, {
      scopeTool: input.scopeTool ?? null,
      scopeEvent: input.scopeEvent,
      action: input.action as VoiceRule['action'],
      template: input.template === undefined ? (existing?.template ?? null) : input.template,
      priority: (input.priority === undefined
        ? (existing?.priority ?? null)
        : input.priority) as VoiceRule['priority'],
    });
    return {
      ruleId: row.ruleId,
      scopeTool: row.scopeTool,
      scopeEvent: row.scopeEvent,
      action: row.action as VoiceRule['action'],
      template: row.template,
      priority: row.priority as VoiceRule['priority'],
    };
  }

  /**
   * 查询迁移时间线。
   * @param sessionId 会话 id
   * @param limit 条数
   * @returns 迁移记录列表
   */
  async getTimeline(sessionId: string, limit: number): Promise<TransitionRecord[]> {
    return listTimeline(this.engine.database, sessionId, limit).map(toRecord);
  }

  /**
   * 检索历史事件（导出与检索页）。
   * @param filter 过滤条件
   * @returns 迁移记录列表
   */
  async searchEvents(filter: {
    eventType?: string;
    toolId?: string;
    from?: string;
    to?: string;
    limit?: number;
  }): Promise<TransitionRecord[]> {
    return listEvents(this.engine.database, {
      eventType: filter.eventType as never,
      toolId: filter.toolId,
      from: filter.from,
      to: filter.to,
      limit: filter.limit,
    }).map(toRecord);
  }

  /**
   * 总览页聚合数据。
   * @returns 各状态计数、工具统计与最近扫描信息
   */
  async getOverview(): Promise<OverviewSummary> {
    const db = this.engine.database;
    const tools = listTools(db);
    const stateCounts = countByState(db);
    const counts = Object.fromEntries(TASK_STATES.map((state) => [state, 0])) as Record<
      TaskState,
      number
    >;
    for (const [state, value] of stateCounts) {
      // 库中可能残留历史状态值（schema 演进场景），只统计已知状态
      if (state in counts) {
        counts[state as TaskState] = value;
      }
    }
    return {
      counts,
      tools: {
        total: tools.length,
        running: tools.filter((tool) => tool.detectStatus === 'running').length,
      },
      attention: counts.waiting_human + counts.failed + counts.timeout,
      adapters: this.monitor?.adapters.length ?? 0,
      lastScan: this.monitor?.lastSummary ?? null,
      generatedAt: new Date().toISOString(),
    };
  }

  /**
   * 查询全部播报规则。
   * @returns 规则列表
   */
  async listVoiceRules(): Promise<VoiceRule[]> {
    return listVoiceRules(this.engine.database).map((row) => ({
      ruleId: row.ruleId,
      scopeTool: row.scopeTool,
      scopeEvent: row.scopeEvent,
      action: row.action as VoiceRule['action'],
      template: row.template,
      priority: row.priority as VoiceRule['priority'],
    }));
  }

  /**
   * 设置工具是否忽略（被忽略的工具不参与扫描）。
   * @param toolId 工具 id
   * @param ignored 是否忽略
   */
  async setToolIgnored(toolId: string, ignored: boolean): Promise<void> {
    if (!this.settingsControl) throw new Error('设置服务尚未就绪');
    const current = this.settingsControl.getSettings().scan.ignoredToolIds;
    const next = ignored
      ? [...new Set([...current, toolId])]
      : current.filter((id) => id !== toolId);
    this.settingsControl.updateSettings({ scan: { ignoredToolIds: next } });
  }

  /**
   * 列出通知中心记录。
   * @param limit 条数
   * @param offset 跳过条数，供「加载更多」翻页
   * @returns 通知列表
   */
  async listNotifications(limit = 100, offset = 0): Promise<NotificationRow[]> {
    return listNotifications(this.engine.database, limit, offset);
  }

  /**
   * 写入一条通知。
   * @param input 通知内容
   * @returns 写入后的行
   */
  appendNotice(input: {
    title: string;
    body: string;
    level: 'attention' | 'info';
    sessionId?: string;
  }): NotificationRow {
    return appendNotification(this.engine.database, input);
  }

  /**
   * 标记通知已读。
   * @param notificationId 空则全部已读
   */
  async markNotificationRead(notificationId?: string): Promise<void> {
    markNotificationRead(this.engine.database, notificationId);
  }

  /**
   * 列出已登记的外部 MCP Server。
   * @returns 行列表
   */
  async listMcpServers(): Promise<McpServerRow[]> {
    return listMcpServers(this.engine.database);
  }

  /**
   * 登记或更新外部 MCP Server，并尝试枚举工具。
   * @param input 配置
   * @returns 写入后的行
   */
  async upsertAndConnectMcpServer(input: {
    serverId?: string;
    name: string;
    transport: 'stdio' | 'streamable-http';
    command?: string;
    args?: string[];
    url?: string;
  }): Promise<McpServerRow> {
    const listed =
      input.transport === 'stdio' && input.command
        ? await listStdioMcpTools(input.command, input.args ?? [])
        : input.transport === 'streamable-http' && input.url
          ? await listHttpMcpTools(input.url)
          : {
              ok: false,
              status: 'disconnected' as const,
              tools: [],
              validationStatus: 'error' as const,
              lastValidatedAt: new Date().toISOString(),
              lastError: '缺少 command 或 url',
            };
    return upsertMcpServer(this.engine.database, {
      serverId: input.serverId,
      name: input.name,
      transport: input.transport,
      command: input.command,
      args: input.args,
      url: input.url,
      status: listed.status,
      tools: listed.tools,
      validationStatus: listed.validationStatus,
      lastValidatedAt: listed.lastValidatedAt,
      lastError: listed.lastError,
    });
  }

  /**
   * 删除外部 MCP Server。
   * @param serverId 主键
   */
  async removeMcpServer(serverId: string): Promise<void> {
    deleteMcpServer(this.engine.database, serverId);
  }
}
