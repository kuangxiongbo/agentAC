# Work 数据投影改进跟踪

更新日期：2026-07-24

| 项 | 范围 | 状态 | 验收门禁 |
|---|---|---|---|
| 0 | Work 详情本地主数据、云端监督合并、任务汇总 | 已完成 | Center/Runtime 2.1.74；主详情与各标签的新旧 Agent ID 均须实时 Bridge |
| 1 | 全局任务投影与 Dashboard | 已完成 | 本地新建/更新/删除在云端正确展示 |
| 2 | 全局活动投影 | 进行中 | 本地会话/任务里程碑进入云端活动流 |
| 3 | Agent 指标投影 | 待开始 | 诊断/归因/成本/评估与本地一致 |
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
