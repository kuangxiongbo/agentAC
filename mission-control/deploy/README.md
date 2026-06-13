# 1Panel / 生产编排说明

## 文件

| 文件 | 说明 |
|------|------|
| `docker-compose.1panel.yml` | 推荐 Compose：镜像部署、数据卷、健康检查、网关连宿主机 |
| `.env.1panel.example` | 环境变量模板；复制为 **`1panel.env`**，或在 1Panel 面板填写（自动写入 `1panel.env`） |

## 快速步骤

1. **构建并推送镜像（推荐：多架构 amd64 + arm64）**  
   在 **`mission-control/`** 目录执行，需已 `docker login` 目标仓库。使用 Buildx 生成 **manifest 列表**，同一条 `MC_IMAGE` 在 x86 云机与 ARM 主机上拉取会自动匹配本机架构。  
   ```bash
   export MC_IMAGE=your-registry/agentcenter:2.0.6
   export MC_IMAGE_LATEST=your-registry/agentcenter:latest   # 可选
   export MC_DOCKER_PUSH=1
   bash scripts/docker-buildx-multiarch.sh
   ```  
   或通过 pnpm：`MC_DOCKER_PUSH=1 MC_IMAGE=... pnpm docker:multiarch`  
   可选环境变量：**`MC_DOCKER_PLATFORM`**（默认 `linux/amd64,linux/arm64`）、**`MC_DOCKER_BUILDX_BUILDER`**（默认 `mc-multiarch`）、**`MC_VERSION`**（写入镜像 label，默认取 `package.json`）。  
   **仅单架构载入本机调试**（不能多平台 `--load`）：  
   `MC_DOCKER_LOAD=1 MC_DOCKER_PLATFORM=linux/amd64 MC_IMAGE=agentcenter:test bash scripts/docker-buildx-multiarch.sh`  
   若仍使用单架构 `docker build` / `docker push`，请保证构建机 CPU 与生产机一致，否则可能出现原生模块不兼容。

### 阿里云 ACR（个人版）推送示例

1. **登录**（密码在终端交互输入，勿提交到仓库；也可用 `--password-stdin` 从环境变量读入）：  
   ```bash
   sudo docker login --username=kuangxiongbo@163.com crpi-c9b9bml2ajb23n5d.cn-shenzhen.personal.cr.aliyuncs.com
   ```  
   或使用 stdin（示例，勿把真实密码写进脚本文件）：  
   `printf '%s' "$ACR_PASSWORD" | sudo docker login --username=kuangxiongbo@163.com --password-stdin crpi-c9b9bml2ajb23n5d.cn-shenzhen.personal.cr.aliyuncs.com`

2. **镜像地址**：须与控制台 **命名空间 + 仓库名** 一致，一般为：  
   `crpi-c9b9bml2ajb23n5d.cn-shenzhen.personal.cr.aliyuncs.com/<命名空间>/<仓库名>:<标签>`  
   将下方 `<命名空间>`、`<仓库名>` 换成你在 ACR 里创建的名称（例如 `1sheng` / `agentcenter`）。

3. **构建并推送**（在 **`mission-control/`** 目录）：  
   ```bash
   export MC_IMAGE=crpi-c9b9bml2ajb23n5d.cn-shenzhen.personal.cr.aliyuncs.com/<命名空间>/<仓库名>:2.0.6
   export MC_IMAGE_LATEST=crpi-c9b9bml2ajb23n5d.cn-shenzhen.personal.cr.aliyuncs.com/<命名空间>/<仓库名>:latest
   export MC_DOCKER_PUSH=1
   bash scripts/docker-buildx-multiarch.sh
   ```  
   若 **arm64 构建阶段拉 Debian 包超时**（跨架构网络不稳定），可先只推 **amd64**（常见云上机型）：  
   `export MC_DOCKER_PLATFORM=linux/amd64` 后再执行上述 `bash scripts/docker-buildx-multiarch.sh`。

4. **Compose 里使用**：将 **`deploy/docker-compose.1panel.yml`** 中 **`image:`** 改为与上一步 **完全一致** 的地址（含 tag），再 `docker compose pull`。

5. **推送失败 `insufficient_scope` / `repository does not exist`**：多为 **ACR 里尚未创建该「命名空间/仓库」**，或 **当前登录账号/RAM 用户无推送权限**。请在控制台 **先创建仓库**（名称与 `MC_IMAGE` 路径一致），并确认账号具备 **推送镜像** 权限后再执行 `bash scripts/docker-buildx-multiarch.sh`。

6. 将 `deploy/` 目录拷到服务器（或只拷上述两个文件到同一目录）。

7. **准备环境变量**  
   - **1Panel**：导入 Compose 后，在应用「环境变量」中填写（如 `AUTH_SECRET=…`）；面板会写入 **`1panel.env`**，编排已包含 `env_file: - 1panel.env`。  
   - **命令行**：`cp .env.1panel.example 1panel.env`，编辑后至少设置 `AUTH_SECRET`、`API_KEY`、`MC_ALLOWED_HOSTS`、Zitadel/用户中心与网关项。

8. **启动**  
   ```bash
   docker compose -f docker-compose.1panel.yml up -d
   ```

9. **1Panel**  
   在「容器」→「Compose」中导入 `docker-compose.1panel.yml`；勿删除 compose 内的 **`env_file: - 1panel.env`**，否则面板里填的环境变量不会注入容器。

## 持久化（必须）

所有状态默认在容器内 **`/app/.data`**，Compose 已挂载命名卷 **`mc_1panel_data` → `/app/.data`**。若需自定义卷名，请同时修改 `docker-compose.1panel.yml` 中 `volumes` 小节与服务的挂载名。

卷内典型内容：

- `mission-control.db`（及 SQLite `-wal` / `-shm`）
- `mission-control-tokens.json`
- `.generated-secrets`（若未在 `.env` 固定 `AUTH_SECRET` / `API_KEY` 时由 entrypoint 生成）

**备份**：定期备份该卷或 `docker volume inspect` 对应主机路径。

## 数据库

使用 **SQLite**，**不需要**单独起 PostgreSQL/MySQL。单副本挂载上述卷即可；多副本共卷不可用。

## 与根目录 `docker-compose.yml` 的差异

- 本编排以 **`image:`** 为主，适合已推仓库的 1Panel 流程；根目录 compose 偏向本地 `build:` 联调。
- 生产务必在 `.env` 中固定 **`AUTH_SECRET`**、**`API_KEY`**，避免依赖仅存在于卷上的自动生成值导致运维混乱。

更全变量说明见仓库 **`/.env.example`** 与 **`docs/deployment.md`**。

## 同机多域名（避免绕圈）

MC、用户中心、Zitadel 在同一台服务器、不同域名时：**浏览器用公网 HTTPS**，**容器间用内网**（`host.docker.internal` 或 Compose 服务名）。配置对照与 Nginx 示例见 **[`SAME-HOST-NETWORK.md`](./SAME-HOST-NETWORK.md)**。

## 排错

### `EACCES: permission denied, mkdir '/app/.next/cache/images'`

根因：Compose 开启 **`read_only: true`** 时，`tmpfs` 默认属主为 root，而镜像以 **`nextjs`（uid 1001）** 运行，Next.js 图片优化无法写缓存。

处理：在 compose 中为 tmpfs 指定 uid/gid（本仓库 `docker-compose.1panel.yml` 已包含）后重建容器：

```bash
docker compose -f docker-compose.1panel.yml up -d --force-recreate
```

仍失败时可临时注释 **`read_only`** 与 **`tmpfs`** 两段以确认。

### 日志里 `spawn uptime ENOENT` / `spawn ps ENOENT`

根因：早期 **`node:slim`** 运行时镜像未带 **`procps`**（无 `ps`/`uptime`），仪表盘轮询 `/api/status` 时会打错误日志。当前 **Dockerfile 已安装 procps**；代码也对缺失 CLI 做了 **`os.uptime()`** 回退。请 **重新 build 并推送镜像** 后 `pull` 重建容器。不影响登录与核心业务。

### `[api/auth/callback] usercenter tenant-context Internal Server Error`

表示容器内请求 **`USER_CENTER_API_URL/api/internal/tenant-context`** 返回 **HTTP 5xx**（或网关错误），与图片缓存无关。请检查 **`1panel.env`**：

1. **`USER_CENTER_API_URL`** 是否应为**内网地址**（同机勿用公网 `https://user.…`）；用 `docker exec` 请求 `http://host.docker.internal:<端口>/api/internal/tenant-context` 验证（见 `SAME-HOST-NETWORK.md`）。
2. **`USER_CENTER_INTERNAL_SECRET`** 是否与用户中心生产环境一致（缺失或错误常导致 403/500）。
3. 生产勿依赖 **`MC_OIDC_TLS_INSECURE`**；用户中心 `fetch` 使用系统 CA，证书异常需在镜像/宿主机配置 **`NODE_EXTRA_CA_CERTS`**。
