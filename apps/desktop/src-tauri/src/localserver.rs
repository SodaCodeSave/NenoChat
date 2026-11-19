// 一体化版本地服务端：
// 安装包里带着一份 Node 运行时与服务端代码，客户端启动时在这里把它拉起来，
// 前端通过 local_server_info 拿到地址与本机握手令牌，直接免密登录。
// 普通联网版安装包里没有这份资源，整个模块会静默跳过。

use std::fs::{create_dir_all, File, OpenOptions};
use std::io::Write;
use std::net::{IpAddr, TcpListener, TcpStream, UdpSocket};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};

const LOOPBACK: &str = "127.0.0.1";
/// 开放局域网时监听所有网卡，回环地址依旧可用
const ANY_HOST: &str = "0.0.0.0";
/// 服务端启动的最长等待时间，首次运行要跑完全部迁移，给足余量
const READY_TIMEOUT: Duration = Duration::from_secs(45);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalServerInfo {
    pub base_url: String,
    pub ws_url: String,
    pub token: String,
    /// 是否已开放到局域网（手机可接入）
    pub lan_enabled: bool,
    /// 开放时给手机用的地址，未开放为 None
    pub lan_url: Option<String>,
}

/// 落盘的长期密钥：重启后 JWT 与托管密钥必须保持一致，否则登录态和 AI 密钥全部失效
#[derive(Debug, Serialize, Deserialize)]
struct Secrets {
    jwt_secret: String,
    secret_key: String,
    token: String,
}

/// 拉起服务端所需的固定信息，开关局域网时复用，不重新跑一遍探测
struct Runtime {
    server_dir: PathBuf,
    node_bin: PathBuf,
    data_dir: PathBuf,
    log_dir: PathBuf,
    secrets: Secrets,
    port: u16,
    host: String,
}

pub struct LocalServerState {
    runtime: Mutex<Option<Runtime>>,
    info: Mutex<Option<LocalServerInfo>>,
    error: Mutex<Option<String>>,
    /// 包里没有服务端资源：普通联网版，前端拿到 None 就走原有的选服务器流程
    skipped: Mutex<bool>,
    child: Mutex<Option<Child>>,
}

impl Default for LocalServerState {
    fn default() -> Self {
        Self {
            runtime: Mutex::new(None),
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
    let listener = TcpListener::bind((LOOPBACK, 0))?;
    let port = listener.local_addr()?.port();
    drop(listener);
    Ok(port)
}

/// 本机在局域网里的地址。
/// 先按 RFC1918 找私有网段的 IPv4：VPN 的 TUN 网卡常拿到 198.18.x 这类地址，
/// 用它拼出来的二维码手机根本连不上。找不到再退回「出口网卡」的判定。
fn lan_ip() -> Option<IpAddr> {
    let mut candidates: Vec<IpAddr> = Vec::new();
    if let Ok(addrs) = if_addrs::get_if_addrs() {
        for addr in addrs {
            if addr.is_loopback() {
                continue;
            }
            let ip = addr.ip();
            if let IpAddr::V4(v4) = ip {
                if v4.is_private() {
                    candidates.push(ip);
                }
            }
        }
    }
    // 同时挂着 Wi-Fi 与有线时优先 192.168 段，家用路由基本都是它
    candidates.sort_by_key(|ip| match ip {
        IpAddr::V4(v4) if v4.octets()[0] == 192 && v4.octets()[1] == 168 => 0,
        _ => 1,
    });
    if let Some(ip) = candidates.first() {
        return Some(*ip);
    }

    let socket = UdpSocket::bind("0.0.0.0:0").ok()?;
    socket.connect("223.5.5.5:80").ok()?;
    let ip = socket.local_addr().ok()?.ip();
    match ip {
        IpAddr::V4(v4) if !v4.is_loopback() && !v4.is_unspecified() => Some(ip),
        _ => None,
    }
}

fn wait_listening(port: u16, timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if TcpStream::connect((LOOPBACK, port)).is_ok() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(150));
    }
    false
}

fn build_info(rt: &Runtime) -> LocalServerInfo {
    let lan = rt.host == ANY_HOST;
    let lan_url = if lan {
        lan_ip().map(|ip| format!("http://{ip}:{}", rt.port))
    } else {
        None
    };
    LocalServerInfo {
        base_url: format!("http://{LOOPBACK}:{}", rt.port),
        ws_url: format!("ws://{LOOPBACK}:{}/ws", rt.port),
        token: rt.secrets.token.clone(),
        lan_enabled: lan && lan_url.is_some(),
        lan_url,
    }
}

fn spawn_child(rt: &Runtime) -> Result<Child, String> {
    let log_path = rt.log_dir.join("integrated-server.log");
    let log = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)
        .map_err(|e| format!("无法打开服务端日志：{e}"))?;
    let stderr = log
        .try_clone()
        .map_err(|e| format!("无法复制日志句柄：{e}"))?;

    let lan_enabled = rt.host == ANY_HOST;
    let public_base = if lan_enabled {
        lan_ip()
            .map(|ip| format!("http://{ip}:{}", rt.port))
            .unwrap_or_else(|| format!("http://{LOOPBACK}:{}", rt.port))
    } else {
        format!("http://{LOOPBACK}:{}", rt.port)
    };

    let mut command = Command::new(&rt.node_bin);
    command
        .arg("server.cjs")
        .current_dir(&rt.server_dir)
        .stdin(Stdio::null())
        .stdout(Stdio::from(log))
        .stderr(Stdio::from(stderr))
        .env("NODE_ENV", "production")
        .env("HOST", &rt.host)
        .env("PORT", rt.port.to_string())
        .env("PUBLIC_BASE_URL", public_base)
        .env("DATA_DIR", &rt.data_dir)
        .env("JWT_SECRET", &rt.secrets.jwt_secret)
        .env("SECRET_KEY", &rt.secrets.secret_key)
        // 只服务本机客户端：关闭注册，靠握手令牌换会话
        .env("LOCAL_MODE", "true")
        .env("LOCAL_AUTH_TOKEN", &rt.secrets.token)
        .env("REGISTRATION_MODE", "closed")
        .env("SERVER_NAME", "NenoChat")
        .env("LOG_LEVEL", "info")
        // 本地大模型（ollama 之类）在回环地址上，必须放行内网端点
        .env("ALLOW_PRIVATE_AI_ENDPOINT", "true")
        .env("LAN_ENABLED", if lan_enabled { "true" } else { "false" })
        // 客户端被强杀时子进程靠这个 pid 判断自己该退出
        .env("PARENT_PID", std::process::id().to_string())
        .env("APP_VERSION", env!("CARGO_PKG_VERSION"));

    // Windows 上不加这个标志，打包后的 GUI 程序会弹一个控制台窗口
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }

    command
        .spawn()
        .map_err(|e| format!("无法启动内置服务端（{}）：{e}", rt.node_bin.display()))
}

fn prepare_runtime(app: &AppHandle) -> Result<Option<Runtime>, String> {
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

    // 运行时优先用包内的 Node，开发态没有随包资源时用系统 node
    let bundled_node = server_dir.join(if cfg!(windows) { "node.exe" } else { "node" });
    let node_bin = if bundled_node.is_file() {
        bundled_node
    } else {
        PathBuf::from("node")
    };

    Ok(Some(Runtime {
        server_dir,
        node_bin,
        data_dir,
        log_dir,
        secrets: load_secrets(&config_dir).map_err(|e| format!("读写本机密钥失败：{e}"))?,
        port: pick_port().map_err(|e| format!("无法分配本地端口：{e}"))?,
        host: LOOPBACK.to_string(),
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

/// 开关「允许手机接入」：切换监听地址并重启服务端，端口保持不变，
/// 桌面端自己的连接地址不受影响，只有手机的扫码地址会随之出现或消失。
#[tauri::command]
pub async fn local_server_set_lan(
    enabled: bool,
    state: State<'_, LocalServerState>,
) -> Result<LocalServerInfo, String> {
    let target_host = if enabled { ANY_HOST } else { LOOPBACK };
    if enabled && lan_ip().is_none() {
        return Err("没有找到局域网地址，请先连上 Wi-Fi 或有线网络".into());
    }

    {
        let runtime = state.runtime.lock().unwrap();
        let Some(rt) = runtime.as_ref() else {
            return Err("当前不是一体版，没有内置服务端".into());
        };
        if rt.host == target_host {
            let info = build_info(rt);
            *state.info.lock().unwrap() = Some(info.clone());
            return Ok(info);
        }
    }

    // 换监听地址必须重启子进程：Node 不能给已监听的端口换绑定
    {
        let mut child = state.child.lock().unwrap().take();
        if let Some(child) = child.as_mut() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }

    let mut runtime = state.runtime.lock().unwrap();
    let rt = runtime.as_mut().ok_or("内置服务端未初始化")?;
    rt.host = target_host.to_string();

    let child = spawn_child(rt)?;
    *state.child.lock().unwrap() = Some(child);

    if !wait_listening(rt.port, READY_TIMEOUT) {
        return Err("切换局域网监听后服务端没有起来，请查看 integrated-server.log".into());
    }

    let info = build_info(rt);
    *state.info.lock().unwrap() = Some(info.clone());
    Ok(info)
}

/// setup 阶段只负责把子进程拉起来，就绪检测放到后台线程，
/// 否则首次运行跑迁移会卡住窗口创建，用户会看到「点了没反应」。
pub fn boot(app: &AppHandle) {
    let state = app.state::<LocalServerState>();
    let rt = match prepare_runtime(app) {
        Ok(Some(rt)) => rt,
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

    let child = match spawn_child(&rt) {
        Ok(child) => child,
        Err(e) => {
            eprintln!("[localserver] {e}");
            *state.error.lock().unwrap() = Some(e);
            return;
        }
    };

    let port = rt.port;
    let info = build_info(&rt);
    *state.child.lock().unwrap() = Some(child);
    *state.runtime.lock().unwrap() = Some(rt);

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
