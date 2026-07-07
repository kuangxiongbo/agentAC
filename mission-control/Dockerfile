ARG NODE_IMAGE=docker.m.daocloud.io/library/node:22.22.0-slim
FROM ${NODE_IMAGE} AS base
# Pin pnpm 9.x: pnpm 10+ blocks dependency install scripts unless explicitly approved,
# which breaks native modules (better-sqlite3, sharp, @swc/core, etc.) in this image.
RUN corepack enable && corepack prepare pnpm@9.15.9 --activate
WORKDIR /app

# 国内 / 代理环境下 deb.debian.org 易 502，构建前切换镜像源（可通过 APT_MIRROR 覆盖）
ARG APT_MIRROR=mirrors.aliyun.com
RUN set -eux; \
  if [ -f /etc/apt/sources.list.d/debian.sources ]; then \
    sed -i "s|deb.debian.org|${APT_MIRROR}|g; s|security.debian.org|${APT_MIRROR}|g" /etc/apt/sources.list.d/debian.sources; \
  elif [ -f /etc/apt/sources.list ]; then \
    sed -i "s|deb.debian.org|${APT_MIRROR}|g; s|security.debian.org|${APT_MIRROR}|g" /etc/apt/sources.list; \
  fi

FROM base AS deps
# Copy only dependency manifests first for better layer caching
COPY package.json ./
COPY pnpm-lock.yaml* ./
COPY .npmrc ./
# Official Node images already include matching headers under /usr/local/include/node.
# Point node-gyp at them so native modules do not depend on live nodejs.org downloads.
ENV npm_config_nodedir=/usr/local
RUN pnpm config set registry https://registry.npmmirror.com && \
    pnpm config set fetch-retries 5 && \
    pnpm config set fetch-retry-mintimeout 10000 && \
    pnpm config set fetch-retry-maxtimeout 120000
# better-sqlite3 requires native compilation tools
RUN set -eux; \
    export DEBIAN_FRONTEND=noninteractive; \
    for attempt in 1 2 3 4 5; do \
      apt-get clean; \
      rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/partial/*; \
      if ! apt-get -o Acquire::Retries=5 -o Acquire::http::No-Cache=true -o Acquire::https::Verify-Peer=false -o Acquire::https::Verify-Host=false update; then \
        if [ "$attempt" = "5" ]; then exit 1; fi; \
        sleep $((attempt * 5)); \
        continue; \
      fi; \
      if apt-get -o Acquire::Retries=5 -o Acquire::http::No-Cache=true -o Acquire::https::Verify-Peer=false -o Acquire::https::Verify-Host=false install -y --fix-missing python3 make g++ libcc1-0 --no-install-recommends; then \
        break; \
      fi; \
      apt-get -o Acquire::Retries=5 -o Acquire::http::No-Cache=true -o Acquire::https::Verify-Peer=false -o Acquire::https::Verify-Host=false -f install -y --fix-missing || true; \
      dpkg --configure -a || true; \
      if [ "$attempt" = "5" ]; then exit 1; fi; \
      sleep $((attempt * 5)); \
    done; \
    rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/partial/*
RUN if [ -f pnpm-lock.yaml ]; then \
      pnpm install --frozen-lockfile; \
    else \
      echo "WARN: pnpm-lock.yaml not found in build context; running non-frozen install" && \
      pnpm install --no-frozen-lockfile; \
    fi

FROM base AS build
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NODE_TLS_REJECT_UNAUTHORIZED=0
RUN pnpm build

FROM ${NODE_IMAGE} AS runtime

ARG MC_VERSION=dev
ARG APT_MIRROR=mirrors.aliyun.com
LABEL org.opencontainers.image.source="https://github.com/builderz-labs/mission-control"
LABEL org.opencontainers.image.description="E-AgentCenter - operations dashboard"
LABEL org.opencontainers.image.licenses="MIT"
LABEL org.opencontainers.image.version="${MC_VERSION}"

WORKDIR /app
ENV NODE_ENV=production
# status/monitor panels invoke ps, uptime, free; slim image omits procps by default
RUN set -eux; \
    if [ -f /etc/apt/sources.list.d/debian.sources ]; then \
      sed -i "s|deb.debian.org|${APT_MIRROR}|g; s|security.debian.org|${APT_MIRROR}|g" /etc/apt/sources.list.d/debian.sources; \
    elif [ -f /etc/apt/sources.list ]; then \
      sed -i "s|deb.debian.org|${APT_MIRROR}|g; s|security.debian.org|${APT_MIRROR}|g" /etc/apt/sources.list; \
    fi; \
    export DEBIAN_FRONTEND=noninteractive; \
    for attempt in 1 2 3 4 5; do \
      apt-get clean; \
      rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/partial/*; \
      if apt-get -o Acquire::Retries=5 -o Acquire::http::No-Cache=true update && \
         apt-get -o Acquire::Retries=5 -o Acquire::http::No-Cache=true install -y --no-install-recommends procps; then \
        break; \
      fi; \
      if [ "$attempt" = "5" ]; then exit 1; fi; \
      sleep $((attempt * 5)); \
    done; \
    rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/partial/*
RUN addgroup --system --gid 1001 nodejs && adduser --system --uid 1001 nextjs
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
COPY --from=build /app/public ./public
# Edge 托盘 runtime：构建前执行 scripts/sync-edge-runtime-bundle.sh，将 zip 放入 public/edge-runtime/
# Edge 托盘 .dmg：构建前执行 scripts/sync-edge-tray-bundle.sh，将 dmg 放入 public/edge-tray/
# Copy schema.sql needed by migration 001_init at runtime
COPY --from=build /app/src/lib/schema.sql ./src/lib/schema.sql
# Create data directory with correct ownership for SQLite
RUN mkdir -p .data && chown nextjs:nodejs .data
RUN echo 'const http=require("http");const r=http.get("http://localhost:"+(process.env.PORT||3000)+"/api/status?action=health",s=>{process.exit(s.statusCode===200?0:1)});r.on("error",()=>process.exit(1));r.setTimeout(4000,()=>{r.destroy();process.exit(1)})' > /app/healthcheck.js
COPY docker-entrypoint.sh /app/docker-entrypoint.sh
RUN chmod 755 /app/docker-entrypoint.sh && \
    chmod -R a+rX /app/public/ /app/src/
USER nextjs
ENV PORT=3000
EXPOSE 3000
ENV HOSTNAME=0.0.0.0
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "/app/healthcheck.js"]
ENTRYPOINT ["/app/docker-entrypoint.sh"]
