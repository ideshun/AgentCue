import { describe, expect, it } from 'vitest';
import { normalizeForSpeech } from './speech-text';

describe('normalizeForSpeech', () => {
  it('把时间读成点分', () => {
    expect(normalizeForSpeech('预计 12:30 完成')).toBe('预计 12 点 30 分 完成');
    expect(normalizeForSpeech('09:05 开始')).toBe('09 点 05 分 开始');
  });

  it('把百分比读成百分之', () => {
    expect(normalizeForSpeech('进度 45%')).toBe('进度 百分之 45');
    expect(normalizeForSpeech('完成 99.5%')).toBe('完成 百分之 99.5');
  });

  it('把版本号读成版本前缀', () => {
    expect(normalizeForSpeech('升级到 v1.2.3')).toBe('升级到 版本 1.2.3');
    expect(normalizeForSpeech('V2.0 已发布')).toBe('版本 2.0 已发布');
  });

  it('把容量与耗时单位换成中文', () => {
    expect(normalizeForSpeech('下载 1.5GB 模型')).toBe('下载 1.5 吉字节 模型');
    expect(normalizeForSpeech('等待了 300ms')).toBe('等待了 300 毫秒');
    expect(normalizeForSpeech('还剩 20 s')).toBe('还剩 20 秒');
  });

  it('不误伤普通英文单词与任务标题', () => {
    expect(normalizeForSpeech('Workflow Monitor 处理 api/v1 请求')).toBe(
      'Workflow Monitor 处理 api/v1 请求',
    );
    expect(normalizeForSpeech('修复 settings 页面的 bug')).toBe('修复 settings 页面的 bug');
  });

  it('不把比例当作时间', () => {
    expect(normalizeForSpeech('比例 1:2')).toBe('比例 1:2');
  });

  it('幂等：重复处理不再变化', () => {
    const once = normalizeForSpeech('预计 12:30 完成 45%，下载 1.5GB');
    expect(normalizeForSpeech(once)).toBe(once);
  });

  it('压缩多余空白并去掉首尾空格', () => {
    expect(normalizeForSpeech('  Workflow   Monitor 完成 ')).toBe('Workflow Monitor 完成');
  });
});
