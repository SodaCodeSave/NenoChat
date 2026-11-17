//! 环回反向代理：Android WebView 154+ 启用 Local Network Access 后，
//! 页面（http://tauri.localhost 属本地上下文）直接 fetch/ws 私网 IP 会被无提示拦截
//! （表现为 Failed to fetch，服务器侧收不到任何请求）。
//! 让前端把 baseUrl/wsUrl 指到本代理（127.0.0.1 随机端口，环回→环回不受限），
//! 由这里转发到用户配置的真实服务器。桌面端 WebView2 未启用该限制，不经过此通道。

use std::sync::{Arc, OnceLock};

use axum::body::Body;
use axum::extract::ws::{Message as WsMessage, WebSocket, WebSocketUpgrade};
use axum::extract::{Request, State};
use axum::http::header::{self, HeaderName, HeaderValue};
use axum::response::Response;
use axum::routing::any;
use axum::Router;
use futures_util::{SinkExt, StreamExt};
use tokio::sync::Mutex;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;

/// 代理运行状态：环回端口进程内不变（前端拿一次地址一直可用），
/// 切换服务器只换转发目标。
struct ProxyState {
    target: Mutex<Option<String>>,
    http: reqwest::Client,
}

static PROXY: OnceLock<Arc<ProxyState>> = OnceLock::new();
static LOCAL_PORT: OnceLock<u16> = OnceLock::new();

impl ProxyState {
    async fn upstream_url(&self, path_and_query: &str) -> Result<String, String> {
        let target = self
            .target
            .lock()
            .await
            .clone()
            .ok_or("代理目标未设置")?;
        Ok(format!(
            "{}/{}",
            target.trim_end_matches('/'),
            path_and_query.trim_start_matches('/')
        ))
    }
}

/// 应用启动时初始化环回监听；命令注册在全平台，仅 Android 前端实际使用。
pub fn init() {
    let http = reqwest::Client::builder()
        .no_proxy()
        .build()
        .expect("构建 reqwest client 失败");
    let state = Arc::new(ProxyState { target: Mutex::new(None), http });

    let bound = state.clone();
    tauri::async_runtime::spawn(async move {
        let app = Router::new()
            .route("/ws", any(handle_ws_upgrade))
            .fallback(any(handle_http_any))
            .with_state(bound);
        match tokio::net::TcpListener::bind("127.0.0.1:0").await {
            Ok(listener) => {
                let port = listener.local_addr().map(|a| a.port()).unwrap_or(0);
                let _ = LOCAL_PORT.set(port);
                if let Err(e) = axum::serve(listener, app).await {
                    eprintln!("[proxy] 环回代理退出: {e}");
                }
            }
            Err(e) => eprintln!("[proxy] 绑定环回端口失败: {e}"),
        }
    });

    let _ = PROXY.set(state);
}

/// 前端调用：设置转发目标（真实服务器 http(s) 地址），返回环回代理地址。
#[tauri::command]
pub async fn proxy_set_target(target: String) -> Result<String, String> {
    let target = target.trim().trim_end_matches('/').to_string();
    if !target.starts_with("http://") && !target.starts_with("https://") {
        return Err("代理目标必须是 http(s) 地址".to_string());
    }
    let port = match LOCAL_PORT.get() {
        Some(port) => *port,
        None => {
            // 监听器异步启动，最多等 3 秒
            let mut found = None;
            for _ in 0..30 {
                tokio::time::sleep(std::time::Duration::from_millis(100)).await;
                if let Some(port) = LOCAL_PORT.get() {
                    found = Some(*port);
                    break;
                }
            }
            found.ok_or("代理尚未就绪".to_string())?
        }
    };
    PROXY.get().expect("代理未初始化").target.lock().await.replace(target);
    Ok(format!("http://127.0.0.1:{port}"))
}

/// WebSocket 升级请求（本应用的实时通道固定为 /ws）
async fn handle_ws_upgrade(
    State(state): State<Arc<ProxyState>>,
    upgrade: WebSocketUpgrade,
    request: Request,
) -> Response {
    forward_ws(state, upgrade, request).await
}

async fn handle_http_any(State(state): State<Arc<ProxyState>>, request: Request) -> Response {
    let origin = request.headers().get(header::ORIGIN).cloned();
    if request.method() == axum::http::Method::OPTIONS {
        // CORS 预检就地短路：上游返回的 CORS 头是按它自己的部署给的，不必转发
        let mut response = Response::new(Body::empty());
        apply_cors(response.headers_mut(), origin.as_ref());
        return response;
    }
    forward_http(state, request, origin).await
}

async fn forward_http(
    state: Arc<ProxyState>,
    request: Request,
    origin: Option<HeaderValue>,
) -> Response {
    let path_and_query = request
        .uri()
        .path_and_query()
        .map(|pq| pq.as_str().to_string())
        .unwrap_or_else(|| "/".to_string());
    let upstream = match state.upstream_url(&path_and_query).await {
        Ok(url) => url,
        Err(e) => return plain_response(502, &e, origin.as_ref()),
    };

    let (parts, body) = request.into_parts();
    let mut headers = parts.headers.clone();
    headers.remove(header::HOST);
    headers.remove(header::CONNECTION);

    let mut builder = state.http.request(parts.method.clone(), &upstream).headers(headers);

    match axum::body::to_bytes(body, 64 * 1024 * 1024).await {
        Ok(bytes) if !bytes.is_empty() => builder = builder.body(bytes.to_vec()),
        Ok(_) => {}
        Err(e) => return plain_response(400, &format!("读取请求体失败: {e}"), origin.as_ref()),
    }

    match builder.send().await {
        Ok(upstream_resp) => {
            let mut response = Response::builder().status(upstream_resp.status().as_u16());
            let resp_headers = response.headers_mut().unwrap();
            for (name, value) in upstream_resp.headers().iter() {
                if matches!(name.as_str(), "transfer-encoding" | "connection" | "content-length") {
                    continue;
                }
                if let Ok(name) = HeaderName::from_bytes(name.as_str().as_bytes()) {
                    resp_headers.append(name, value.clone());
                }
            }
            apply_cors(resp_headers, origin.as_ref());
            match upstream_resp.bytes().await {
                Ok(bytes) => response.body(Body::from(bytes)).unwrap_or_else(|_| {
                    plain_into_response(502, "构造响应失败", origin.as_ref())
                }),
                Err(e) => plain_response(502, &format!("读取上游响应失败: {e}"), origin.as_ref()),
            }
        }
        Err(e) => plain_response(502, &format!("无法连接上游服务器: {e}"), origin.as_ref()),
    }
}

async fn forward_ws(state: Arc<ProxyState>, upgrade: WebSocketUpgrade, request: Request) -> Response {
    let path_and_query = request
        .uri()
        .path_and_query()
        .map(|pq| pq.as_str().to_string())
        .unwrap_or_else(|| "/".to_string());
    let upstream = match state.upstream_url(&path_and_query).await {
        Ok(url) => url,
        Err(e) => return plain_response(502, &e, None),
    };
    let ws_url = upstream.replacen("http://", "ws://", 1).replacen("https://", "wss://", 1);

    let mut ws_request = match ws_url.into_client_request() {
        Ok(req) => req,
        Err(e) => return plain_response(502, &format!("上游 WS 地址不合法: {e}"), None),
    };
    // 带上鉴权上下文；设备头用于多端会话管理
    for name in [
        header::AUTHORIZATION,
        header::COOKIE,
        HeaderName::from_static("x-device-id"),
    ] {
        if let Some(value) = request.headers().get(&name) {
            ws_request.headers_mut().insert(name, value.clone());
        }
    }

    let (upstream_ws, _resp) = match tokio_tungstenite::connect_async(ws_request).await {
        Ok(ok) => ok,
        Err(e) => return plain_response(502, &format!("连接上游 WebSocket 失败: {e}"), None),
    };

    let (mut upstream_sink, mut upstream_stream) = upstream_ws.split();
    upgrade.on_upgrade(move |socket: WebSocket| async move {
        let (mut client_sink, mut client_stream) = socket.split();
        let up_task = tokio::spawn(async move {
            while let Some(Ok(msg)) = client_stream.next().await {
                let out = match msg {
                    WsMessage::Text(t) => {
                        tokio_tungstenite::tungstenite::Message::Text(t.to_string().into())
                    }
                    WsMessage::Binary(b) => {
                        tokio_tungstenite::tungstenite::Message::Binary(b.into())
                    }
                    WsMessage::Ping(p) => tokio_tungstenite::tungstenite::Message::Ping(p),
                    WsMessage::Pong(p) => tokio_tungstenite::tungstenite::Message::Pong(p),
                    WsMessage::Close(c) => tokio_tungstenite::tungstenite::Message::Close(
                        c.map(|f| tokio_tungstenite::tungstenite::protocol::CloseFrame {
                            code: f.code.into(),
                            reason: f.reason.as_str().into(),
                        }),
                    ),
                };
                if upstream_sink.send(out).await.is_err() {
                    break;
                }
            }
            let _ = upstream_sink.close().await;
        });
        while let Some(Ok(msg)) = upstream_stream.next().await {
                let out = match msg {
                    tokio_tungstenite::tungstenite::Message::Text(t) => {
                        WsMessage::Text(t.to_string().into())
                    }
                tokio_tungstenite::tungstenite::Message::Binary(b) => WsMessage::Binary(b.into()),
                tokio_tungstenite::tungstenite::Message::Ping(p) => WsMessage::Ping(p),
                tokio_tungstenite::tungstenite::Message::Pong(p) => WsMessage::Pong(p),
                tokio_tungstenite::tungstenite::Message::Close(c) => {
                    WsMessage::Close(c.map(|f| axum::extract::ws::CloseFrame {
                        code: f.code.into(),
                        reason: f.reason.to_string().into(),
                    }))
                }
                // 原始帧仅在特殊配置下出现，直接丢弃
                tokio_tungstenite::tungstenite::Message::Frame(_) => continue,
            };
            if client_sink.send(out).await.is_err() {
                break;
            }
        }
        up_task.abort();
    })
}

fn apply_cors(headers: &mut axum::http::HeaderMap, origin: Option<&HeaderValue>) {
    let Some(origin) = origin else { return };
    headers.insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, origin.clone());
    headers.insert(
        header::ACCESS_CONTROL_ALLOW_CREDENTIALS,
        HeaderValue::from_static("true"),
    );
    headers.insert(
        header::ACCESS_CONTROL_ALLOW_METHODS,
        HeaderValue::from_static("GET,POST,PATCH,DELETE,OPTIONS"),
    );
    headers.insert(
        header::ACCESS_CONTROL_ALLOW_HEADERS,
        HeaderValue::from_static("Authorization, Content-Type, X-Device-Id, X-Client-Version"),
    );
    headers.insert(header::ACCESS_CONTROL_MAX_AGE, HeaderValue::from_static("86400"));
    headers.append(header::VARY, HeaderValue::from_static("Origin"));
}

fn plain_into_response(status: u16, message: &str, origin: Option<&HeaderValue>) -> Response {
    let mut response = Response::new(Body::from(message.to_string()));
    response
        .headers_mut()
        .insert(header::CONTENT_TYPE, HeaderValue::from_static("text/plain; charset=utf-8"));
    if let Some(origin) = origin {
        apply_cors(response.headers_mut(), Some(origin));
    }
    if let Ok(code) = axum::http::StatusCode::from_u16(status) {
        *response.status_mut() = code;
    }
    response
}

fn plain_response(status: u16, message: &str, origin: Option<&HeaderValue>) -> Response {
    plain_into_response(status, message, origin)
}
