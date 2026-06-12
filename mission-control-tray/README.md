# E-Agent Edge（托盘客户端）

轻量 Tauri 托盘程序：**首次启动联网**从服务中心下载 runtime，本地启动 `mission-control-client`（默认 `http://127.0.0.1:5101`）。

**托盘在哪里？（macOS）**

- **默认**：纯 Cocoa `NSStatusItem`（`edge_menubar.m`），**template 单色图标**，与 Clash 一样在菜单栏**右侧**（时钟 / Wi‑Fi 左侧），左键弹出菜单。
- **必须用 `.app` 启动**（macOS 15+ 常要求 bundle 才显示菜单栏图标）：`pnpm tauri build` → `open src-tauri/target/release/bundle/macos/E-Agent\ Edge.app`（或 `bash scripts/verify-menubar-tray.sh`）。
- **不要用** `target/debug/mission-control-tray` 裸跑（Dock 会显示 `exec`，菜单栏常无图标）。
- 后端切换（排错用）：
  - `MC_EDGE_TAURI_TRAY=1` — Clash 同款 `TrayIconBuilder` + `tray-icon-mono.ico`
  - `MC_EDGE_NATIVE_TRAY=1` — Rust `objc2` NSStatusItem
- 开发兜底（非正式入口）：`MC_EDGE_TOP_HELPER=1` 显示顶部 WebView 快捷条。
- macOS 15 **系统设置** → **菜单栏** / **控制中心**：确认 **E-Agent Edge** 允许在菜单栏显示；菜单栏过满时点右侧 **`…`** 折叠区查找。
- Tauri 托盘调试：`MC_EDGE_TRAY_FIX=1` 移除 TrayTarget；`MC_EDGE_TRAY_TITLE=1` 显示文字「Edge」。

**托盘菜单**

| 菜单项 | 说明 |
|--------|------|
| 打开 Web 控制台（本机） | 浏览器打开 `http://127.0.0.1:5101` |
| 打开服务中心 | 浏览器打开配置的 `center_url` |
| 双击托盘图标 | 同「打开 Web 控制台（本机）」 |

**图标**

从 `mission-control/public/brand/app-logo.png` 生成（与 Dock 图标同源）。菜单栏默认使用 **同款彩色 logo**（`tray-icon.png`）；若需系统反色 template：`MC_EDGE_TRAY_TEMPLATE=1`。重新生成：

```bash
bash mission-control-tray/scripts/generate-tray-icons.sh
```

## 安装后初始化（仅需两项）

首次启动会弹出 **Web 初始化窗口**（本机内嵌页面，非 5101）：

| 字段 | 说明 |
|------|------|
| **连接地址** | 服务中心「本站点连接信息」中的 URL，如 `https://agent.1sheng.work` |
| **认证令牌 (API TOKEN)** | 同上，复制 API TOKEN 粘贴 |

可选勾选 **企业内网 / 自签 HTTPS 证书**（写入 `tls_insecure`）。

点击「连接并启动」后托盘将：连接中心 → 准备 runtime → **自动启动本机 5101 服务** → 健康检查通过后 **自动打开浏览器**（`/chat`）。

已配置用户：每次打开 E-Agent Edge 托盘也会在后台尝试启动/校验 5101（无需再手动 `pnpm prod`）。

已配置用户：**左键点击菜单栏图标** 或 **Dock 图标** 打开连接配置页（与首次初始化相同）；**右键** 打开托盘菜单。**连接设置…** 会先停 5101 再打开配置页。

## 24 小时在线（只要不关机）

托盘运行期间，macOS 会通过 `caffeinate` **阻止系统进入睡眠**（**显示器可以正常息屏**），Edge 5101 与中心服 Bridge 保持连接，服务端可随时下发任务。

- 合盖 / 手动「睡眠」仍会断网（需唤醒后自动重连）；**关机**后需重新打开托盘。
- 开发模式 `pnpm prod:restart` 同样默认启用保活（`MC_KEEP_AWAKE=1`）。
- 若需恢复系统默认睡眠：`MC_KEEP_AWAKE=0` 后重启托盘。

## 方案 B：首次从服务中心下载并自动入网

| 组件 | 说明 |
|------|------|
| **托盘安装包** | 体积小（仅 Tauri），内置 `center_url` + `EDGE_ENROLL_TOKEN`（企业注册令牌） |
| **client-runtime zip** | 由中心 bootstrap 一并返回 manifest（或单独 `edge-runtime-manifest`） |
| **客户端名称** | 自动取 **本机 hostname**（去 `.local`），每台电脑不同 |
| **连接配置** | 中心下发 `gateway.server_url` / `gateway.token` / `gateway.client_name`，托盘写入本地 DB 并连 Bridge |

首次启动流程：

1. `GET {center}/api/edge/bootstrap?hostname=...&device_id=...`（Header: `x-edge-enroll-token`）
2. 下载 runtime zip → 校验 → 解压 → 启动 `5101`
3. `POST http://127.0.0.1:5101/api/edge/apply-bootstrap` 写入与 Web 设置页相同的连接项
4. 自动连接中心 Bridge，中心侧以 `gateway.client_name` 区分各边缘节点

### 中心服环境变量（docker / 1panel）

```bash
MC_EDGE_ENROLL_TOKEN=your-company-distribution-secret
MC_EDGE_ENTERPRISE_NAME=奕升科技
EDGE_RUNTIME_MANIFEST_PATH=/app/config/edge-runtime-manifest.json
# 可选多企业：MC_EDGE_ENROLL_TOKENS='{"token-a":{"name":"A公司","slug":"a"}}'
```

### 安装包分发

构建托盘时写入（或安装脚本生成 `~/.e-agent-edge/config.json`）：

```json
{
  "center_url": "https://agent.1sheng.work",
  "enroll_token": "your-company-distribution-secret"
}
```

## 本地数据目录

- `~/.e-agent-edge/config.json` — 中心地址、端口、runtime 版本
- `~/.e-agent-edge/runtime/` — 解压后的 standalone
- `~/.e-agent-edge/data/` — SQLite / tokens（与 dev 分离）

## 开发

```bash
cd mission-control-tray
pnpm install
pnpm tauri dev
```

需本机 **Node.js 22+**（runtime 由 zip 提供应用代码，Node 解释器用系统 PATH）。

## 打包 Runtime（发布前）

```bash
cd mission-control-client
bash scripts/package-edge-runtime.sh
# 产出 ../releases/dist/client-runtime-{version}-{platform}.zip
```

将 zip 与 `releases/edge-runtime-manifest.json` 挂到 GitHub Release `edge-runtime-v{version}`。

## 打包托盘

```bash
pnpm tauri build
```

## 用户流程

1. 安装 E-Agent Edge（dmg/msi）
2. 首次启动 → 拉 manifest → 下载 zip → 校验 SHA256 → 解压 → 启动 5101
3. 托盘「打开控制台」→ 浏览器访问本机 UI（需能访问中心服登录/Bridge）
