//! AI 流式网关：把 OpenAI 兼容接口的 SSE 流转成 Tauri 事件推给前端。
//!
//! 只有 key 存放在本地（key_location = local）时才走这里；
//! key 存在服务端时由服务端生成、通过 WebSocket 推流。

use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

const EVENT_DELTA: &str = "ai://delta";
const EVENT_DONE: &str = "ai://done";
const EVENT_ERROR: &str = "ai://error";

/// 一条对话消息。content 可能是纯文本，也可能是多模态分片数组
/// （text / image_url），交给 serde_json::Value 原样透传上游。
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct ChatMessage {
    pub role: String,
    pub content: serde_json::Value,
}

#[derive(Debug, Deserialize)]
pub struct AiRequest {
    pub generation_id: String,
    pub base_url: String,
    pub api_key: String,
    pub model: String,
    pub temperature: Option<f32>,
    pub max_tokens: Option<u32>,
    pub messages: Vec<ChatMessage>,
    #[serde(default)]
    pub extra_headers: Option<std::collections::HashMap<String, String>>,
}

#[derive(Clone, Serialize)]
struct DeltaPayload {
    generation_id: String,
    delta: String,
}

#[derive(Clone, Serialize)]
struct DonePayload {
    generation_id: String,
    prompt_tokens: Option<i64>,
    completion_tokens: Option<i64>,
    cached_tokens: Option<i64>,
    model: Option<String>,
}

#[derive(Clone, Serialize)]
struct ErrorPayload {
    generation_id: String,
    message: String,
}

/// 流式与一次性补全共用的用量结构：上游没给的字段为 None
#[derive(Debug, Clone, Serialize)]
pub struct AiUsage {
    pub prompt_tokens: Option<i64>,
    pub completion_tokens: Option<i64>,
    pub cached_tokens: Option<i64>,
}

/// 一次性补全的返回：正文 + 真实用量，供调试模式落库
#[derive(Debug, Clone, Serialize)]
pub struct AiCompleteResult {
    pub content: String,
    pub usage: Option<AiUsage>,
}

fn parse_usage(value: &serde_json::Value) -> Option<AiUsage> {
    let usage = value.get("usage")?;
    let num = |v: Option<&serde_json::Value>| v.and_then(|x| x.as_i64());
    let prompt_tokens = num(usage.get("prompt_tokens"));
    let completion_tokens = num(usage.get("completion_tokens"));
    // OpenAI 系在 prompt_tokens_details 里给缓存命中；个别站点直接给 cached_tokens
    let cached_tokens = usage
        .get("prompt_tokens_details")
        .and_then(|d| d.get("cached_tokens"))
        .and_then(|x| x.as_i64())
        .or_else(|| num(usage.get("cached_tokens")));
    if prompt_tokens.is_none() && completion_tokens.is_none() && cached_tokens.is_none() {
        return None;
    }
    Some(AiUsage {
        prompt_tokens,
        completion_tokens,
        cached_tokens,
    })
}

/// 发起一次流式补全，增量通过 `ai://delta` 事件下发。
#[tauri::command]
pub async fn ai_generate(app: AppHandle, request: AiRequest) -> Result<(), String> {
    let generation_id = request.generation_id.clone();
    let result = run_stream(&app, &request).await;

    match result {
        Ok((usage, model)) => {
            let _ = app.emit(
                EVENT_DONE,
                DonePayload {
                    generation_id,
                    prompt_tokens: usage.as_ref().and_then(|u| u.prompt_tokens),
                    completion_tokens: usage.as_ref().and_then(|u| u.completion_tokens),
                    cached_tokens: usage.as_ref().and_then(|u| u.cached_tokens),
                    model,
                },
            );
            Ok(())
        }
        Err(message) => {
            let _ = app.emit(
                EVENT_ERROR,
                ErrorPayload {
                    generation_id,
                    message: message.clone(),
                },
            );
            Err(message)
        }
    }
}

async fn run_stream(app: &AppHandle, request: &AiRequest) -> Result<(Option<AiUsage>, Option<String>), String> {
    let base = request.base_url.trim_end_matches('/');
    let url = if base.ends_with("/chat/completions") {
        base.to_string()
    } else {
        format!("{base}/chat/completions")
    };

    let mut body = serde_json::json!({
        "model": request.model,
        "messages": request.messages,
        "stream": true,
        "stream_options": { "include_usage": true },
    });
    if let Some(t) = request.temperature {
        body["temperature"] = serde_json::json!(t);
    }
    if let Some(m) = request.max_tokens {
        body["max_tokens"] = serde_json::json!(m);
    }

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(180))
        .build()
        .map_err(|e| format!("创建 HTTP 客户端失败: {e}"))?;

    let mut builder = client
        .post(&url)
        .header("accept", "text/event-stream")
        .bearer_auth(&request.api_key)
        .json(&body);

    if let Some(headers) = &request.extra_headers {
        for (key, value) in headers {
            builder = builder.header(key, value);
        }
    }

    let response = builder
        .send()
        .await
        .map_err(|e| format!("请求上游失败: {e}"))?;

    if !response.status().is_success() {
        let status = response.status();
        let text = response.text().await.unwrap_or_default();
        let brief: String = text.chars().take(400).collect();
        return Err(format!("上游返回 {status}: {brief}"));
    }

    let mut usage: Option<AiUsage> = None;
    let mut model = None;
    let mut buffer = String::new();
    let mut stream = response.bytes_stream();

    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("读取流失败: {e}"))?;
        buffer.push_str(&String::from_utf8_lossy(&chunk));

        while let Some(pos) = buffer.find('\n') {
            let line = buffer[..pos].trim_end_matches('\r').to_string();
            buffer = buffer[pos + 1..].to_string();
            let Some(data) = line.strip_prefix("data:") else {
                continue;
            };
            let data = data.trim();
            if data.is_empty() {
                continue;
            }
            if data == "[DONE]" {
                return Ok((usage, model));
            }

            let Ok(value) = serde_json::from_str::<serde_json::Value>(data) else {
                continue;
            };

            if let Some(m) = value.get("model").and_then(|v| v.as_str()) {
                model = Some(m.to_string());
            }
            // usage 通常在最后一个 chunk，出现就覆盖
            if let Some(parsed) = parse_usage(&value) {
                usage = Some(parsed);
            }

            let delta = value
                .pointer("/choices/0/delta/content")
                .and_then(|v| v.as_str())
                .unwrap_or("");

            if !delta.is_empty() {
                let _ = app.emit(
                    EVENT_DELTA,
                    DeltaPayload {
                        generation_id: request.generation_id.clone(),
                        delta: delta.to_string(),
                    },
                );
            }
        }
    }

    Ok((usage, model))
}

/// 非流式的一次性补全，用于记忆压缩、主动消息这类不需要逐字展示的场景。
/// 返回正文与真实 usage，调用方负责把用量上报给服务端落库。
#[tauri::command]
pub async fn ai_complete(
    base_url: String,
    api_key: String,
    model: String,
    messages: Vec<ChatMessage>,
    temperature: Option<f32>,
    max_tokens: Option<u32>,
    json_mode: Option<bool>,
) -> Result<AiCompleteResult, String> {
    let base = base_url.trim_end_matches('/');
    let url = if base.ends_with("/chat/completions") {
        base.to_string()
    } else {
        format!("{base}/chat/completions")
    };

    let mut body = serde_json::json!({ "model": model, "messages": messages });
    if let Some(t) = temperature {
        body["temperature"] = serde_json::json!(t);
    }
    if let Some(m) = max_tokens {
        body["max_tokens"] = serde_json::json!(m);
    }
    if json_mode.unwrap_or(false) {
        body["response_format"] = serde_json::json!({ "type": "json_object" });
    }

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(120))
        .build()
        .map_err(|e| format!("创建 HTTP 客户端失败: {e}"))?;

    let response = client
        .post(&url)
        .bearer_auth(&api_key)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("请求上游失败: {e}"))?;

    if !response.status().is_success() {
        let status = response.status();
        let text = response.text().await.unwrap_or_default();
        let brief: String = text.chars().take(400).collect();
        return Err(format!("上游返回 {status}: {brief}"));
    }

    let value: serde_json::Value = response.json().await.map_err(|e| format!("解析响应失败: {e}"))?;
    let content = value
        .pointer("/choices/0/message/content")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .ok_or_else(|| "上游响应中没有内容".to_string())?;

    Ok(AiCompleteResult {
        content,
        usage: parse_usage(&value),
    })
}
