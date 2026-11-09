/* The same renderer uses the preload bridge in Electron and this bridge in Tauri. */
(() => {
  'use strict';
  const { core, event } = window.__TAURI__;
  const invoke = core.invoke;
  const subscribe = (name, handler, ready) => {
    let disposed = false;
    let remove;
    void event.listen(name, ({ payload }) => handler(payload)).then((unlisten) => {
      if (disposed) unlisten();
      else {
        remove = unlisten;
        if (ready) void invoke('bridge_ready');
      }
    });
    return () => {
      disposed = true;
      remove?.();
    };
  };
  window.awm = Object.freeze({
    platform: '__AGENTCUE_PLATFORM__',
    getConfig: () => invoke('get_config'),
    scanNow: () => invoke('scan_now'),
    setMuted: (muted) => invoke('set_muted', { muted }),
    speakTest: (text) => invoke('speak_test', { text }),
    pickReferenceAudio: () => invoke('pick_reference_audio'),
    onRefresh: (handler) => subscribe('agentcue-refresh', handler),
    onConfirmClose: (handler) => subscribe('agentcue-confirm-close', handler, true),
    respondClose: (requestId, proceed) => void invoke('respond_close', { requestId, proceed }),
    showWindow: () => invoke('show_window'),
  });
  document.addEventListener('click', (click) => {
    const anchor = click.target instanceof Element && click.target.closest('a[target="_blank"]');
    if (!anchor || !/^https?:/.test(anchor.href)) return;
    click.preventDefault();
    void invoke('open_external', { url: anchor.href });
  });
})();
