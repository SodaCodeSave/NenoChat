//! 桌面系统通知。
//!
//! Windows 只给登记过显示名的 AUMID 建立可展示的通知通道：开发模式下
//! tauri-plugin-notification 会跳过 app_id，回落到 PowerShell 身份，
//! toast 会被写进通知数据库却不弹出。这里在启动时补一个 AUMID 注册项，
//! 发送时显式使用它，并接管点击回跳。

use tauri::AppHandle;

#[cfg(windows)]
pub const APP_ID: &str = "com.nenochat.app";

/// 在 HKCU 注册 AUMID 的显示名与图标。
/// 只写当前用户，不建开始菜单快捷方式，卸载时随用户配置一起清理。
#[cfg(windows)]
pub fn ensure_app_id_registered(display_name: &str, icon: Option<&std::path::Path>) {
    use winreg::enums::HKEY_CURRENT_USER;
    use winreg::RegKey;

    let path = format!(r"Software\Classes\AppUserModelId\{APP_ID}");
    let Ok((key, _)) = RegKey::predef(HKEY_CURRENT_USER).create_subkey(&path) else {
        return;
    };
    let _ = key.set_value("DisplayName", &display_name.to_string());
    if let Some(icon) = icon {
        let _ = key.set_value("IconUri", &icon.display().to_string());
    }
    let _ = key.set_value("ShowInSettings", &1u32);
}

/// 弹出一条系统通知；Windows 下使用自有 AUMID，其余平台继续走通知插件。
#[tauri::command]
pub fn show_system_notification(
    app: AppHandle,
    title: String,
    body: String,
    silent: Option<bool>,
    conversation_id: Option<String>,
) -> Result<(), String> {
    #[cfg(windows)]
    {
        use tauri_winrt_notification::{Duration, Sound, Toast};

        let (clicked_tx, clicked_rx) = std::sync::mpsc::channel::<()>();
        let sound = if silent.unwrap_or(false) {
            None
        } else {
            Some(Sound::Default)
        };
        Toast::new(APP_ID)
            .title(&title)
            .text1(&body)
            .duration(Duration::Short)
            .sound(sound)
            .on_activated(move |_| {
                let _ = clicked_tx.send(());
                Ok(())
            })
            .show()
            .map_err(|error| error.to_string())?;

        // 点击回调运行在 WinRT 事件线程，这里单独等待，避免阻塞命令线程
        std::thread::spawn(move || {
            if clicked_rx
                .recv_timeout(std::time::Duration::from_secs(3600))
                .is_err()
            {
                return;
            }
            focus_main_window(&app);
            if let Some(conversation_id) = conversation_id {
                use tauri::Emitter;
                let _ = app.emit("system-notification://click", conversation_id);
            }
        });
        Ok(())
    }

    #[cfg(not(windows))]
    {
        use tauri_plugin_notification::NotificationExt;
        let _ = silent;
        let _ = conversation_id;
        app.notification()
            .builder()
            .title(title)
            .body(body)
            .show()
            .map_err(|error| error.to_string())
    }
}

#[cfg(windows)]
fn focus_main_window(app: &AppHandle) {
    use tauri::Manager;
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}
