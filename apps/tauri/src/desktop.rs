use crate::services::Services;
use agentcue_runtime::paths::AppPaths;
use agentcue_runtime::voice::SpeakResult;
use serde_json::{Value, json};
use std::sync::{
    Mutex,
    atomic::{AtomicBool, AtomicU64, Ordering},
};
use tauri::{
    AppHandle, Emitter, Manager, RunEvent, State, WebviewUrl, WebviewWindowBuilder, WindowEvent,
    image::Image,
    menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent},
};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_opener::OpenerExt;
use tokio::sync::oneshot;

#[derive(Clone, Copy, PartialEq, Eq)]
enum CloseReason {
    Window,
    Quit,
}
struct Pending {
    id: u64,
    reason: CloseReason,
}
struct Host {
    services: Services,
    pending: Mutex<Option<Pending>>,
    next_id: AtomicU64,
    renderer_ready: AtomicBool,
    quitting: AtomicBool,
    isolated: bool,
}

#[tauri::command]
fn get_config(host: State<'_, Host>) -> Value {
    json!({"apiPort":host.services.info.api_port,"token":host.services.info.token})
}

#[tauri::command]
async fn scan_now(host: State<'_, Host>) -> Result<(), String> {
    host.services.monitor.scan().await.map(|_| ())
}

#[tauri::command]
fn set_muted(host: State<'_, Host>, muted: bool) -> Result<(), String> {
    update_mute(&host, muted)
}

fn update_mute(host: &Host, muted: bool) -> Result<(), String> {
    host.services
        .runtime
        .update_settings(&json!({"quiet":{"globalMute":muted}}))
        .map(|_| ())
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn speak_test(host: State<'_, Host>, text: String) -> Result<SpeakResult, String> {
    let input = if text.trim().is_empty() {
        "这是一条测试播报"
    } else {
        text.as_str()
    };
    Ok(host
        .services
        .voice
        .preview(&input.chars().take(200).collect::<String>())
        .await)
}

#[tauri::command]
async fn pick_reference_audio(
    app: AppHandle,
    host: State<'_, Host>,
) -> Result<Option<String>, String> {
    let (send, receive) = oneshot::channel();
    app.dialog()
        .file()
        .set_title("选择 ZipVoice 参考音频")
        .add_filter("WAV 音频", &["wav"])
        .pick_file(move |path| {
            let _ = send.send(path);
        });
    let Some(source) = receive.await.map_err(|_| "文件选择器已关闭")? else {
        return Ok(None);
    };
    let source = source.into_path().map_err(|_| "请选择本机 WAV 文件")?;
    let info = tokio::fs::metadata(&source)
        .await
        .map_err(|_| "参考音频不可读")?;
    if !info.is_file() {
        return Err("请选择一个 WAV 音频文件".into());
    }
    if info.len() > 20 * 1024 * 1024 {
        return Err("参考音频不能超过 20MB".into());
    }
    let directory = host.services.runtime.data_dir.join("voice-references");
    tokio::fs::create_dir_all(&directory)
        .await
        .map_err(|_| "无法创建参考音频目录")?;
    let target = directory.join(format!("reference-{}.wav", uuid::Uuid::new_v4()));
    tokio::fs::copy(source, &target)
        .await
        .map_err(|_| "无法保存参考音频")?;
    Ok(Some(target.to_string_lossy().into_owned()))
}

#[tauri::command]
fn open_external(app: AppHandle, url: String) -> Result<(), String> {
    let parsed = reqwest::Url::parse(&url).map_err(|_| "链接无效")?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err("链接协议不受支持".into());
    }
    app.opener()
        .open_url(parsed.as_str(), None::<&str>)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn bridge_ready(host: State<'_, Host>) {
    host.renderer_ready.store(true, Ordering::Release);
}

#[tauri::command]
fn show_window(app: AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

#[tauri::command]
fn respond_close(app: AppHandle, host: State<'_, Host>, request_id: u64, proceed: bool) {
    let reason = {
        let mut pending = host.pending.lock().unwrap_or_else(|p| p.into_inner());
        if pending.as_ref().is_none_or(|r| r.id != request_id) {
            return;
        }
        pending.take().map(|r| r.reason)
    };
    if proceed && let Some(reason) = reason {
        finish_close(app, reason);
    }
}

fn request_close(app: &AppHandle, reason: CloseReason) {
    let Some(host) = app.try_state::<Host>() else {
        return;
    };
    if host.quitting.load(Ordering::Acquire) {
        return;
    }
    if !host.renderer_ready.load(Ordering::Acquire) {
        finish_close(app.clone(), reason);
        return;
    }
    let request_id = host.next_id.fetch_add(1, Ordering::Relaxed);
    {
        let mut pending = host.pending.lock().unwrap_or_else(|p| p.into_inner());
        if pending.is_some() {
            return;
        }
        *pending = Some(Pending {
            id: request_id,
            reason,
        });
    }
    if reason == CloseReason::Quit {
        show_window(app.clone());
    }
    let result = app.emit_to(
        "main",
        "agentcue-confirm-close",
        json!({
            "requestId":request_id,
            "reason":if reason == CloseReason::Quit {"quit"} else {"close"}
        }),
    );
    if result.is_err() {
        // Preserve the window and draft if its listener cannot be reached.
        let mut pending = host.pending.lock().unwrap_or_else(|p| p.into_inner());
        if pending.as_ref().is_some_and(|r| r.id == request_id) {
            pending.take();
        }
    }
}

fn finish_close(app: AppHandle, reason: CloseReason) {
    if reason == CloseReason::Window {
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.hide();
        }
        return;
    }
    let host = app.state::<Host>();
    if host.quitting.swap(true, Ordering::AcqRel) {
        return;
    }
    tauri::async_runtime::spawn(async move {
        app.state::<Host>().services.close().await;
        app.exit(0);
    });
}

struct Tray {
    icon: TrayIcon,
    status: MenuItem<tauri::Wry>,
    mute: CheckMenuItem<tauri::Wry>,
}

impl Tray {
    fn create(app: &AppHandle) -> tauri::Result<Self> {
        let status = MenuItem::with_id(app, "status", "暂无进行中的任务", false, None::<&str>)?;
        let open = MenuItem::with_id(app, "open", "打开主窗口", true, Some("CmdOrCtrl+O"))?;
        let scan = MenuItem::with_id(app, "scan", "扫描工具", true, Some("CmdOrCtrl+R"))?;
        let mute = CheckMenuItem::with_id(app, "mute", "静音播报", true, false, None::<&str>)?;
        let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
        let menu = Menu::with_items(
            app,
            &[
                &status,
                &PredefinedMenuItem::separator(app)?,
                &open,
                &scan,
                &mute,
                &PredefinedMenuItem::separator(app)?,
                &quit,
            ],
        )?;
        let icon = Image::from_bytes(include_bytes!(
            "../../desktop/src/renderer/assets/brand/tray@2x.png"
        ))?;
        let icon = TrayIconBuilder::with_id("agentcue")
            .icon(icon)
            .tooltip("AgentCue")
            .menu(&menu)
            .show_menu_on_left_click(cfg!(target_os = "linux"))
            .on_tray_icon_event(|tray, event| {
                if let TrayIconEvent::Click {
                    button: MouseButton::Left,
                    button_state: MouseButtonState::Up,
                    ..
                } = event
                {
                    show_window(tray.app_handle().clone());
                }
            })
            .on_menu_event(|app, event| match event.id().as_ref() {
                "open" => show_window(app.clone()),
                "scan" => {
                    let app = app.clone();
                    tauri::async_runtime::spawn(async move {
                        let _ = app.state::<Host>().services.monitor.scan().await;
                    });
                }
                "mute" => {
                    let host = app.state::<Host>();
                    let muted = host.services.runtime.config()["quiet"]["globalMute"] == true;
                    let _ = update_mute(&host, !muted);
                }
                "quit" => request_close(app, CloseReason::Quit),
                _ => {}
            })
            .build(app)?;
        Ok(Self { icon, status, mute })
    }

    fn refresh(&self, host: &Host) {
        let config = host.services.runtime.config();
        let overview = host.services.runtime.overview().unwrap_or(Value::Null);
        let attention = overview["attention"].as_i64().unwrap_or(0);
        let running = overview["counts"]["running"].as_i64().unwrap_or(0);
        let muted = config["quiet"]["globalMute"] == true;
        let text = if attention > 0 {
            format!("{attention} 个任务等你处理")
        } else if running > 0 {
            format!("{running} 个任务进行中")
        } else {
            "暂无进行中的任务".into()
        };
        let _ = self.icon.set_tooltip(Some(format!("AgentCue · {text}")));
        let _ = self.status.set_text(text);
        let _ = self.mute.set_checked(muted);
        #[cfg(target_os = "macos")]
        {
            let title = if attention > 0 {
                attention.to_string()
            } else if muted {
                "静".into()
            } else {
                String::new()
            };
            let _ = self.icon.set_title(Some(title));
        }
    }
}

fn forward_events(app: AppHandle, tray: Tray) {
    let mut events = app.state::<Host>().services.runtime.events.subscribe();
    tauri::async_runtime::spawn(async move {
        loop {
            match events.recv().await {
                Ok(event) => {
                    let kind = event["type"].as_str().unwrap_or_default();
                    let host = app.state::<Host>();
                    if host.quitting.load(Ordering::Acquire) {
                        break;
                    }
                    if kind == "notify" && !host.isolated {
                        let data = &event["data"];
                        let _ = app
                            .notification()
                            .builder()
                            .title(data["title"].as_str().unwrap_or("AgentCue"))
                            .body(data["body"].as_str().unwrap_or_default())
                            .show();
                    }
                    if matches!(
                        kind,
                        "state.transition" | "settings.changed" | "scan.completed" | "notify"
                    ) {
                        tray.refresh(&host);
                    }
                }
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {
                    tray.refresh(&app.state::<Host>())
                }
                Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
            }
        }
    });
}

pub fn run(paths: AppPaths, isolated: bool) -> Result<(), String> {
    let executable = std::env::current_exe().map_err(|e| e.to_string())?;
    let builder = tauri::Builder::default();
    #[cfg(target_os = "macos")]
    let builder = builder
        .menu(|app| {
            let menu = Menu::default(app)?;
            // AppKit's built-in Quit terminates directly and bypasses ExitRequested.
            if let Some(tauri::menu::MenuItemKind::Submenu(application)) = menu.items()?.first()
                && let Some(last) = application.items()?.len().checked_sub(1)
            {
                application.remove_at(last)?;
                application.append(&MenuItem::with_id(
                    app,
                    "agentcue-quit",
                    "退出 AgentCue",
                    true,
                    Some("CmdOrCtrl+Q"),
                )?)?;
            }
            Ok(menu)
        })
        .on_menu_event(|app, event| {
            if event.id().as_ref() == "agentcue-quit" {
                request_close(app, CloseReason::Quit);
            }
        });
    let app = builder
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            get_config,
            scan_now,
            set_muted,
            speak_test,
            pick_reference_audio,
            open_external,
            bridge_ready,
            show_window,
            respond_close
        ])
        .setup(move |app| {
            let services = tauri::async_runtime::block_on(async {
                let services = Services::start(paths, executable, isolated).await?;
                services.start_monitor();
                Ok::<_, String>(services)
            })
            .map_err(std::io::Error::other)?;
            app.manage(Host {
                services,
                pending: Mutex::new(None),
                next_id: AtomicU64::new(1),
                renderer_ready: AtomicBool::new(false),
                quitting: AtomicBool::new(false),
                isolated,
            });
            let builder =
                WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                    .title("AgentCue")
                    .inner_size(1180.0, 780.0)
                    .min_inner_size(900.0, 620.0)
                    .accept_first_mouse(true)
                    .visible(false)
                    .on_navigation(|url| {
                        matches!(
                            (url.scheme(), url.host_str()),
                            ("tauri", Some("localhost"))
                                | ("http" | "https", Some("tauri.localhost"))
                        )
                    })
                    .on_page_load(|window, payload| {
                        if payload.event() == tauri::webview::PageLoadEvent::Finished {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    });
            #[cfg(target_os = "macos")]
            let builder = builder
                .title_bar_style(tauri::TitleBarStyle::Overlay)
                .hidden_title(true);
            builder.build()?;
            let tray = Tray::create(app.handle())?;
            tray.refresh(&app.state::<Host>());
            forward_events(app.handle().clone(), tray);
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event
                && window.label() == "main"
                && !window.state::<Host>().quitting.load(Ordering::Acquire)
            {
                api.prevent_close();
                request_close(window.app_handle(), CloseReason::Window);
            }
        })
        .build(tauri::generate_context!())
        .map_err(|e| e.to_string())?;
    app.run(|app, event| match event {
        RunEvent::ExitRequested { api, .. }
            if app
                .try_state::<Host>()
                .is_some_and(|host| !host.quitting.load(Ordering::Acquire)) =>
        {
            api.prevent_exit();
            request_close(app, CloseReason::Quit);
        }
        #[cfg(target_os = "macos")]
        RunEvent::Reopen { .. } => show_window(app.clone()),
        _ => {}
    });
    Ok(())
}
