/**
 * 心跳监控单测：使用可控时钟验证 3 周期阈值判定。
 */
import { describe, expect, it } from 'vitest';
import { HeartbeatMonitor } from './monitor';

/** 创建带可控时钟的监控器 */
function createMonitor() {
  let current = 1_700_000_000_000;
  const monitor = new HeartbeatMonitor(() => current);
  return {
    monitor,
    advance(ms: number) {
      current += ms;
    },
  };
}

describe('HeartbeatMonitor', () => {
  it('未超过阈值不判定丢失', () => {
    const { monitor, advance } = createMonitor();
    monitor.register({ sessionId: 'demo:p:s1', intervalSec: 30, probe: 'file_mtime' });
    advance(30_000 * 2);
    expect(monitor.collectLost()).toEqual([]);
    expect(monitor.size).toBe(1);
  });

  it('连续 3 周期无信号判定丢失并取消登记', () => {
    const { monitor, advance } = createMonitor();
    monitor.register({ sessionId: 'demo:p:s1', intervalSec: 30, probe: 'file_mtime' });
    advance(30_000 * 3);
    expect(monitor.collectLost()).toEqual(['demo:p:s1']);
    expect(monitor.size).toBe(0);
  });

  it('收到信号后重新计时', () => {
    const { monitor, advance } = createMonitor();
    monitor.register({ sessionId: 'demo:p:s1', intervalSec: 30, probe: 'file_mtime' });
    advance(30_000 * 2);
    monitor.markAlive('demo:p:s1');
    advance(30_000 * 2);
    expect(monitor.collectLost()).toEqual([]);
  });

  it('多个会话各自独立判定', () => {
    const { monitor, advance } = createMonitor();
    monitor.register({ sessionId: 'demo:p:s1', intervalSec: 30, probe: 'file_mtime' });
    monitor.register({ sessionId: 'demo:p:s2', intervalSec: 10, probe: 'api_ping' });
    advance(30_000);
    // s2 间隔短，已满足 3 周期；s1 尚未满足
    expect(monitor.collectLost()).toEqual(['demo:p:s2']);
  });

  it('取消登记后不再监控', () => {
    const { monitor, advance } = createMonitor();
    monitor.register({ sessionId: 'demo:p:s1', intervalSec: 30, probe: 'file_mtime' });
    monitor.unregister('demo:p:s1');
    advance(30_000 * 5);
    expect(monitor.collectLost()).toEqual([]);
  });
});
