ARG NODE_IMAGE=docker.m.daocloud.io/library/node:22.22.0-slim
FROM ${NODE_IMAGE} AS base
RUN corepack enable && corepack prepare pnpm@latest --activate
WORKDIR /app

FROM base AS deps
# Copy only dependency manifests first for better layer caching
COPY package.json ./
COPY pnpm-lock.yaml* ./
# better-sqlite3 requires native compilation tools
RUN apt-get -o Acquire::Retries=5 -o Acquire::https::Verify-Peer=false -o Acquire::https::Verify-Host=false update && \
    apt-get -o Acquire::Retries=5 -o Acquire::https::Verify-Peer=false -o Acquire::https::Verify-Host=false install -y --fix-missing python3 make g++ --no-install-recommends && \
    rm -rf /var/lib/apt/lists/*
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
LABEL org.opencontainers.image.source="https://github.com/builderz-labs/mission-control"
LABEL org.opencontainers.image.description="E-AgentCenter - operations dashboard"
LABEL org.opencontainers.image.licenses="MIT"
LABEL org.opencontainers.image.version="${MC_VERSION}"

WORKDIR /app
ENV NODE_ENV=production
RUN addgroup --system --gid 1001 nodejs && adduser --system --uid 1001 nextjs
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
COPY --from=build /app/public ./public
# Copy schema.sql needed by migration 001_init at runtime
COPY --from=build /app/src/lib/schema.sql ./src/lib/schema.sql
# Create data directory with correct ownership for SQLite
RUN mkdir -p .data && chown nextjs:nodejs .data
RUN echo 'const http=require("http");const r=http.get("http://localhost:"+(process.env.PORT||3000)+"/api/status?action=health",s=>{process.exit(s.statusCode===200?0:1)});r.on("error",()=>process.exit(1));r.setTimeout(4000,()=>{r.destroy();process.exit(1)})' > /app/healthcheck.js
COPY docker-entrypoint.sh /app/docker-entrypoint.sh
COPY scripts/load-env.sh /app/scripts/load-env.sh
RUN chmod 755 /app/docker-entrypoint.sh && \
    chmod 644 /app/scripts/load-env.sh && \
    chmod -R a+rX /app/public/ /app/src/
USER nextjs
ENV PORT=3000
EXPOSE 3000
ENV HOSTNAME=0.0.0.0
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "/app/healthcheck.js"]
ENTRYPOINT ["/app/docker-entrypoint.sh"]
