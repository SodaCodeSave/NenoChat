# 构建阶段：只装生产依赖
FROM node:22-alpine AS builder
WORKDIR /app

RUN corepack enable && corepack prepare pnpm@12 --activate

# 先复制清单，利用层缓存
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/shared/package.json ./packages/shared/
COPY apps/server/package.json ./apps/server/

RUN pnpm install --filter @nenochat/server... --frozen-lockfile

# 再复制源码
COPY packages/shared ./packages/shared
COPY apps/server ./apps/server

# 运行阶段：保留编译期原生模块
FROM node:22-alpine AS runner
WORKDIR /app

RUN corepack enable && corepack prepare pnpm@12 --activate \
    && mkdir -p /app/apps/server/data

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=8787

COPY --from=builder /app /app

WORKDIR /app/apps/server

EXPOSE 8787

# 数据目录挂卷持久化：SQLite 与上传文件都在这里
VOLUME ["/app/apps/server/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD wget -qO- "http://127.0.0.1:${PORT}/health" || exit 1

CMD ["pnpm", "start"]
