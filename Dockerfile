# syntax=docker/dockerfile:1

# ---------- deps：安装全部依赖 ----------
FROM node:22-bookworm-slim AS deps
ARG HTTP_PROXY=
ARG HTTPS_PROXY=
ENV http_proxy=${HTTP_PROXY} https_proxy=${HTTPS_PROXY}
WORKDIR /app
RUN npm install -g pnpm@11.15.0
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/web/package.json apps/web/
COPY packages/core/package.json packages/core/
COPY packages/cli/package.json packages/cli/
RUN pnpm install --frozen-lockfile

# ---------- build：next build（standalone 产物） ----------
FROM deps AS build
COPY . .
RUN pnpm -F @kanban-hub/web build

# ---------- dev：开发环境（挂载源码热更新，由 docker-compose.dev.yml 使用） ----------
FROM node:22-bookworm-slim AS dev
ARG HTTP_PROXY=
ARG HTTPS_PROXY=
RUN http_proxy=${HTTP_PROXY} https_proxy=${HTTPS_PROXY} apt-get update \
 && http_proxy=${HTTP_PROXY} https_proxy=${HTTPS_PROXY} apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && git config --system --add safe.directory /data \
 && http_proxy=${HTTP_PROXY} https_proxy=${HTTPS_PROXY} npm install -g pnpm@11.15.0
# 这些路径会挂成命名卷。容器以任意 PUID 运行，命名卷第一次创建时会继承镜像里这些目录的权限，
# 所以这里预先建好并放开权限（仅用于开发镜像）。
RUN mkdir -p /app/node_modules /app/apps/web/node_modules /app/apps/web/.next \
             /app/packages/core/node_modules /app/packages/cli/node_modules \
             /pnpm-store /tmp/kh-home \
 && chmod 777 /app/node_modules /app/apps/web/node_modules /app/apps/web/.next \
              /app/packages/core/node_modules /app/packages/cli/node_modules \
              /pnpm-store /tmp/kh-home
WORKDIR /app
# 不设 WATCHPACK_POLLING：它只对 webpack 生效，Next 16 的开发服务用 Turbopack。
# 热更新靠挂载目录的原生文件事件（Docker Desktop 会转发，Linux 宿主是 inotify）。
ENV HOME=/tmp/kh-home \
    KH_IN_CONTAINER=1 \
    KH_DATA_DIR=/data \
    KH_BACKUP_DIR=/backups \
    GIT_COMMITTER_NAME=kanban-hub \
    GIT_COMMITTER_EMAIL=kanban-hub@localhost

# ---------- runtime：非 root 精简运行时 ----------
FROM node:22-bookworm-slim AS runtime
ARG HTTP_PROXY=
ARG HTTPS_PROXY=
ENV NODE_ENV=production \
    PORT=28970 \
    HOSTNAME=0.0.0.0 \
    KH_DATA_DIR=/data \
    KH_BACKUP_DIR=/backups \
    KH_IN_CONTAINER=1
# 代理只用于这一步安装，不写进最终镜像的环境变量
RUN http_proxy=${HTTP_PROXY} https_proxy=${HTTPS_PROXY} apt-get update \
 && http_proxy=${HTTP_PROXY} https_proxy=${HTTPS_PROXY} apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && git config --system --add safe.directory /data
WORKDIR /app
COPY --from=build /app/apps/web/.next/standalone ./
COPY --from=build /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=build /app/apps/web/public ./apps/web/public
COPY docker/entrypoint.sh /usr/local/bin/kh-entrypoint
RUN chmod 755 /usr/local/bin/kh-entrypoint \
 && mkdir -p /data /backups \
 && chown node:node /data /backups
USER node
EXPOSE 28970
ENTRYPOINT ["kh-entrypoint"]
CMD ["serve"]
