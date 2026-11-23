//! 启动崩溃取证与本地镜像库兜底。
//!
//! release 构建关掉了控制台（windows_subsystem = "windows"）且 panic = "abort"，
//! 一旦启动阶段出错，用户只会看到「点了没反应」，日志无处可查。
//! 这里把 panic 写进日志目录，并在迁移校验冲突时把坏库改名留档，让下一次启动能重建。

use std::fs::{create_dir_all, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

/// sqlx 在本地库已应用过某版本、但内嵌 SQL 文本变了时给出的报错片段
const MIGRATION_CONFLICT_MARKER: &str = "was previously applied but has been modified";

/// 应用数据目录，等价于 tauri 的 app_config_dir
#[cfg(windows)]
fn config_dir(identifier: &str) -> Option<PathBuf> {
    std::env::var_os("APPDATA").map(|base| PathBuf::from(base).join(identifier))
}

#[cfg(target_os = "macos")]
fn config_dir(identifier: &str) -> Option<PathBuf> {
    std::env::var_os("HOME")
        .map(|home| PathBuf::from(home).join("Library").join("Application Support").join(identifier))
}

#[cfg(all(unix, not(target_os = "macos"), not(target_os = "android"), not(target_os = "ios")))]
fn config_dir(identifier: &str) -> Option<PathBuf> {
    let base = std::env::var_os("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".config")))?;
    Some(base.join(identifier))
}

#[cfg(any(target_os = "android", target_os = "ios"))]
fn config_dir(_identifier: &str) -> Option<PathBuf> {
    None
}

/// 应用日志目录，等价于 tauri 的 app_log_dir
#[cfg(windows)]
fn log_dir(identifier: &str) -> Option<PathBuf> {
    std::env::var_os("LOCALAPPDATA").map(|base| PathBuf::from(base).join(identifier).join("logs"))
}

#[cfg(target_os = "macos")]
fn log_dir(identifier: &str) -> Option<PathBuf> {
    std::env::var_os("HOME").map(|home| PathBuf::from(home).join("Library").join("Logs").join(identifier))
}

#[cfg(all(unix, not(target_os = "macos"), not(target_os = "android"), not(target_os = "ios")))]
fn log_dir(identifier: &str) -> Option<PathBuf> {
    config_dir(identifier).map(|dir| dir.join("logs"))
}

#[cfg(any(target_os = "android", target_os = "ios"))]
fn log_dir(_identifier: &str) -> Option<PathBuf> {
    None
}

fn unix_seconds() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// 登记 panic 落盘：窗口还没创建就崩的时候，这里是唯一能看到原因的地方
pub fn install_panic_hook(identifier: &str) {
    let dir = log_dir(identifier);
    std::panic::set_hook(Box::new(move |info| {
        let text = format!(
            "===== {} (unix) =====\n{info}\n{}\n",
            unix_seconds(),
            std::backtrace::Backtrace::force_capture()
        );
        eprintln!("{text}");
        let Some(dir) = dir.as_ref() else { return };
        let _ = create_dir_all(dir);
        if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(dir.join("crash.log")) {
            let _ = file.write_all(text.as_bytes());
        }
    }));
}

/// 判断构建失败是否来自迁移校验冲突（本地库比二进制旧且 SQL 文本被改过）
pub fn is_migration_conflict(error: &str) -> bool {
    error.contains(MIGRATION_CONFLICT_MARKER)
}

/// 把冲突的本地库改名留档，返回是否真的挪动了文件。
/// 改名而不是删除：本地镜像里可能还有没发出去的消息，坏了也得让用户能找回来。
pub fn quarantine_local_db(identifier: &str) -> bool {
    let Some(dir) = config_dir(identifier) else { return false };
    let stamp = unix_seconds();
    let mut moved = false;
    for suffix in ["", "-wal", "-shm"] {
        let source = dir.join(format!("nenochat.db{suffix}"));
        if !source.is_file() {
            continue;
        }
        let target = dir.join(format!("nenochat.db{suffix}.broken-{stamp}"));
        if std::fs::rename(&source, &target).is_ok() {
            moved = true;
        }
    }
    moved
}

/// 崩溃日志的实际路径，用于提示用户去哪儿找
pub fn crash_log_path(identifier: &str) -> Option<PathBuf> {
    log_dir(identifier).map(|dir| dir.join("crash.log"))
}
