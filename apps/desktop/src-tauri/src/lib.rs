mod db;
mod localserver;
mod notification;
mod secrets;

use tauri::Manager;
use tauri_plugin_sql::{Builder as SqlBuilder};

/// 应用标识与设备信息，供前端展示与上报。
#[tauri::command]
fn app_info() -> serde_json::Value {
    serde_json::json!({
        "name": "NenoChat",
        "version": env!("CARGO_PKG_VERSION"),
        "platform": std::env::consts::OS,
        "arch": std::env::consts::ARCH,
    })
}

/// 桌面端独有的插件：updater 只支持桌面平台，移动端构建里不存在这些 crate
#[cfg(desktop)]
fn with_desktop_plugins(builder: tauri::Builder<tauri::Wry>) -> tauri::Builder<tauri::Wry> {
    builder
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
}

#[cfg(not(desktop))]
fn with_desktop_plugins(builder: tauri::Builder<tauri::Wry>) -> tauri::Builder<tauri::Wry> {
    builder
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init());
    let builder = with_desktop_plugins(builder);
    builder
        // 手机扫码后由系统唤起客户端，链接形如 nenochat://pair?url=...&code=...
        .plugin(tauri_plugin_deep_link::init())
        .plugin(
            SqlBuilder::default()
                .add_migrations(db::DB_URL, db::migrations())
                .build(),
        )
        .manage(localserver::LocalServerState::default())
        .invoke_handler(tauri::generate_handler![
            app_info,
            localserver::local_server_info,
            localserver::local_server_set_lan,
            secrets::secret_set,
            secrets::secret_get,
            secrets::secret_delete,
            notification::show_system_notification,
        ])
        .setup(|app| {
            // Windows 通知平台要求 AUMID 带显示名，否则 toast 只入库不弹出
            #[cfg(windows)]
            {
                let icon = std::env::current_exe().ok();
                notification::ensure_app_id_registered("NenoChat", icon.as_deref());
            }
            // 调试构建自动打开开发者工具，方便看日志（open_devtools 仅桌面端可用）
            #[cfg(all(desktop, debug_assertions))]
            {
                if let Some(window) = app.get_webview_window("main") {
                    window.open_devtools();
                }
            }
            // 一体化版：拉起随包的本地服务端；联网版没有随包资源会直接跳过
            localserver::boot(app.handle());
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            // 退出时回收内置服务端，别留下一个占着端口的孤儿 Node 进程
            if let tauri::RunEvent::Exit = event {
                localserver::shutdown(app);
            }
        });
}
