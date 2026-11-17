//! API Key 的安全存储：主密钥放在操作系统钥匙串，密文落在应用 store 里。
//! 移动端没有桌面钥匙串，这里以编译期条件隔离。

#[cfg(desktop)]
const SERVICE: &str = "com.nenochat.app";

/// 把密钥写入系统钥匙串。
#[cfg(desktop)]
#[tauri::command]
pub fn secret_set(account: String, value: String) -> Result<(), String> {
    let entry = keyring::Entry::new(SERVICE, &account).map_err(|e| format!("打开钥匙串失败: {e}"))?;
    entry
        .set_password(&value)
        .map_err(|e| format!("写入钥匙串失败: {e}"))
}

/// 从系统钥匙串读取密钥，不存在时返回空字符串。
#[cfg(desktop)]
#[tauri::command]
pub fn secret_get(account: String) -> Result<String, String> {
    let entry = keyring::Entry::new(SERVICE, &account).map_err(|e| format!("打开钥匙串失败: {e}"))?;
    match entry.get_password() {
        Ok(value) => Ok(value),
        Err(keyring::Error::NoEntry) => Ok(String::new()),
        Err(e) => Err(format!("读取钥匙串失败: {e}")),
    }
}

/// 从系统钥匙串删除密钥。
#[cfg(desktop)]
#[tauri::command]
pub fn secret_delete(account: String) -> Result<(), String> {
    let entry = keyring::Entry::new(SERVICE, &account).map_err(|e| format!("打开钥匙串失败: {e}"))?;
    match entry.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(format!("删除钥匙串条目失败: {e}")),
    }
}

/// 移动端暂不支持系统钥匙串，前端会据此降级提示。
#[cfg(not(desktop))]
#[tauri::command]
pub fn secret_set(_account: String, _value: String) -> Result<(), String> {
    Err("当前平台不支持系统钥匙串".into())
}

#[cfg(not(desktop))]
#[tauri::command]
pub fn secret_get(_account: String) -> Result<String, String> {
    Ok(String::new())
}

#[cfg(not(desktop))]
#[tauri::command]
pub fn secret_delete(_account: String) -> Result<(), String> {
    Ok(())
}
