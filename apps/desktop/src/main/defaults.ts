/**
 * 首启动默认数据（FR-11 播报规则的出厂配置）。
 *
 * 空库写入出厂配置；显式升级只改仍与旧出厂配置完全相同的规则。
 * 宿主用设置中的 rulesRevision 控制升级时机，用户自定义规则保持不变。
 */
import { listVoiceRules, upsertVoiceRule, type AppDb } from '@awm/store';

/** 出厂规则：动作 + 模板 + 优先级 */
const LEGACY_RULES = [
  {
    scopeEvent: 'task.waiting_human',
    action: 'speak',
    template: '「{title}」等你拍板',
    priority: 'high',
  },
  {
    scopeEvent: 'task.failed',
    action: 'speak',
    template: '{tool} 任务失败：{title}',
    priority: 'high',
  },
  {
    scopeEvent: 'task.timeout',
    action: 'speak',
    template: '{tool} 等待超时：{title}',
    priority: 'mid',
  },
  {
    scopeEvent: 'task.completed',
    action: 'notify',
    template: '{tool} 任务完成：{title}',
    priority: 'low',
  },
  {
    scopeEvent: 'task.started',
    action: 'mute',
    template: '',
    priority: 'low',
  },
  {
    scopeEvent: '*',
    action: 'notify',
    template: '{tool}：{event}',
    priority: 'low',
  },
  // v1 出厂文本也只降级为通知，不改变任何自定义规则。
  {
    scopeEvent: 'task.failed',
    action: 'speak',
    template: '{tool}：「{title}」处理失败，请查看。',
    priority: 'high',
  },
  {
    scopeEvent: 'task.timeout',
    action: 'speak',
    template: '{tool}：「{title}」等待确认已超时。',
    priority: 'mid',
  },
  // v2 出厂文本：书名号包住标题，短句连读时语调偏硬，v3 起改为逗号分句。
  {
    scopeEvent: 'task.waiting_human',
    action: 'speak',
    template: '{tool}：「{title}」需要你确认。',
    priority: 'high',
  },
  {
    scopeEvent: 'task.failed',
    action: 'notify',
    template: '{tool}：「{title}」处理失败，请查看。',
    priority: 'high',
  },
  {
    scopeEvent: 'task.timeout',
    action: 'notify',
    template: '{tool}：「{title}」等待确认已超时。',
    priority: 'mid',
  },
  {
    scopeEvent: 'task.completed',
    action: 'speak',
    template: '{tool}：「{title}」已完成。',
    priority: 'low',
  },
  {
    scopeEvent: 'task.started',
    action: 'speak',
    template: '{tool}：开始处理「{title}」。',
    priority: 'low',
  },
  {
    scopeEvent: '*',
    action: 'notify',
    template: '{tool}：「{title}」{event}',
    priority: 'low',
  },
] as const;

/**
 * 出厂播报均包含工具、任务与事件，便于定位需要处理的会话。
 * 用逗号把固定短语和标题分开：合成器会在逗号处自然换气，短播报不再一字一顿。
 */
const DEFAULT_RULES = [
  {
    scopeEvent: 'task.waiting_human',
    action: 'speak',
    template: '{tool} 有个任务等你确认，{title}。',
    priority: 'high',
  },
  {
    scopeEvent: 'task.failed',
    action: 'notify',
    template: '{tool} 的任务失败了，{title}，请查看。',
    priority: 'high',
  },
  {
    scopeEvent: 'task.timeout',
    action: 'notify',
    template: '{tool} 的确认等待超时了，{title}。',
    priority: 'mid',
  },
  {
    scopeEvent: 'task.completed',
    action: 'speak',
    template: '{tool} 的任务已经完成，{title}。',
    priority: 'low',
  },
  {
    scopeEvent: 'task.started',
    action: 'speak',
    template: '{tool} 开始处理，{title}。',
    priority: 'low',
  },
  {
    scopeEvent: '*',
    action: 'notify',
    template: '{tool}：{title}，{event}。',
    priority: 'low',
  },
] as const;

/**
 * 首次启动写入出厂规则，显式升级仅更新完整匹配旧出厂规则的项。
 * @param db 数据库句柄
 * @param options 是否升级旧出厂规则，由宿主迁移标记控制
 * @returns 是否写入了规则
 */
export function ensureDefaultVoiceRules(
  db: AppDb,
  options: { upgradeDefaults?: boolean } = {},
): boolean {
  const existing = listVoiceRules(db);
  if (existing.length > 0 && !options.upgradeDefaults) return false;
  let changed = false;
  db.transaction(() => {
    for (const rule of DEFAULT_RULES) {
      const matching = existing.find(
        (item) =>
          item.scopeTool === null &&
          item.action !== 'mute' &&
          LEGACY_RULES.some(
            (old) =>
              old.scopeEvent === rule.scopeEvent &&
              item.scopeEvent === old.scopeEvent &&
              item.action === old.action &&
              item.template === old.template &&
              item.priority === old.priority,
          ),
      );
      if (existing.length > 0 && !matching) continue;
      upsertVoiceRule(db, {
        ruleId: matching?.ruleId,
        scopeTool: null,
        scopeEvent: rule.scopeEvent,
        action: rule.action,
        template: rule.template,
        priority: rule.priority,
      });
      changed = true;
    }
  });
  return changed;
}
