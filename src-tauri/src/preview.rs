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
            shell::popup::show_popup_menu, shell::set_close_quits, shell::quit_app,
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
                .title("Pi Agent LW Preview").inner_size(1200.0, 800.0).build()?;
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
                host.state.terminals.shutdown();
            }
        }
    });
}
