/** 出厂规则升级仅用内存库，不读取用户设置或播放音频。 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDatabase, listVoiceRules, upsertVoiceRule, type DatabaseHandle } from '@awm/store';
import { defaultSettings, voiceSettingsSchema } from '@awm/schema';
import { ensureDefaultVoiceRules } from '../../apps/desktop/src/main/defaults';

describe('default voice rules', () => {
  let handle: DatabaseHandle;
  beforeEach(() => {
    handle = createDatabase(':memory:');
  });
  afterEach(() => handle.sqlite.close());

  const oldRules = [
    { scopeEvent: 'task.started', action: 'mute', template: '', priority: 'low' },
    {
      scopeEvent: 'task.waiting_human',
      action: 'speak',
      template: '「{title}」等你拍板',
      priority: 'high',
    },
    {
      scopeEvent: 'task.completed',
      action: 'notify',
      template: '{tool} 任务完成：{title}',
      priority: 'low',
    },
  ] as const;

  it('新库开始、待确认和完成默认播报，所有内置模板均可定位工具和任务', () => {
    expect(ensureDefaultVoiceRules(handle.db)).toBe(true);
    const rules = listVoiceRules(handle.db);
    for (const event of ['task.started', 'task.waiting_human', 'task.completed']) {
      expect(rules.find((rule) => rule.scopeEvent === event)?.action).toBe('speak');
    }
    expect(rules.filter((rule) => rule.action === 'speak')).toHaveLength(3);
    expect(rules.find((rule) => rule.scopeEvent === 'task.failed')?.action).toBe('notify');
    expect(rules.find((rule) => rule.scopeEvent === 'task.timeout')?.action).toBe('notify');
    for (const rule of rules) {
      expect(rule.template).toContain('{tool}');
      expect(rule.template).toContain('{title}');
    }
    const saved = listVoiceRules(handle.db);
    expect(ensureDefaultVoiceRules(handle.db)).toBe(false);
    expect(listVoiceRules(handle.db)).toEqual(saved);
  });

  it('已有库缺省不升级；显式升级精确旧内置项且可重复调用', () => {
    for (const rule of oldRules) upsertVoiceRule(handle.db, { ...rule, scopeTool: null });
    const before = listVoiceRules(handle.db);
    expect(ensureDefaultVoiceRules(handle.db)).toBe(false);
    expect(listVoiceRules(handle.db)).toEqual(before);
    expect(ensureDefaultVoiceRules(handle.db, { upgradeDefaults: true })).toBe(true);
    const upgraded = listVoiceRules(handle.db);
    expect(upgraded).toHaveLength(3);
    for (const rule of upgraded) {
      if (rule.scopeEvent === 'task.started') {
        expect(rule).toMatchObject({ action: 'mute', template: '', priority: 'low' });
        continue;
      }
      expect(rule.action).toBe('speak');
      expect(rule.template).toContain('{tool}');
      expect(rule.template).toContain('{title}');
    }
    expect(ensureDefaultVoiceRules(handle.db, { upgradeDefaults: true })).toBe(false);
    expect(listVoiceRules(handle.db)).toEqual(upgraded);
  });

  it.each([0, 1])('仅将v%s完全匹配的失败/超时出厂播报降为通知，保留已有静音', (revision) => {
    upsertVoiceRule(handle.db, {
      scopeTool: null,
      scopeEvent: 'task.failed',
      action: 'speak',
      priority: 'high',
      template:
        revision === 0 ? '{tool} 任务失败：{title}' : '{tool}：「{title}」处理失败，请查看。',
    });
    upsertVoiceRule(handle.db, {
      scopeTool: null,
      scopeEvent: 'task.timeout',
      action: 'speak',
      priority: 'mid',
      template: revision === 0 ? '{tool} 等待超时：{title}' : '{tool}：「{title}」等待确认已超时。',
    });
    upsertVoiceRule(handle.db, { ...oldRules[0], scopeTool: null });
    upsertVoiceRule(handle.db, {
      scopeTool: 'custom',
      scopeEvent: 'task.failed',
      action: 'mute',
      template: '用户静音',
      priority: 'high',
    });
    expect(ensureDefaultVoiceRules(handle.db, { upgradeDefaults: true })).toBe(true);
    const rules = listVoiceRules(handle.db);
    expect(
      rules.find((rule) => rule.scopeTool === null && rule.scopeEvent === 'task.failed')?.action,
    ).toBe('notify');
    expect(rules.find((rule) => rule.scopeEvent === 'task.timeout')?.action).toBe('notify');
    expect(rules.find((rule) => rule.scopeEvent === 'task.started')?.action).toBe('mute');
    expect(rules.find((rule) => rule.scopeTool === 'custom')?.action).toBe('mute');
    expect(ensureDefaultVoiceRules(handle.db, { upgradeDefaults: true })).toBe(false);
  });

  it('升级保留自定义动作、文案、优先级与工具范围，不补缺失规则', () => {
    upsertVoiceRule(handle.db, {
      ...oldRules[0],
      template: '用户要求开始时保持静默',
      scopeTool: null,
    });
    upsertVoiceRule(handle.db, { ...oldRules[1], action: 'mute', scopeTool: null });
    upsertVoiceRule(handle.db, { ...oldRules[2], priority: 'high', scopeTool: null });
    upsertVoiceRule(handle.db, { ...oldRules[0], scopeTool: 'demo-tool' });
    const before = listVoiceRules(handle.db);
    expect(ensureDefaultVoiceRules(handle.db, { upgradeDefaults: true })).toBe(false);
    expect(listVoiceRules(handle.db)).toEqual(before);
  });

  it('内部规则迁移标记缺省为0，拒绝负数和小数', () => {
    expect(defaultSettings().voice.rulesRevision).toBe(0);
    expect(voiceSettingsSchema.parse({ enabled: false }).rulesRevision).toBe(0);
    expect(voiceSettingsSchema.safeParse({ rulesRevision: -1 }).success).toBe(false);
    expect(voiceSettingsSchema.safeParse({ rulesRevision: 0.5 }).success).toBe(false);
    expect(voiceSettingsSchema.parse({ rulesRevision: 1 }).rulesRevision).toBe(1);
  });
});
