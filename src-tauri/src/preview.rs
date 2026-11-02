//! Explicit native static Preview. This entry never starts Next or the updater.
use std::{path::Path, sync::{Arc, Mutex}, time::{Duration, Instant}};
use tauri::Manager;
use crate::{pi_ipc, shell::{self, CloseQuits, DesktopApiToken}, static_host::IsolatedStaticHost};

fn create_private_directory(path: &Path) -> Result<(), String> {
    if !path.is_absolute() { return Err("preview data path must be absolute".into()); }
    let mut current = std::path::PathBuf::new();
    for component in path.components() {
        if matches!(component, std::path::Component::ParentDir | std::path::Component::CurDir) { return Err("invalid preview data path".into()); }
        current.push(component.as_os_str());
        if matches!(component, std::path::Component::Prefix(_)) { continue; }
        let metadata = match std::fs::symlink_metadata(&current) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                std::fs::create_dir(&current).map_err(|e| e.to_string())?;
                std::fs::symlink_metadata(&current).map_err(|e| e.to_string())?
            }
            Err(error) => return Err(error.to_string()),
        };
        if !metadata.is_dir() || metadata.file_type().is_symlink() { return Err("unsafe preview data directory".into()); }
        #[cfg(windows)] { use std::os::windows::fs::MetadataExt; if metadata.file_attributes() & 0x400 != 0 { return Err("unsafe preview data directory".into()); } }
    }
    Ok(())
}

fn preview_navigation_allowed(url: &tauri::Url) -> bool {
    let app_origin = url.port().is_none() && if cfg!(windows) { url.scheme() == "http" && url.host_str() == Some("tauri.localhost") } else { url.scheme() == "tauri" && url.host_str() == Some("localhost") };
    app_origin || crate::native_prefs::is_inline_frame_document(url)
        || (url.scheme() == "pi-resource" && url.host_str() == Some("localhost"))
        || (url.scheme() == "http" && url.host_str() == Some("pi-resource.localhost"))
}

fn preview_close_quits(quit: bool) -> Result<(), String> {
    if quit { Ok(()) } else { Err("Hiding the window to the tray is not supported in Static Preview".into()) }
}

#[tauri::command]
fn set_close_quits(quit: bool) -> Result<(), String> { preview_close_quits(quit) }

pub fn run_static_preview() {
    let app = tauri::Builder::default()
        .on_webview_event(|webview, event| {
            if let tauri::WebviewEvent::DragDrop(tauri::DragDropEvent::Drop { paths, .. }) = event {
                if let Some(state) = webview.app_handle().try_state::<Arc<pi_ipc::IpcHostState>>() { state.native_drops.register(&state, paths); }
            }
        })
        .register_uri_scheme_protocol("pi-resource", |ctx, request| {
            let state = ctx.app_handle().state::<Arc<pi_ipc::IpcHostState>>();
            crate::resource_handler::respond(&state.resources, request)
        })
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_process::init())
        .on_menu_event(|app, event| {
            if event.id().as_ref().starts_with(shell::popup::POPUP_ID_PREFIX) {
                if let Some(state) = app.try_state::<shell::popup::PopupMenuSelection>() {
                    if let Ok(slot) = state.0.lock() { if let Some(sender) = slot.as_ref() { let _ = sender.send(event.id().as_ref().to_string()); } }
                }
            }
        })
        .manage(CloseQuits(Mutex::new(true)))
        .manage(shell::popup::PopupMenuSelection::default())
        .manage(DesktopApiToken(crate::generate_random_hex().expect("preview random token unavailable")))
        .invoke_handler(tauri::generate_handler![
            crate::workspace_picker::select_project_directory,
            pi_ipc::pi_ipc, crate::resource_save::save_resource_as,
            pi_ipc::pi_ipc_subscribe_events, pi_ipc::pi_ipc_subscribe_scheduled,
            pi_ipc::pi_ipc_subscribe_running, pi_ipc::pi_ipc_subscribe_terminal,
            crate::provider_auth::pi_ipc_login_stream,
            crate::open_external_url, crate::open_path, crate::open_log_dir,
            crate::reveal_item_in_dir, crate::list_apps_for_file, crate::open_path_with,
            shell::popup::show_popup_menu, set_close_quits, shell::quit_app,
            shell::show_main_window_cmd, shell::app_ready, shell::window_painted,
            crate::native_prefs::set_ui_theme, crate::native_prefs::clear_app_cache
        ])
        .setup(|app| {
            if app.config().identifier != "com.hao.pi-agent-lw.preview" { return Err("preview application identifier mismatch".into()); }
            let config = app.path().app_config_dir()?;
            create_private_directory(&config).map_err(std::io::Error::other)?;
            let home = config.join("home");
            create_private_directory(&home).map_err(std::io::Error::other)?;
            let root = app.path().resource_dir()?.join("static-preview");
            let bundle = crate::preview_bundle::verify(&root).map_err(std::io::Error::other)?;
            let host = IsolatedStaticHost::init_preview(&home, bundle).map_err(std::io::Error::other)?;
            app.manage(Arc::clone(&host.state));
            app.manage(host);
            tauri::WebviewWindowBuilder::new(app, "main", tauri::WebviewUrl::App("index.html".into()))
                .title("Pi Agent LW Preview").inner_size(1200.0, 800.0)
                .initialization_script(r#"(function(){try{document.documentElement.classList.add("native-desktop");}catch(e){}})();"#)
                .on_navigation(|url| {
                    if preview_navigation_allowed(url) { true } else { shell::open_external(url); false }
                })
                .on_new_window(|url, _| { shell::open_external(&url); tauri::webview::NewWindowResponse::Deny })
                .build()?;
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("failed to initialize Static Preview");
    app.run(|handle, event| {
        if matches!(event, tauri::RunEvent::Exit) {
            if let Some(host) = handle.try_state::<IsolatedStaticHost>() {
                if let Err(errors) = host.shutdown_until(Instant::now() + Duration::from_secs(5)) {
                    eprintln!("Static Preview shutdown uncertain: {errors:?}");
                }
                // Preview denies terminal.create before admission, so this host
                // cannot own a PTY. Do not invoke the unbounded PTY shutdown.
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn preview_close_behavior_rejects_unsupported_tray_mode() {
        assert!(preview_close_quits(true).is_ok());
        assert!(preview_close_quits(false).unwrap_err().contains("not supported"));
    }

    #[test]
    fn preview_generated_acl_grants_registered_commands_and_keeps_login_local() {
        let manifest: serde_json::Value = serde_json::from_str(include_str!(concat!(env!("OUT_DIR"), "/acl-manifests.json"))).unwrap();
        let capabilities: serde_json::Value = serde_json::from_str(include_str!(concat!(env!("OUT_DIR"), "/capabilities.json"))).unwrap();
        let context: tauri::Context<tauri::Wry> = tauri::generate_context!();
        let selected = serde_json::to_value(&context.config().app.security.capabilities).unwrap();
        let selected = selected.as_array().unwrap();
        assert!(selected.iter().any(|entry| entry == "desktop-pi-ipc"));
        let capability = &capabilities["desktop-pi-ipc"];
        assert_eq!(capability["local"], true);
        assert_eq!(capability["windows"], serde_json::json!(["main"]));
        assert!(capability.get("remote").is_none_or(serde_json::Value::is_null));
        assert!(capability["permissions"].as_array().unwrap().iter().any(|p| p == "allow-pi-ipc-login-stream"));
        let permissions = manifest["__app-acl__"]["permissions"].as_object().unwrap();
        assert_eq!(permissions["allow-pi-ipc-login-stream"]["commands"]["allow"], serde_json::json!(["pi_ipc_login_stream"]));
        for (id, other) in capabilities.as_object().unwrap() {
            if id != "desktop-pi-ipc" {
                assert!(!other["permissions"].as_array().unwrap().iter().any(|p| p == "allow-pi-ipc-login-stream"));
            }
        }
        let source = include_str!("preview.rs");
        let handler = source.split(".invoke_handler(tauri::generate_handler![").nth(1).unwrap().split("])").next().unwrap();
        for item in handler.split(',').map(str::trim).filter(|item| !item.is_empty()) {
            let command = item.rsplit("::").next().unwrap();
            let allowed = selected.iter().filter_map(serde_json::Value::as_str).any(|name| {
                capabilities[name]["permissions"].as_array().is_some_and(|grants| grants.iter().filter_map(serde_json::Value::as_str).any(|grant| {
                    permissions.get(grant).and_then(|permission| permission["commands"]["allow"].as_array()).is_some_and(|commands| commands.iter().any(|value| value == command))
                }))
            });
            assert!(allowed, "registered Preview command {command} has no selected generated app ACL permission");
        }
    }

    #[test]
    fn preview_navigation_keeps_external_origins_out_of_the_webview() {
        let app = if cfg!(windows) { "http://tauri.localhost/index.html" } else { "tauri://localhost/index.html" };
        assert!(preview_navigation_allowed(&tauri::Url::parse(app).unwrap()));
        assert!(preview_navigation_allowed(&tauri::Url::parse("about:srcdoc").unwrap()));
        assert!(!preview_navigation_allowed(&tauri::Url::parse("https://example.invalid/").unwrap()));
        assert!(!preview_navigation_allowed(&tauri::Url::parse("http://tauri.localhost.evil.invalid/").unwrap()));
    }
}
