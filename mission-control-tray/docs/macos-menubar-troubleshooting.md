# macOS 菜单栏图标排错（E-Agent Edge）

## 结论摘要（本机 1470×956 + 诊断日志）

| 现象 | 含义 |
|------|------|
| `visible=1` `hasImage=1` | 系统 API 认为已创建，不是「没装上」 |
| `screen=(696,919,22×22)` | 图标在菜单栏**中部偏右**，不是时钟旁最右侧 |
| 旧日志 `screen=(0,-37)` | 启动瞬间尚未布局，可忽略 |
| `inMenuBar=0`（旧版诊断） | 误判：刘海屏菜单栏约 37pt，不是 22pt |

**最可能你看不到的原因（按优先级）：**

1. **看错位置** — 在整条菜单栏中间找**红色圆点**小图标，不要只盯 Wi‑Fi/时钟左侧。
2. **被系统藏进折叠区** — 菜单栏过满时点右侧 **`…`**，或 **系统设置 → 菜单栏 / 控制中心** 打开 E-Agent Edge。
3. **曾被拖掉隐藏** — 旧版 `RemovalAllowed` 时 Cmd+拖走会长期隐藏；需在控制中心重新勾选（已改 Default）。
4. **未用 .app 启动** — 必须 `open "E-Agent Edge.app"`，不要直接跑 `target/debug/...`。
5. **磁盘满无法更新** — 若未重新 `pnpm tauri build`，跑的仍是旧 `native_tray` 日志。
6. **template 图标太淡** — 默认已改**彩色圆点**；要 Clash 单色：`MC_EDGE_TRAY_TEMPLATE=1`。

## 一键验证

```bash
cd mission-control-tray
bash scripts/verify-menubar-tray.sh
cat ~/Library/Logs/E-Agent-Edge/tray-diag.log
```

期望最新日志含：

- `objc_tray`（不是旧的 `native_tray`）
- `inMenuBar=1`
- `env ... inApp=1`

## 环境变量

| 变量 | 作用 |
|------|------|
| `MC_EDGE_TAURI_TRAY=1` | 与 Clash 相同 Tauri 托盘路径 |
| `MC_EDGE_NATIVE_TRAY=1` | Rust objc2 托盘 |
| `MC_EDGE_TRAY_TEMPLATE=1` | 单色 template 图标 |
| `MC_EDGE_TOP_HELPER=1` | 顶部 WebView 快捷条（备用） |

## 与 Clash 仍不一致时

Clash 为已签名、从「应用程序」启动的成熟 bundle；Edge 当前为 adhoc 签名。若以上都排除，可尝试：

- 将 Edge 拖入「应用程序」后再开
- 对比 `MC_EDGE_TAURI_TRAY=1` 构建是否仅 Tauri 路径可见
