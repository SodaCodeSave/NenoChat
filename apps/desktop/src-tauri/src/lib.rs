mod db;
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(
            SqlBuilder::default()
                .add_migrations(db::DB_URL, db::migrations())
                .build(),
        )
        .invoke_handler(tauri::generate_handler![
            app_info,
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
            let _ = app;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
