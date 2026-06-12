# 操作日志 (operatelog)

## 2026-06-06（续 6）

- **Edge 开机即在线（只要不关机）**：
  - 托盘启动时 `caffeinate -imsu -w <托盘pid>`，托盘存活期间阻止 macOS 系统/空闲睡眠（显示器可息屏）。
  - Node 5101 仍用 `caffeinate -imsu` 包裹；开发脚本 `mc-keep-awake.sh` 同步加 `-u`（电池供电也保活）。
  - 退出托盘时释放保活断言。

## 2026-06-06（续 5）

- **Edge 息屏保持在线（用户诉求：安装客户端后应持续活跃）**：
  - 根因：托盘启动 5101 时仅设置 `MC_KEEP_AWAKE=1` 环境变量，未实际执行 `caffeinate`，息屏后 Node 被挂起、Bridge 心跳停止。
  - `mission-control-tray/process.rs`：macOS 下用 `caffeinate -ims` 包裹 `node server.js`（允许显示器息屏，阻止系统/空闲睡眠）。
  - 撤销服务端 90s stale 强制断连；改为每 30s 主动向 Edge 发 keepalive ping（仅 ping 发送失败时关闭 socket）。
  - 客户端唤醒后先 probe ping 再判定断线，避免息屏恢复时误显示离线。

## 2026-06-06（续 4）

- **Bridge 息屏僵尸连接修复**：
  - 根因：Mac 息屏后 Edge 5101 暂停心跳，但服务端 WebSocket 仍为 OPEN，`isBridgeClientOnline` 误判在线，发消息写入半开 TCP 后长时间无响应（最长 5 分钟）。
  - 服务端 `bridge-server.ts`：按 `lastSeenAt` 90s 判定 stale，定时 sweep 关闭僵尸连接；`isBridgeClientOnline` / `findConnectedEdgeBridge` 同步校验；TCP keepalive；agent 消息默认超时降至 90s。
  - 客户端 `remote-server-bridge.ts`：检测 heartbeat 定时器 gap（息屏唤醒）并主动重连。
  - 单测：`bridge-server-stale.test.ts`。

## 2026-06-06（续 3）

- **i18n 清理**：移除 mission-control-client 中已废弃的 `localCliPermission*`（设置页 / Agent 详情）文案；补全 mission-control `en.json` 的 `licenseGate.localCliElevation*` 键。

## 2026-06-06（续 2）

- **聊天输入框临时提权按钮（订阅门控）**：
  - 输入框旁星形「提权」按钮，仅对**当前一条消息**生效，发送后自动关闭。
  - 订阅权益 `enableLocalCliElevation`（`license-schema.json`）；未订阅点击提示前往用户中心。
  - 服务端 API 校验：`/api/chat/messages`、`/api/agents/message`、`/api/sessions/continue` 接受 `local_cli_elevated`。
  - Bridge 透传至 Edge 5101，`deliver-agent-message` / `enqueueLocalSessionPrompt` 注入 `permissionMode: full`。
  - 移除设置页与 Agent 详情中的全局/按 Agent 权限配置；保留 `MC_LOCAL_CLI_PERMISSION_MODE` 仅供开发调试。

## 2026-06-06（续）

- **本地 CLI 高权限模式（服务端聊天 → Edge 5101）**：
  - 新增 `local-cli-permission.ts`：`standard`（默认）与 `full`（Codex `--dangerously-bypass-approvals-and-sandbox`、Claude `--dangerously-skip-permissions`）。
  - 优先级：智能体 `config.mc_local_cli_permission` > 环境变量 `MC_LOCAL_CLI_PERMISSION_MODE` > 设置 `local_cli.permission_mode`。
  - `local-session-executor` 在 full 模式下放宽会话 preamble 中的 Operating rules。
  - **5101 设置页**与**智能体详情 → 概览**可配置；`.env.example` 增加 `MC_LOCAL_CLI_PERMISSION_MODE` 说明。
  - 单测：`local-cli-permission.test.ts`（4 passed）。

## 2026-06-06

- **mission-control：推送 agentcenter:2.0.1（新 runtime zip df9b93eb + 托盘 ditto/Node22 修复）**：
  - 重新打包 client runtime zip（69M，含顶层 `styled-jsx`/`@swc/helpers` 链接）；`df9b93eb4a8422de2f6386c1b7202dc53209e69cfa55c09710d06e30d8c14ea5`。
  - 重编译 Edge 托盘（`ditto -xk` 解压 zip、`repair_runtime_peer_links`、Node 22+ 优先）；dmg `6fe17a2e…`。
  - amd64 + arm64 推送；manifest digest **`sha256:a77a6e038a78bfada6980c76ae56059fa54b4204352b34a8853ebc287d1eaa96`**；`latest` 已更新。

- **mission-control：推送 agentcenter:2.0.1（Edge 下载页 + tray dmg 1e923db7…）**：
  - amd64 推送成功；arm64 元数据缓存失败后 `buildx prune` 重试成功。
  - manifest digest **`sha256:e5ca8c2d2cbca0f1294ee4fb96df5b371de2138811847167942f015dd234d2b4`**；`latest` 已更新。
  - 注：runtime zip 仍为 `61605e36…`（本机磁盘不足未能重打 client runtime）；5101 符号链接修复需后续重打 zip + 重编译托盘。

- **Edge 5101 启动失败（server.js:16 require('next')）根因与修复**：
  - 根因 1：Rust `zip` crate 解压 runtime zip 不保留 pnpm 符号链接，导致 `styled-jsx` 等 peer 依赖缺失。
  - 根因 2：部分用户 Node 为 v20（日志末尾可见），E-Agent 需要 **Node 22+**。
  - 修复：`runtime.rs` macOS 改用 `ditto -xk` 解压 zip；安装后 `repair_runtime_peer_links` 补齐顶层链接；`node_path.rs` 优先选用 22+ 并跳过 v20。
  - 修复：`package-edge-runtime.sh` 为 `@swc/helpers` 等 scoped 包创建父目录后再 `ln -sf`。
  - 用户侧：`rm -rf ~/.e-agent-edge/runtime` → 安装 Node 22+ → 重新「连接并启动」。

- **mission-control：推送 agentcenter:2.0.1（Edge 下载页滚动/安装说明 + tray dmg）**：
  - amd64 推送成功；arm64 Docker 元数据缓存失败后 `buildx prune` 重试成功。
  - manifest digest **`sha256:595c1171278b32fe3076a960e07bbb7615efd375e200edcc4e4297b1cad1ebb7`**；`latest` 已更新。
  - edge-tray dmg：`sha256:dc362081…`（amd64 构建时）/ `0b7b4315…`（arm64 构建时）。
  - 服务器：`docker compose -f docker-compose.1panel.yml pull && docker compose -f docker-compose.1panel.yml up -d`。

- **mission-control-client + tray：托盘连接信息自动同步 + 合并令牌字段**：
  - 修复托盘在 5101 已运行时跳过 `apply-bootstrap`，导致 Web 设置页「服务网关地址」为空。
  - 新增 `POST /api/edge/import-tray-config`：从 `~/.e-agent-edge/config.json` 导入 `gateway.server_url` / `gateway.token`；设置页加载时自动调用。
  - 托盘 `submit_setup` 在 5101 已健康时预推送配置；`ensure_running` 沿用现有进程时仍写入 bootstrap 设置。
  - 设置页移除重复的「边缘注册令牌」字段，仅保留「网关 API 令牌」（与托盘共用同一 key）。

- **mission-control：Edge 下载页安装说明补全 + 滚动修复**：
  - 根布局 `overflow-hidden` 导致长内容被截断；下载页改为 `h-full overflow-y-auto`，顶栏 sticky，去掉垂直居中。
  - 安装步骤扩展为 9 步：dmg 通配符 `e-agent-edge-*.dmg`（兼容 Chrome `(1)` 后缀）、强调勿在 dmg 内运行、拖入后推出 dmg、开发者身份拦截说明与「仍要打开」路径、备用 codesign 命令。
  - 更新 `messages/en.json`、`messages/zh.json` 中 `edgeDownload` 文案。

- **mission-control：推送 agentcenter:2.0.1（含 ditto runtime zip + edge-tray）**：
  - Edge runtime zip 已用 `ditto` 重打：`sha256:61605e36edc591d72530cfb5459192d7a408c4788f6cb41b699fb40d6a55dbbe`（约 121M）。
  - Edge tray dmg：`sha256:fd50864b4208f065fe493e4206d096ad4918e5524b37b0a4d55f0ee960c3e676`。
  - 修复 `sync-edge-tray-bundle.sh`：`cleanup_staging` EXIT trap 在 `set -e` 下误返回 exit 1，导致 multiarch 脚本 tray sync 后未进入 docker build。
  - `docker-publish-multiarch.sh`：amd64 推送成功；arm64 因 Docker 元数据缓存失败（`node:22.22.0-slim` size validation），经 `buildx prune` + 单独 `docker-publish-local.sh` 重试成功。
  - 多架构 manifest digest **`sha256:79d74d1149ff33806c2d411906da6c458500fd42a9dea85094e5a79e1307eab4`**；`latest` 已更新。
  - 平台 digest：amd64 `sha256:8074f2d0323bfa3f2a2a12c7d7e6f06c9a52253bd9ecd2f3d16d065aa0d138c1`；arm64 `sha256:6af26044ce675cd750979516b75e583f8ec66cdff073c9f6d1114cf89fc45984`。
  - 服务器：`docker compose -f docker-compose.1panel.yml pull && docker compose -f docker-compose.1panel.yml up -d`。
  - Edge 用户若曾安装损坏 runtime：`rm -rf ~/.e-agent-edge/runtime` 后重新「连接并启动」。

## 2026-05-19

- **mission-control：Edge 托盘 .dmg 打入服务端镜像**：
  - 新增 `scripts/sync-edge-tray-bundle.sh`，拷贝 tray .dmg 到 `public/edge-tray/` + manifest（与中心版本 2.0.1 配套）。
  - `docker-publish-*.sh` 构建前自动 sync；缺少 tray manifest 则中止。
  - 下载页从 manifest 解析 `/edge-tray/e-agent-edge-{version}-darwin-aarch64.dmg`。
  - 已重新推送多架构镜像；digest `sha256:ae303a18feb0c0ada1ed3f4fc19f12209b39dbd281664ba06f3a4f2321cc39c7`。
- **Edge runtime MODULE_NOT_FOUND（styled-jsx）修复**：
  - 根因：zip 解压/copy 破坏 pnpm 符号链接，`node_modules/next` 被截断。
  - `package-edge-runtime.sh` 改用 `ditto` 打包并补 `styled-jsx` 等 peer 链接。
  - 托盘 `runtime.rs` macOS 用 `ditto` 安装 runtime，并加强 `is_runtime_usable` 检测。

  - `resolveDistributionEnrollToken` 与 bootstrap 一致：MC_EDGE_ENROLL_TOKEN → 多企业 map → 全局 API Key → Bridge 令牌。
  - 下载页展示完整可复制令牌，并标注来源（API Key 同步等）。
- **mission-control：推送 agentcenter:2.0.1（含令牌同步 + edge-tray）**：
  - manifest digest `sha256:7595cb75d4003c9a5062e2597918a9937df96cbe191d08d9ff25a311597344b0`；`latest` 已更新。
- **Edge 安装 macOS Gatekeeper 说明 + dmg 重打包**：
  - `sync-edge-tray-bundle.sh` 发布前 ad-hoc 签名并重新打 dmg。
  - 下载页 `/edge/download` 安装说明含完整步骤与可复制终端命令（xattr / codesign）。

- **mission-control：推送 agentcenter:2.0.1 多架构镜像**：
  - amd64 + arm64 已推送；manifest digest `sha256:cf002a13eb1e1e99ee65179f3fafc6686d631a84335d418d58a1eb46508ea773`；`latest` 已更新。
  - 含 Edge 下载页、/edge-tray/ 放行、download-info API 等最新改动。
  - 服务器：`docker compose -f docker-compose.1panel.yml pull && docker compose -f docker-compose.1panel.yml up -d`

- **mission-control：Edge 下载页改为可复制连接信息**：
  - `.dmg` 无法在 Web 下载时按用户动态写入配置；页面改为展示完整「服务中心地址 + 分发令牌」并支持一键复制。
  - 安装步骤：下载 dmg → 启动 Edge → 粘贴地址与令牌 → 连接并启动。
  - API `download-info` 对登录用户返回完整 `enroll_token`；移除页面上的配置脚本入口。

- **mission-control / mission-control-client：Edge 客户端下载入口**：
  - 顶部栏右侧新增下载图标，跳转 `/edge/download`（本地 5101 客户端模式则打开上游服务中心下载页）。
  - 连接状态浮层（网关 / 服务 / 中心 Bridge）底部增加「下载 Edge 客户端」链接。
  - 新增下载页：展示中心地址、分发令牌（脱敏）、dmg 下载与 macOS 配置脚本（写入 `~/.e-agent-edge/config.json`）。
  - API：`GET /api/edge/download-info`、`GET /api/edge/install-script`（需登录）。
  - `proxy.ts` 放行 `/edge-tray/` 静态安装包；`.env.1panel.example` 增加 `MC_EDGE_TRAY_DOWNLOAD_URL` 说明。

## 2026-05-29

## 2026-06-05

- **mission-control：推送 agentcenter:2.0.1（含 /edge-runtime/ 鉴权放行）**：
  - 多架构 manifest（amd64+arm64）+ `latest` 已更新；digest `sha256:f5e300195b03...`。
- **mission-control：修复 Edge runtime zip 下载 SHA256 失败**：
  - 根因：`/edge-runtime/*.zip` 被 `proxy.ts` 鉴权重定向到 `/login`，托盘下载到 6 字节 `/login` 导致校验失败。
  - `proxy.ts`：放行 `pathname.startsWith('/edge-runtime/')`，matcher 排除 `edge-runtime/`。
  - 托盘 `runtime.rs`：校验失败时提示「可能被重定向到登录页」。
  - **需重新构建并部署服务端镜像** 后 Edge「连接并启动」方可下载 zip。
- **E-Agent Edge：退出行为 — 仅菜单栏「退出」停 5101，Dock/关窗只隐藏**：
  - 菜单栏托盘「退出」→ `quit_from_tray`：停 5101 + 结束应用。
  - 配置窗关闭 / Dock ⌘Q → `hide_to_background`：只隐藏窗口，5101 与菜单栏托盘继续运行。
- **mission-control：修复 exec format error — 推送多架构 manifest（amd64+arm64）**：
  - 原因：`docker-publish-local.sh` 在 Mac M 上仅产出 **linux/arm64**，x86 云服务器报 `exec /app/docker-entrypoint.sh: exec format error`。
  - 已构建并推送 `2.0.1-amd64`（linux/amd64），与既有 arm64 合并为 manifest list `agentcenter:2.0.1`；**`:latest` 已同步指向同一多架构 manifest**。
  - 更新 `scripts/docker-publish-multiarch.sh`（amd64 buildx + arm64 local + imagetools create）。
- **mission-control：重新构建并推送 agentcenter:2.0.1 镜像**：
  - 执行 `scripts/docker-publish-local.sh`（sync runtime + pnpm build + Dockerfile.runtime-only + push）。
- **mission-control：推送 agentcenter:2.0.1 至阿里云 CR（含 Edge runtime）**：
  - 本机 `pnpm build` + `Dockerfile.runtime-only` 打镜像（规避 Docker 内 apt 502）。
  - 镜像：`crpi-c9b9bml2ajb23n5d.cn-shenzhen.personal.cr.aliyuncs.com/1sheng/agentcenter:2.0.1` 已 push。
  - 新增 `scripts/docker-publish-local.sh`、`.dockerignore.publish`、`Dockerfile.runtime-only`。
  - 服务端需 `docker compose pull && up -d` 拉新镜像后 manifest 503 才会消失。
- **E-Agent Edge：服务端内置 runtime 配套发布（简化流程）**：
  - 本机已打包 `client-runtime-2.0.1-darwin-aarch64.zip`（97M）并 sync 到 `mission-control/public/edge-runtime/`。
  - 新增 `scripts/sync-edge-runtime-bundle.sh`：`pnpm sync:edge-runtime` 一键打包 client + 写 manifest（sha256）。
  - 中心服 `loadEdgeRuntimeManifest()` 默认读 `public/edge-runtime/manifest.json`；API 自动把 `/edge-runtime/*.zip` 补全为站点绝对 URL。
  - `docker build` / buildx 构建前自动 sync；zip 不提交 Git，manifest 可提交。
  - 文档：`mission-control/deploy/EDGE-RUNTIME.md`。
- **E-Agent Edge：本机修复 5101（standalone build + runtime 安装）**：
  - 执行 `mission-control-client` 的 `pnpm install` / `pnpm build`，生成 `.next/standalone`。
  - 将 standalone 复制到 `~/.e-agent-edge/runtime`（含 static/public、VERSION）。
  - 手动启动验证：`curl http://127.0.0.1:5101/api/status?action=health` 返回 200。
- **E-Agent Edge：runtime 清单 HTTP 503（服务中心未配置 manifest）**：
  - 503 原因：`agent.1sheng.work` 未设置 `EDGE_RUNTIME_MANIFEST_PATH` / `EDGE_RUNTIME_MANIFEST_JSON`。
  - 托盘：`fetch_manifest` 503 提示管理员配置；`install_from_local_standalone` 在下载失败时从 `MC_EDGE_STANDALONE_DIR` 或 `~/Desktop/agent指挥仓/mission-control-client/.next/standalone` 复制。
  - 初始化顺序恢复为：中心 bootstrap → runtime → 启动 5101。
- **E-Agent Edge：修复误导性错误「无法调用 apply-bootstrap」**：
  - 根因仍是 5101 未起来（runtime 损坏）；原流程在健康检查前就 POST apply-bootstrap，界面误报。
  - `ensure_running`：先 `wait_until_healthy` 再 `apply-bootstrap`；初始化顺序改为 runtime → 中心 bootstrap → 启动 5101。
  - 已在本机执行 `rm -rf ~/.e-agent-edge/runtime` 清除损坏目录。
- **E-Agent Edge：5101 无法启动 — runtime 损坏（Cannot find module 'next'）**：
  - 根因：`~/.e-agent-edge/runtime` 为开发机复制的 standalone，`node_modules/next` 符号链接指向已删除的 `.next/standalone`，Node 能启动但 `server.js` 立即退出。
  - `runtime::is_runtime_usable()` 校验 `next` 可解析；`ensure_runtime` 损坏时自动删除目录并重新下载/安装。
  - `wait_until_healthy` 失败时附带 `~/.e-agent-edge/logs/node-server.log` 尾部。
- **E-Agent Edge：修复 GUI 启动找不到 Node（No such file or directory）**：
  - 新增 `node_path.rs`：从 Finder/.app 启动时 PATH 不含 Homebrew/nvm，改为依次探测 `MC_EDGE_NODE_PATH`、`which`、`/opt/homebrew/bin/node`、`/usr/local/bin/node`、fnm/volta、`.nvm/versions/node/v22+`、登录 shell `zsh -l -c 'command -v node'`。
  - `Info.plist` 增加 `LSEnvironment.PATH`（含 `/opt/homebrew/bin`）。
  - `process::start` 使用解析到的绝对路径启动 `node server.js`，并为子进程设置 `PATH`；Node 子进程 stderr 写入 `~/.e-agent-edge/logs/node-server.log`。
  - 错误文案改为中文可操作指引（安装 Node 或设置 `MC_EDGE_NODE_PATH`）；**须完全退出旧进程后覆盖 `/Applications` 再打开**，否则仍显示旧版「请安装 Node.js 22+」。
  - 已执行：`killall` → `cp` 新包 → `open -a "E-Agent Edge"`。
- **E-Agent Edge：安装/启动自动拉起 5101，修复打开 Internal Server Error**：
  - 新增 `process::ensure_running` / `is_healthy`：启动后健康检查 `/api/status?action=health`；已配置用户打开托盘即后台拉起服务。
  - 端口被占用但服务异常时给出明确提示（避免裸连 `127.0.0.1:5101/` 看到 500）。
  - 浏览器默认打开 `http://127.0.0.1:5101/chat`（非根路径 `/`）。
  - `open_console` 前若未就绪会尝试 `ensure_running` 并提示先完成「连接并启动」。
- **E-Agent Edge：点击托盘/Dock 打开连接配置页**：
  - 左键点击菜单栏图标 → `open_tray_config`（同首次初始化 `setup.html`，不先停 5101）。
  - 右键仍弹出托盘菜单；Dock 点击（`RunEvent::Reopen`）同样打开配置页。
  - 菜单「连接设置…」仍为 `open_connection_setup`（先停 5101 再配置）。
  - Cocoa 托盘（`MC_EDGE_COCOA_TRAY=1`）左键 `tray_click`、右键弹出菜单。
  - `setup.html` 纳入构建拷贝；窗口标题改为「连接配置」。
- **E-Agent Edge：菜单栏图标与软件 logo 统一**：
  - `generate-tray-icons.sh`：`menu-bar-tray` / `tray-icon` 均从 `app-logo.png` 生成；`tray-icon-mono.ico` 由品牌 template 导出。
  - macOS 默认 Tauri 托盘改用 `tray-icon@2x.png`（彩色、`icon_as_template(false)`）；`MC_EDGE_TRAY_TEMPLATE=1` 可回退单色反色。
  - Cocoa/objc2 默认 `tray-icon@2x.png`；Windows 托盘 `tray-icon.png`。

## 2026-05-19

- **E-Agent Edge：Tauri 托盘 rect 从 y=1912 纠正到 (1488,0)**：
  - 日志解读：Retina 物理坐标；`y=1912` 为屏底错位，`x=1488,y=0` 为菜单栏右侧（与 Clash 同区）。
  - `menu_bar_visible`：仅当 `rect` 物理 `y>120` 时自动移除 TrayTarget；到位后不移除（对齐 Clash）。
- **E-Agent Edge：菜单栏日志 visible=1 仍不可见 → 改默认 Clash 托盘**：
  - 用户截图：Clash 猫头可见，Edge `objc_tray screen=(696,919)` 无图标；根因之一 `menu-bar-tray.png` **黑底**在深色菜单栏不可见。
  - 默认后端改为 **Tauri/Clash**（`tray-icon-mono.ico` + template）；Cocoa 仅 `MC_EDGE_COCOA_TRAY=1`。
  - Cocoa/objc2 默认改 **template 透明底** 图标。
- **E-Agent Edge：菜单栏常驻排错（本机实测）**：
  - 根因归纳：API `visible=1` 但用户盯右侧；图标实际在 `screen.x≈696`（中部）；刘海屏菜单栏 ~37pt（`y=919` 在 956 屏顶内），旧 `inMenuBar` 误判。
  - 曾 `RemovalAllowed` 导致拖掉后长期隐藏；改 Default；默认**彩色**圆点；延迟 600/1800ms 刷新布局。
  - 磁盘 100% 满导致无法打包 → `cargo clean` 释放 16G 后重编；`build.rs` 链接 AppKit/Foundation。
  - 新增 `docs/macos-menubar-troubleshooting.md`。
- **E-Agent Edge：攻关右侧 Clash 式菜单栏小图标（方案 B）**：
  - 新增纯 Cocoa 模块 `edge_menubar.m` + `objc_tray.rs`（`NSStatusItem` + template PNG，无 `tray-icon`/TrayTarget），**默认后端**。
  - `MC_EDGE_TAURI_TRAY=1` → Clash 同款 Tauri 托盘；`MC_EDGE_NATIVE_TRAY=1` → objc2 原生。
  - Tauri 托盘修复改为默认仅 `setVisible(true)`；移除 TrayTarget / 标题需 `MC_EDGE_TRAY_FIX=1` / `MC_EDGE_TRAY_TITLE=1`。
  - 顶部 WebView 快捷条默认**关闭**（`MC_EDGE_TOP_HELPER=1` 才开），避免遮挡排错。
  - `build.rs` 用 `cc` 编译 Objective-C；README / `verify-menubar-tray.sh` 补充 macOS 15 菜单栏系统设置说明。

- **E-Agent Edge：菜单栏快捷条（用户截图已可见）**：
  - 将 `tray-panel.html` 纳入仓库（原仅在 `dist/`，被 gitignore）；`beforeBuildCommand` / `beforeDevCommand` 自动 `cp` 到 `dist/`。
  - 快捷条样式：半透明深色、绿/红状态点、宽度约 248px；窗口 `transparent(true)` 减少白底。
  - 说明：此为 `MC_EDGE_TOP_HELPER` 默认开启的**菜单栏行内嵌条**，非 Clash 式右侧 `NSStatusItem` 小图标；原生图标请查菜单栏**最左侧**或 `…` 折叠区。

## 2026-05-28

- **E-Agent Edge：菜单栏仍不可见 → 加强诊断 + 默认快捷条**：
  - 用户截图右侧无 Edge；日志 `window=(0,-37)` 但屏幕截图无项 → 增加 `convertRectToScreen`、`hasImage`、`title`、`len=72` 日志；仅彩色 PNG（不用 template .ico）。
  - 顶部快捷条恢复默认开启（`MC_EDGE_TOP_HELPER=0` 可关），保证可用入口。

- **E-Agent Edge：默认纯原生 NSStatusItem + 本机验证**：
  - 默认放弃 Tauri `TrayIconBuilder`（诊断 `rect y=1912` 错位）；改 `macos/native_tray.rs` 直接 `NSStatusBar.statusItem`，无 TrayTarget 子视图。
  - 本机 release `.app` 诊断：`native_tray[install] isVisible=true button=(0,0,71x22) subviews=0 window=(0,-37,71x37)`（顶部菜单栏坐标，对比旧 Tauri `y=1912`）。
  - 顶部快捷条默认关闭（`MC_EDGE_TOP_HELPER=1` 才开）；`scripts/verify-menubar-tray.sh` 一键 build/sign/open/读日志。
  - `MC_EDGE_TAURI_TRAY=1` 可回退旧 Tauri 托盘（仅调试）。

## 2026-05-22

- **E-Agent Edge：Dock 出现 exec 说明裸二进制启动**：
  - 用户截图 Dock 中 `exec` 图标：进程在跑但未用 `.app` 打包启动，菜单栏仍无 Edge。
  - 默认改回 **Clash 模式** `TrayIconBuilder`（mono template）；`MC_EDGE_NATIVE_TRAY=1` 才走原生。
  - 修复 `TRAY_CREATED` 逻辑错误导致托盘未创建；新增 `scripts/macos-open-app.sh`（build + codesign + open）。
  - 诊断日志：`~/Library/Logs/E-Agent-Edge/tray-diag.log`。
- **E-Agent Edge：纯原生 NSStatusItem 菜单栏（绕过 Tauri tray-icon）**：
  - 用户反馈 `setVisible` + 去 TrayTarget 仍无圆点；新增 `macos/native_tray.rs`：objc2 直接 `NSStatusBar.statusItem`，`setVisible(true)` + 标题 Edge + 彩色 PNG，muda 菜单 + `App::on_menu_event`。
  - 默认不再走 `TrayIconBuilder`；`MC_EDGE_TAURI_TRAY=1` 可回退旧路径。顶部快捷条默认开启作备用。
- **E-Agent Edge：菜单栏托盘必现修复（核心）**：
  - 新模块 `macos/menu_bar_visible.rs`：创建托盘后默认执行 `NSStatusItem.setVisible(true)`、移除 `TrayTarget` 遮挡层、设置彩色图标 + 标题「Edge」，并 5 次延迟重试。
  - 根因：`tray-icon` 0.23 未调用 `setVisible`，且透明 `TrayTarget` 盖住按钮；与 Clash 同库但需显式修复才可在 macOS 15 显示。
  - 顶部快捷条改回仅 `MC_EDGE_TOP_HELPER=1` 时显示；删除旧 `macos_tray_fix.rs`。
  - 探测程序 `nsstatusitem-probe` 已加 `setVisible:YES` 便于对照。
- **E-Agent Edge：macOS 托盘对齐 Clash Verge Rev**：
  - 参考 `_tray-reference/clash-verge-rev/src-tauri/src/core/tray/mod.rs`：`TrayIconBuilder` + `tray-icon-mono.ico` + `icon_as_template(true)`，去掉 status 标题。
  - 启动策略改为 **Regular**（与 Clash 一致），关 setup 窗/进后台时再 `Accessory`；托盘在 `RunEvent::Ready` 主线程延迟创建，不再在 `setup()` 同步创建。
  - 默认关闭 `tauri-nspanel`（仅 `MC_EDGE_NSPANEL=1` 启用）；**顶部快捷条默认开启**（`MC_EDGE_TOP_HELPER=0` 可关）。
  - 用户本机：ahkohd 示例与原生 `PROBE` 均无菜单栏图标，Clash 有图标 → 属环境差异，需 `tauri build` + 可选 `codesign` 后再测。
- **托盘问题隔离：独立 clone ahkohd 官方示例在本机构建运行**：
  - 路径：`_tray-reference/tauri-macos-menubar-app-example`（v2 分支），`pnpm install` + `pnpm tauri build` 成功。
  - 产物：`.../bundle/macos/tauri-macos-menubar-app-example.app`；`open` 后进程存在（`pgrep tauri-macos-menubar`）。
  - 本机菜单栏右侧截图（逻辑分辨率 1470×956）：仅有系统图标（控制中心/Wi‑Fi/电量/Spotlight/Siri/时间），**未见**示例 Tauri 托盘图标，与 E-Agent Edge 现象一致。
  - **结论倾向**：更可能是本机 macOS 15.7 + Tauri/tray-icon 环境/菜单栏策略问题，而非仅 mission-control-tray 业务代码导致；建议用户本机肉眼确认该 `.app`，并检查菜单栏「…」折叠区、是否安装 Bartender 等、与 Clash Verge（原生托盘）对照。
  - **用户确认**：官方示例 `.app` 本机也**看不到**菜单栏小图标，隔离实验成立。
  - **用户确认**：示例应用** Dock 底部有图标**（进程在跑），仅菜单栏托盘不可见；说明是「状态栏项显示」问题，非应用未启动。
  - 新增 `_tray-reference/nsstatusitem-probe/`：Swift 原生 `NSStatusItem`（标题 `PROBE`）探测脚本，用于区分「Tauri 层」与「系统层」；运行 `./build-and-run.sh`。
- **E-Agent Edge：按 ahkohd + EasyCLI 方案改造 macOS 托盘壳**：
  - 依赖：`tauri-nspanel`（v2 分支）、`macos-private-api`；`tauri.conf.json` 增加隐藏窗 `edge-shell` + `macOSPrivateApi`。
  - 新模块 `src-tauri/src/macos/{mod,tray,panel}.rs`：`Accessory`、NSPanel、`template` 图标菜单栏托盘；业务仍用 `bootstrap`/`runtime`/`process`。
  - `Info.plist` 关闭 `LSUIElement`，改由 `Accessory` 隐藏 Dock；`macos_tray_fix` 仅 `MC_EDGE_TRAY_LEGACY_FIX=1` 启用。
  - 对齐 EasyCLI：setup 窗口在服务运行中关闭时仅隐藏；托盘菜单增加「检查托盘应用更新」占位。
  - 参考仓库：ahkohd/tauri-macos-menubar-app-example、router-for-me/EasyCLI、clash-verge-rev（托盘对照）。
- **E-Agent Edge：.app 仍无菜单栏图标（TrayTarget 遮挡 + 默认修复）**：
  - 根因：Tauri `tray-icon` 在 `NSStatusBarButton` 上叠加 `TrayTarget` 透明层，挡住图标/标题；template 36×36 在部分主题下几乎不可见。
  - `macos_tray_fix` 默认开启：移除 `TrayTarget` 子视图，用彩色 `menu-bar-tray.png` 重设图标 + 标题 `Edge`；启动与 `RunEvent::Ready` 及延迟 4 次重试。
  - 初始托盘改用 `menu-bar-tray.png`、`icon_as_template(false)`；菜单增加「显示顶部快捷条」；`MC_EDGE_TRAY_FIX=0` 可关修复。
- **E-Agent Edge：macOS 15 控制中心无应用项 + dev 自动顶部快捷条**：
  - macOS 15「控制中心→仅菜单栏」通常只列系统项（时钟/Siri 等），第三方托盘应用不会出现，属正常，不能靠此页开关托盘。
  - 新增 `macos_launch.rs`：检测是否 `.app` bundle；`pnpm tauri dev` 裸二进制时**默认**显示屏幕顶部 `tray-panel` 快捷条；`MC_EDGE_TOP_HELPER=0` 可关；打包 `.app` 后默认不显示快捷条。
  - 启动日志说明：要菜单栏图标请 `pnpm tauri build` 后 `open .../E-Agent Edge.app`。
- **E-Agent Edge：修复 `show_menu` 编译错误（Tauri 2）**：
  - `TrayIcon` 无 `show_menu()`；已删除左键回调里的调用，仅保留 `TrayIconBuilder::show_menu_on_left_click(true)`。
  - `cargo build`（mission-control-tray/src-tauri）已通过；若仍报错请完全退出旧 `tauri dev` 后重新编译。
- **E-Agent Edge：初始化页保存并回填 API TOKEN**：
  - 令牌本就写入 `~/.e-agent-edge/config.json`；新增 `get_saved_setup`，打开连接设置时自动填入地址/令牌/自签选项。
  - 已保存时令牌可留空直接点「连接并启动」沿用上次；页面提示保存位置与留空规则。
- **E-Agent Edge：Bridge 重连失效（isShuttingDown 卡死）**：
  - `stopRemoteBridge` 后 `isShuttingDown` 未清除，`connect()` 直接 return，「点击重新连接」无效；`restartRemoteBridge` + `startRemoteBridge` 重置状态。
- **E-Agent Edge：中心服 Bridge「已断开」修复（自签 HTTPS）**：
  - 根因：`agent.1sheng.work` 为自签证书；`remote-server-bridge` 的 `/api/bridge/info` 与 `wss://` 未走 TLS 跳过，导致无法发现/连接 Bridge。
  - `remote-server-bridge.ts`：`bridge/info` 改用 `edgeUpstreamFetch`；`wss` 连接在 `tls_insecure` 时 `rejectUnauthorized: false`。
  - 托盘 `process.rs`：`tls_insecure:true` 时向 5101 子进程注入 `NODE_TLS_REJECT_UNAUTHORIZED=0`。
- **E-Agent Edge：macOS 15 托盘已创建但看不见**：
  - 日志 `rect y=1912` 为 tray-icon 内部坐标，不代表菜单位置；默认**关闭** `macos_tray_fix`（隐藏 TrayTarget 在 15.7 上反而可能不显示）。
  - 改用 template 图标 + 标题 Edge；左键 `show_menu_on_left_click(true)` 弹出菜单、双击打开控制台；可选 `MC_EDGE_TOP_HELPER=1` 顶部快捷条。
- **E-Agent Edge：macOS 菜单栏托盘不可见排查**：
  - 常见误用：只跑 `pnpm prod:restart`（5101 网页）≠ 托盘；须单独运行 `mission-control-tray` 的 `pnpm tauri dev` 或安装 `.app`。
  - `macos_tray_fix` 改为隐藏 TrayTarget（不删除），红色圆点 + 标题 Edge；启动日志提示在「…」折叠区查找。
- **E-Agent Edge：macOS 仅用系统菜单栏图标（取消默认浮动条）**：
  - 控制条改回标准 `NSStatusItem`：顶部菜单栏「Edge」图标 + 左键菜单；浮动 WebView 条仅 `MC_EDGE_TRAY_PANEL=1` 调试时启用。
- **E-Agent Edge：控制条嵌入 macOS 菜单栏行**：
  - 控制条窗口设为 `NSStatusWindowLevel`，`y=屏幕顶`、右侧预留系统图标区，高度约 26px，视觉与菜单栏同一行。
  - 若 `tray.rect()` 有效则贴靠红点「Edge」状态项左侧；菜单栏图标改回红色圆点（非 template）。
- **E-Agent Edge：macOS 无菜单栏图标且无浮动条**：
  - 浮动控制条此前需 `MC_EDGE_TRAY_PANEL=1` 才显示；现 **macOS 默认** 在屏幕右上角（`work_area`）显示红框 `tray-panel`。
  - 取消代码里 `ActivationPolicy::Accessory`（与 LSUIElement 叠加可能导致状态栏不显示）；菜单栏改用 **template 图标 + 标题 Edge**。
  - `macos_tray_fix` 仅移除 `TrayTarget` 子视图并延迟 3 次重试；托盘菜单增加「显示顶部控制条」。
- **E-Agent Edge：修复反复打开大量浏览器标签页**：
  - `setup.html` 在 `phase=done` 时每次 `refreshStatus`（2s）都调用 `open_console`；已改为完成后停止轮询，且不再在轮询里自动开页。
  - 首次连接成功由 Rust `run_setup_pipeline` 调用一次 `open_console`；`open_console` 增加 10s 防抖。
  - 托盘后台启动 `run_if_configured(..., false)`，不再每次启动都弹浏览器。
- **E-Agent Edge：修复「连接并启动」apply-bootstrap 403**：
  - 原因：本机 5101 由 `pnpm prod:restart` 启动时未设 `MC_EDGE_ALLOW_BOOTSTRAP=1`，托盘 `wait_and_apply_local_settings` 写入被拒。
  - `apply-bootstrap/route.ts`：本机 loopback 且带 `x-edge-tray: 1` 或进程已设 `MC_EDGE_ALLOW_BOOTSTRAP=1` 时允许写入。
  - `start-standalone.sh`：默认 `export MC_EDGE_ALLOW_BOOTSTRAP=1`。
  - 托盘 `bootstrap.rs`：请求头 `x-edge-tray: 1`；`process.rs`：5101 已被占用时明确提示先 `pnpm prod:restart --stop`。
- **托盘 macOS 菜单栏图标根因修复**：
  - `tray-icon` 在 `NSStatusBarButton` 上叠加透明 `TrayTarget` 子视图，挡住图标/标题；`macos_tray_fix.rs` 启动后移除子视图并设置标题 `Edge`。
- **托盘 macOS：菜单栏图标不可见时的顶部控制条**：
  - 诊断 `rect` 已创建但用户看不到（刘海/多屏/坐标 y=1912）；新增 `tray-panel.html` 浮动条（主屏右上角，打开控制台/连接设置）。
  - 菜单栏标题改为 `Edge` + 红色圆标。
- **托盘 macOS 菜单栏仍不可见（二次修复）**：
  - 菜单栏显示红色圆标 `menu-bar-tray.png`（非 template）+ 文字标题 `E`（微信输入法左侧）。
  - 启动时打印 tray `rect` 便于确认系统是否注册了 status item。
- **托盘 macOS 菜单栏图标消失（根因修复）**：
  - `TrayIcon` 被立即 drop 会从菜单栏移除；现 `app.manage(AppTray(tray))` 保持存活。
- **托盘 macOS 菜单栏不可见**：
  - 始终 `ActivationPolicy::Accessory`（仅顶部菜单栏，不占 Dock）。
  - 启动后终端提示菜单位置；已配置时自动打开 5101 浏览器。
- **托盘**：删除未使用的 `default_manifest_url` / `default_bootstrap_url`，消除编译 warning。
- **中心 mission-control 镜像构建并推送 ACR**：
  - `linux/amd64` → `crpi-c9b9bml2ajb23n5d.cn-shenzhen.personal.cr.aliyuncs.com/1sheng/agentcenter:2.0.1` 与 `:latest`
  - 含 `/api/edge/bootstrap`、`/api/releases/edge-runtime-manifest` 及 `proxy.ts` 公开路径
  - 生产需：`docker compose pull && up -d --force-recreate`；`1panel.env` 配置 `MC_EDGE_ENROLL_ALLOW_API_KEY=1` 等
- **E-Agent Edge：安装后 Web 初始化（仅连接地址 + API TOKEN）**：
  - 托盘首次启动弹出 `setup.html` 窗口；`submit_setup` 保存 `~/.e-agent-edge/config.json` 后执行 bootstrap → runtime → 启动 5101 → 自动打开浏览器。
  - 字段与中心「本站点连接信息」一致；可选自签 TLS；托盘菜单「连接设置…」可重新配置。
  - `config.setup_completed` 标记完成状态；未配置时不自动后台 bootstrap。
- **E-Agent Edge：5101 proxy-bootstrap 502（自签 TLS + 中心 API 未部署）**：
  - `edge-local-bootstrap.ts`：中心 fetch 失败或返回 HTML/非 JSON 时，用本机 `gateway.*` 设置合成 bootstrap（托盘 Web 通道可成功）。
  - `start-standalone.sh`：读取 `~/.e-agent-edge/config.json` 的 `tls_insecure:true` 时导出 `NODE_TLS_REJECT_UNAUTHORIZED=0`。
- **E-Agent Edge：修复已复制 runtime 仍拉中心 manifest 401**：
  - 托盘 `runtime.rs`：`resolve_server_js()` 同时识别 `~/.e-agent-edge/runtime/server.js`（5101 复制）与 `runtime/runtime/server.js`（zip 安装）；`ensure_runtime` 已有 `server.js` 则跳过下载，下载失败时若本地已安装则降级继续。
  - 5101 `edge-upstream-fetch.ts`：`proxy-bootstrap` / `proxy-runtime-manifest` 支持 `NODE_TLS_REJECT_UNAUTHORIZED=0` 与 `MC_EDGE_TLS_INSECURE=1`，缓解 `fetch failed`（自签证书）。
- **E-Agent Edge：从 5101 复制 runtime（绕开中心 zip 401）**：
  - `POST /api/edge/provision-tray-runtime`：将当前 standalone 复制到 `~/.e-agent-edge/runtime`。
  - 托盘 `ensure_runtime` 优先调用该接口，再尝试 manifest 下载。
- **E-Agent Edge：经 Web 客户端 (5101) 通道拉 bootstrap**：
  - `GET /api/edge/proxy-bootstrap`：用 5101 已有 `gateway.server_url` + `gateway.token` 代请求中心（与 Bridge 同配置，绕开托盘单独 enroll/TLS）。
  - 托盘优先 `http://127.0.0.1:5101/api/edge/proxy-bootstrap`，失败再直连中心或本地降级。
- **E-Agent Edge bootstrap 401 修复**：
  - 中心 `proxy.ts` 将 `/api/edge/bootstrap`、`/api/releases/edge-runtime-manifest` 加入公开 API（由 enroll token 鉴权，不再被中间件 401）。
  - `edge-bootstrap`：未设 `MC_EDGE_ENROLL_TOKEN` 时默认允许与 `API_KEY`/`security.api_key` 相同的令牌（5101 网关令牌）。
  - 托盘：中心仍 401 时用本地 5101 配置降级启动（不下载 runtime manifest 时需已安装 runtime）。
- **E-Agent Edge：TLS 自签证书（代理/VPN）**：托盘支持 `tls_insecure` / `EDGE_TLS_INSECURE=1`；已写入 `~/.e-agent-edge/config.json`。
- **运维：从本机 5101 写入托盘 config**（`GET /api/settings` → `~/.e-agent-edge/config.json`，含 center_url / enroll_token / mac001）。
- **E-Agent Edge：从 5101 读取注册令牌 + Web 设置可改**：
  - `GET /api/edge/tray-config`（本机）：返回 `gateway.server_url`、`edge.enroll_token`（缺省用 `gateway.token`）等；托盘启动时自动拉取。
  - `POST /api/edge/sync-tray-config`：将 Web 设置写入 `~/.e-agent-edge/config.json`。
  - 设置页新增「边缘注册令牌」与「同步到托盘配置」。
- **E-Agent Edge：菜单栏托盘 vs Dock + 品牌图标**：
  - 说明：macOS **Dock 右键**为系统菜单；业务菜单在 **顶部菜单栏托盘**（`LSUIElement` + `ActivationPolicy::Accessory`）。
  - 图标：`scripts/generate-tray-icons.sh` 从 `app-logo.png` 生成 bundle 与 `tray-icon-template.png`（菜单栏单色适配）。
- **E-Agent Edge 托盘菜单：Web 控制台**：
  - 托盘右键：**打开 Web 控制台（本机）**（`127.0.0.1:5101`）、**打开服务中心**（`center_url`）；双击托盘图标打开本机控制台。
- **E-Agent Edge 托盘：服务中心 bootstrap + 自动入网 + 主机名客户端**：
  - 中心 `GET /api/edge/bootstrap`：校验 `MC_EDGE_ENROLL_TOKEN`，返回企业信息、`gateway.*` 连接配置、runtime manifest、按 hostname 生成的 `client_name`。
  - 本地 `POST /api/edge/apply-bootstrap`（仅托盘启动且 `MC_EDGE_ALLOW_BOOTSTRAP=1`）：写入 settings 并重启 Bridge。
  - 托盘：拉 bootstrap → 下载 runtime → 启动 Node → apply 配置；`gateway.client_name` = OS hostname；`device.client_id` 按 enroll+device 稳定派生。
  - `remote-server-bridge` 支持 `MC_EDGE_CLIENT_NAME` 环境变量兜底。
- **E-Agent Edge 托盘（方案 B：首次启动下载 runtime）**：
  - 新增 `mission-control-tray/`（Tauri 2）：系统托盘菜单（打开控制台 / 重启边缘服务 / 检查并更新 Runtime / 退出）；双击托盘打开 `http://127.0.0.1:5101`。
  - 首次运行：从 `{center_url}/api/releases/edge-runtime-manifest` 拉清单 → 下载 `client-runtime-{version}-{platform}.zip` → SHA256 校验 → 解压到 `~/.e-agent-edge/runtime` → `node server.js`（数据目录 `~/.e-agent-edge/data`）。
  - `mission-control-client/scripts/package-edge-runtime.sh`：构建 standalone 并打 zip 到 `releases/dist/`。
  - `releases/edge-runtime-manifest.example.json`：各平台 zip URL + sha256 示例。
  - 中心服 `GET /api/releases/edge-runtime-manifest`：读取 `EDGE_RUNTIME_MANIFEST_PATH` 或 `EDGE_RUNTIME_MANIFEST_JSON`。
  - CI：`.github/workflows/edge-runtime-release.yml`（tag `edge-runtime-v*` 多平台打包 artifact）。
  - 文档：`mission-control-tray/README.md`。
- **prod-restart.sh 停止已退出进程时 exit 1**：
  - 修复 `stop_pid`：进程不存在时返回 0，避免 `set -e` 导致 `--stop` / `prod:build` 在 `stop_all` 阶段失败。
- **本地 client 24h 防待机（可息屏、保持网络）**：
  - `scripts/mc-keep-awake.sh`：standalone 默认 `MC_KEEP_AWAKE=1`，macOS 下 `caffeinate -ims` 阻止系统/空闲睡眠，**不**阻止显示器息屏（无 `-d`）。
  - `start-standalone.sh` 经 `mc_exec_keep_awake` 启动 `node server.js`；设 `MC_KEEP_AWAKE=0` 可恢复系统默认睡眠。
- **中心服镜像推送 ACR（创建智能体仅挂 Main + 人工值守规则等）**：
  - buildx 推送 **`1sheng/agentcenter:2.0.1`** / **`:latest`**（**linux/amd64**），manifest **`sha256:af182d417d7f9a61a778a2476664ba8b05ca44f5b148e160c1d31f5d519b7338`**。
  - 镜像：`crpi-c9b9bml2ajb23n5d.cn-shenzhen.personal.cr.aliyuncs.com/1sheng/agentcenter:2.0.1`
  - 生产：`docker compose -f deploy/docker-compose.1panel.yml pull && docker compose -f deploy/docker-compose.1panel.yml up -d --force-recreate`
- **本地创建智能体：去掉 Worker 上级下拉**：
  - 第 1 步已选 Main 运行时类型后，第 2 步仅只读展示「主运行时」，不再列出其它 Worker 作上级；`parent_id` 仍自动挂到对应 Main（`mission-control` + `mission-control-client`）。
- **中心服镜像推送 ACR（人工值守规则准确率+命中率 + diagnose + Tab 修复）**：
  - buildx 推送 **`1sheng/agentcenter:2.0.1`** / **`:latest`**（**linux/amd64**），manifest **`sha256:573c57a92eec1dcae349612515e0075688a951e49eab0e0efabcd5bd9d438703`**。
  - 镜像：`crpi-c9b9bml2ajb23n5d.cn-shenzhen.personal.cr.aliyuncs.com/1sheng/agentcenter:2.0.1`
  - 生产：`docker compose -f deploy/docker-compose.1panel.yml pull && docker compose -f deploy/docker-compose.1panel.yml up -d --force-recreate`
- **人工值守规则：准确率 + 命中率平衡**：
  - 强/弱话术分层：强信号（请确认/只读/不能创建等）查最近 2 条 assistant；弱信号（继续吗/下一步怎么做）仅最后一条 assistant。
  - `require_last_message_from_assistant`：用户已回复则 `awaiting_user_reply` 不介入，降误触。
  - 默认 idle 50s / 有信号 30s；无时间戳仅强信号或 pending_tool 可命中；移除宽泛词「是否」「需要你」。
- **人工值守默认规则提高命中率**：
  - `idle_timeout_seconds` 90→45；新增 `idle_timeout_with_stuck_seconds` 25（有确认/工具受阻时用更短空闲）；`exclude_if_tool` 120→60s；扩展关键词；无时间戳且有受阻信号时可命中（`match_when_stuck_without_timestamps`）；修复无时间戳时 `lastActivityAt` 误用 `now` 导致永远不算空闲。
- **人工值守无干预：规则放宽 + 会话匹配 + 诊断 API**：
  - 根因：默认规则需 **idle≥90s 且** 确认类话术；「你确认后」「只读/不能创建」未命中旧关键词；`worker_session_id` 与 Bridge 索引 `session_key` 不一致时 transcript 事件找不到绑定；`no_session_kind` 仅 debug 无审计。
  - 优化：扩展 `confirmation_patterns`（含你确认/只读/不能创建等）、最近 3 条 assistant 消息扫描；`listEnabledBindingsForTranscriptUpdate` 按索引 session_key 兜底；`no_session_kind` 写入审计；新增 **`GET /api/human-watch/diagnose?binding_id=`** 返回检查项、规则评估、最近干预记录与 hints。
  - 文件：`human-watch-rules.ts`、`human-watch-bindings.ts`、`human-watch-orchestrator.ts`、`human-watch-diagnose.ts`、`api/human-watch/diagnose/route.ts`、测试。
- **中心服镜像推送 ACR（人工值守 Tab 加载修复 + display_name + files 200）**：
  - 构建前修复 `event-bus.ts` 补充 `human_watch.bindings_synced` 的 `EventType`（否则 `pnpm build` 失败）。
  - buildx 推送 **`1sheng/agentcenter:2.0.1`** / **`:latest`**（**linux/amd64**），manifest **`sha256:08d3212045ae24cef6565cae6fac9b8a6983380e8edf0d8b5b8473252424cf29`**。
  - 镜像：`crpi-c9b9bml2ajb23n5d.cn-shenzhen.personal.cr.aliyuncs.com/1sheng/agentcenter:2.0.1`
  - 生产：`docker compose -f deploy/docker-compose.1panel.yml pull && docker compose -f deploy/docker-compose.1panel.yml up -d --force-recreate`
- **人工值守 Tab 一直「加载人工值守配置」+ 智能体名称显示错误**：
  - 根因：`workerResolved` 每次渲染为新对象 → `load` 依赖变化 → 无限重复请求；详情标题用 `agentState.name` 未用 `getAgentDisplayName`；Bridge 智能体 `GET /api/agents/{id}/files` 误查本地表返回 400。
  - 修复：`useMemo` 稳定 `workerResolved`；标题改为 `getAgentDisplayName`；`files` 对 `bridge_index` / 无 workspace 返回空文件集而非 400；`getAgentDisplayName` 兼容 `sync_client_id` 前缀剥离；`mission-control-client` 同步显示名逻辑与详情标题；Bridge 列表项 API 增加 `display_name` 字段。
- **人工值守一直无干预（边缘 transcript 未上报中心）**：
  - 根因：中心编排只监听 `session.transcript.updated`，但边缘 Codex/Claude 写 jsonl 时仅本地广播，**未**经 Bridge 发 `session_transcript_changed`（此前仅在 continue 代发时上报）；绑定 `worker_session_id` 也可能与当前 `session_key` 不一致。
  - 修复：客户端 `session-realtime` 在 transcript 变更时调用 `pushSessionTranscriptChangedToUpstream`；中心 `syncHumanWatchBindingSessionIds` 在 Bridge 索引同步后对齐 `worker_session_id`；编排启动时立即执行一次 poll。
  - 文件：`mission-control-client` `session-realtime.ts`、`remote-server-bridge.ts`；`mission-control` `human-watch-bindings.ts`、`sync-agent-index.ts`、`human-watch-orchestrator.ts`。
- **中心服镜像推送 ACR（人工值守绑定 Tab + edge-identity）**：
  - buildx 推送 **`1sheng/agentcenter:2.0.1`** / **`:latest`**（**linux/amd64**），manifest **`sha256:7f8d57c735af18795103852b1f3e127a4cd25ca9fce15c42c5740b2fac41192c`**。
  - 镜像：`crpi-c9b9bml2ajb23n5d.cn-shenzhen.personal.cr.aliyuncs.com/1sheng/agentcenter:2.0.1`
  - 生产：`docker compose -f deploy/docker-compose.1panel.yml pull && docker compose up -d --force-recreate`
- **人工值守绑定 Tab 无法显示已绑定关系（mc-local 边缘客户端）**：
  - 根因：详情刷新后 `node_id` / `local_agent_id` 丢失，或仅按本地字段匹配绑定；创建时已写入 `human_watch_bindings` 但 Tab 提前显示「仅边缘 Bridge…」。
  - 修复：新增 `GET /api/agents/[id]/edge-identity` + `resolveAgentEdgeIdentity`（按 sync 索引 id / `remote_name` / `original_name` 解析）；`useAgentEdgeIdentity` 供 Worker/值守绑定 Tab 使用；支持按 `sync_index_id` 匹配绑定；Worker Tab 显示当前值守并可「更新绑定」换值守 Agent。
  - 文件：`resolve-agent-edge-identity.ts`、`use-agent-edge-identity.ts`、两个 bind tab、`agent-card-helpers.ts`、`sync-agent-index.ts`、i18n。
- **中心服 Worker 详情「人工值守」Tab 显示值守 Agent**：
  - 根因：Bridge 在线拉取边缘详情时 `config.local_agent_id` 被覆盖丢失，Tab 用 `worker_local_agent_id` 匹配绑定失败，显示「尚未绑定」。
  - 修复：`GET /api/agents/[id]` 合并 `mergeBridgeIndexIntoConfig`；`HumanWatchWorkerBindTab` 同时按 `worker_sync_index_id` / `worker_local_agent_id` 匹配，并用 `resolveHumanWatchStewardLabel` 显示值守智能体名（绑定表 `steward_name` 或列表 `getAgentDisplayName`）。
  - 文件：`sync-agent-index.ts`、`agent-card-helpers.ts`、`agents/[id]/route.ts`、`human-watch-worker-bind-tab.tsx`、测试 `human-watch-binding-match.test.ts`。
- **客户端 standalone 与 dev 共用 `.data` 数据库**：`start-standalone.sh` / `prod-restart` 设置 `MISSION_CONTROL_DB_PATH` 指向项目根 `.data`，修复 prod(5101) 与 dev(5001) 配置（网关地址、令牌）互不见的问题。
- **客户端 `command.ts` TS 构建**：`child.stdout`/`stderr`/`stdin` 可能为 null，改为可选链与判空。
- **客户端构建修复 + 长期运行脚本**：`conversation-list` 补 `sessionId` 类型；新增 `scripts/prod-restart.sh`（`pnpm prod:restart` / `prod:stop` / `prod:build`），standalone 后台 **5101**。
- **客户端端口规划（避免冲突）**：新增 `scripts/mc-ports.sh` — **dev 5001** / **standalone·install 5101** / 中心服保留 **3000**；`dev-restart`、`start-standalone`、`deploy-standalone`、`install.sh`、`.env.example` 已对齐。
- **客户端 `start-standalone.sh`**：修复 macOS `HOSTNAME=*.local` 导致 `ENOTFOUND`；默认端口 **5101**；启动时打印访问 URL。
- **客户端脚本可执行权限**：为 `scripts/start-standalone.sh`、`deploy-standalone.sh` 等补充 `chmod +x`，修复直接 `./start-standalone.sh` 报 `permission denied`。
- **服务端镜像推送 ACR（最新：session_key 绑定 + Bridge 发消息 + TS 修复）**：
  - 构建前修复 `findAgentBoundToSessionRecord` 泛型（`getAgentDisplayName` 类型错误）。
  - buildx 推送 **`1sheng/agentcenter:2.0.1`** / **`:latest`**（**linux/amd64**），manifest **`sha256:bb11192f3bedbacdf7a5fb59f835b36ec543f1e0454db0a03656d0ea8312f62e`**。
  - 镜像：`crpi-c9b9bml2ajb23n5d.cn-shenzhen.personal.cr.aliyuncs.com/1sheng/agentcenter:2.0.1`
  - 生产：`docker compose pull && docker compose up -d --force-recreate`（`deploy/docker-compose.1panel.yml`）。

## 2026-05-21

- **服务端镜像推送 ACR（尝试）**：首次 buildx 因 BuildKit 磁盘 `input/output error` 失败；重启 Docker 后本机 daemon 未就绪，**未完成推送**。Docker 恢复后于 `mission-control/` 执行：`MC_DOCKER_PUSH=1 MC_DOCKER_PLATFORM=linux/amd64 bash scripts/docker-buildx-multiarch.sh`（含聊天列表 `session_key` 绑定、Bridge 发消息等）。
- **中心服聊天列表智能体名（边缘会话绑定修复）**：
  - 根因：中心 `sync_sessions` 的会话 `id` 为 `client:kind:sessionId`，列表却用 `session_key === s.id` 匹配；Bridge 索引未同步 `session_key`，且同步会话 `agent` 字段为 Codex 目录 slug（`test`）而非智能体名。
  - 修复：迁移 `063_sync_agent_index_session_key`；`agent_status` 写入 `session_key`；`findAgentBoundToSessionRecord` 按 `sessionId/key/id` 匹配；默认标题 `Codex CLI • {智能体显示名}`。若仍显示旧名，检查是否曾在列表「重命名」过（`session-prefs` 优先于默认名）。
- **本地客户端重启**：`mission-control-client` 执行 `pnpm dev:restart`；`http://127.0.0.1:5001` Ready，PID **50664**（含 Bridge `agent_message_request` 等新代码）。
- **服务端镜像推送 ACR（指挥栏 Bridge 发消息 + 聊天列表智能体名）**：
  - buildx 推送 **`1sheng/agentcenter:2.0.1`** / **`:latest`**（**linux/amd64**），manifest **`sha256:9fce5f0a124e0c9fa70c4d705be13fa9c90ab25f0fa7ab3face6bd6731796de9`**。
  - 镜像：`crpi-c9b9bml2ajb23n5d.cn-shenzhen.personal.cr.aliyuncs.com/1sheng/agentcenter:2.0.1`
  - 生产：`docker compose pull && docker compose up -d --force-recreate`（`deploy/docker-compose.1panel.yml`）。
  - **边缘 client** 需同步部署 `agent_message_request` 处理（仅拉中心镜像不够）。
- **中心服指挥栏向边缘智能体发消息（Bridge 转发）**：
  - `POST /api/agents/message`：中心 `agents` 表未命中时，用 `getBridgeAgentIndexByRecipient` 解析 `sync_agent_index`（`remote_name` / `original_name`），经 Bridge `agent_message_request` 转发至边缘执行。
  - 中心：`bridge-server.ts` 新增 `requestBridgeClientAgentMessage`；`sync-agent-index.ts` 新增 `getBridgeAgentIndexByRecipient`；路由 `maxDuration=300`。
  - 边缘：`deliver-agent-message.ts` 抽取投递逻辑；`remote-server-bridge.ts` 处理 `agent_message_request`。
  - 测试：`sync-agent-index-bridge.test.ts` 覆盖收件人解析。
  - **部署**：中心服与边缘 client 均需更新（仅推中心镜像不够，边缘需同步 client 代码/镜像）。
- **服务端镜像推送 ACR（中心服聊天列表智能体名）**：
  - buildx 推送 **`1sheng/agentcenter:2.0.1`** / **`:latest`**（**linux/amd64**），manifest **`sha256:83292c1ab72a73a616d8932163aea4d52799efe540a54dfcafd1d477ceb9226f`**。
  - 镜像：`crpi-c9b9bml2ajb23n5d.cn-shenzhen.personal.cr.aliyuncs.com/1sheng/agentcenter:2.0.1`
  - 生产：`docker compose pull && docker compose up -d --force-recreate`（`deploy/docker-compose.1panel.yml`）。
- **中心服聊天列表显示智能体名**：
  - `mission-control/src/components/chat/conversation-list.tsx`：按 `agents.session_key === session.id` 匹配绑定 Agent，默认标题为 `{运行时} • {智能体名}`（`getAgentDisplayName`，与客户端逻辑一致）；`loadConversations` 依赖 `agents`。
- **服务端镜像推送 ACR（人工值守全局规则 + 设置 UI）**：
  - 修复 `human-watch-rules-config.tsx` 构建 TS 类型后 buildx 推送 **`1sheng/agentcenter:2.0.1`** / **`:latest`**（**linux/amd64**），manifest **`sha256:7658880c09730fcec0f4d6cf4ec89dddca97ae5d42b44566bb191b8c33e7f144`**。
  - 镜像：`crpi-c9b9bml2ajb23n5d.cn-shenzhen.personal.cr.aliyuncs.com/1sheng/agentcenter:2.0.1`
  - 生产：`docker compose pull && docker compose up -d --force-recreate`（`deploy/docker-compose.1panel.yml`）。
- **人工值守全局规则 UI 精简**：设置 → 通用仅保留「启用规则」开关 +「配置」按钮；详细 L1–L3 参数在弹窗 `HumanWatchRulesDetailModal` 中编辑。
- **人工值守全局规则移至设置页**：
  - 中心服 **设置 → 通用**（admin）编辑全局 L1–L3 规则；`GET|PATCH /api/human-watch/rules` 改为 **admin** 权限、**不校验** enableHumanWatch 订阅。
  - 智能体绑定 Tab 只读规则摘要 + 跳转设置；侧栏无独立「人工值守」配置入口（`/human-watch` 页仅绑定列表/导出提示）。
- **人工值守判断规则改为租户全局配置**：
  - 迁移 `062_human_watch_global_rules`：`tenants.human_watch_rules_json`；`GET|PATCH /api/human-watch/rules`。
  - 编排器 `resolveHumanWatchRulesForBinding` 仅读全局规则，忽略 `binding.rules_override`；新建绑定不再写入 per-binding 规则。
  - UI：侧栏 **「人工值守」** 页编辑全局规则；智能体绑定 Tab 只读摘要 + **本绑定设置**（启用/模式）。
- **人工值守规则 UI 全量可配**（后并入全局页）：`HumanWatchRulesConfig` 支持编辑绑定启用/模式、L1 空闲、工具排除窗口、L2/L3 信号、确认关键词（多行）、组合逻辑、静默期、每小时上限；Worker/值守绑定 Tab 传入 `bindingMode`/`bindingEnabled`。
- **人工值守：值守仅大模型介入**：
  - 新建/默认值守 `steward.llm_enabled: true`（中心 `human-watch-defaults`、边缘 `human-watch-steward`）；更新值守 config 时强制保持 `llm_enabled`。
  - 编排器规则命中后**仅**走值守判官 LLM（Worker 摘要 → 判官会话 → 回复）；取消固定 `prompt_template` 回退；判官失败/空回复记 `intervention_skipped`（`steward_judge_*`）。
  - `parseStewardConfigFromAgent` 对 `human-watch` / `human_watch` 强制启用 LLM；默认判官模板与 SOUL 改为「先读上下文再像人回复」。
  - i18n 规则说明改为「规则触发判官代发」。
- **客户端快速重启脚本**：`mission-control-client/scripts/dev-restart.sh`（`pnpm dev:restart` / `pnpm dev:stop`），先 kill 占用 5001 与 next dev 进程再启动。
- **新智能体独立 Codex 会话**：首次建会话使用 `{workspace}/.e-agent/agent-{id}` 隔离目录，避免 `codex exec` 复用同仓库下已有「test」线程；忽略 stdout 中已存在 thread id；列表显示 `Codex • {智能体名}`。
- **恢复创建时后台绑会话 + 原聊天列表**：值守/本地 Agent 创建时重新 `enqueueProvisionAgentDedicatedSession`；聊天列表恢复 **隐藏值守专用会话**（去掉占位会话合并）；发消息在已有 `session_key` 时走 **enqueue 快速路径**，仅无绑定时 `await` 建会话。
- **本地客户端重启**：释放 5001 后于 `mission-control-client` 执行 `pnpm dev`；`http://127.0.0.1:5001` Ready。
- **智能体发消息「真成功」= 写入聊天会话**：
  - `POST /api/agents/message` 对本地运行时改为 **`await executeBoundLocalAgentPrompt`**（不再仅 `enqueue` 即返回 `success`）；响应增加 `delivered: true` 与 `session_key`；路由 `maxDuration=300`。
  - 详情页发送成功后 **种子化聊天列表项**、跳转对应 `session:*` 会话，并 `dispatchSessionPendingPrompt` 展示用户行；文案区分 `messageDelivered` / `messageSendingLong`。
  - 聊天 `SessionConversationView` 对 `boundAgentId` 匹配实时事件；占位页展示 `seedUserPrompt`。
- **值守 Agent 发消息后聊天无会话（根因修复）**：
  - 创建值守时不再后台单独跑 READY 引导（避免与首条用户消息争抢同一 Codex 队列、长时间无 `session_key`）。
  - `persistAgentSessionBinding` / 后台 prompt 完成后刷新 Codex 扫描与会话列表缓存，并广播 `session.list.updated`。
  - 聊天列表为无 `session_key` 的值守 Agent 显示 **进行中占位会话**；发消息后自动跳转该占位页并轮询直至绑定真实 `session_id`。
  - Codex `start` 在解析新 session 前 `invalidateCodexSessionScan`。
- **本地客户端聊天显示值守会话**：`conversation-list` 不再隐藏值守 `session_key` 对应会话，列表显示 **「值守」** 标记；智能体详情发消息后自动跳转聊天（有 session 时），无 session 时提示正在创建专用会话。
- **本地客户端识别人工值守类型**：`agent-squad-panel-phase3` 卡片/详情展示 **「值守」** 徽章与 **「人工值守」** 角色文案；`isHumanWatchAgent`（`role=human-watch` 或 `config.agent_kind=human_watch`）；值守卡片青色描边；详情增加 SOUL Tab；编排选人继续排除值守 Agent。
- **本地客户端重启**：释放 5001 后于 `mission-control-client` 执行 `pnpm dev`；`http://127.0.0.1:5001` Ready，`GET /api/init` 200。
- **服务端镜像推送 ACR（人工值守编辑/改绑/删除）**：buildx 推送 **`1sheng/agentcenter:2.0.1`** / **`:latest`**（**linux/amd64**），manifest **`sha256:89a886193d5f6c7fb7b43786809f6a0654f9035e5092b7e1b9a6e338078a8c93`**。生产：`docker compose pull && docker compose up -d --force-recreate`；边缘 client 需同步部署（Bridge `steward_update` / `steward_delete`）。

## 2026-05-20

- **人工值守：编辑 / 改绑 / 删除（中心服 + 边缘 Bridge）**：
  - **绑定**：`PATCH /api/human-watch/bindings/:id` 支持改绑 Worker/Steward（`patchHumanWatchBinding`）；新增 `DELETE` 解除绑定。
  - **值守 Agent**：Bridge `steward_update` / `steward_delete`；`PATCH|DELETE /api/human-watch/stewards`；中心 `PUT|DELETE /api/agents/[id]` 识别 `bridge_index` 值守 Agent 并转发边缘。
  - **边缘**：`updateHumanWatchStewardAgent` / `deleteHumanWatchStewardAgent`；删除时释放会话队列。
  - **UI**：Worker「人工值守」Tab 改绑走 PATCH、可解除绑定；值守「绑定 Worker」Tab 可编辑名称/SOUL、保存规则、逐条解除 Worker 绑定；智能体详情删除对值守 Agent 生效。
- **服务端镜像推送 ACR（人工值守创建绑定 + 默认规则 + 会话绑定）**：buildx 推送 **`1sheng/agentcenter:2.0.1`** / **`:latest`**（**linux/amd64**），manifest **`sha256:da5e17ca518179eb8543c374f89ad7e1488e3deb3c75e08499b023f074c8ac39`**。生产：`docker compose pull && docker compose up -d --force-recreate`。
- **添加人工值守支持创建时绑定 Worker**：弹窗增加「同时绑定 Worker」下拉；`POST /api/human-watch/stewards` 支持 `worker_local_agent_id`；绑定解析在索引未同步时经 Bridge 拉取 agent 详情兜底。
- **添加人工值守弹窗展示默认规则**：`human-watch-create-steward-modal` 嵌入 `HumanWatchRulesConfig` 与创建后绑定说明。
- **人工值守默认规则**：`human-watch-defaults.ts` 统一默认 L1–L3 规则、跟进话术、静默期与每小时上限；创建值守 Agent（边缘）与新建 binding 自动写入 `rules_override`；值守/Worker 绑定 Tab 展示「默认值守规则」卡片。
- **值守 Agent 绑定 Worker UI**：值守智能体详情新增 **「绑定 Worker」** Tab（`human-watch-steward-bind-tab.tsx`），可列出已绑定 Worker 并新增绑定；Worker 侧「人工值守」Tab 仍可用；策略接口改用 `available`。
- **服务端镜像推送 ACR（订阅授权 + 人工值守关联 + 设置 Tab）**：buildx 推送 **`1sheng/agentcenter:2.0.1`** / **`:latest`**（**linux/amd64**），manifest **`sha256:5b62b72ed8783fad2850bdc14a8d71eed0ef68f80205bd7168b3533b68418106`**。构建前修复 `human-watch/interventions/route.ts` TS。生产：`docker compose pull && docker compose up -d --force-recreate`。
- **服务端镜像构建修复**：`human-watch/interventions/route.ts` 修复 `limit` 可能为 `undefined` 的 TS 错误，以便 Docker `pnpm build` 通过。
- **客户端构建修复**：`mission-control-client/src/lib/human-watch-judge.ts` 将 `isHumanWatchAgent` 改为从 `human-watch-helpers` 导入（原误从 `human-watch-steward` 导入导致 5001 Turbopack 编译失败）。
- **设置页「自定义」Tab 常显**：无 `custom` 类 settings 时也显示 Tab，避免「订阅与授权」区块无法进入。
- **人工值守与订阅授权关联修复**：`resolveHumanWatchAvailability` 合并 `enableHumanWatch` 订阅权益与 `tenants.human_watch_enabled`；`GET /api/human-watch/policy` 返回 `subscription_entitled` / `available`；创建值守弹窗按订阅与租户分别提示。
- **订阅授权（对齐 1sheng-console）**：
  - 新增 `mission-control/license-schema.json`（`appId=mission-control`、`enableHumanWatch` 增值项、`requiresSubscription`）。
  - 服务端：`license-verifier` / `effective-license` / `license-settings-store`（SQLite `settings` 存离线 lic 与用户中心 URL）；API `GET /api/license/status|config`、`PATCH config`、`POST import`、`GET schema-template`（admin 下载隐藏模板）；`GET /api/auth/me` 返回 `license` 快照。
  - 策略：`requireHumanWatchEntitlement`（未订阅 `enableHumanWatch` → 402）；订阅过期且 `requiresSubscription` → 登录后全屏 `SubscriptionLicenseGate` 引导用户中心。
  - 前端：设置「自定义」Tab `LicenseSettingsSection`；智能体页人工值守按钮与 `HumanWatchEntitlementNotice`；Zustand `license` 状态。
  - 环境变量：`LICENSE_APP_ID`、`USER_CENTER_API_URL`、`USER_CENTER_INTERNAL_SECRET`、`USER_CENTER_PORTAL_URL`、`MC_LICENSE_ENFORCE`（默认 true；未配置用户中心 API 时开发环境放行）。
- **关闭中心服免登以恢复统一登录与单位信息**：`mission-control/.env.local` 设 `MC_DISABLE_AUTH=false`、注释 `MISSION_CONTROL_DISABLE_AUTH`；重启 5000。客户端 `.env.local` 增加 `NEXT_PUBLIC_MC_AUTH_LOGIN_URL=http://127.0.0.1:5000/login`。
- **人工值守入口迁至智能体页**：中心服 `agent-squad-panel-phase3` 增加「添加人工值守」与创建弹窗；Worker 详情增加「人工值守」绑定 Tab；值守 Agent 保留「干预记录」Tab；侧栏移除「人工值守」；`/human-watch` 页仅保留绑定列表与 CSV 导出。
- **中心服重启**：释放 5000 端口后 `mission-control` 执行 `pnpm dev`；`http://127.0.0.1:5000` Ready，`GET /api/init` 200。
- **本地客户端启动**：`mission-control-client` 执行 `pnpm dev`；`http://127.0.0.1:5001` Ready（Next.js 16.1.6，`.env.local`）；`GET /` 200。
- **人工值守 HW-018/019（Phase 2：L4 判官 + LLM 扫漏）**：
  - **Bridge**：`steward_judge_request` / `steward_judge_response`（中心 `requestBridgeClientStewardJudge`；边缘 `human-watch-judge.ts` + `remote-server-bridge`）。
  - **编排**：`human-watch-judge.ts`（摘要裁剪、`parseStewardConfigFromAgent`）；`llm_enabled` 时 Worker 摘要 → 值守 session 判官 → `reply` 代发 Worker；失败回退 `prompt_template`。
  - **扫漏**：`llm_sweep_enabled` + `llm_sweep_interval_minutes`（默认 30min）；60s 轮询 `pollLlmSweepBindings`；`event_type=llm_sweep` 留痕。
  - 单测 **23 条**通过（新增 `human-watch-judge` 3 条、编排 2 条）；修复 steward 配置缓存仅在 agent 存在时写入。
- **人工值守 E2E 联调文档**：`文档/06-测试报告/联调步骤-人工值守.md`；冒烟脚本 `mission-control/scripts/human-watch-e2e-smoke.sh`。
- **本地客户端重启**：释放 5001 端口后在 `mission-control-client` 执行 `pnpm dev`；`http://127.0.0.1:5001` Ready（Next.js 16.1.6，`.env.local`），`GET /api/init` 200。

## 2026-05-19

- **人工值守 HW-016/020 收尾**：
  - **HW-020**：`GET /api/export?type=human_watch_interventions&format=csv`（admin，按 workspace + tenant 过滤）。
  - **HW-016**：编排 `bridge_offline` 写入 `intervention_skipped`；查询 API / 导出按 `tenant_id` 隔离；`POST /api/human-watch/evaluate` 手动触发评估。
  - 单测增至 **18 条**（含租户隔离、bridge 离线、continue 失败）；测试报告与需求状态已更新。
- **人工值守 HW-011～014（编排骨架 + audit 全链路 + Bridge 代发）**：
  - `human-watch-orchestrator.ts`：订阅 `session.transcript.updated` + 60s 活跃 binding 轮询；规则评估 → 指纹/静默期/限流 → `session_continue` 代发。
  - 全事件留痕：`rule_evaluated`、`intervention_attempt`、`intervention_completed`、`intervention_skipped`（`fingerprint_duplicate` / `grace_after_prompt` / `rate_limited` / `suggest_only`）。
  - `human-watch-audit` 扩展：`hasSuccessfulInterventionFingerprint`、`getLastInterventionCompletedAt`、`countSuccessfulInterventionsSince`。
  - `human-watch-bindings` 扩展：`listEnabledBindingsForWorkerSession`、`listAllEnabledHumanWatchBindings`。
  - `human-watch-transcript.ts`：transcript → 规则输入行。
  - `scheduler` 在 `centralMode` 下 `initHumanWatchOrchestrator()`；单测 3 条通过。
- **人工值守 HW-009/010/015 部分（中心 UI + 规则引擎 + 干预 Tab）**：
  - **HW-009**：`HumanWatchPanel`（侧栏「人工值守」、创建值守、bindings）；舰队卡片「值守」徽标；编排栏排除值守 Agent；聊天会话列表隐藏判官 `session_key`。
  - **HW-015**：智能体详情「干预记录」Tab（`human-watch-interventions-tab.tsx`）；`GET /api/human-watch/interventions` 支持 `steward_local_agent_id`。
  - **HW-010**：`human-watch-rules.ts`（L1–L3 浅规则 + 指纹）+ 单测 2 条。
  - 双端 i18n `humanWatch` / `agentSquadPhase3.humanWatchBadge`；`mission-control-client` 同步 `human-watch-helpers`、会话过滤、编排排除。
- **人工值守 HW-005～008（租户开关 + Bridge 创建值守 + bindings API）**：
  - **HW-005**：migration `061_human_watch_tenant_flag`（`tenants.human_watch_enabled`）；`human-watch-policy.ts`（租户开关 + `MC_HUMAN_WATCH_ENABLED` 环境变量兜底）；`GET/PATCH /api/human-watch/policy`。
  - **HW-006**：边缘 `human-watch-steward.ts` + Bridge `steward_create_request`/`steward_create_response`（`mission-control-client/src/lib/remote-server-bridge.ts`）。
  - **HW-007**：中心 `requestBridgeClientStewardCreate`（`bridge-server.ts`）+ `POST /api/human-watch/stewards`（经 Bridge 在边缘创建 `agent_kind=human_watch` 并 provision）。
  - **HW-008**：`human-watch-bindings.ts` + `GET/POST /api/human-watch/bindings`、`GET/PATCH /api/human-watch/bindings/[id]`（同 `client_id`、framework 一致、禁止共用 `session_key` 校验）。
  - 单测：`human-watch-policy` 3 条、`human-watch-bindings` 2 条、`human-watch-steward` 2 条（与既有 audit 5 条合计通过）。
- **人工值守 干预留痕实现（HW-002～004）**：`mission-control` migration `060_human_watch`（`human_watch_bindings` + `human_watch_interventions`）；`human-watch-audit.ts`（log/list/幂等）；`GET /api/human-watch/interventions`；单测 5 条通过。
- **人工值守 干预留痕（PRD V1.3 + 任务拆解）**：FR-008 强化为 Phase 1 必做；`human_watch_interventions` 表与 API/UI；新增 `框架设计-人工值守.md`、`任务拆解-人工值守.md`、`测试用例-人工值守.md`（HW-TC-A01～A06）。
- **人工值守 PRD V1.2**：控制面/执行面分离；中心高级服务+选 client 经 Bridge 在边缘创建值守；`human_watch_bindings` 中心监视绑定；中心编排；上下文窗口默认值；API 代发（模拟 user）。见 `文档/01-PRD/PRD-人工值守.md`。
- **人工值守 PRD V1.1**：值守 Agent 可选 Claude/Codex 运行时，智能体列表归对应类型分组 +「值守」徽标；Worker 绑定须 framework 一致。见 `文档/01-PRD/PRD-人工值守.md`。
- **人工值守 PRD**：新增 `文档/01-PRD/PRD-人工值守.md`（V1.0 草案）、`文档/07-状态跟踪/需求状态-人工值守.md`；专用值守 Agent + Worker 绑定 + 值守 Tab 规则配置；架构/测试用例待 PRD 评审后编写。
- **服务端镜像推送 ACR（聊天首条回复后隐藏状态 + 远程结束检测）**：buildx 推送 **`1sheng/agentcenter:2.0.1`** / **`:latest`**（**linux/amd64**），manifest **`sha256:8bc2231d5f34be5fe1ddc3860dd3fc81793f8237c72737722a601593a5879b85`**。生产：`docker compose pull && docker compose up -d --force-recreate`。
- **本地客户端重启**：释放 5001 端口后在 `mission-control-client` 执行 `pnpm dev`；`http://127.0.0.1:5001` Ready，`GET /api/init` 200。
- **聊天回复状态：首条可见后隐藏 + 远程会话结束检测**：
  - 首条 assistant 正文出现后不再显示「下一条回复生成中」（`resolveReplyProgressUi` → `hidden`）。
  - 所有会话类型在 transcript 显示完整回复且无进行中 tool 时结束 `backgroundPromptBusy`（`isReplyCycleComplete`）；远程/中心服额外识别 `bridge_continue`。
  - 等待回复期间 transcript 轮询带 `forceFresh`（`nocache=1`）；远程会话（`nodeId`）在 SSE 已连接时仍保留 5s 兜底轮询。
  - 同步 **mission-control** / **mission-control-client** 与单测。
- **服务端镜像推送 ACR（聊天回复状态 + 构建修复）**：
  - 构建前修复 `chat-workspace.tsx`：`applyPendingPromptFromRealtime` 对 `detail` 做空值收窄；`promptMatchVariants` 正则去掉 `s` 标志（改用 `[\s\S]`），满足生产 TS 目标。
  - buildx 推送 **`1sheng/agentcenter:2.0.1`** / **`:latest`**（**linux/amd64**），manifest **`sha256:790f9bae6c989cf18cd196b826b13be31311225cee2529623625f73549ebf377`**。生产：`docker compose pull && docker compose up -d --force-recreate`。
- **聊天窗口回复状态（与人工值守无关）**：
  - 修复「已有 assistant 正文但仍在底部显示正在思考」：改为扫描 baseline 之后**任意** assistant 文本，不再只看最后一条消息。
  - 分两档 UI：**等待首条回复** / **已有回复后续跑**，统一用 `SessionReplyStatusRow` 排在消息流中（与 assistant 回复同一行样式 ◆），不再使用独立横幅条。
  - 一问多答：状态行始终在**最后一条消息下方**（下一条回复位置）；本地会话仅在 `prompt_completed` 后结束，避免第一段文字出现后状态过早消失；续写文案 `assistantNextReplyProgress`。
  - 结束 `backgroundPromptBusy`：在 `prompt_completed` 之外，当本轮已有可见回复且无未完成 tool 时也可结束（`isReplyCycleComplete`）。
  - 新增 i18n `assistantContinuingProgress` / `assistantContinuingToolProgress`；单测 `session-thinking-progress.test.ts`；同步 **mission-control** 与 **mission-control-client**。
- **服务端镜像推送 ACR（品牌主色青 + 近期服务端改动）**：buildx 推送 **`1sheng/agentcenter:2.0.1`** / **`:latest`**（**linux/amd64**），manifest **`sha256:0073171f1d1201bfc85145ccd62d08462c19f35e2663ad260881221d9a96cdf1`**。生产：`docker compose pull && docker compose up -d --force-recreate`。
- **品牌主色：红 → 青（与「实时」一致）**：
  - `--primary` / `--ring` 由 Technical Red 改为与 `--void-cyan` 同色（浅色 `190 80% 45%`，深色 `190 80% 65%`），避免主按钮/焦点环被误解为错误态。
  - 错误/危险仍用 `--destructive` 与 `--void-crimson`（红）；顶栏 SSE「事件 · 实时」徽标改用 `void-cyan` 与设计令牌一致。
  - 同步 **mission-control**、**mission-control-client** 的 `globals.css` 与双端 `header-bar.tsx` `SseBadge`。
- **服务端镜像推送 ACR（会话绑定 Bridge 同步 + 思考进展条）**：buildx 推送 **`1sheng/agentcenter:2.0.1`** / **`:latest`**（**linux/amd64**），manifest **`sha256:fd1631d92e128da6676d0b5e8e1bf8437c79fdf8615768058d2179b98975fe0a`**。构建前修复 `bridge-server.ts` `requestBridgeClientAgentsBySession` 的 TypeScript Promise 类型。生产：`docker compose pull && docker compose up -d --force-recreate`。
- **中心服会话绑定同步修复（Bridge 查边缘 DB）**：
  - 根因：生产站 `GET /api/agents/by-session` 只查中心 SQLite；`session_key` 绑定在 Mac 边缘库，Bridge 索引不含 `session_key`，故显示「没有智能体绑定」但 transcript 正常。
  - 新增 Bridge RPC：`agents_by_session_request/response`、`agent_session_update_request/response`；边缘 client 实现查询/更新本地绑定。
  - `by-session` 支持 `client_id`，Bridge 在线时以边缘库为准；SQL 同时匹配 `session_id` 与 `session_key`（如 `test`）。
  - 中心服 `PUT /api/agents` 绑定：对仅存在于 `sync_agent_index` 的智能体转发至边缘更新。
  - 聊天页 `reloadLinkedAgents` / 绑定请求携带 `session.nodeId`。
  - 涉及 `agents-by-session.ts`、`bridge-server.ts`、`remote-server-bridge.ts`、双端 `by-session/route.ts`、`chat-workspace.tsx`。
- **服务端镜像推送 ACR（聊天思考进展条 + 局部 transcript 刷新）**：buildx 推送 **`1sheng/agentcenter:2.0.1`** / **`:latest`**（**linux/amd64**），manifest **`sha256:05ca63b5cf1585d99a54a8a158ee7b5dc17378f2c327645d1c7c3dcdd7d409bb`**。生产：`docker compose pull && docker compose up -d --force-recreate`。
- **聊天「正在思考」进展条 + 局部刷新 transcript**：
  - 发送/继续会话后保持 `backgroundPromptBusy` 直至 assistant 文本落盘或 `prompt_completed`；底部独立 `ThinkingProgressBanner` 显示耗时，并按 transcript 推断阶段（思考 / 调用工具 `tool` / 生成回复）。
  - 等待期间秒数用本地 `setInterval` 更新，不再把占位 assistant 消息塞进列表。
  - 后台拉 transcript：若 `sourceMtimeMs` 与内容快照均未变则跳过 `setSessionTranscript`，避免整段消息列表无意义重渲染。
  - 新增 `session-thinking-progress.tsx`、i18n `assistantThinkingProgress` / `assistantToolProgress` / `assistantRespondingProgress`；同步 **mission-control** 与 **mission-control-client**。
- **编排栏「选择智能体」补全子智能体**：下拉不再要求 `parent_id` 为空；挂在 Main 下的子智能体（如 claude/codex 安全员）一并可选。`isSelectableOperativeAgent`。
- **智能体列表/下拉：隐藏 IDE Main + 远程按客户端分组**：新增 `isRuntimeMainAnchorAgent` / `isOperativeUserAgent`；智能体舰队、编排栏「选择智能体」下拉仅展示用户创建的智能体（名称无类型后缀）；中心服下拉用 `<optgroup>` 按边缘客户端分组并显示 `original_name`；挂靠在 Main 下的子智能体仍显示在舰队网格。同步 client/server。
- **本地客户端重启**：释放 5001 端口后于 `mission-control-client` 执行 `pnpm dev`；`http://127.0.0.1:5001` Ready，`GET /api/init` 返回 200。
- **服务端镜像推送 ACR（智能体下拉/隐藏 Main + 子智能体可选）**：buildx 推送 **`1sheng/agentcenter:2.0.1`** / **`:latest`**（**linux/amd64**），manifest **`sha256:d98326e206d0d662427cc73aff05fb4c9f6f52d42d9c43143bfc0a57b9e50dfd`**。生产：`docker compose pull && docker compose up -d --force-recreate`。
- **服务端镜像推送 ACR（智能体远程展示 + 聊天 UX）**：manifest **`sha256:a596824bccc5fd99f6d01051d49851f86374e92eb325c165faf55aee0cc2a445`**（已被上条取代）。构建前修复 `chat-workspace` 中 `setConversations` 类型错误。生产：`docker compose pull && docker compose up -d --force-recreate`。
- **中心服智能体列表（对齐本地展示 + 按客户端筛选）**：
  - 远程卡片显示边缘 `original_name`（如 Claude Code (Main)），不再展示 `mc-local-…` 远程别名；分组标题使用 CLAUDE/CODEX 等友好标签。
  - `centralMode` 下隐藏「添加智能体」及本地/配置同步按钮；`POST /api/agents` 返回 403。
  - 顶栏增加「节点」下拉：所有节点 / 按 `client_id` 筛选；「所有节点」视图按客户端分块后再按框架分组。
  - 来源徽标显示客户端名称或 `runtime`，替代 `bridge_index`。
  - 涉及 `agent-squad-panel-phase3.tsx`、`agent-card-helpers.ts`、`agents/route.ts`、i18n。
- **聊天 UX：unknown 模型名 / 记住「加载更早」/ 默认滚到底**：
  - **unknown**：Codex JSONL 常用 `model_provider`+`model_id` 而非 `model`；`codex-sessions.ts` 增加 `resolveCodexModelFromPayload` / `normalizeCodexDisplayModel`；`sync-sessions` 不再写入字面量 `unknown`；列表与详情栏对 `unknown` 回退为运行时标签（Claude/Codex）。
  - **加载更早记住**：`chat.session_prefs` 增加 `historyExpanded`；用户点击「加载更早」后 PATCH 持久化；再次打开同会话自动链式拉取历史页直至无更多。
  - **默认滚到底**：修复新消息到达后误将 `stickToBottom` 置 `false`；仅用户上滚离开底部时取消跟随；滚回底部恢复跟随；历史全部加载完成后再次定位到底部。
  - 同步 **mission-control** 与 **mission-control-client**。
- **服务端镜像推送 ACR（聊天 transcript client_id + 智能体混合同步）**：buildx 推送 **`1sheng/agentcenter:2.0.1`** / **`:latest`**（**linux/amd64**），manifest **`sha256:f8df8553369672a3d5f8fdb305a2ed0cbf2e64cba059dca6c27e53b48b53af54`**。生产：`docker compose pull && docker compose up -d --force-recreate`。
- **中心服聊天无 transcript（Codex/Claude 边缘会话）**：`chat-workspace` 拉取 `/api/sessions/transcript` 未带 `client_id`，中心服误读本机空 JSONL 而显示「此会话暂无转录片段」。已补 `nodeId` → `client_id` 查询参数（client/server）。需边缘 Bridge 在线；生产中心服需重新部署镜像后生效。
- **智能体一致性强优先（方案 1）**：Bridge 推送索引后 `reconcileClientAgentInventory` 清理陈旧 `source=client` 镜像；列表合并时若 `bridge_online` 则用 `bridge_index` 覆盖同 key 的 HTTP 镜像，离线则仍用 client 镜像、无镜像时才展示索引缓存。
- **智能体混合同步（Bridge 索引 + 按需详情）**：中心服新增 `sync_agent_index` 表与 `sync-agent-index.ts`；Bridge `hello`/`agent_status` 写入轻量索引并全量对账删除；`agent_detail_request/response` 按需拉边缘详情；`GET /api/agents` 在 `centralMode` 合并 `bridge_index` 行；`GET /api/agents/[id]` 对索引 ID 在线走 Bridge、离线返回缓存摘要；client 在 Bridge 已连接时跳过 HTTP `register` 循环（仍保留 heartbeat `agent_inventory`）。单测：`sync-agent-index-bridge.test.ts`。
- **服务端镜像推送 ACR（方案 A 智能体对账 + 页脚移除等）**：buildx 推送 **`1sheng/agentcenter:2.0.1`** / **`:latest`**（**linux/amd64**），manifest **`sha256:34f23534323133e218f541d95b49128c6a5f97ad8e490704546e79f0b35c647c`**。生产：`docker compose pull && docker compose up -d --force-recreate`。
- **方案 A：heartbeat 智能体全量对账（网盘式删除）**：`mission-control-client` 的 `gateway-sync` 在 `POST /api/server-sync/heartbeat` 请求体增加 `agent_inventory`（`original_name`、status、role、framework）；`mission-control` 新增 `sync-agent-inventory.ts`，在 `full` 模式下按 `source=client` + `node_id` 删除清单外镜像，匹配 `config.original_name` 或注册用远端 `name`；`centralMode` 时仍返回 `clients-only` 且不对账。单测：`sync-agent-inventory.test.ts`。

## 2026-05-17

- **移除 nyk 页脚推广文案**：删除 `mission-control` 主布局底部「用心构建，来自 nyk」footer；删除未使用的 `promo-banner.tsx`（client/server）。
- **同步 mission-control（服务端）聊天与智能体详情**：从 mission-control-client 同步 `local-session-executor`（异步入队 + pendingPrompt/agentId）、`session-realtime-events`、`session-realtime`、`agents/message`、`chat-workspace`、`agent-session-binding`、`by-session`、`sessions-list-cache`；服务端 `agent-detail-tabs` / `orchestration-bar` 增加 `dispatchSessionPendingPrompt`；`sessions/continue` 本地路径改异步入队（保留 Bridge）；补 i18n `messageAccepted`/`messageSending`/`continueSending`。
- **Codex/Cursor/OpenCode 发消息聊天乐观更新**：`sessionSourceFromKind` 原先不支持 cursor/opencode，服务端 `notifySessionTranscriptUpdated` 直接 return；无 `session_key` 时不发 `prompt_queued`。现扩展 realtime 类型、入队带 `agentId`、聊天按绑定智能体匹配；Codex 用户行去掉 `Message from` 前缀也能对齐 transcript；Codex 执行后刷新会话索引。涉及 `session-realtime-events.ts`、`local-session-executor.ts`、`chat-workspace.tsx`、`agents/message/route.ts`、概览/编排栏。
- **智能体发消息后聊天即时显示**：根因是消息异步入队 CLI，用户行要等 JSONL 落盘才出现在 transcript；从智能体概览/编排栏发送时聊天页也无乐观更新。修复：`prompt_queued` SSE/窗口事件携带 `pendingPrompt`；`SessionConversationView` 监听并展示待发送用户行 +「正在思考」+ 2s 轮询；API 返回 `queued_prompt`/`session_kind`，概览与编排栏成功后 `dispatchSessionPendingPrompt` 即时刷新已打开的会话。涉及 `session-realtime-events.ts`、`session-realtime.ts`、`local-session-executor.ts`、`agents/message/route.ts`、`chat-workspace.tsx`、`agent-detail-tabs.tsx`、`orchestration-bar.tsx`。
- **会话绑定类型校验**：Claude 智能体只能绑定 Claude 会话，Codex 只能绑定 Codex（`agent-session-binding.ts` + `PUT /api/agents` + 聊天绑定下拉过滤）；混绑返回 409 `session_kind_mismatch`。
- **会话绑定查询与自动关联**：`GET /api/agents/by-session` 按会话 UUID 匹配 `session_key` 与 `primary_session_key`（不再误用 project slug）；聊天打开未绑定会话时，若仅有一个同工作空间且无会话的智能体则自动绑定；`PUT` 绑定时写入 `mc_bound_agent_id`；持久化绑定后广播 `agent.updated`。
- **创建智能体后自动建会话**：`POST /api/agents` 成功后对本地运行时智能体后台调用 `enqueueProvisionAgentDedicatedSession`（bootstrap 专用 CLI 会话并绑定）；默认 `session_mode: dedicated`；概览轮询直至 `session_key` 就绪；`manual` 模式仍保留「创建会话」按钮。首条发消息不再等待完整建会话。
- **Claude 新建智能体会话未出现在聊天列表**：首次发消息时 CLI 进程异常退出（`code: null`）但 JSONL 已落盘，导致 `session_key` 未写入、智能体状态 `broken`。修复：`recoverClaudeSessionStart` 从磁盘 JSONL 恢复会话绑定；`runCommand` 默认 `stdin: ignore` 避免 Claude 等待 stdin；建会话/续聊后 `syncClaudeSessions` 刷新聊天列表缓存。已将 agent 37 绑定到 `36103471-dc31-4835-8f24-1e8bbd6e9fbe`。
- **Claude 智能体发消息会话不起（测试专家）**：根因是 `claude --resume` 必须在创建会话时的项目 cwd 下执行，而智能体 `workspace_path`（如 `/Users/kuangxb/Desktop/test`）与 bootstrap 时实际 cwd（如 `mission-control-client`）不一致导致 resume 失败。修复：`findClaudeSessionProjectPath` 从 JSONL 解析真实 cwd；`resolveLocalExecutionWorkingDirectory` 优先使用该路径；绑定会话时持久化 `mc_session_project_path`；`no conversation found` 视为可恢复错误以便自动重建会话。
- **聊天页切换与会话列表分页**：左侧点「聊天」即时切换（`ChatPagePanel`/`ChatWorkspace` 动态加载 + 骨架屏）；`/api/sessions` 支持 `limit`/`offset`/`skip_sync`，首屏默认 40 条；会话列表「加载更多」+ 加载中骨架；首次列表请求跳过 Claude 全量 sync 以加快首屏。
- **新建智能体 openclaw_id 校验修复**：中文显示名/智能体 ID 自动规范为 kebab-case 或生成 `agent-xxxx` 后备 ID，避免 `openclaw_id must be kebab-case` 导致创建失败。涉及 `validation.ts`、`agent-detail-tabs.tsx`、`api/agents/route.ts`。
- **删除智能体不再拖垮服务**：删除时 `releaseAgentExecutionQueues` 释放 CLI 执行队列，避免后续请求卡在已删智能体的 Codex 任务后；后台任务检测智能体已删则静默退出；删除菜单 UI 改为单一「删除中」提示并防重复点击。
- **首次建会话加速**：合并角色 bootstrap 与用户首条消息为**单次** Codex/Claude CLI 调用（不再先 `READY` 再发用户话），首次等待时间约减半。
- **本地智能体消息异步投递**：`POST /api/agents/message`、`POST /api/sessions/continue`、聊天转发与 Bridge continue 改为后台队列执行 CLI，HTTP 在「已接受投递」后立即返回；回复与进度在聊天 transcript 中通过轮询/SSE 更新。新增 `enqueueBoundLocalAgentPrompt`、`enqueueLocalSessionPrompt`；同步 `executeBoundLocalAgentPrompt` 仍供任务派发等使用。
- **发消息操作流畅性**：智能体概览「消息」区增加发送中锁定（防重复点击/Enter）、禁用输入、耗时秒数与首次建会话提示；编排栏命令发送同样防重复；聊天页继续会话输入发送中禁用并显示「发送中 (Ns)」。i18n：`messageSending`、`messageProvisioning`、`messageProvisionHint`、`continueSending`、`orchestration.sending`。涉及 `agent-detail-tabs.tsx`、`orchestration-bar.tsx`、`chat-workspace.tsx`。
- **智能体发消息失败修复**：Codex `exec` 在 stderr 含 rollout 噪声但 stdout 已返回 `thread.started` 时不再误判失败；概览发消息后即时更新 `session_key`；聊天会话绑定默认收起；首次会话成功后自动绑定智能体（单候选时）。
- **智能体概览保存后即时刷新**：保存成功后用 API 返回数据更新 `agentState` 并重新拉取详情；`fetchAgents(true)` 强制刷新列表；同步 `selectedAgent`。
- **智能体详情概览展示工作空间**：概览 Tab 在「会话键」上方显示 `workspace_path`；编辑时可从已注册工作空间选择或自定义路径；`PUT /api/agents` 支持更新 `workspace_path`。
- **修复新建智能体配置步 React 报错**：工作空间加载逻辑改为独立 `useEffect`，避免在 `setFormData` 回调内调用 `setState` 导致页面崩溃。
- **新建智能体配置：工作空间选择**：创建向导第 3 步「配置」增加工作空间下拉（读取 `/api/workspaces`）与自定义路径；`POST /api/agents` 持久化 `workspace_path`。
- **工作空间自动建目录**：保存工作空间时若路径不存在且勾选「若目录不存在则自动创建」，服务端 `mkdir -p` 创建目录；禁止文件系统根路径；路径已存在但非目录时报错。默认勾选。
- **编排栏「工作空间」Tab**：在「工作流」之前新增 **工作空间** 标签页，可注册/编辑/删除本地目录路径（名称、绝对路径、默认标记）；数据存 `settings.general.agent_workspaces`；`GET/POST/PUT/DELETE /api/workspaces`；列表展示关联智能体数量。涉及 `workspace-tab.tsx`、`agent-workspaces.ts`、`orchestration-bar.tsx`、中英文 i18n。同步 **mission-control** 与 **mission-control-client**。
- **会话 ID 查看/编辑 + 智能体详情中文**：聊天页 Codex/Claude 会话展开「会话绑定」可查看/复制会话 ID、解除或保存智能体 `session_key` 绑定；无绑定时可从下拉选择智能体绑定当前会话。新增 `GET /api/agents/by-session`。智能体详情弹窗标签/删除/状态等改中文；概览「会话键」支持清空绑定与说明文案。同步 mission-control。
- **i18n（弹窗/文档操作菜单）**：修复 `messages/en.json` / `zh.json` 中重复的 `agentDetail` 键（后者覆盖前者导致智能体详情弹窗显示 `agentDetail.xxx` 原始参数）；补全 `agentDetail` 中文约 100+ 项；新增 `documents` / `documents.operations`（文档检查、抽取原子知识、智能整理、知识问答等）；补全 `documents`、`agentHistory`、`pipeline`、`debug`、`taskBoard` 的 zh 键；`documents-panel.tsx` 增加「操作」下拉菜单与结果弹窗。同步 **mission-control** 与 **mission-control-client**。
- **mission-control-client（智能体会话绑定防串线）**：`local-session-executor.ts` 发消息前校验 `session_key`（是否被其他智能体占用、cwd 是否与 `workspace_path` 一致）；Codex 自动建会话时排除已占用 ID、移除宽松回退；绑定写入 `mc_bound_agent_id`；新建向导说明「留空则首次发送时自动分配」。
- **服务端镜像推送 ACR（移除侧栏推广链接）**：buildx 推送 **`1sheng/agentcenter:2.0.1`** / **`:latest`**，manifest **`sha256:f0663cca7415af738549689ef89b72ef721c9a44432c002d56bc3b5ab0ac594b`**（linux/amd64）。生产：`docker compose pull && docker compose up -d --force-recreate`。
- **服务端侧栏**：移除 xint / builderz 外部推广链接卡片（`nav-rail.tsx`）。
- **服务端镜像推送 ACR（SSO 单组织租户）**：buildx 推送 **`1sheng/agentcenter:2.0.1`** / **`:latest`**，manifest **`sha256:7b8bc14928f30f3e849e70d8547c964c340f5ed7587c5aa034d73c6223a9f5b3`**（linux/amd64）。生产：`docker compose pull && docker compose up -d --force-recreate`。
- **SSO 单组织租户（mission-control）**：
  - 新增 `tenant-auth-scope.ts`：IdP（Zitadel/Google）用户永不走平台多租户；`canManageAllTenants` 仅本地 admin 且 `MC_PLATFORM_MULTI_TENANT_UI=1` 时启用。
  - `nav-rail.tsx`：IdP 用户侧栏只展示 `/api/auth/me` 返回的 `organization`（单位名）及下属项目，不再 `fetchTenants()` 列出全部租户；移除「+ 新建组织」入口。
  - `auth/callback`：登录时若用户中心无租户且 `MC_AUTO_PROVISION_ORG_ON_LOGIN`（默认开）则自动 `createUsercenterTenant`；未配用户中心时 `ensureOrganizationBindingForUser` 按单位名本地建租户并绑定工作区；已有租户则 `syncExistingUserWithUsercenterPortal` 对齐展示名与同租户数据。
- **服务端镜像推送 ACR（侧栏版本号布局）**：提交 **`5fc0fa6`** 后 buildx 推送 **`1sheng/agentcenter:2.0.1`** / **`:latest`**，manifest **`sha256:8cfca7f7445de3fc6559b62e758e9cd98f391b44cc162003260b29295694656c`**（linux/amd64）。已 **`git push origin main`**。
- **侧栏底部布局（客户端/服务端一致）**：移除底部单独版本号空白区；版本号移至顶部 Logo 名称下方；收紧 ContextSwitcher 底部内边距。
- **服务端镜像推送 ACR（transcript 分页 + 移动底栏顺序）**：提交 **`6ca1867`** 后 buildx 推送 **`1sheng/agentcenter:2.0.1`** / **`:latest`**，manifest **`sha256:d75b02cf892a515c6e3f6d465e85cd399f8c74dee7c0788ff09baa7b049cafe6`**（linux/amd64）。已 **`git push origin main`**。生产：`docker compose pull && docker compose up -d --force-recreate`。
- **移动端底栏菜单顺序与 Web 侧栏一致**：`nav-rail.tsx` 底栏按侧栏分组顺序收集 Tab（`collectMobileBarItems`），不再用扁平列表 `filter(priority)`；精简模式下 `essential` 项也按侧栏顺序显示（如聊天在任务与活动之间）。中心服 `chat` 设为 `priority: true`。
- **Codex transcript 完整分页（非头尾拼接）**：`session-transcript.ts` 按字节块或消息索引分页读取 JSONL（`before` 游标）；API 返回 `hasMoreOlder` / `nextOlderCursor` / `sourceMtimeMs`；聊天页顶部「加载更早消息」；活跃会话轮询 5s；Bridge 远程 transcript 透传分页字段。Codex 会话展示同步说明（网页读 `~/.codex/sessions`，可能略滞后于 TUI）。
- **聊天 transcript 与终端不一致**：超大 Codex JSONL 原「头+尾」拼接会混入旧内容；改为只读文件尾部（最近约 6MB）。切换会话/手动刷新带 `nocache=1`；Codex 会话 transcript 条数上限提至 80。
- **mission-control-client（顶部网关状态）**：中心服 Bridge 连接状态并入顶栏「客户端模式」徽章（动态绿/黄/红灯 + 中心服已连接等文案），悬停详情、点击重连；完全移除左下角 `GatewayStatusFloater` 及 `fixed bottom` 占位；主内容区 `min-h-full` 改为 `min-h-0` 避免底部留白。逻辑抽至 `use-bridge-status.ts`。
- **mission-control-client 本地启动**：执行 `pnpm dev`，服务就绪 **http://127.0.0.1:5001**（Next.js 16.1.6，加载 `.env.local`）。

## 2026-05-16

- **服务端镜像推送 ACR（聊天乐观发送 + 静默刷新）**：提交 **`c002f2a`** 后 buildx 推送 **`1sheng/agentcenter:2.0.1`** / **`:latest`**，manifest **`sha256:0cd0cbb1db551cd0cb88d6a903da11f8efa29c4ed474542bcf0894ac8051b424`**（linux/amd64）。已 **`git push origin main`**。生产：`docker compose pull && docker compose up -d --force-recreate`。
- **聊天 UX（后台静默刷新 transcript）**：发送后轮询改为 `background` 模式，不再清缓存、不触发 `loading` 骨架屏；历史消息保持可见，仅「正在思考…」行脉冲更新，真实回复到达后原位替换。
- **聊天 UX（乐观发送 + 去重复回复）**：`mission-control-client` / `mission-control` 的 `SessionConversationView` 移除输入框下方 `lastReply` 重复展示；点击发送后立即在 transcript 显示用户消息，并显示「正在思考…」占位；执行期间每 2s 轮询刷新 transcript，完成后由真实转录替换。i18n 新增 `chat.assistantThinking`。
- **服务端镜像推送 ACR（打开会话默认滚到底）**：提交 **`783d835`** 后推送 **`1sheng/agentcenter:2.0.1`** / **`:latest`**，manifest **`sha256:a699918533e9442fad9f3ca69804bdb030961f0879b35c550ad5e913635b3d95`**（linux/amd64）。
- **服务端镜像推送 ACR（含加载性能 + 聊天 UX）**：提交 **`bcb051e`** 后 buildx 推送 **`1sheng/agentcenter:2.0.1`** / **`:latest`**，manifest **`sha256:d6269a24aed65b6c6f5a854bd8847ca82ff7f26f479a57504e52f7bdb317a227`**（本次为 **linux/amd64** 单架构；arm64 构建 OOM 未纳入）。已 **`git push origin main`**。生产：`docker compose pull && docker compose up -d --force-recreate`。
- **服务端镜像推送 ACR（含 transcript SSE / working_dir）**：提交 **`4447c67`** 后 buildx 推送 **`1sheng/agentcenter:2.0.1`** / **`:latest`**，manifest **`sha256:d7c79c97af0a2a63f96af10e1da6a4ca81566e364e9d2b6137fcb5f0522ba929`**（amd64+arm64）；已 **`git push origin main`**。生产 1Panel：`docker compose pull && docker compose up -d --force-recreate`。
- **聊天 UX**：点击进入会话默认滚到 transcript 最底部（`useLayoutEffect` + `stickToBottom`）；上翻历史后后台刷新不再抢滚动。
- **聊天 UX**：transcript 仅在选中会话时加载，前端内存缓存切换秒开；会话列表 `requestIdleCallback` 懒加载；修复轮询刷新时强制滚底——仅在接近底部时自动滚动，上翻历史时显示「新消息」按钮。
- **聊天性能**：切换会话时立即清空 transcript 并显示骨架屏；Codex transcript 改为按 sessionId 定位单个 JSONL（不再扫描 300 个文件）；Claude 先路径/片段匹配再读；`/api/sessions` Codex 扫描 5s 缓存；transcript API 4s 缓存。
- **mission-control-client 本地重启**：停止占用 **5001** 的旧进程后执行 `pnpm dev`，服务已就绪 **http://127.0.0.1:5001**（Next.js 16.1.6，加载 `.env.local` 含 `MC_REMOTE_SERVER_URL`）。
- **客户端/服务端发消息优化（续）**：Mac 执行 continue 后经 Bridge 发送 **`session_transcript_changed`**，中心服 **`notifySessionTranscriptUpdated`** 推 SSE → 浏览器即时刷新 transcript（保留 10s 兜底轮询）；生产模式下无 **`nodeId`** 的 CLI 会话在列表标「无边缘节点」并禁用发送框。
- **客户端/服务端发消息优化**：Bridge `session_continue` 透传 **`working_dir`**（中心服 continue API → Bridge → Mac `executeLocalSessionPrompt` 的 `cwd`）；聊天页远程会话展示工作目录提示、Bridge 离线/`client_id` 缺失的明确错误、发送后延迟刷新 transcript；**mission-control-client** 本地 continue API 与聊天页同步上述逻辑。
- **会话继续 `spawn codex ENOENT`**：`/api/sessions/continue` 在**生产中心服**（`centralMode`）返回 **503** 提示改在 **http://127.0.0.1:5001** 发送；**mission-control-client** 的 `local-session-executor` 增加 **`MC_CODEX_BIN`**、Homebrew PATH 与更明确的 ENOENT 错误文案。
- **mission-control（i18n）**：`messages/zh.json` 的 `agentDetail` 补全 **`send`** 等键，修复控制台 `MISSING_MESSAGE: agentDetail.send (zh)`。
- **端口约定**：**mission-control-client** 本机 dev 改为 **5001**（`package.json`）；**mission-control** Bridge 恢复 **5002**（`scheduler.ts`、`bridge/info/route.ts`）；**deploy/.env.1panel.example** 反代与映射改为 **5002**。本机访问客户端：**http://127.0.0.1:5001**。
- **GitHub**：提交 **`399c922`** 并推送 **`origin/main`**（Bridge continue、部署文档、客户端 5001 等）；Codex 会话因沙箱仅可写 `mission-control-client` 无法在仓库根 `git push`。
- **服务端镜像推送 ACR**：本地 buildx 推送 **`1sheng/agentcenter:2.0.1`** / **`:latest`**，manifest **`sha256:a8a99ed52eca877a2d55c7396eb44d2e0871e94a4e4cba80b34e597f28ff8a25`**（含 Bridge `session_continue`、transcript 503、zh `agentDetail.send` 等未提交本地改动）。
- **Bridge 远程发送消息**：中心服 `POST /api/sessions/continue` 在带 **`client_id`** 或 **centralMode** 时经 Bridge 下发 **`session_continue_request`**；边缘 **mission-control-client** 本机执行 `executeLocalSessionPrompt` 并 **`session_continue_response`** 回传；聊天页 continue 请求附带 **`session.nodeId`**。需部署新服务端镜像并重启 Mac 客户端。
- **Bridge 已打通（用户确认）**：Nginx **`/bridge-ws` → `127.0.0.1:5002`** 生效，生产聊天页已能拉取本地会话 **transcript**；Mac 代理客户端需保持运行且 Bridge 已连接。
- **Bridge 排错（agent.1sheng.work）**：生产 `/api/bridge/info` 仍返回 **`wss://…:5002`**（旧镜像），与 Nginx **`/bridge-ws`→5003** 不一致；Mac 客户端连 `:5002` 失败。`curl` 测 **`/bridge-ws` 为 502** → 宿主机 **5003 未监听或未映射**。客户端 `.env.local` 增加 **`MC_REMOTE_SERVER_URL=wss://agent.1sheng.work/bridge-ws`**（502 修复后生效）。生产需 **`MC_BRIDGE_PUBLIC_WS_URL`** + compose **`127.0.0.1:5003:5003`** + 重启容器。
- **生产聊天页 Failed to fetch transcript（agent.1sheng.work）**：会话列表来自 HTTP 同步，但 **`GET /api/sessions/transcript`** 在中心模式下需经 **Bridge WebSocket** 向边缘 Mac 拉取本地 JSONL；边缘未连 Bridge 时原返回 500。服务端改为 **503 + `bridge_offline`** 明确提示；**`bridge/info`** 支持 **`MC_BRIDGE_PUBLIC_WS_URL`**（反代 `wss://…/bridge-ws`）。客户端 **`remote-server-bridge`** 在未设 `MC_REMOTE_SERVER_URL` 时自动使用设置里的 **`gateway.server_url` + `gateway.token`** 建 Bridge。
- **mission-control-client（上游同步连不上 agent.1sheng.work）**：根因为 Node `fetch` 校验 HTTPS 失败（`self-signed certificate in certificate chain`），非服务网关地址填错；控制台 `POST /api/scheduler` 返回 500 是同步任务 `ok: false` 的正常表现。已在 **`mission-control-client/.env.local`** 增加 **`NODE_TLS_REJECT_UNAUTHORIZED=0`**（仅本地开发；生产应在反代配置有效证书后移除）。**`gateway-sync.ts`** 在 heartbeat 捕获 TLS 错误时返回明确中文提示，避免仅显示「7 register failure(s)」。

## 2026-05-14

- **mission-control**：新增 Zitadel OIDC 统一登录（参考 `/Users/kuangxb/Desktop/yisheng/1sheng-console` 的 PKCE 流程）。
  - 新增 `src/lib/oidc-zitadel.ts`（discovery、token、id_token 校验、登出 URL）。
  - 新增 `src/lib/oidc-flow-cookie.ts`（AUTH_SECRET 签名的短期 `mc_oidc_flow` Cookie）。
  - 新增路由：`GET /api/auth/sso`、`GET /api/auth/zitadel`、`GET /api/auth/callback`；登出时清除 `mc_oidc_id_token` 并可返回 IdP `end_session` URL。
  - 登录页在服务端已配置 OIDC 时展示「统一账号登录」入口；文案见 `messages/en.json`、`messages/zh.json`。
  - 用户 `provider` 扩展为 `zitadel`；访问审批 `access-requests` 按请求的 `provider` 写回用户。
  - 环境变量说明见 `mission-control/.env.example`（**勿**将客户端密钥提交到仓库，使用本地 `.env`）。
- **mission-control（对齐 1sheng-console 前端习惯）**：
  - 新增 `src/lib/zitadel-sso-client.ts`：`buildZitadelStartLoginUrl`（`return_to` + `login_hint`，与 `useAdminSession.startHostedLogin` 一致）、`logoutThenFollowSsoRedirect`（消费登出响应中的 `redirectUrl`，与 `useAdminSession.logout` 一致）。
  - 登录页「统一账号登录」改为按钮跳转：从 URL 读取 `next` 作为登录后 `return_to`，读取 `login_hint` 传给 IdP。
- **控制台统一退出**：侧栏底部身份菜单（ContextSwitcher 弹出层）增加「退出登录」，调用 `logoutThenFollowSsoRedirect`；非 SSO 则清会话并跳转 `/login`。文案 `contextSwitcher.signOut` / `signingOut`。
- **mission-control（登录页与配置说明）**：
  - `src/app/login/page.tsx`：在已处于 `!needsSetup` 区块内去掉三元表达式中重复的 `!needsSetup &&`，避免 JSX 括号误读；`eslint` 校验通过。
  - `mission-control/.env.example`：补充 `MC_UNIFIED_LOGIN`（`sso_only` / 默认 `sso_primary`）及应急入口 `/login?local=1` 的说明。
- **mission-control（与先前约定 / 1sheng-console 对齐的环境变量）**：
  - 新增 `mission-control/.env.local.example`：`cp` 为 `.env.local` 后填写 `ZITADEL_*`；说明与 `1sheng-console` 变量名一致、MC 直连 IdP；含此前约定的 `ZITADEL_CLIENT_ID=372833575113850886` 占位与 `127.0.0.1:5000` 回调示例；**不写**客户端密钥。
  - `mission-control/.env.example`：Zitadel 段增加指向 `.env.local.example` 的说明。
- **mission-control（本机 Zitadel 凭据）**：在用户本机已 gitignore 的 `mission-control/.env.local` 中写入 `ZITADEL_ISSUER`（奕升默认 `https://sso.1sheng.work`）、`ZITADEL_CLIENT_ID`、`ZITADEL_CLIENT_SECRET` 及回调/登出 URI；**未**将密钥写入任何已跟踪文件。备注：当前 `.env.local` 仍为 `MC_DISABLE_AUTH=true`，若需走真实统一登录流程需改为 `false`；聊天中明文过的密钥建议在 Zitadel 控制台轮换。
- **mission-control（地址与 1sheng-console 对齐）**：在 `.env.local` 注释、`mission-control/.env.example` 与 `mission-control/.env.local.example` 中写明与 `1sheng-console` 一致的公开地址：`ZITADEL_ISSUER=https://sso.1sheng.work`、`USER_CENTER_API_URL=https://user.1sheng.work`（仅对照，MC 直连 IdP 不读此项），并注明 1sheng 本机回调 `localhost:3010`、生产 `einsight.1sheng.work` 与 MC 本机 `5000` 回调须与 Zitadel 登记及浏览器主机名一致。
- **mission-control（统一登录页 UI）**：已配置 Zitadel 时隐藏本地/Google 表单（仅 `?local=1` 应急显示）；登录页改为参考一生智视 SSO 卡片的暗色布局：圆形 Logo、`BUILD … · SSO ACTIVE`（`NEXT_PUBLIC_MC_BUILD_LABEL`）、安全认证中心文案、可选邮箱 `login_hint`、红色主按钮；品牌名改为 `OpenClaw 指挥舱` / `OpenClaw Mission Control`；可选 `NEXT_PUBLIC_SSO_REGISTER_URL` 显示「注册」；`messages/*` 增加对应键。
- **mission-control（品牌文案）**：登录页与页脚标语中的产品名由 OpenClaw 改为 **Agent**：`auth.missionControl` 为「Agent 指挥舱」/「Agent Mission Control」；`auth.orchestrationTagline` 各语言去掉 OpenClaw 前缀或改为中性「智能体编排」类表述。网关/诊断等仍保留 OpenClaw 专名字符串以对接实际组件。
- **mission-control（统一登录环境变量说明与排错）**：`.env.example` / `.env.local.example` 标明 OIDC 最小集合须含 `AUTH_SECRET`；`/api/auth/zitadel` 在 catch 中对缺少 `AUTH_SECRET`、discovery 网络失败等返回更明确的 `error` 文案便于对照配置。
- **mission-control（OIDC 就绪判断）**：`oidcIsConfigured()` 增加对 `AUTH_SECRET` 的校验，与发起登录时签名 Cookie 的要求一致，避免 `/api/auth/sso` 显示已就绪而 `/api/auth/zitadel` 仍 500。
- **mission-control（OIDC TLS / discovery）**：`sso.1sheng.work` 等环境存在自签证书链时 Node `fetch` 会 `fetch failed`；`oidc-zitadel` 在 `MC_OIDC_TLS_INSECURE=1` 时对 OIDC 相关 HTTPS 使用 `rejectUnauthorized: false` 的 `https.request`；`fetchJson` 包装错误链；`/api/auth/zitadel` 对证书类失败追加 `MC_OIDC_TLS_INSECURE` / `NODE_EXTRA_CA_CERTS` 说明；`.env.example` 与 `.env.local.example` 补充该变量。
- **mission-control（OIDC 限流）**：`/api/auth/zitadel` 与 `/api/auth/callback` 从与密码登录共用的 `loginLimiter`（5 次/分钟）改为独立的 `oidcFlowLimiter`（45 次/分钟、`critical: false`），避免联调 OIDC 时过快 429；`/api/auth/login` 与 Google 仍用原 `loginLimiter`。
- **mission-control（统一登录 UX）**：说明文案明确「红按钮先经本站 `/api/auth/zitadel` 再跳转 IdP 托管登录页」；`login_hint` 支持邮箱或用户名；表单 `onSubmit` + 回车触发；`window.location.assign`；占位与 `loginHintHelp` 多语言更新。
- **mission-control（统一登录页精简）**：SSO 卡片去掉 `loginHintHelp` 长说明、底部「应急本地」区与 `orchestrationTagline`；移除仅用于该区的 `emergencyLocalHref` 等状态；注册入口改为由 `/api/auth/sso` 返回的 `registerUrl` 驱动（见下条）。
- **mission-control（OIDC 主机名自动对齐）**：`/api/auth/sso` 增加 `oidcEntryOrigin`（来自 `ZITADEL_REDIRECT_URI`）；登录页在启用 Zitadel 且当前 `window.location.origin` 与其不一致时 `location.replace` 到同源（保留 path/query），`?stay_host=1` 可跳过；缓解 localhost / 127.0.0.1 混用导致 `oidc_invalid_state`。`.env.example`、`/api/index`、`sso-route.test.ts` 已更新。
- **mission-control（统一登录按钮发起入口修复）**：`buildZitadelStartLoginUrl()` 增加 `baseOrigin` 参数；登录页点击「统一账号登录」时优先使用 `/api/auth/sso` 返回的 `oidcEntryOrigin` 发起 `/api/auth/zitadel`，确保写入 `mc_oidc_flow` 的主机与 `ZITADEL_REDIRECT_URI` 回调主机一致。新增单测覆盖该行为；已验证 `/api/auth/zitadel` 返回 302 到 `sso.1sheng.work` 且 Set-Cookie 含 `mc_oidc_flow` / `SameSite=lax`；`tsc --noEmit` 通过。
- **mission-control（本地验证：OIDC 回调 + 注册 URL + 质量门）**：新增 `src/lib/zitadel-register-url.ts` 与单测；`sso/route` 引用之；新增 `callback.zitadel.test.ts`、`zitadel-route.cookie.test.ts`、`sso-route.test.ts`。修正 `csp.test.ts`；补全 `settings-panel.tsx` 的 `handleRotateKey` / `handleCopyKey` 及 `syncTask` 类型。**`pnpm test`、`pnpm typecheck`、`pnpm build` 已通过。**
- **mission-control（OIDC 回调「登录状态已过期」修复）**：根因多为 `mc_oidc_flow` 使用 `SameSite=Strict`，从 IdP 顶级导航回本站时浏览器不附带该 Cookie，导致 `/api/auth/callback` 判定 `oidc_invalid_state`。`getMcSessionCookieOptions` 支持可选 `sameSite`；`/api/auth/zitadel` 写 flow Cookie 与 `/api/auth/callback` 清除时均用 `lax`。回调分支增加 `console.warn` 便于对照日志。`messages/zh.json`、`en.json` 更新 `oidcLoginInvalidState` 文案；`.env.example` 注释说明；`session-cookie` 单测覆盖 `sameSite: 'lax'`。
- **mission-control（统一登录发起 UX）**：统一登录卡改为 **原生 GET 表单** 提交到 `action`（与 `ZITADEL_REDIRECT_URI` 同源的 `oidcEntryOrigin`），避免仅依赖 `preventDefault` + `location.assign` 时偶发无导航；`return_to` 用隐藏域并从 URL `next` 同步；导出 `sanitizeOidcReturnPath`。`/api/auth/zitadel` 在 OIDC 未就绪或发起异常时 **302 回 `/login?login_error=…`**（并尽量保留 `next`），不再返回裸 JSON 500；新增 `oidcNotConfigured` / `oidcStartFailed` 文案。`zitadel-sso-client` 单测补充；`pnpm test` 已通过。
- **mission-control（OIDC 与 1sheng-console 对照集成）**：在 `zitadel-sso-client.ts` 增加 `resolveOidcPostLoginReturnTo()`（优先 `next`、`return_to`，在 `/login` 且无参数时回 `/`，非登录路径则用 `pathname+search`，对齐 `1sheng-console/src/admin/useAdminSession.ts` 的 `startHostedLogin`）；扩充文件头对照路径（`oidcAuth.ts`、`cookies.ts`）。登录页 `return_to` 隐藏域改用该解析。`oidc-zitadel.ts`、`/api/auth/zitadel/route` 顶部注释标明与 `1sheng-console/server/oidc/hosted.ts` 及 `oidcAuth` 对齐；`.env.example` Zitadel 段补充仓库路径。新增 Vitest 覆盖 `resolveOidcPostLoginReturnTo`。登录页 SSO 表单 `action` 改为相对路径 **`/api/auth/zitadel`**（始终与当前文档同源）。此前在 `default-src 'self'` 且未声明 `form-action` 时，若 `action` 为绝对 URL 且主机与当前页不一致（如页在 `127.0.0.1` 而回调登记为 `localhost`），浏览器会按 CSP **拦截表单提交**，表现为点击「统一账号登录」无反应。主机未与 `oidcEntryOrigin` 对齐时禁用提交并提示「正在跳转统一登录…」，仍依赖既有 `location.replace` 对齐逻辑；`?stay_host=1` 时不禁用以便应急。
- **mission-control（用户中心租户门闸，对齐 1sheng-console）**：新增 `src/lib/usercenter-tenant-gateway.ts`，调用 `POST {USER_CENTER_API_URL}/api/internal/tenant-context`（可选 `USER_CENTER_INTERNAL_SECRET` → `X-Internal-Secret`）；`/api/auth/callback` 在换票成功后若已启用用户中心且 `hasTenant !== true`，则 **302** 到门户（`USER_CENTER_PORTAL_URL` 或 API 的 origin）+ `USER_CENTER_ONBOARDING_PATH`（默认 `/login`），查询参数含 `from=mission-control`、`onboarding=1`、`sub`、`login_hint`、`mc_origin`、`mc_return_to`、`uc_reason`；接口失败回 `login_error=tenant_gateway_failed`；无门户 URL 回 `tenant_onboarding_no_portal`。未配置 `USER_CENTER_API_URL` 时行为与旧版一致（仅本地 `users` 审批）。`.env.example`、`.env.local.example`、`/api/index`、`messages`、`login/page.tsx`、`callback.zitadel.test.ts` mock、`usercenter-tenant-gateway.test.ts` 已更新。
- **mission-control-client（不在客户端提供登录/注册）**：Next 16 以 `src/proxy.ts` 为网络中间件入口（`export default proxy`，勿再建 `middleware.ts`）；`/login` 重定向为 `new URL('/', request.url)` 或 `NEXT_PUBLIC_MC_AUTH_LOGIN_URL`；`login/page.tsx` 改为服务端 `redirect('/')`；`setup` 完成后跳转 `/`；`.env.example` 说明；`README` 鉴权章节说明；更新 `deploy-standalone.sh`、`install.sh`、`install.ps1`、`station-doctor.sh`、`take-screenshots.ts`；调整 `tests/login-flow.spec.ts`、`i18n-language-switcher.spec.ts`（改测顶栏语言菜单）、`legacy-cookie-removed.spec.ts`、`src/proxy.test.ts`。顺带修复 `dashboard.tsx` 使用 `useEffect` 但未从 `react` 导入导致 `pnpm build` 类型检查失败。
- **mission-control（用户中心租户自动落库）**：对齐 `1sheng-console` 在 OIDC 成功后对门户上下文的本地投影：新增 `src/lib/usercenter-provision-local.ts`（事务内查找/插入 `tenants`、确保 `workspaces`、调用 `createUser`）；`/api/auth/callback` 在 `USER_CENTER_API_URL` 启用且用户中心已返回 `tenant`、本地尚无 `users` 行且 `MC_USERCENTER_AUTO_PROVISION` 非 `0` 时自动投影，失败则 `login_error=tenant_provision_failed` 并写审计 `zitadel_usercenter_provision_user`。`usercenter-provision-local.ts` 中 SQLite 参数类型由误用的 `Database.Database` 改为 `Database`（`import type { Database }`），`pnpm typecheck` 通过。`messages/en.json`、`zh.json` 与 `login/page.tsx` 增加 `tenantProvisionFailed`；`.env.example`、`.env.local.example` 补充 `MC_USERCENTER_AUTO_PROVISION` 说明。
- **范围澄清**：统一登录问题若以 **mission-control 单体**（浏览器直连服务端 `/login`）为主，则排查与修复集中在 `mission-control`；已撤销对 `mission-control-client` 的临时改动（`proxy.ts` 登录 URL 推断、`csp.ts` form-action、`.env.example` 扩展注释），避免与「仅服务端需登录」场景混淆。
- **文档**：在 `mission-control-client/README.md` 与 `mission-control/README.md` 的 Authentication 小节补充说明——客户端与服务端为两套系统、通过配置对接；统一身份在服务端完成，客户端可不承载 SSO。
- **mission-control（CSP 与统一登录表单）**：控制台报错 `form-action ... http://127.0.0.1:*` 仍拦截对 `http://127.0.0.1:5000` 的 GET 表单，根因为 Chrome 对 **form-action** 上 `127.0.0.1:*` 类端口通配支持不可靠。`src/lib/csp.ts` 新增 `devFormActionSourcesForOidc()`：合并 `ZITADEL_REDIRECT_URI` 的 origin 及其 localhost/127 对等 origin，并补充常见 loopback 端口显式列表；开发态 **form-action** 改为上述显式 origin（`connect-src` 等仍保留原有 `:*` 写法）。`csp.test.ts` 与登录页注释同步更新。
- **mission-control（统一登录跳转与会话短路）**：根因之一为浏览器对「跨 loopback 的 GET 表单」的 CSP `form-action` 限制；之二为已持有效会话仍停留在 `/login`。`/api/auth/sso` 增加 `hasMcSession`（鉴权未关闭且会话 Cookie 校验通过）；登录页拉取后若已登录则 `replace` 至 `resolveOidcPostLoginReturnTo()`（`?force_login=1` 可跳过）；「统一账号登录」改为表单 `preventDefault` + `buildZitadelStartLoginUrl` 后 `location.assign`，与 `sso_only` 自动入口一致，避免依赖表单跨域提交。`sso-route.test.ts`、`/api/index` 描述已更新。
- **mission-control（与 1sheng-console OIDC 发起对齐）**：对比 `/Users/kuangxb/Desktop/yisheng/1sheng-console`：`useAdminSession.startHostedLogin` 始终 `new URL(apiUrl('/api/auth/zitadel'), window.location.origin)`，不在客户端把请求改写到 `ZITADEL_REDIRECT_URI` 的另一 loopback 主机。MC 登录页此前对 `buildZitadelStartLoginUrl` 传入 `oidcEntryOrigin` 会在 localhost/127 混用时产生与奕升不同的跨主机 `assign`。已改为默认不传 `baseOrigin`（与奕升同源策略一致），主机对齐仍依赖既有 `location.replace` + 用户浏览器地址与回调登记一致；`zitadel-sso-client.ts` 注释说明 `baseOrigin` 仅作例外。
- **mission-control（OIDC 成功后仍回登录页）**：根因常为 HTTP 本机访问时 `.env` 误设 `MC_COOKIE_SECURE=1`，`getMcSessionCookieOptions` 曾令 `Secure` Cookie 被浏览器静默丢弃，回调 302 到 `/` 后无会话，`proxy` 再重定向 `/login`。`session-cookie.ts` 改为「非 HTTPS 请求一律 `secure: false`」；HTTPS 上仍可用 `MC_COOKIE_SECURE` 显式关闭（自担风险）。`session-cookie.test.ts`、`.env.example` 注释已更新。
- **mission-control（OIDC return_to）**：`/api/auth/zitadel` 的 `sanitizeReturnTo` 将纯 `/login` 规范为 `/`，避免回调成功却仍 302 回登录页造成误解。
- **mission-control（SSO 成功但进不了平台页）**：根因之二为会话 Cookie 默认 `SameSite=Strict`：从 IdP **顶级导航**回 `/api/auth/callback` 时，部分浏览器不保存 Strict 会话 Cookie，随后首页 `fetch('/api/auth/me')` 401，`[[...panel]]` 再 `router.replace('/login?next=…')`。`session-cookie.ts` 引入 `resolveDefaultSameSite()`：未设 `MC_COOKIE_SAMESITE` 时默认 **lax**；仍可显式 `strict`。`.env.example`、诊断 `diagnostics/route`、单测已更新；首页对 `/api/auth/me` 增加 `credentials: 'include'`。
- **mission-control（OIDC 回调 SQLite）**：`/api/auth/callback` 中 `userLookupSql` 在 `users` 与 `workspaces` 左联后 `ORDER BY id` 与 `WHERE` 中未加表别名，触发 `SQLITE_ERROR: ambiguous column name: id`。已改为 `ORDER BY u.id`、`u.provider` / `u.provider_user_id` / `u.email` 限定列。
- **mission-control（排障）**：若仍见 `ambiguous column name: id`，多为旧 Turbopack 缓存或未重启：已在本机对 `mission-control` 执行 `rm -rf .next` 并释放 `5000` 后重启 `pnpm dev`。
- **mission-control（RemoteBridge 日志）**：`MC_REMOTE_SERVER_URL` 或库内 `gateway.server_url` 若为非空但缺少 `http(s)://` / `ws(s)://` 协议（如仅 `127.0.0.1:5000`），`resolveRemoteBridgeUrl` 会抛错且重连循环刷屏。`startRemoteBridge` 在启动前校验 URL，无效则 `warn` 并禁用桥接；错误文案附带配置预览；`getRemoteBridgeStatus().enabled` 与之一致。
- **mission-control（统一登录 UX + 首页 401）**：登录页统一 SSO 表单增加 `noValidate`、选填说明 `loginHintOptionalLine`；`login_hint` 留空仍发起 OIDC；按钮改为 `type="button"` 并 `ssoNavigating` 防重复点击、失败时显式错误（非静默 return）。`[[...panel]]` 对 `/api/auth/me` 401 改为 `window.location.replace` 整页回登录并带 `next`，避免与 `router.replace` 的会话竞态。
- **mission-control（gateway-sync / RemoteBridge）**：设置里 `gateway.server_url` 若为无协议主机（如 `127.0.0.1:5000`）或非法字符串，Node `fetch` 会在 `new Request` 抛错（RemoteBridge catch-up 调 `runServerGatewaySync` 时刷屏）。`gateway-sync.ts` 用 `new URL` 校验，仅接受 `http:`/`https:` 且含 host，否则跳过同步并 `warn`。
- **mission-control（本机 `.env.local`）**：为验证 Zitadel 真实会话，将 `MC_DISABLE_AUTH`、`MISSION_CONTROL_DISABLE_AUTH` 改为 `false`；重启 `pnpm dev` 后 `GET /api/auth/me` 无 Cookie 返回 **401**（此前为免登绕过）。
- **mission-control（待审批 UX，对齐奕升 pending-onboarding）**：Zitadel 回调在本地用户未审批时不再 `302` 到 `/login?pending_approval=1`，改为 **`/login/pending-access`** 并设置短期 HttpOnly Cookie `mc_pending_access`（HMAC，`AUTH_SECRET`）；新增 `GET/DELETE /api/auth/pending-access`、`src/lib/pending-access-cookie.ts`、专用页 `login/pending-access`；`/login` 遇旧参数 `pending_approval=1` 时 `useLayoutEffect` 整页跳转专用页；`proxy` 放行 `pathname.startsWith('/login/')`；`callback.zitadel.test` 增加未审批用例；`messages/*` 增加 `pendingAccess*` 文案。
- **mission-control（去掉 OIDC/Google 审批门禁）**：按产品要求不再走访问审批：Zitadel 回调在无本地用户时 **`createUser`** 自动落库（`is_approved=1`），已存在但未审批则 **`updateUser(..., is_approved: 1)`** 后直接建会话；Google 登录同理并修正用户查询 SQL 表前缀。删除 `pending-access` 路由/页面/Cookie 库及登录页相关跳转；`usercenter-provision-local` 导出 `deriveZitadelLocalUsername` 供两处复用。
- **mission-control（i18n 收尾）**：从 `messages/de.json`、`es.json`、`fr.json`、`ja.json`、`ko.json`、`pt.json`、`ru.json`、`ar.json` 中删除已废弃的 `pendingAccess*` 文案键，与 `en.json` / `zh.json` 保持一致。
- **mission-control（SSO 租户角色与展示）**：用户中心返回 `tenant` 时，存量用户每次 Zitadel 回调调用 **`syncExistingUserWithUsercenterPortal`** 对齐租户展示名、默认工作区与 MC **`users.role`**（扩展 **`mapUsercenterTenantRoleToMcRole`**：`tenant_founder` / `tenant_manager` / 中英文「创始人」「负责人」等 → `admin`）。**`updateUser`** 支持 **`workspace_id`**。**`/api/auth/me`** 与 Google 登录 JSON 增加 **`organization`**（租户 `display_name` / `slug`）。顶栏与侧栏底 **`ContextSwitcher`** 对非 `local` provider 展示 **单位 + 帐号**（人名/邮箱）；**`messages/zh.json` / `en.json`** 增加 **`header.organization`**。Google 路由在用户中心已配置时拉 **`tenant-context`** 并支持 **`provisionLocalUserFromUsercenterTenant`**（`authProvider: 'google'`）与同步。新增 **`usercenter-provision-local.test.ts`**。
- **mission-control（返回帐号角色）**：迁移 **`058_users_portal_tenant_role`** 为 **`users`** 增加 **`portal_tenant_role`**（存用户中心 **`tenant.role`** 原文）。**`syncExistingUserWithUsercenterPortal` / `provisionLocalUserFromUsercenterTenant`** 写入该字段；**`createUser` / `updateUser` / `validateSession` / `getUserById` / `getAllUsers`** 等鉴权链路全量带上。对外 JSON 通过 **`publicAuthUserFields`** 统一返回 **`account_role`**（无上游角色时为 `null`），与现有 **`role`**（`admin`/`operator`/`viewer`）并存；**`/api/auth/login`**、**`/api/auth/me`**、**`/api/auth/users`**、**`/api/setup`**、**Google** 响应已切换为该形状。
- **mission-control（用户中心门闸仅 Zitadel）**：按产品要求，**`/api/auth/google`** 不再调用用户中心 **`tenant-context`**、不再 **`provision`/`sync`** 租户、响应不再附带 **`organization`**；租户与帐号角色校验与落库仅保留在 **`/api/auth/callback`（Zitadel OIDC）**。
- **mission-control（SSO 后误显本地登录）**：根因 **`/api/auth/sso`** 在 **`hasMcSession`** 时先 **`return`** 未执行 **`setSsoInfo`**，**`finally` 仍将 `ssoReady=true`**，导致 **`zitadel` 仍为假** 且 **`showLocalLogin`** 误判为真，已登录用户回到 **`/login`** 时会短暂（或卡住）看到用户名密码区。已改为 **先写入 `ssoInfo` 再处理会话跳转**；**`showLocalLogin`** 改为 **`ssoReady && (!zitadelEnabled || localBypass)`**，避免 OIDC 配置拉取前误显本地表单。
- **mission-control（SSO 成功进入过渡页 + 租户名）**：Zitadel **`/api/auth/callback`** 建会话后 **302 到 `/auth/enter?next=…`**（不再直跳业务页），全屏加载并 **轮询 `/api/auth/me`** 直至会话可读，再 **`replace` 到 `next`**；成功时若响应含 **`user.organization.display_name`**（来自用户中心 **`tenant.name`** 落库后的租户展示名）则在过渡页展示 **`auth.ssoHandoffOrganization`**。**`proxy`** 放行 **`/auth/enter`**；**`login`** 增加 **`session_pending`** 错误文案；**`usercenter-tenant-gateway`** 注释标明 **`USER_CENTER_API_URL` 可设为 `https://user.1sheng.work`**；**`callback.zitadel.test`** 断言重定向含 **`/auth/enter`**。
- **mission-control（zh.json 语法）**：`messages/zh.json` 在 **`auth.sessionPendingAfterSso`** 与顶层 **`nav`** 之间漏写 **`},`**，导致 JSON 非法、Next/Turbopack 报「expected ',' or '}'」并阻塞整站加载。已补全 **`auth` 对象闭合逗号**，与 **`en.json`** 结构一致。
- **mission-control（Zitadel 认证三步与强制用户中心）**：在 **`/api/auth/callback`** 文件头用注释写明 **①Zitadel 换票验签 → ②用户中心 `tenant-context`（租户 + `tenant.role`）→ ③本地 users + 会话**；导出 **`isUsercenterApiConfigured`**；新增 **`MC_ZITADEL_REQUIRE_USERCENTER=1`** 时若未配置 **`USER_CENTER_API_URL`** 则 **`login_error=usercenter_required`**；登录页与 **`messages/en|zh`** 增加 **`usercenterRequired`**；**`.env.example`**、**`/api/index`** 说明同步；**`callback.zitadel.test`** 与 **`usercenter-tenant-gateway.test`** 补充断言。
- **mission-control（本机 env）**：**`.env.local`** 写入 **`USER_CENTER_API_URL`** / **`USER_CENTER_PORTAL_URL`**（`https://user.1sheng.work`）、**`MC_ZITADEL_REQUIRE_USERCENTER=1`**；修正注释中「MC 不读用户中心」的过时表述；**`.env.local.example`** 补充用户中心变量说明与可复制注释块（勿提交密钥）。
- **mission-control（重启联调自检）**：`pnpm dev` 已加载 **`.env.local`**；**`GET /api/auth/sso`** 返回 **`zitadel: true`**。自本机 **`curl`** 访问 **`https://user.1sheng.work/api/internal/tenant-context`** 在系统 CA 下因证书链自签失败（与 **`NODE_TLS_REJECT_UNAUTHORIZED=0` / `MC_OIDC_TLS_INSECURE`** 仅作用于 Node 进程一致）；**`curl -k`** 可达且返回 **HTTP 403**（无 **`X-Internal-Secret`** 时用户中心拒绝），说明地址与路由可达，完整校验需在 **`.env.local`** 配置 **`USER_CENTER_INTERNAL_SECRET`**（与用户中心约定一致）后走真实 Zitadel 回调验证。
- **mission-control（OIDC CSP + localhost/127.0.0.1）**：控制台报 **`connect-src 'self'`** 拦截对 **`/api/auth/callback`** 的 fetch，根因多为 **localhost 与 127.0.0.1 混用**（Cookie / 重定向 / CSP 对端未放行）。新增 **`src/lib/request-origin.ts`**，回调与 Zitadel 入口重定向统一用 **Host 头 origin**；**`proxy`** 按请求把当前 origin 及 loopback 对端写入 **`connect-src`**；**`/login`** 在 **`sso_only`** 下须 **`origin === oidcEntryOrigin`** 后才自动跳 IdP；新增 **`/auth/callback`** 与 **`/api/auth/callback`** 等价；单测 **`request-origin.test.ts`**、**`csp.test`** 已更新。
- **mission-control（用户中心 403 / tenant_gateway_failed）**：服务端日志为 **`usercenter tenant-context Forbidden`**，因 **`.env.local` 未设 `USER_CENTER_INTERNAL_SECRET`**。已从奕升 **`1sheng-console/.env`** 对齐写入 **`USER_CENTER_INTERNAL_SECRET`**（与 `https://user.1sheng.work` 一致）；**`curl -k` + X-Internal-Secret** 验证 **`tenant-context` HTTP 200**。已重启 **`pnpm dev`** 加载新环境变量。
- **mission-control（无租户入驻，对齐 1sheng-console）**：此前 **`hasTenant !== true`** 仅 **302 外链用户中心**；现默认 **`MC_USERCENTER_ONBOARDING_MODE=local`**：回调写 **`mc_pending_onboarding`** 凭证 Cookie 并跳转 **`/login/tenant-onboarding`**（注册单位 / 申请加入）；新增 **`zitadel-onboarding-proof`**、用户中心 **`search/create/apply/status`** API 封装、**`/api/auth/pending-onboarding|onboarding-status|join-tenant-search|register-tenant-from-zitadel|join-tenant-request`**；入驻成功后重新发起 SSO 进入平台；**`portal` 模式**保留旧外链行为。
- **mission-control（租户管理员 / 所有人 → 设置页权限）**：用户中心 **`uc_tenant_members.role`** 为 **`sub_admin`**（租户管理员）时，原先映射为 MC **`operator`**，访问 **`/api/settings`**（要求 **`admin`**）出现「需要管理员权限」。已将 **`sub_admin` / `tenant_user_admin` / `tenant_admin`** 等与 **`owner`** 一并映射为 **`admin`**，并新增 **`usercenter-tenant-role-map.ts`**；**`validateSession`** 在存在 **`portal_tenant_role`** 时若本地 **`users.role`** 与映射不一致则 **`updateUser` 纠偏**，无需重新登录即可刷新权限。
- **mission-control（设置页 Tab 宽度）**：设置根容器仅有 **`max-w-4xl mx-auto`** 未占满主内容区，在 flex 布局下会随 Tab 内容收缩导致各 Tab 视觉宽度不一致。已为根容器、Tab 栏、各分类内容区及通用设置行列表增加 **`w-full min-w-0`**（`settings-panel.tsx`）。
- **mission-control（1Panel 编排模板）**：新增 **`deploy/docker-compose.1panel.yml`**（镜像部署、**`mc_1panel_data`→`/app/.data`**、健康检查、`host.docker.internal`、`read_only`+`tmpfs`）、**`deploy/.env.1panel.example`**（`MC_IMAGE`、密钥、**`MC_ALLOWED_HOSTS`**、网关与 OIDC 占位）、**`deploy/README.md`**；**`docs/deployment.md`** 增加小节指向上述文件。
- **mission-control（deploy 预填 .env）**：在 **`deploy/.env`**（已被根 **`.gitignore`** 忽略、勿提交）写入可本地直接 `docker compose -f deploy/docker-compose.1panel.yml up` 试跑的骨架：随机 **AUTH_SECRET** / **API_KEY**、占位 **`REPLACE_PUBLIC_HOST`**、奕升 **`ZITADEL_ISSUER` / `USER_CENTER_*` URL**；**`ZITADEL_CLIENT_*`、用户中心 internal secret、公网域名与镜像地址**须部署方自行替换；若对话环境不可信请重新 **`openssl rand -hex 32`** 轮换密钥。
- **mission-control（入驻页 OnboardingGate UI）**：**`/login/tenant-onboarding`** 改为全屏双栏 **`TenantOnboardingGate`**（对齐奕升 **`OnboardingGate`**）：左侧首登说明/当前认证账号/绑定收益/三步路径，右侧 Step 1/2、注册单位与加入已有单位 Tab、slug 可选、加入搜索+申请留言、待审批状态与刷新；内联 SVG 替代 `lucide-react`。**`register-tenant-from-zitadel`**：slug 留空时服务端自动生成；**`join-tenant-search`** 返回 **`score`/`loginRouteSegment`**；**`join-tenant-request`** 返回 **`delivery`**，申请后刷新 **`onboarding-status`** 展示 pending 而非立即重登。**`messages/en|zh.json`** 扩展 **`auth.tenantOnboarding`** 文案；**`pnpm typecheck`** 通过。

## 2026-05-16

- **mission-control-client（WebSocket 误连 :5002/gateway-ws）**：代理客户端无本机 OpenClaw 时不再自动连 **`ws://127.0.0.1:5002/gateway-ws`**；**`gateway-url`** 跳过与页面同 host:port 的 fallback；**`websocket`/`page.tsx`** 支持 **`NEXT_PUBLIC_GATEWAY_OPTIONAL=true`**；**`gateways/connect`** 对错误端口返回 422；新增 **`.env.local`** / **`.env.local.example`**。
- **mission-control-client**：**`pnpm dev`** 默认端口改为 **5002**；**mission-control** 本机 Bridge WebSocket 改为 **5003**，避免与客户端争用 5002（**`scheduler.ts`**、**`bridge/info/route.ts`**）。

- **mission-control（ACR 镜像重建推送）**：重新 **buildx** 推送 **`…/1sheng/agentcenter:2.0.1`** 与 **`:latest`**（含 procps、登录页取消 sso_only 自动跳转、status ENOENT 回退等）；manifest **`sha256`** 以 `docker buildx imagetools inspect` 为准。服务器执行 **`docker compose pull && up -d --force-recreate`**。

- **mission-control（登录页 SSO 自动跳转）**：移除 **`MC_UNIFIED_LOGIN=sso_only`** 时进入 `/login` 即调用 **`startUnifiedLogin()`** 的逻辑；统一登录改为**仅点击按钮**（或表单提交）后跳转 IdP。已登录会话仍会在 **`hasMcSession`** 时自动离开登录页；**`oidcEntryOrigin`** 主机对齐逻辑保留。更新 **`.env.example`**、**`/api/auth/sso`** 注释。

- **mission-control（Docker 生产 spawn ENOENT）**：**`node:slim`** 缺 **`ps`/`uptime`** 导致 `/api/status` 刷 **`spawn … ENOENT`**；**Dockerfile** runtime 安装 **procps**；**`status/route.ts`** 对缺失 CLI 用 **`os.uptime()`** 回退并降低 ENOENT 日志级别。**`deploy/README.md`** 补充说明。

- **mission-control（deploy）**：新增 **`deploy/SAME-HOST-NETWORK.md`**（同机多域名：内网 `USER_CENTER_API_URL` vs 公网 `USER_CENTER_PORTAL_URL`、Nginx/Compose 参考）；**`.env.1panel.example`**、**`deploy/README.md`** 增加链接与注释。

- **mission-control（Docker 生产 EACCES）**：修复 **`read_only` + tmpfs** 下 Next.js 无法创建 **`/app/.next/cache/images`**（tmpfs 默认 root、进程 uid 1001）。**`deploy/docker-compose.1panel.yml`**、**`docker-compose.yml`** 的 tmpfs 增加 **`uid=1001,gid=1001`**；**`docker-entrypoint.sh`** 启动前 **`mkdir -p`** 缓存目录；**`deploy/README.md`** 增加 EACCES 与用户中心 **tenant-context 5xx** 排错说明。

- **mission-control（deploy / 1Panel）**：**`docker-compose.1panel.yml`** 的 **`env_file`** 改为引用 **`1panel.env`**（与 1Panel 面板默认写入文件名一致）；**`.env.1panel.example`**、**`deploy/README.md`** 说明面板填变量 + compose 引用方式；**`.gitignore`** 增加 **`1panel.env`**。
- **mission-control（deploy）**：**`docker-compose.1panel.yml`** 将 **`image` / `container_name` / `ports`** 写死在编排内（ACR **`…/1sheng/agentcenter:2.0.1`**、**`agentcenter`**、**`127.0.0.1:3000:3000`**）；**`.env`** 仅承载应用配置。**`deploy/.env.1panel.example`** 移除 **`MC_IMAGE`** 等 Compose 项；**`deploy/README.md`** 同步说明升级时改 compose 内 **`image:`** tag。

- **GitHub 提交与推送**：提交 **`7d2cbe8`**（rebase 后为 **`13ab946`**）**`feat: Zitadel SSO, user-center tenancy, and production deploy tooling`**（494 文件）；**`git pull --rebase origin main`** 丢弃与远端重复的 **`c02812f`**；**`git push origin main`** 至 **`kuangxiongbo/agentAC`** 成功。未提交 **`.env.local`**、**`deploy/.env`**（已 gitignore）。
- **镜像与代码对齐检查**：ACR **`agentcenter:2.0.1`** / **`:latest`** manifest 仍为 **`sha256:88e9a874…`**（**amd64+arm64**）；该镜像在提交前由本地工作区构建，与当前 **`main`** 内容一致，**无需因本次 push 再次构建**。仓库根目录无 **`.github/workflows`**，**`mission-control/.github`** 内 CI/镜像工作流不会在 push 时自动运行；生产仍用 ACR 手动 **`docker-buildx-multiarch.sh`**。
- **mission-control（阿里云 ACR 镜像构建与推送）**：在 **`mission-control/`** 使用 **`scripts/docker-buildx-multiarch.sh`**（**`MC_DOCKER_PUSH=1`**、builder **`mc-multiarch`**）构建并推送多架构 manifest：**`linux/amd64`** + **`linux/arm64`**。镜像地址：**`crpi-c9b9bml2ajb23n5d.cn-shenzhen.personal.cr.aliyuncs.com/1sheng/agentcenter:2.0.1`** 与 **`:latest`**（digest **`sha256:88e9a8749bbedc3a50cc1425b0a68019e73d47179fc4786a7ad4205235e16c98`**）。**`deploy/.env`** 中 **`MC_IMAGE`** 已由 **`:1.0.0`** 更新为 **`:2.0.1`**，与 **`package.json`** 版本一致。构建耗时约 **7.7 分钟**，**`docker login`** 使用既有 ACR 凭据。

## 2026-05-15

- **mission-control（Docker 构建：pnpm 10 与依赖脚本）**：此前 **`docker build`** 使用 **`corepack prepare pnpm@latest`** 拉到 **pnpm 10**，默认 **`ERR_PNPM_IGNORED_BUILDS`**，**`better-sqlite3` / `sharp` / `@swc/core` 等** 安装脚本被跳过导致 **`pnpm install` 失败**。已将 Dockerfile 中 pnpm **固定为 `9.15.9`**（与 **`pnpm-lock.yaml` lockfileVersion 9.0** 一致），**deps 阶段 `COPY .npmrc`**；**`.npmrc`** 去掉空的 **`onlyBuiltDependenciesFile=`** 行，仅保留 **`ignore-scripts=false`**。推送镜像仍需在目标环境执行 **`docker login`**、**`docker tag`** 至私有仓库并 **`docker push`**（本环境未配置仓库地址与凭据）。
- **mission-control（Docker 构建：Next 段配置再导出）**：**`src/app/auth/callback/route.ts`** 原先 **`export { GET, dynamic } from '@/app/api/auth/callback/route'`**，Turbopack 报「**`dynamic` 不能再导出**」。已改为在本文件 **`export const dynamic = 'force-dynamic'`**，仅 **`export { GET }`** 从 API 路由复用处理器。
- **mission-control（生产构建自检）**：在仓库根下 **`mission-control`** 执行 **`pnpm build`**（Next 16.1.6 Turbopack），**编译、TypeScript、静态页生成均通过**，路由表含 **`/auth/callback`**。
- **mission-control（Docker 多架构构建 amd64 + arm64）**：新增 **`scripts/docker-buildx-multiarch.sh`**（Buildx **`docker-container`** builder、默认 **`linux/amd64,linux/arm64`**、**`MC_DOCKER_PUSH=1`** 推送 manifest、**`MC_DOCKER_LOAD=1`** 单架构载入本机）；**`package.json`** 增加 **`pnpm docker:multiarch`**；**`deploy/README.md`**、**`docs/deployment.md`**、**`README.md`** 补充智创跨平台构建与推送说明。
- **mission-control（智能体「在线」误判）**：**`GET /api/agents/:id/heartbeat`** 原在控制台「检查工作项」时仍 **`updateAgentStatus(..., 'idle')`**，未接客户端也会把智能体标成非离线；概览 **`onlineAgents`** 又用「总数 − offline」把长期 **`idle`** 算进容量。已改为 **GET 仅查询工作项、不写状态**；**POST** 在 **`connection_id` / 显式 `status` / 默认 API 心跳** 时更新 **`last_seen` 与状态**。**`/api/status` dashboard** 增加 **`agents.signalingOnline`**（**`online`/`busy`/`active`**，或 **`idle` 且 `last_seen` 在 10 分钟内**；与 **`agents` 列表** 一致隐藏 **`hidden`**、**中央模式** 下仅 **`gateway`/`client`**）。仪表卡片副文案 **`metricAgentSignalingSubtitle`**（**`messages/en|zh.json`**），**`metric-cards-widget`** 显示 **`值 / 已注册总数`** 并用颜色区分有无信令。
- **mission-control（deploy：阿里云 ACR 推送说明）**：在 **`deploy/README.md`** 增加个人版实例 **`crpi-c9b9bml2ajb23n5d.cn-shenzhen.personal.cr.aliyuncs.com`** 的 **`docker login`**、**`MC_IMAGE` 命名空间/仓库占位**、**Buildx 推送** 与 **`MC_DOCKER_PLATFORM=linux/amd64`** 排错说明；快速步骤序号顺延。
- **mission-control（deploy：镜像仓库名 agentcenter）**：**`deploy/docker-compose.1panel.yml`** 默认镜像改为 **`agentcenter:local-build`**、默认容器名 **`agentcenter`**；**`deploy/.env.1panel.example`**、**`deploy/.env`** 中 **`MC_IMAGE`** 对齐阿里云路径 **`…/1sheng/agentcenter:1.0.0`**、**`MC_CONTAINER_NAME=agentcenter`**；**`deploy/README.md`**、**`docs/deployment.md`**、**`README.md`**、**`scripts/docker-buildx-multiarch.sh`** 示例与占位仓库名改为 **`agentcenter`**（Compose 服务名仍为 **`mission-control`**；SQLite 文件名 **`mission-control.db`** 等未改）。
