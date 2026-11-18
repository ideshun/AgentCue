import { Plugin } from '@opencode/plugin';
import { spawn } from 'node:child_process';
const types = ['session.execution.started','session.execution.succeeded','session.execution.failed','session.execution.interrupted','permission.asked','permission.replied'];
function deliver(event) {
  return new Promise(resolve => {
    const child = spawn(__AGENTCUE_EXECUTABLE_JSON__, ['--tool-hook','opencode'], {stdio:['pipe','ignore','ignore'],windowsHide:true});
    const timer = setTimeout(() => child.kill(), 2000);
    const done = () => { clearTimeout(timer); resolve(); };
    child.on('error',done); child.on('exit',done); child.stdin.on('error',() => {});
    child.stdin.end(JSON.stringify({hook_event_name:event.type,session_id:event.data.sessionID,
      event_id:event.id,occurred_at:new Date(event.created).toISOString()}));
  });
}
export default Plugin.define({
  id:'agentcue',
  setup(ctx) {
    const controller = new AbortController();
    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({types,signal:controller.signal})) await deliver(event);
      } catch (error) { if (!controller.signal.aborted) console.warn('AgentCue event observer stopped'); }
    })();
    return () => controller.abort();
  },
});
