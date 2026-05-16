# 同机多域名部署 — 配置参考（避免「绕圈」）

同一台服务器上跑多个服务、多个域名（如 `mc.example.com`、`user.1sheng.work`、`sso.1sheng.work`）是正常架构。**问题出在容器/进程用公网 URL 访问同机另一服务**，流量会经公网 IP 再折返（hairpin），易 500/超时/TLS/Host 错误。

原则：**人（浏览器）用 HTTPS 公网域名；机（服务间）用内网地址。**

---

## 一、Mission Control `1panel.env` 对照表

| 变量 | 谁发起请求 | 推荐值（同机） | 勿用 |
|------|------------|----------------|------|
| `ZITADEL_ISSUER` | MC 服务端 → IdP | `https://sso.1sheng.work`（IdP 常在别机；同机也可用内网，见下） | — |
| `ZITADEL_REDIRECT_URI` | 浏览器回调 | `https://<MC公网域名>/api/auth/callback` | `127.0.0.1`（与浏览器不一致会丢 Cookie） |
| `USER_CENTER_API_URL` | **MC 容器内** `fetch` | `http://host.docker.internal:<用户中心端口>` 或 `http://<compose服务名>:<端口>` | `https://user.1sheng.work`（同机易绕圈） |
| `USER_CENTER_PORTAL_URL` | **浏览器** 302 跳转 | `https://user.1sheng.work` | 内网 IP（用户浏览器访问不到） |
| `USER_CENTER_INTERNAL_SECRET` | MC → 用户中心 API | 与用户中心生产配置一致 | — |
| `OPENCLAW_GATEWAY_HOST` | MC 容器 → 网关 | `host.docker.internal` 或网关容器服务名 | 容器内 `127.0.0.1` |
| `NEXT_PUBLIC_GATEWAY_*` | **浏览器** → 网关 WS | 公网域名 / `wss://...` 或同域反代 | — |
| `MC_ALLOWED_HOSTS` | MC 校验 Host 头 | MC 的**公网域名**（逗号分隔） | 仅写内网 IP |

---

## 二、三种常见拓扑

### A. 用户中心在宿主机进程，MC 在 Docker（最常见）

```bash
# 1panel.env — 服务端走宿主机端口（示例用户中心监听 8080）
USER_CENTER_API_URL=http://host.docker.internal:8080
USER_CENTER_PORTAL_URL=https://user.1sheng.work
USER_CENTER_INTERNAL_SECRET=...

OPENCLAW_GATEWAY_HOST=host.docker.internal
OPENCLAW_GATEWAY_PORT=18789
```

Compose 需包含（本仓库 `docker-compose.1panel.yml` 已含）：

```yaml
extra_hosts:
  - "host.docker.internal:host-gateway"
```

### B. MC 与用户中心都在 Docker，同一 Compose / 同一 network

```bash
USER_CENTER_API_URL=http://user-center:8080
USER_CENTER_PORTAL_URL=https://user.1sheng.work
```

```yaml
services:
  mission-control:
    networks: [app_net]
  user-center:
    networks: [app_net]
networks:
  app_net:
```

### C. 全部在宿主机、不用 Docker 跑 MC

```bash
USER_CENTER_API_URL=http://127.0.0.1:8080
USER_CENTER_PORTAL_URL=https://user.1sheng.work
```

---

## 三、Nginx 参考（同机多 `server_name`）

对外：每个域名 HTTPS → 不同 upstream（**公网入口**）。

```nginx
# MC
server {
  server_name mc.1sheng.work;
  location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
  }
}

# 用户中心（浏览器）
server {
  server_name user.1sheng.work;
  location / {
    proxy_pass http://127.0.0.1:8080;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
  }
}
```

若用户中心 API **校验 Host**，且 MC 用 `http://127.0.0.1:8080` 访问，可在**仅监听本机**的 `location` 中补 Host：

```nginx
# 可选：127.0.0.1:18080 专供容器内网，不对外
server {
  listen 127.0.0.1:18080;
  location / {
    proxy_pass http://127.0.0.1:8080;
    proxy_set_header Host user.1sheng.work;
  }
}
```

则 `USER_CENTER_API_URL=http://host.docker.internal:18080`。

---

## 四、Zitadel / SSO（同机时）

| 场景 | 建议 |
|------|------|
| Zitadel 在独立机器 | `ZITADEL_ISSUER=https://sso.1sheng.work` 保持不变 |
| Zitadel 也在本机 Docker | MC 调 discovery/token 可试 `http://host.docker.internal:<zitadel端口>`，浏览器仍用 `https://sso.1sheng.work`；或统一走公网（IdP 通常无 hairpin 问题时可接受） |
| 证书自签 | 开发可用 `MC_OIDC_TLS_INSECURE=1`；生产用 `NODE_EXTRA_CA_CERTS` |

---

## 五、自检命令

```bash
# 1. 容器内 — 应用内网 API（应 200 + JSON，非 500）
docker exec agentcenter wget -qO- \
  --header="Content-Type: application/json" \
  --header="X-Internal-Secret=$USER_CENTER_INTERNAL_SECRET" \
  --post-data='{"subject":"test"}' \
  http://host.docker.internal:8080/api/internal/tenant-context

# 2. 对比 — 公网 URL（同机常失败或慢，说明应改用内网 USER_CENTER_API_URL）
docker exec agentcenter wget -qO- --timeout=5 https://user.1sheng.work/ 2>&1 | head -3

# 3. MC 健康
curl -sS "http://127.0.0.1:3000/api/status?action=health"
```

---

## 六、快速记忆

```
浏览器  →  永远 HTTPS + 公网域名
MC 容器  →  用户中心/网关  →  host.docker.internal 或 Docker 服务名 + HTTP
勿让 MC 容器 fetch https://同机另一服务的公网域名
```

更全变量说明见仓库根目录 **`.env.example`**。
