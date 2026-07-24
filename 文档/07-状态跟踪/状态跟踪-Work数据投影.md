# Work 数据投影改进跟踪

更新日期：2026-07-24

| 项 | 范围 | 状态 | 验收门禁 |
|---|---|---|---|
| 0 | Work 详情本地主数据、云端监督合并、任务汇总 | 已完成 | Center/Runtime 2.1.74；主详情与各标签的新旧 Agent ID 均须实时 Bridge |
| 1 | 全局任务投影与 Dashboard | 已完成 | 本地新建/更新/删除在云端正确展示 |
| 2 | 全局活动投影 | 已完成 | 本地会话/任务里程碑进入云端活动流 |
| 3 | Agent 指标投影 | 进行中 | 诊断/归因/成本/评估与本地一致 |
| 4 | 搜索投影与站会 | 待开始 | 搜索和站会可定位本地 Work 事实 |
| 5 | Work 资源可靠写回 | 待开始 | 云端命令经本地校验/ACK 后生效 |
| 6 | 离线快照、来源标识和端到端回归 | 待开始 | 断线/重连/旧客户端/回滚均通过 |

每项必须依次完成：实现 -> 自测 -> 发布 -> 生产验证。未通过生产验证不得将状态改为完成。

## 第 0 项验收记录

- 版本：Center/Runtime `2.1.74`
- Git：`2a1ffb5 fix(agent): unify legacy work detail identity`
- 镜像：`agentcenter:2.1.74` 与 `latest`，digest `sha256:c8fc3dab89e345411020c4a4f81db451b5bbba7e9375b26b62a660eba6c32aeb`
- Runtime：`client-runtime-2.1.74-darwin-aarch64.zip`，SHA-256 `721f48dc4b33d0807aedbe2897717350ce9171aa8286b6b358d67e85c0a41c49`
- 自测：Center 31/31、Edge 6/6；Center/Edge 生产构建、Runtime 干净目录启动、发布面校验均通过。
- 生产 API：旧云端 ID `31` 与当前索引 ID `305652` 均解析到本地 Agent `6`，`source=bridge_index`、`detail_live=true`、`bridge_online=true`。
- 生产数据：本地临时任务在新旧 ID 详情均显示为 `local_runtime`，与 `cloud_control` 监督任务正确合并；删除后本地任务和云端卡片快照均回到 0。
- 生产 UI：`https://agent.1sheng.work/agents` 版本显示 `v2.1.74`；“安全专家”主详情、任务、活动、配置均无加载错误，文件/SOUL/记忆均请求 `/api/agents/305652/*` 并返回本地实时结果。

## 第 1 项验收记录

- 版本：Center/Runtime `2.1.75`，Tray `3.0.10`
- Git：`1516678 feat(tasks): project edge work into cloud dashboard`
- 镜像：`agentcenter:2.1.75` 与 `latest`，digest `sha256:976443d22c3368ddea1eb5d9a1124a30b8cda8670b901f51d88c403711a7f84f`
- Runtime：`client-runtime-2.1.75-darwin-aarch64.zip`，SHA-256 `c36c6e491887bc580c4e0c94377d8193f3c98fc34e307176e9d824ef7d1f992c`
- Tray DMG：SHA-256 `f84890223051a2d07a27eb16fcb69f7a661c43964ff4b54a3a660733b2cec610`
- 自测：Center `1156/1156`、Edge `1001/1001`；两端 typecheck、生产构建、Runtime 干净目录启动、发布面校验均通过。
- 生产协议：本地 Runtime `2.1.75` 在线，Bridge capability 包含 `task_snapshot`；Center 可请求最多 1000 条本地任务和完整状态汇总。
- 生产新建：本地任务 `E2E-2.1.75-projection-1784869050` 在云端生成稳定负 ID，`source=local_runtime`；任务板与 Dashboard 同步展示。
- 生产更新：本地任务更新为 `in_progress` 后，云端约 `145ms` 内同步状态和汇总。
- 生产删除：本地删除后，云端约 `67ms` 内移除，Dashboard/客户端本地任务总数恢复为 0，无测试数据残留。
- 生产 UI：临时任务 `UI-E2E-2.1.75-local-runtime` 可在云端任务板打开详情，显示 `local_runtime` 来源且不提供编辑/删除按钮；清理后页面确认任务消失，既有云端监督任务未受影响。

## 第 2 项验收记录

- 版本：Center/Runtime `2.1.76`，Agent 筛选兼容修复 `2.1.77`，Tray `3.0.10`
- Git：`7d4416c feat(activity): project edge work into cloud feed`；`aa7a0ad fix(activity): filter bridge agents by original name`
- 镜像：`agentcenter:2.1.77` 与 `latest`，digest `sha256:aa884aef95580e0c56a660b9b0bc7e9e41ae72ff1937b1c859a30641abecd1a1`，生产容器已健康运行。
- Runtime：`client-runtime-2.1.77-darwin-aarch64.zip`，SHA-256 `7e444a8045c33947198c7f63ff49a5851740e0789de620eb877a4e63e3944a99`；Tray DMG SHA-256 `f84890223051a2d07a27eb16fcb69f7a661c43964ff4b54a3a660733b2cec610`。
- 自测：Center `1160/1160`、Edge `1002/1002`；两端 typecheck、聚焦 lint、生产构建、Runtime 干净目录启动和发布面校验均通过。
- 生产协议：Bridge capability 包含 `activity_snapshot`，云端合并本地 `activities` 与 CLI `session_activity`，保留 `source=local_runtime`、设备和客户端身份，且本地仍为权威数据源。
- 生产延迟：任务更新约 `1792ms` 可见，删除约 `2728ms` 可见；稳定负 ID、分页、统计、会话里程碑和 SSE 刷新均通过。
- 生产 Runtime：托盘从公网清单获取 `2.1.77`，完成 39MB 下载、原子替换和重启；`package.json`、`config.json`、`bootstrap.json` 与 `5101/api/status` 均为 `2.1.77`。
- 生产 UI：活动流显示本地会话及任务里程碑；点击云端 Agent `mc-edge-a8901a06c732-安全专家` 时，实际请求为 `/api/activities?actor=安全专家&limit=50&offset=0`，正确返回 2 条本地 Agent 完成事件，无前缀名不匹配问题。
