// 一体化版本地服务端：
// 安装包里带着一份 Node 运行时与服务端代码，客户端启动时在这里把它拉起来，
// 前端通过 local_server_info 拿到地址与本机握手令牌，直接免密登录。
// 普通联网版安装包里没有这份资源，整个模块会静默跳过。

use std::fs::{create_dir_all, File, OpenOptions};
use std::io::Write;
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};

const HOST: &str = "127.0.0.1";
/// 服务端启动的最长等待时间，首次运行要跑完全部迁移，给足余量
const READY_TIMEOUT: Duration = Duration::from_secs(45);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalServerInfo {
    pub base_url: String,
    pub ws_url: String,
    pub token: String,
}

/// 落盘的长期密钥：重启后 JWT 与托管密钥必须保持一致，否则登录态和 AI 密钥全部失效
#[derive(Debug, Serialize, Deserialize)]
struct Secrets {
    jwt_secret: String,
    secret_key: String,
    token: String,
}

pub struct LocalServerState {
    info: Mutex<Option<LocalServerInfo>>,
    error: Mutex<Option<String>>,
    /// 包里没有服务端资源：普通联网版，前端拿到 None 就走原有的选服务器流程
    skipped: Mutex<bool>,
    child: Mutex<Option<Child>>,
}

impl Default for LocalServerState {
    fn default() -> Self {
        Self {
            info: Mutex::new(None),
            error: Mutex::new(None),
            skipped: Mutex::new(false),
            child: Mutex::new(None),
        }
    }
}

fn random_secret() -> String {
    // uuid v4 是 122 位随机数，两段拼起来远超 32 字符的强度要求
    format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    )
}

/// 只有一体版才内嵌服务端；用标识符判定而不是「资源目录里有没有 server」，
/// 否则本地先后构建两种安装包时，残留的资源副本会让联网版也误进一体化模式
fn is_integrated_build(app: &AppHandle) -> bool {
    app.config().identifier.ends_with(".integrated")
}

/// 找安装包里的服务端目录；开发调试时回退到仓库里的资源目录
fn resolve_server_dir(app: &AppHandle) -> Option<PathBuf> {
    let dev_override = cfg!(debug_assertions) && std::env::var("NENOCHAT_INTEGRATED_DEV").is_ok();
    if !is_integrated_build(app) && !dev_override {
        return None;
    }

    if let Ok(resource) = app.path().resource_dir() {
        let candidate = resource.join("server");
        if candidate.join("server.cjs").is_file() {
            return Some(candidate);
        }
    }
    if dev_override {
        let dev = Path::new(env!("CARGO_MANIFEST_DIR")).join("resources/server");
        if dev.join("server.cjs").is_file() {
            return Some(dev);
        }
    }
    None
}

fn load_secrets(config_dir: &Path) -> std::io::Result<Secrets> {
    create_dir_all(config_dir)?;
    let file = config_dir.join("integrated-server.json");
    if let Ok(raw) = std::fs::read_to_string(&file) {
        if let Ok(parsed) = serde_json::from_str::<Secrets>(&raw) {
            return Ok(parsed);
        }
    }
    let secrets = Secrets {
        jwt_secret: random_secret(),
        secret_key: random_secret(),
        token: random_secret(),
    };
    let mut handle = File::create(&file)?;
    handle.write_all(serde_json::to_string_pretty(&secrets)?.as_bytes())?;
    Ok(secrets)
}

/// 取一个当前空闲的回环端口；绑完立刻释放，交给 Node 去监听
fn pick_port() -> std::io::Result<u16> {
    let listener = TcpListener::bind((HOST, 0))?;
    let port = listener.local_addr()?.port();
    drop(listener);
    Ok(port)
}

fn wait_listening(port: u16, timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if TcpStream::connect((HOST, port)).is_ok() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(150));
    }
    false
}

/// 启动内置服务端；没有随包资源时返回 Ok(None)，表示这是一个普通客户端
fn spawn(app: &AppHandle) -> Result<Option<LocalServerInfo>, String> {
    let Some(server_dir) = resolve_server_dir(app) else {
        return Ok(None);
    };

    let config_dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("无法定位配置目录：{e}"))?;
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("无法定位数据目录：{e}"))?
        .join("server");
    let log_dir = app
        .path()
        .app_log_dir()
        .map_err(|e| format!("无法定位日志目录：{e}"))?;
    create_dir_all(&data_dir).map_err(|e| format!("无法创建数据目录：{e}"))?;
    create_dir_all(&log_dir).map_err(|e| format!("无法创建日志目录：{e}"))?;

    let secrets = load_secrets(&config_dir).map_err(|e| format!("读写本机密钥失败：{e}"))?;
    let port = pick_port().map_err(|e| format!("无法分配本地端口：{e}"))?;
    let base_url = format!("http://{HOST}:{port}");

    // 运行时优先用包内的 Node，开发态没有随包资源时用系统 node
    let bundled_node = server_dir.join(if cfg!(windows) { "node.exe" } else { "node" });
    let node_bin = if bundled_node.is_file() {
        bundled_node
    } else {
        PathBuf::from("node")
    };

    let log_path = log_dir.join("integrated-server.log");
    let log = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)
        .map_err(|e| format!("无法打开服务端日志：{e}"))?;
    let stderr = log
        .try_clone()
        .map_err(|e| format!("无法复制日志句柄：{e}"))?;

    let mut command = Command::new(&node_bin);
    command
        .arg("server.cjs")
        .current_dir(&server_dir)
        .stdin(Stdio::null())
        .stdout(Stdio::from(log))
        .stderr(Stdio::from(stderr))
        .env("NODE_ENV", "production")
        .env("HOST", HOST)
        .env("PORT", port.to_string())
        .env("PUBLIC_BASE_URL", &base_url)
        .env("DATA_DIR", &data_dir)
        .env("JWT_SECRET", &secrets.jwt_secret)
        .env("SECRET_KEY", &secrets.secret_key)
        // 只服务本机客户端：关闭注册，靠握手令牌换会话
        .env("LOCAL_MODE", "true")
        .env("LOCAL_AUTH_TOKEN", &secrets.token)
        .env("REGISTRATION_MODE", "closed")
        .env("SERVER_NAME", "NenoChat")
        .env("LOG_LEVEL", "info")
        // 本地大模型（ollama 之类）在回环地址上，必须放行内网端点
        .env("ALLOW_PRIVATE_AI_ENDPOINT", "true")
        // 客户端被强杀时子进程靠这个 pid 判断自己该退出
        .env("PARENT_PID", std::process::id().to_string())
        .env("APP_VERSION", app.package_info().version.to_string());

    // Windows 上不加这个标志，打包后的 GUI 程序会弹一个控制台窗口
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }

    let child = command
        .spawn()
        .map_err(|e| format!("无法启动内置服务端（{}）：{e}", node_bin.display()))?;

    let state = app.state::<LocalServerState>();
    *state.child.lock().unwrap() = Some(child);

    Ok(Some(LocalServerInfo {
        base_url: base_url.clone(),
        ws_url: format!("ws://{HOST}:{port}/ws"),
        token: secrets.token,
    }))
}

/// 前端启动时读取：等子进程就绪后一次性拿到地址与令牌
#[tauri::command]
pub async fn local_server_info(
    state: State<'_, LocalServerState>,
) -> Result<Option<LocalServerInfo>, String> {
    let deadline = Instant::now() + READY_TIMEOUT;
    loop {
        if *state.skipped.lock().unwrap() {
            return Ok(None);
        }
        if let Some(error) = state.error.lock().unwrap().clone() {
            return Err(error);
        }
        if let Some(info) = state.info.lock().unwrap().clone() {
            return Ok(Some(info));
        }
        if Instant::now() >= deadline {
            return Err("内置服务端启动超时".into());
        }
        tokio::time::sleep(Duration::from_millis(150)).await;
    }
}

/// setup 阶段只负责把子进程拉起来，就绪检测放到后台线程，
/// 否则首次运行跑迁移会卡住窗口创建，用户会看到「点了没反应」。
pub fn boot(app: &AppHandle) {
    let state = app.state::<LocalServerState>();
    let info = match spawn(app) {
        Ok(Some(info)) => info,
        Ok(None) => {
            *state.skipped.lock().unwrap() = true;
            return;
        }
        Err(e) => {
            eprintln!("[localserver] {e}");
            *state.error.lock().unwrap() = Some(e);
            return;
        }
    };

    let port = match info.base_url.rsplit(':').next().and_then(|p| p.parse::<u16>().ok()) {
        Some(port) => port,
        None => {
            *state.error.lock().unwrap() = Some("内置服务端端口解析失败".into());
            return;
        }
    };

    let handle = app.clone();
    std::thread::spawn(move || {
        let state = handle.state::<LocalServerState>();
        if wait_listening(port, READY_TIMEOUT) {
            *state.info.lock().unwrap() = Some(info);
        } else {
            *state.error.lock().unwrap() =
                Some("内置服务端启动超时，请查看日志目录下的 integrated-server.log".into());
        }
    });
}

/// 退出时回收子进程，避免残留一个占着端口的 Node
pub fn shutdown(app: &AppHandle) {
    let state = app.state::<LocalServerState>();
    let child = state.child.lock().unwrap().take();
    if let Some(mut child) = child {
        let _ = child.kill();
        let _ = child.wait();
    }
}
