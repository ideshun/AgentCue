import { spawn } from 'node:child_process';
export const name = 'agentcue';
export const inject = ['sessions'];
export function apply(ctx) {
  ctx.on('session/event', (session, event) => {
    if (!['turn/start', 'turn/end'].includes(event.type)) return;
    const child = spawn(__AGENTCUE_EXECUTABLE_JSON__, ['--tool-hook', 'deepseek-harness'], { stdio: ['pipe','ignore','ignore'], windowsHide: true });
    const timer = setTimeout(() => child.kill(), 2000);
    child.on('error', () => clearTimeout(timer));
    child.on('exit', () => clearTimeout(timer));
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify({session_id: session.id, hook_event_name:event.type,
      turn:event.data.turn, reason:event.data.reason, event_id:String(event.seq),
      occurred_at:new Date(event.time).toISOString()}));
  });
}
