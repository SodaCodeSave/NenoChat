mod crash;
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

/// 坏库重建已经重启过一次的标记，防止重启后又崩、又重启，无限循环
const DB_RECOVERY_ENV: &str = "NENOCHAT_DB_RECOVERY";

fn build_app(context: tauri::Context<tauri::Wry>) -> tauri::Result<tauri::App<tauri::Wry>> {
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
        .build(context)
}

/// 本地镜像库记录的迁移校验和与二进制内嵌的 SQL 对不上时，把坏库改名留档并重启进程：
/// Context 与 Builder 都是一次性消耗的，同一进程里没法重建，重启是最省事的自愈方式。
fn recover_from_migration_conflict(identifier: &str, error: &tauri::Error) {
    let message = error.to_string();
    if !crash::is_migration_conflict(&message) {
        if let Some(path) = crash::crash_log_path(identifier) {
            eprintln!("[crash] 启动失败，详情见 {}", path.display());
        }
        return;
    }
    if std::env::var_os(DB_RECOVERY_ENV).is_some() || !crash::quarantine_local_db(identifier) {
        return;
    }
    let Ok(exe) = std::env::current_exe() else { return };
    match std::process::Command::new(exe).env(DB_RECOVERY_ENV, "1").spawn() {
        Ok(_) => std::process::exit(0),
        Err(e) => eprintln!("[crash] 重建本地库后重启失败：{e}"),
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let context = tauri::generate_context!();
    let identifier = context.config().identifier.clone();
    // 必须早于任何构建步骤：启动阶段的 panic 根本走不到 setup
    crash::install_panic_hook(&identifier);

    let app = match build_app(context) {
        Ok(app) => app,
        Err(error) => {
            recover_from_migration_conflict(&identifier, &error);
            panic!("error while building tauri application: {error}");
        }
    };

    app.run(|app, event| {
        // 退出时回收内置服务端，别留下一个占着端口的孤儿 Node 进程
        if let tauri::RunEvent::Exit = event {
            localserver::shutdown(app);
        }
    });
}
