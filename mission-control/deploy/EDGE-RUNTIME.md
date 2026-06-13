# Edge 客户端 runtime 与中心服配套发布

中心服镜像内置 **mission-control-client standalone zip**，Edge 托盘「连接并启动」时自动下载，无需单独配 GitHub Release。

## 生产镜像（多架构，必做）

云服务器多为 **linux/amd64**。若只在 Mac 上 `docker-publish-local.sh`，镜像是 **arm64**，容器会报：

`exec /app/docker-entrypoint.sh: exec format error`

请推送 **amd64 + arm64** manifest：

```bash
bash mission-control/scripts/docker-publish-multiarch.sh
# 或
MC_IMAGE=crpi-.../agentcenter:2.0.6 MC_DOCKER_PUSH=1 bash mission-control/scripts/docker-buildx-multiarch.sh
```

服务器 `docker compose pull` 后会自动拉取匹配架构的层。

## 一条命令（本机 Mac M 系列 — 仅 arm64，勿用于生产 x86）

```bash
# 仓库根目录
bash mission-control/scripts/sync-edge-runtime-bundle.sh
cd mission-control
docker build -t crpi-c9b9bml2ajb23n5d.cn-shenzhen.personal.cr.aliyuncs.com/1sheng/agentcenter:2.0.6 .
docker push crpi-c9b9bml2ajb23n5d.cn-shenzhen.personal.cr.aliyuncs.com/1sheng/agentcenter:2.0.6
```

1Panel：`docker compose pull && docker compose up -d`（改 compose 里镜像 tag 与版本一致）。

## 做了什么

| 步骤 | 说明 |
|------|------|
| `sync-edge-runtime-bundle.sh` | 打包 `mission-control-client` → zip 拷到 `public/edge-runtime/` + 写 `manifest.json` |
| `docker build` | `public/edge-runtime/` 打进镜像 |
| 托盘连接 | `GET /api/releases/edge-runtime-manifest` 返回清单（zip URL 自动补全为站点域名） |

## 验证

```bash
curl -sk https://agent.1sheng.work/api/releases/edge-runtime-manifest | head
curl -skI https://agent.1sheng.work/edge-runtime/client-runtime-2.0.6-darwin-aarch64.zip | head
```

不应再出现 **503 manifest not configured**。

## 版本升级

1. 改 `mission-control-client/package.json` 与 `mission-control/package.json` 同版本号  
2. 重新执行 `sync-edge-runtime-bundle.sh` + `docker build` + 推送  
3. 员工 Edge 托盘重新「连接并启动」或「重启边缘服务」

## 其他平台

```bash
EDGE_RUNTIME_PLATFORM=darwin-x86_64 bash mission-control/scripts/sync-edge-runtime-bundle.sh
# 多次 sync 会追加/覆盖 manifest 中对应 platform 项（需扩展脚本时再加）
```

Windows / Linux zip 需在对应 OS 上打包后合并 manifest，或扩展 sync 脚本支持多平台。

## 文件说明

- `public/edge-runtime/manifest.json` — 可提交 Git（含 sha256）
- `public/edge-runtime/*.zip` — 体积约 100MB，**不提交 Git**，构建前 sync 生成

## Edge 托盘 .dmg（下载页）

与 runtime 相同，**打入中心服镜像**，避免版本不一致：

```bash
# Mac 上（需已 pnpm tauri build 或 --skip-build 使用已有 dmg）
bash mission-control/scripts/sync-edge-tray-bundle.sh
```

| 步骤 | 说明 |
|------|------|
| `sync-edge-tray-bundle.sh` | 拷贝 `mission-control-tray` 的 .dmg → `public/edge-tray/` + `manifest.json` |
| `docker build` | `public/edge-tray/` 打进镜像 |
| 下载页 | `/edge/download` 从 manifest 读取 `/edge-tray/e-agent-edge-{version}-darwin-aarch64.dmg` |

验证：

```bash
curl -skI https://agent.1sheng.work/edge-tray/e-agent-edge-2.0.6-darwin-aarch64.dmg | head
```

- `public/edge-tray/manifest.json` — 可提交 Git
- `public/edge-tray/*.dmg` — **不提交 Git**，构建前 sync 生成

`docker-publish-multiarch.sh` 会自动执行 runtime + tray sync；缺少 tray manifest 会中止构建。
