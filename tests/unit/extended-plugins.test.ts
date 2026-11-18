import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { EventEmitter } from 'node:events';
import { expect, it } from 'vitest';
const root = new URL('../../crates/agentcue-runtime/resources/', import.meta.url);
const templates = JSON.parse(readFileSync(new URL('extended-hook-templates.json', root), 'utf8'));
function sandbox() {
  const sent: { executable: string; args: string[]; body: unknown }[] = [];
  const context = vm.createContext({
    AbortController, console, setTimeout, clearTimeout,
    spawn(executable: string, args: string[]) {
      const child = new EventEmitter() as EventEmitter & { stdin: EventEmitter & { end(text: string): void }; kill(): void };
      child.stdin = Object.assign(new EventEmitter(), { end(text: string) {
        sent.push({executable,args,body:JSON.parse(text)});
        queueMicrotask(() => child.emit('exit', 0));
      }});
      child.kill = () => child.emit('exit', 1);
      return child;
    },
    Plugin: { define: (plugin: unknown) => plugin },
  });
  return { context, sent };
}
it('ships plugin templates identical to the maintained observer sources', () => {
  for (const [id, file] of [['deepseek-harness','deepseek-agentcue.mjs'],['opencode','opencode-agentcue.js']]) {
    expect(templates.find((t: {id: string}) => t.id === id).files[0].content)
      .toBe(readFileSync(new URL(`integrations/${file}`, root),'utf8'));
  }
});
it('DeepSeek observer forwards committed boundaries with stable sequence and timestamp only', () => {
  const { context,sent }=sandbox();
  const source=readFileSync(new URL('integrations/deepseek-agentcue.mjs',root),'utf8')
    .replace(/^import .*;$/gm,'').replace(/export /g,'').replace('__AGENTCUE_EXECUTABLE_JSON__',JSON.stringify('/fixture/AgentCue'));
  vm.runInContext(source,context);
  vm.runInContext(`apply({on(name,callback) { globalThis.handler=callback; globalThis.eventName=name; }})`,context);
  vm.runInContext(`handler({id:'fixture'}, {type:'turn/end',seq:12,time:1000,data:{turn:2,reason:{kind:'completed'},private:'never forward'}})`,context);
  expect(vm.runInContext('eventName',context)).toBe('session/event');
  expect(sent[0]).toEqual({executable:'/fixture/AgentCue',args:['--tool-hook','deepseek-harness'],body:{session_id:'fixture',hook_event_name:'turn/end',turn:2,reason:{kind:'completed'},event_id:'12',occurred_at:'1970-01-01T00:00:01.000Z'}});
  vm.runInContext(`handler({id:'fixture'}, {type:'assistant/message',data:{text:'private'}})`,context);
  expect(sent).toHaveLength(1);
});
it('OpenCode plugin subscribes to explicit execution events and disposes its stream', async () => {
  const {context,sent}=sandbox();
  const source=readFileSync(new URL('integrations/opencode-agentcue.js',root),'utf8')
    .replace(/^import .*;$/gm,'').replace('export default Plugin.define','globalThis.plugin = Plugin.define').replace('__AGENTCUE_EXECUTABLE_JSON__',JSON.stringify('/fixture/AgentCue'));
  vm.runInContext(source,context);
  vm.runInContext(`globalThis.cleanup=plugin.setup({event:{subscribe(options) {
    globalThis.subscription=options;
    return (async function*() {yield {id:'event-1',type:'session.execution.succeeded',created:1000,data:{sessionID:'fixture',private:'never forward'}};})();
  }}})`,context);
  await new Promise(resolve=>setTimeout(resolve,0));
  expect(sent[0].body).toEqual({hook_event_name:'session.execution.succeeded',session_id:'fixture',event_id:'event-1',occurred_at:'1970-01-01T00:00:01.000Z'});
  expect(vm.runInContext('subscription.types.includes("session.idle")',context)).toBe(false);
  vm.runInContext('cleanup()',context);
  expect(vm.runInContext('subscription.signal.aborted',context)).toBe(true);
});
it('native file drops fill only the icon zone and convert physical coordinates', () => {
  const handlers: Record<string,(event: unknown)=>void>={};
  const sent: unknown[]=[];
  let inside = true;
  let point: number[]=[];
  const context=vm.createContext({
    devicePixelRatio:2,
    window:{__TAURI__:{core:{invoke(){}},event:{listen(name: string,callback: (event: unknown)=>void){handlers[name]=callback;return Promise.resolve(()=>{});}}},dispatchEvent(event: unknown){sent.push(event);}},
    document:{addEventListener(){},elementFromPoint(x: number,y: number){point=[x,y];return {closest(){return inside ? {} : null;}};}},
    CustomEvent: class { constructor(public type: string,public init: unknown){} },
  });
  vm.runInContext(readFileSync(new URL('../../apps/tauri/bridge.js',import.meta.url),'utf8'),context);
  handlers['tauri://drag-drop']({payload:{paths:['/fixture/图标.png'],position:{x:800,y:600}}});
  expect(point).toEqual([400,300]);
  expect(JSON.parse(JSON.stringify(sent))).toEqual([{type:'agentcue-icon-drop',init:{detail:['/fixture/图标.png']}}]);
  inside=false;
  handlers['tauri://drag-drop']({payload:{paths:['/fixture/other.png'],position:{x:0,y:0}}});
  expect(sent).toHaveLength(1);
});
