# 基础镜像走国内加速源；如需官方源可用 --build-arg NODE_IMAGE=node:22-alpine 覆盖
ARG NODE_IMAGE=docker.m.daocloud.io/library/node:22-alpine

# 构建阶段：只装生产依赖
FROM ${NODE_IMAGE} AS builder
WORKDIR /app

# npm/pnpm/corepack 全部走 npmmirror 镜像
ENV COREPACK_NPM_REGISTRY=https://registry.npmmirror.com
ENV npm_config_registry=https://registry.npmmirror.com

RUN corepack enable && corepack prepare pnpm@12 --activate

# 先复制清单，利用层缓存
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/shared/package.json ./packages/shared/
COPY apps/server/package.json ./apps/server/
COPY apps/admin/package.json ./apps/admin/

# 管理面板产物由部署脚本本地预构建并同步到 apps/server/public/admin：
# NAS 内存有限，容器内跑 vite 构建会被 OOM 杀掉（2026-11-22 实测）。这里只装服务端依赖，
# 与既有部署验证过的安装范围一致；admin 依赖仅在需要容器内构建时才装（见下）
RUN pnpm install --filter @nenochat/server... --frozen-lockfile

# 再复制源码与版本解析脚本（服务端启动时据此读取版本）
COPY scripts ./scripts
COPY packages/shared ./packages/shared
COPY apps/server ./apps/server
COPY apps/admin ./apps/admin

# 管理面板构建：产物直接落到 apps/server/public/admin，服务端启动时发现即挂载；
# 已有预构建产物（部署脚本同步）时跳过，避免 NAS 上 vite OOM
RUN if [ ! -d apps/server/public/admin ]; then \
        pnpm install --filter @nenochat/admin... --frozen-lockfile \
        && pnpm --filter @nenochat/admin build; \
    fi

# 运行阶段：保留编译期原生模块
FROM ${NODE_IMAGE} AS runner
WORKDIR /app

# pnpm 安装也走 npmmirror（运行期需要时同样加速）
ENV COREPACK_NPM_REGISTRY=https://registry.npmmirror.com
ENV npm_config_registry=https://registry.npmmirror.com

RUN corepack enable && corepack prepare pnpm@12 --activate \
    && mkdir -p /app/apps/server/data \
    && chown -R node:node /app

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=8787

COPY --from=builder --chown=node:node /app /app

# 构建时间戳：由部署脚本每次以 build ARG 注入新值，ARG 一变这层缓存必然失效，
# 因此 stamp 一定是真正跑了构建的那次部署的时间；compose up 未触发构建（复用旧镜像）时
# stamp 保持旧值，部署脚本据此识别"新版本号 + 旧代码"的假部署。
# 手动 docker build 不带该 ARG 时 stamp 为 unknown，同样过不了部署后的校验
ARG BUILD_STAMP=unknown
RUN echo "$BUILD_STAMP" > /app/apps/server/.build-stamp

# 以非 root 的 node 用户运行（node:22-alpine 自带 uid=1000 的 node 用户）
USER node

WORKDIR /app/apps/server

EXPOSE 8787

# 数据目录挂卷持久化：SQLite 与上传文件都在这里
VOLUME ["/app/apps/server/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD wget -qO- "http://127.0.0.1:${PORT}/health" || exit 1

CMD ["pnpm", "start"]
