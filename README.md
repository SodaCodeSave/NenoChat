# NenoChat

基于 Tauri 2 的跨平台 AI 聊天软件。外层是 QQ 式的导航与会话列表，进入群聊后切换为 Discord 式的频道三栏；AI 会话与普通会话共用同一套消息模型，长回复会自动拆成多条像真人一样分批发出。

## 组成

| 包 | 作用 |
|---|---|
| `packages/shared` | 两端唯一真源：实体类型、zod 校验、WS 事件表、LWW 合并、AI 提示词与**分条算法** |
| `apps/server` | 自建消息服务器：Fastify 5 + WebSocket + better-sqlite3，含鉴权、群组权限、消息、同步、文件、AI |
| `apps/desktop` | Tauri 2 + Vue 3 客户端：QQ 外壳 + Discord 三栏，本地 SQLite 镜像，离线优先 |

## 快速开始

```bash
# 依赖
pnpm install

# 1) 起服务端（默认 http://0.0.0.0:8787）
pnpm dev:server

# 2) 起前端
pnpm dev:web            # 浏览器版（手机浏览器可直接访问，用于验证多端同步）
pnpm dev:app            # Tauri 桌面窗口
```

首次启动服务端会自动建库并跑迁移，数据放在 `apps/server/data/`。

- 首个注册的账号自动成为管理员
- 注册策略由环境变量 `REGISTRATION_MODE` 控制：`open` / `invite` / `closed`
- 客户端首次打开会要求填服务器地址，填 `http://localhost:8787` 即可

> 生产部署务必替换 `JWT_SECRET` 与 `SECRET_KEY`（见 `apps/server/.env.example`）。

## 核心设计

### 1. 一切皆会话

AI 会话就是 `conversations.type = 'ai'`，消息落在同一张 `messages` 表。于是置顶、未读、@提醒、搜索、离线补拉、引用回复全部自动复用，不需要为 AI 单独写一套。

### 2. seq 是会话内唯一排序依据

`messages.seq` 由 `conversations.seq_counter` 在同一事务内分配，同时承担：排序键、分页游标、已读游标、断线补洞的跳号检测。

### 3. 写路径只有一条

任何写操作都在**同一个事务**内完成：实体写入 → `sync_change_log` 追加 → 提交后广播。`payload` 存完整快照而不是 diff，客户端拿到直接 upsert。

### 4. 同步靠游标，不靠内存

`cursor = sync_change_log.seq`，语义是「我已完整应用 seq ≤ cursor 的全部变更」。WS 重连时按 cursor 补拉，追平后才进入实时态，期间产生的实时事件按 seq 排序补发。

### 5. AI 长回复分条

`packages/shared/src/ai/splitter.ts` 是纯函数：去 Markdown 噪音 → 按段落切 → 超长按句末标点切 → 再按逗号切 → 硬切兜底 → 合并过短片段 → 超出条数上限时尾部合并（不截断）。

每种回复风格有独立阈值（`chatty` / `concise` / `narrative`），分条后逐条落库为独立消息，带上 `ai_generation_id` 与 `ai_index`，前端据此只显示一次头像并标注「共 N 条」。

### 6. AI 密钥两种位置

| | 本机（默认） | 服务端托管 |
|---|---|---|
| 调用方 | Tauri Rust 网关（reqwest 流式 SSE） | 服务端 |
| 流式体验 | 逐字打字感 | 分条延迟投递 |
| 多端共享 | 每台设备各配一次 | 配一次全端可用 |
| 密钥保管 | 系统钥匙串 | AES-256-GCM，接口只回掩码 |

策略（提示词、记忆、分条）全在 `shared` 里，两端只做运输。

### 7. 角色是「会话 + 通讯录」的一等公民

创建角色时在同一个事务里做三件事：写 `ai_personas`、写 `sync_change_log`、`ensureAiConversation()` 建 `type='ai'` 的会话。所以角色不需要「点一下才出现」——它一建好就在消息列表的「AI 角色」分区与通讯录的「AI 角色」分组里。

会话的 `name` / `avatar_url` 是角色快照，改角色名或换头像时由 `syncPersonaToConversations()` 一次性刷到该角色所有会话上；删角色时连会话一起软删，客户端的 `ordered` 过滤掉 `deletedAt`。

AI 消息写入 `meta.ai.personaId`，渲染时按「消息自带的 personaId → 会话绑定的角色 → 会话名」三级回退，历史消息也能显示对的人。

「通讯录」用的是 `ai_personas.in_contacts` 这一列，而不是 `contacts` 表——后者 `contact_user_id` 外键指向 `users`，结构上放不了 persona。

### 8. 主动消息由服务端统一判定

`proactive-rules.ts` 是纯函数（时间窗口、配额、冷却都在这里），`proactive-service.ts` 负责扫描与生成：

- 空闲以「最后一条**用户**消息」为基准，否则 AI 自己的主动消息会把计时清零
- 占位用唯一索引 `(conversation_id, day_key, slot)`，先占坑再生成，多实例只有一个能抢到
- 免打扰窗口支持跨零点（`start > end`）
- 密钥托管在服务端时离线也能发；密钥在本机时服务端只推 `ai.proactive.due`，由在线客户端代跑

## 目录速览

```
packages/shared/src/
  entities.ts enums.ts events.ts constants.ts ids.ts permissions.ts
  sync/lww.ts              # 字段级 LWW + 时钟钳制
  ai/splitter.ts           # 长回复分条（含单测）
  ai/prompt.ts             # 上下文拼装 / 压缩 / 主动消息提示词
  schemas/                 # zod，两端共用的入参校验

apps/server/src/
  db/migrations/           # 服务端 DDL 唯一真源
  services/message-service.ts   # seq + change_log + 广播的单事务写路径
  services/sync-service.ts      # 增量查询（WS 与 REST 复用）
  services/ai-service.ts        # 服务商/角色/会话/记忆/服务端生成
  ws/connection.ts              # catchingUp → live 状态机
  jobs/                         # 预留：主动消息与记忆兜底

apps/desktop/src/
  stores/                  # auth / servers / conversations / messages / channels
                           # members / typing / sync / ai / ui
  realtime/ws-client.ts    # 握手、心跳、退避重连、请求配对
  platform/                # db（本地镜像）/ keychain / device
  components/chat/         # 三栏、消息列表、输入框
  views/                   # 登录、会话、通讯录、动态、设置
```

## 命令

```bash
pnpm typecheck     # 三个包全量类型检查
pnpm test          # shared 单测 + server 集成测试
pnpm build:web     # 浏览器版产物
pnpm build:app     # 桌面安装包（联网版：选择服务器 + 登录）
pnpm build:app:integrated   # 一体化安装包（内置服务端，免登录）
```

一体化版与联网版的区别：

- 安装包里带着一份 Node 运行时、服务端代码与迁移脚本（`scripts/build-integrated-server.mjs` 生成）。
- 客户端启动时把服务端拉起来，只监听 `127.0.0.1` 的随机端口，退出时回收。
- 服务端以 `LOCAL_MODE=true` 运行：关闭注册，客户端凭进程内注入的握手令牌调用 `/auth/local` 换取会话，首次启动自动创建 `owner` 账号。
- 内置的服务端标识符是 `com.nenochat.app.integrated`，数据与联网版完全隔离，可与联网版同时安装。
- 数据落在应用数据目录的 `server/` 下，日志是应用日志目录的 `integrated-server.log`。

服务端也可用 Docker 部署：

```bash
docker compose up -d --build
```

## 当前进度

已打通并经过自动化测试：

- 账号注册/登录、JWT 刷新轮换、令牌重放检测
- 私聊（幂等）、群聊（默认频道）、成员角色与权限位
- 发消息事务、seq 连续、幂等发送、撤回墓碑、置顶
- 已读游标只前进不后退、群聊已读人数聚合
- WS 握手、增量追平、实时推送、未认证拒绝
- 同步变更的可见性过滤（非成员拉不到别人的私聊）
- AI 服务商/角色/会话、分条消息、记忆读写、密钥脱敏
- 角色化 AI：创建角色即自动进「消息」与「通讯录」，改名换头像即时同步到会话
- 角色卡 + 兴趣 + 提示词三段式人设，注入聊天与主动消息提示词
- 文件上传（头像 / 角色卡 / 附件）：MIME 白名单 + 魔数校验 + sha256 去重 + 静态目录
- 服务端主动消息调度：空闲时长 / 每日上限 / 免打扰窗口 / 跨实例防重
- 消息身份渲染：AI 气泡用角色名与头像，不再显示模型名
- 消息去重收敛到 `composables/message-merge.ts`（id + clientNonce 双键）
- 动态空间：发布（≤9 图）、信息流分页、点赞、评论、删除，WS 实时广播
- 表情包：分组管理、图片上传、聊天面板直接发送贴纸；分组级「允许 AI 使用」总开关 + 角色级白名单（`ai_personas.sticker_pack_ids`，空 = 跟随全局授权），提示词清单与落库校验共用同一口径
- 聊天附件：图片/文件上传（进度）、粘贴截图、图片点击预览
- 全局搜索：消息（FTS5 trigram，短词回退 LIKE）、联系人、会话，Ctrl/Cmd+K 打开
- 消息虚拟滚动：可变高度窗口化 + 历史分页 + 滚动锚点
- 消息操作：右键菜单（回复/复制/编辑/置顶/撤回确认）

待接入：

- 真人好友申请/分组体系（`contacts` 表已建，当前仅用 `ai_personas.in_contacts` 承载 AI 分组）
- 语音/视频通话（本轮明确不做）
- 动态与表情的离线镜像（当前在线优先，WS 增量更新）
