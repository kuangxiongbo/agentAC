# AgentCenter 发布接手信息

更新时间：2026-06-13

本文档用于快速接手 E-AgentCenter / mission-control 项目的 GitHub 提交、云镜像发布和生产部署。本文只记录仓库路径、账号标识、鉴权入口和操作命令，不记录明文密码、PAT、ACR 密码或一次性 token。

## 1. 项目与代码仓库

- 本机项目目录：`/Users/kuangxb/Desktop/agent指挥仓`
- 服务端目录：`/Users/kuangxb/Desktop/agent指挥仓/mission-control`
- Edge Web 客户端目录：`/Users/kuangxb/Desktop/agent指挥仓/mission-control-client`
- 托盘客户端目录：`/Users/kuangxb/Desktop/agent指挥仓/mission-control-tray`
- GitHub remote：`git@github.com:kuangxiongbo/agentAC.git`
- 默认分支：`main`
- 当前发布提交示例：`git log --oneline -5`

提交前检查：

```bash
cd /Users/kuangxb/Desktop/agent指挥仓
git status --short
git diff --stat
git remote -v
```

提交与推送：

```bash
git add <release files only>
git commit -m "release: agentcenter <version>"
git push origin main
```

注意：不要提交 `.github/`、`_tray-reference/`、`.dev-server.pid`、`releases/`、本地缓存、密钥或无关临时文档，除非明确需要。

## 2. GitHub 鉴权

- 推荐方式：SSH remote，当前 remote 为 `git@github.com:kuangxiongbo/agentAC.git`。
- 本机如使用 HTTPS/PAT，应放在系统 Keychain、Git credential helper 或本机环境变量中。
- 不得把 GitHub PAT 写入仓库、文档、镜像、日志或脚本。

检查 Git 鉴权：

```bash
ssh -T git@github.com
git ls-remote origin HEAD
```

若必须使用 HTTPS：

```bash
git remote set-url origin https://github.com/kuangxiongbo/agentAC.git
git config --global credential.helper osxkeychain
```

## 3. 云镜像仓库

- Registry：`crpi-c9b9bml2ajb23n5d.cn-shenzhen.personal.cr.aliyuncs.com`
- Namespace：`1sheng`
- Repository：`agentcenter`
- 完整镜像仓库：
  `crpi-c9b9bml2ajb23n5d.cn-shenzhen.personal.cr.aliyuncs.com/1sheng/agentcenter`
- 生产发布 tag：
  - `:<version>`
  - `:latest`
- 当前云服务器架构：`linux/amd64`
- 默认发布平台：`linux/amd64`
- 只有明确需要 ARM 时才使用：`linux/amd64,linux/arm64`

ACR 登录账号标识：

```text
kuangxiongbo@163.com
```

登录命令：

```bash
docker login --username=kuangxiongbo@163.com crpi-c9b9bml2ajb23n5d.cn-shenzhen.personal.cr.aliyuncs.com
```

安全要求：ACR 密码或访问凭证只通过交互输入、Keychain、Docker credential store 或临时环境变量提供，不写入仓库。

## 4. 发布前必跑

每次发布前必须先更新主文档和发布文档，然后同步到镜像上下文：

```bash
cd /Users/kuangxb/Desktop/agent指挥仓/mission-control
bash scripts/sync-project-docs.sh
```

如果变更服务端或 Edge Web runtime 版本：

```bash
cd /Users/kuangxb/Desktop/agent指挥仓
bash mission-control/scripts/sync-edge-runtime-bundle.sh
```

如果只变更服务端/runtime，不变更原生托盘代码，托盘 native 版本保持 `3.0.0`，只需要确认：

```bash
cat mission-control/public/edge-tray/manifest.json
```

发布前验证：

```bash
cd /Users/kuangxb/Desktop/agent指挥仓/mission-control
pnpm run verify:release-surfaces
pnpm run typecheck
pnpm exec vitest run src/lib/__tests__/effective-license.test.ts

cd /Users/kuangxb/Desktop/agent指挥仓/mission-control-client
pnpm run typecheck
```

## 5. 构建并推送镜像

x86 生产发布命令：

```bash
cd /Users/kuangxb/Desktop/agent指挥仓/mission-control
export MC_IMAGE=crpi-c9b9bml2ajb23n5d.cn-shenzhen.personal.cr.aliyuncs.com/1sheng/agentcenter:$(node -p "require('./package.json').version")
export MC_IMAGE_LATEST=crpi-c9b9bml2ajb23n5d.cn-shenzhen.personal.cr.aliyuncs.com/1sheng/agentcenter:latest
export MC_DOCKER_PUSH=1
export MC_DOCKER_PLATFORM=linux/amd64
bash scripts/docker-buildx-multiarch.sh
```

推送后验证：

```bash
docker buildx imagetools inspect crpi-c9b9bml2ajb23n5d.cn-shenzhen.personal.cr.aliyuncs.com/1sheng/agentcenter:$(node -p "require('./package.json').version")
docker buildx imagetools inspect crpi-c9b9bml2ajb23n5d.cn-shenzhen.personal.cr.aliyuncs.com/1sheng/agentcenter:latest
```

要求：版本 tag 和 `latest` digest 必须一致。当前生产优先 x86，因此 manifest 类型可以是单架构 `application/vnd.docker.distribution.manifest.v2+json`。

## 6. 生产部署

1Panel / Compose 更新命令：

```bash
docker compose pull
docker compose up -d --force-recreate
```

生产部署后检查：

```bash
curl -k https://agent.1sheng.work/edge-runtime/manifest.json
curl -k https://agent.1sheng.work/edge-tray/manifest.json
```

授权配置检查：

```bash
curl -k https://agent.1sheng.work/api/license/config
```

未登录时该接口会返回 401，需要在浏览器已登录会话中查看或通过应用设置页确认。

## 7. 当前授权 appId 约定

- 产品/应用展示名：`agentCenter`
- 授权业务 appId：`mission-control`
- `license-schema.json` 必须是：

```json
{
  "appId": "mission-control"
}
```

用户中心中对应关系必须一致：

- SKU `schema_app_id = mission-control`
- Zitadel 应用实例 `business_app_id = mission-control`
- AgentCenter 服务端 `/api/license/config` 返回 `appId = mission-control`

如果应用提示 `app_instance_mismatch`，优先检查用户中心应用实例的 `business_app_id` 是否仍是 `mission-control`，以及生产 `ZITADEL_CLIENT_ID` 是否对应这个应用实例。

## 8. 空间与清理

发布前检查：

```bash
df -h /Users/kuangxb/Library/Containers/com.docker.docker/Data /Users/kuangxb/Desktop/agent指挥仓 /Volumes/* 2>/dev/null
docker info
docker system df
```

本项目 Docker 构建前至少保留 30GiB 可用空间。不要删除 Docker volumes、数据库或用户数据。若 Docker cleanup 卡住，可以杀掉 stuck Docker CLI 并重启 Docker Desktop，但不要 reset Docker Desktop data。
