<div align="center">
<p align="center"><img src="./apps/desktop/src/assets/nenochat-logo.svg" alt="NenoChat" width="240"></p>
<p align="center">专为角色扮演而生的Agent客户端</p>
<p align="center">

[![License](https://img.shields.io/badge/License-Apache_2.0-blue?style=flat-square)](LICENSE) [![GitHub release](https://img.shields.io/github/v/release/SodaCodeSave/NenoChat?style=flat-square&color=brightgreen)](https://github.com/SodaCodeSave/NenoChat/releases)[![CI](https://img.shields.io/github/actions/workflow/status/SodaCodeSave/NenoChat/ci.yml?style=flat-square&label=CI)](https://github.com/SodaCodeSave/NenoChat/actions/workflows/ci.yml) [![Release Build](https://img.shields.io/github/actions/workflow/status/SodaCodeSave/NenoChat/release-build.yml?style=flat-square&label=Release%20Build)](https://github.com/SodaCodeSave/NenoChat/actions/workflows/release-build.yml)

[![Node](https://img.shields.io/badge/Node.js-≥22.12-339933?style=flat-square&logo=nodedotjs&logoColor=white)](https://nodejs.org/) [![pnpm](https://img.shields.io/badge/pnpm-12-F69220?style=flat-square&logo=pnpm&logoColor=white)](https://pnpm.io/) [![TypeScript](https://img.shields.io/badge/TypeScript-5.9-3178C6?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org/) [![Vue](https://img.shields.io/badge/Vue-3-4FC08D?style=flat-square&logo=vuedotjs&logoColor=white)](https://vuejs.org/) [![Tauri](https://img.shields.io/badge/Tauri-2-FFC131?style=flat-square&logo=tauri&logoColor=black)](https://tauri.app/) [![Fastify](https://img.shields.io/badge/Fastify-5-000000?style=flat-square&logo=fastify&logoColor=white)](https://fastify.dev/)

</p>
</div>

---

NenoChat 是一个自托管的 AI 角色扮演聊天应用。你部署一个自己的服务端，托管 AI 供应商密钥与聊天数据；客户端长得像一个原生聊天 App——联系人列表、单聊、群聊、朋友圈式的动态空间，只是对面坐着的是你创造的 AI 角色。

## 功能特性

- **单聊与群聊**：创建 AI 角色联系人，拉多个角色进群，AI 之间与 AI 和真人可以互相接话
- **AI 供应商自由配置**：接入任意兼容的供应商，填 API 地址与密钥即可；密钥由服务端 AES 加密托管，支持自动获取模型列表、按模型开关
- **主动消息**：AI 会按你设定的频率主动找你聊天、发动态、评论点赞，而不是只被动回复
- **动态空间**：你和所有 AI 角色共同的朋友圈，可以发图文、互相评论点赞
- **表情包**：上传表情包分组，授权给指定 AI 角色在聊天中使用
- **连接器**：给 AI 挂载外部能力，内置哔哩哔哩、和风天气等
- **多端同步**：换设备登录后消息自动增量同步
- **一体化版**：不想部署服务端？下载 Windows 一体版，服务端内嵌在客户端里，开箱即用，还能打开局域网让手机扫码接入

## 快速开始（一体化版，推荐新手）

1. 到 [Releases](https://github.com/SodaCodeSave/NenoChat/releases) 下载 `NenoChat-Integrated` 的 Windows 安装包并安装
2. 打开即是聊天界面，无需注册登录、无需配置服务器
3. 在设置 → AI 中填入供应商地址与 API Key，创建一个 AI 角色，开始聊天
4. 想让手机也能聊：在设置中打开局域网接入，手机客户端扫码配对即可

## 快速开始（独立部署）

适合多设备或多人共用一个服务器的场景，只需要 Docker。

### 1. 准备配置

在任意目录创建 `.env`，写入两个强密钥（可用 `openssl rand -hex 32` 生成，至少 32 字符）：

```bash
JWT_SECRET=<你的JWT密钥>
SECRET_KEY=<你的AES密钥>
# 可选：注册方式 open(开放) / invite(邀请) / closed(关闭)，多人部署建议 invite
REGISTRATION_MODE=open
# 部署在域名反代之后时改成对外地址，否则附件链接会指向容器内
PUBLIC_BASE_URL=http://你的服务器地址:8787
```

### 2. 启动服务

使用仓库根目录的 `docker-compose.yml`：

```bash
docker compose up -d
```

数据库（PostgreSQL）持久化在 `nenochat-pg` 数据卷，上传文件在 `nenochat-data` 数据卷；NAS 等 bind mount 场景改用 `./data` 目录挂载即可。

### 3. 安装客户端并连接

1. 到 [Releases](https://github.com/SodaCodeSave/NenoChat/releases) 下载对应平台的客户端（Windows exe/MSI、Linux AppImage/deb），客户端内置自动更新
2. 打开客户端，添加服务器地址（如 `http://你的服务器地址:8787`）
3. 注册账号（取决于服务端的注册模式），进入聊天
4. 在设置 → AI 中配置供应商与密钥，创建 AI 角色，开始聊天

> 想用本地模型（如 Ollama）？在服务端开启 `ALLOW_PRIVATE_AI_ENDPOINT=true`，客户端里把供应商地址指向内网地址即可。

## 服务端配置参考

服务端通过环境变量配置，缺失或非法值会在启动时直接报错：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `8787` | 监听端口 |
| `HOST` | `0.0.0.0` | 监听地址 |
| `PUBLIC_BASE_URL` | `http://localhost:8787` | 对外基础地址，用于拼装附件 URL |
| `DATABASE_URL` | `postgres://nenochat:nenochat@localhost:5432/nenochat` | PostgreSQL 连接串 |
| `DATA_DIR` | `./data` | 上传文件目录 |
| `JWT_SECRET` | （仅开发默认值） | JWT 签名密钥，生产环境必须 ≥ 32 字符 |
| `SECRET_KEY` | （仅开发默认值） | 托管 AI 密钥的 AES 加密密钥，生产环境必须 ≥ 32 字符 |
| `REGISTRATION_MODE` | `open` | 注册模式：`open` / `invite` / `closed` |
| `SERVER_NAME` | `NenoChat` | 服务器名称 |
| `LOG_LEVEL` | `info` | 日志级别 |
| `CORS_ORIGINS` | `*` | 允许跨域来源，逗号分隔 |
| `ALLOW_PRIVATE_AI_ENDPOINT` | `false` | 允许 AI 供应商地址指向内网（本地模型需开启），防 SSRF 默认关闭 |

## 从源码构建

需要 Node.js ≥ 22.12 与 pnpm 12；打包桌面端另需 Rust 工具链与 Tauri 2 系统依赖。

```bash
pnpm install        # 安装依赖
pnpm dev            # 同时启动服务端与 Web 客户端
pnpm dev:app        # Tauri 桌面客户端开发模式
pnpm typecheck      # 全工作区类型检查
pnpm test           # 全工作区测试（Vitest）
pnpm build:app      # 打包 Tauri 桌面应用
pnpm build:app:integrated  # 构建服务端内嵌的一体化版本
```

架构为 pnpm monorepo：`apps/server`（Fastify + better-sqlite3 服务端）、`apps/desktop`（Tauri 2 + Vue 3 客户端）、`packages/shared`（前后端共享协议与 Schema）。开发约定见 [AGENTS.md](./AGENTS.md)，界面规范见 [DESIGN.md](./DESIGN.md)。推送 `v*` tag 即触发 GitHub Actions 自动构建并发布 Release（Windows / Linux，含一体版）。

## 许可证

[Apache-2.0](LICENSE)
