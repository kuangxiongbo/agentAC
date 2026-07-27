# Work 数据投影改进跟踪

更新日期：2026-07-27

| 项 | 范围 | 状态 | 验收门禁 |
|---|---|---|---|
| 0 | Work 详情本地主数据、云端监督合并、任务汇总 | 已完成 | Center/Runtime 2.1.74；主详情与各标签的新旧 Agent ID 均须实时 Bridge |
| 1 | 全局任务投影与 Dashboard | 已完成 | 本地新建/更新/删除在云端正确展示 |
| 2 | 全局活动投影 | 已完成 | 本地会话/任务里程碑进入云端活动流 |
| 3 | Agent 指标投影 | 已完成 | 诊断/归因/成本/评估与本地一致 |
| 4 | 搜索投影与站会 | 已完成 | 搜索和站会可定位本地 Work 事实 |
| 5 | Work 资源可靠写回 | 已完成 | 云端命令经本地校验/ACK 后生效 |
| 6 | 离线快照、来源标识和端到端回归 | 已完成 | 断线/重连/旧客户端/回滚均通过 |

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

## 第 3 项验收记录

- 版本：Center/Runtime `2.1.78`，生产延迟修复 `2.1.79`，Tray `3.0.10`。
- Git：`0275837 feat(metrics): project edge agent metrics to center`；`356bf96 fix(metrics): bound security audit scan latency`。
- 镜像：`agentcenter:2.1.79` 与 `latest`，`linux/amd64` digest `sha256:925202d13866064b5c4f702478d7fad1ef0bb3b4392d92728f3ac7491cb50d05`。
- Runtime：`client-runtime-2.1.79-darwin-aarch64.zip`，SHA-256 `1b0458286df6369b533328c740c096eb4fd023fdaac172185ee978941d38c0f8`；Tray DMG SHA-256 `7379be6c1366888edc787d6bc31ec1f9265cbdd19ee068fdbddb21b33d639000`。
- 自测：Center `1164/1164`，Edge 指标 Bridge `9/9`，安全扫描聚焦 `5/5`；两端 typecheck、生产构建、Runtime 干净解压启动和发布面门禁通过。
- 生产诊断/归因：云端 Agent `305652` 实时解析本地 Agent `6` `安全专家`，`authority=local_runtime`、`local_live=true`，诊断活动数和归因成本结构正确。
- 生产评估/成本：`/api/agents/evals?timeframe=day` 返回 `200/authority=combined`；`stats/trends/by-agent/task-costs/session-costs` 全部返回 `200`，空数据场景不再返回 400。
- 生产 UI：`v2.1.79` 安全审计页正常显示 Agent 评估仪表板，热访问两个聚合请求约 `1.8s`；成本页四个聚合请求约 `0.81s`，页面无 400、空白或持续加载。

## 第 4 项验收记录

- 版本：Center/Runtime `2.1.81`，Tray `3.0.10`。
- Git：`d405c00 feat(search): project edge work into search and standup`；`bd79589 fix(bridge): supersede stale edge connections`。
- 镜像：`agentcenter:2.1.81` 与 `latest`，`linux/amd64` digest `sha256:a9a621a368cd6cd75c905633cb438ad71e59a014566d4b1fd62a65eef4b40507`，生产容器健康运行。
- Runtime：`client-runtime-2.1.81-darwin-aarch64.zip`，SHA-256 `c0400ddab6a640612ce7effa769a9ac621b719e0731aa71267eb13dd39cf21d7`；Tray DMG SHA-256 `43a24ce1113e6b50fa4a11c0bf72ed733dd26c1acc6d8380d9ac083f867c54fb`。
- 自测：Center `1166/1166`、Edge `1008/1008`，搜索/站会聚焦 `2/2`、Edge Bridge 聚焦 `11/11`；两端 typecheck、聚焦 lint、生产构建、Runtime 干净解压启动和发布面门禁通过。
- 连接可靠性：同一 `client_id` 的新 Bridge 连接会主动替换旧连接，旧连接待处理 RPC 显式失败；Edge 旧 socket 关闭事件不会清除新连接或触发重复重连。
- 生产 Runtime：托盘从公网清单下载约 41MB 更新包并原子替换，`package.json` 已升级为 `2.1.81`，`5101/api/status` 恢复可用；Bridge 仅保留一个有效客户端并声明 `work_search`、`standup_snapshot` 能力。
- 生产搜索：临时本地任务 `E2E-SEARCH-STANDUP-2.1.81-1785117257` 返回稳定负 ID `-4138582491518280`，`source/authority=local_runtime`、`local_entity_id=7`，Agent 映射为 `mc-edge-a8901a06c732-安全专家`，`local_errors=[]`。
- 生产站会：同一任务进入上述 Agent 的 `inProgress`，保持相同负 ID 和 `local_runtime` 来源；活动计数为 1，`sources.authority=combined`、`local_live=true`、`errors=[]`。验收后临时任务及活动均已删除，本地残留为 0。

## 第 5 项验收记录

- 版本：Center/Runtime `2.1.82`，Tray `3.0.10`；Git `6e9f5f6 feat(tasks): reliably write cloud mutations to edge`。
- 镜像：`agentcenter:2.1.82` 与 `latest`，`linux/amd64` digest `sha256:81256db88134cbf029873f3cec6f1a0fa5dcd197745747b2df974db3b85b24e2`；生产容器健康运行并报告 `2.1.82`。
- Runtime：`client-runtime-2.1.82-darwin-aarch64.zip`，SHA-256 `a53c65da0678f7eb34ca995a903e5ac195f4895bd09da185548dfb1a88973f6b`；Tray DMG SHA-256 `4e3cf1fb73835251ccad9e45bf7f6be60eabe7694a88077f3225e0d66f5abb08`。托盘真实下载并原子升级到 `2.1.82`，5101 服务恢复。
- 自测：Center `1168/1168`、Edge `1011/1011`；Center 写回/投影聚焦 `5/5`、Edge mailbox/Bridge 聚焦 `20/20`；两端 typecheck、聚焦 lint、生产构建、Runtime 干净启动和发布面门禁通过。
- 可靠更新：生产临时任务本地 ID `8` 经消息 `9358a4da-eeec-4835-9cd7-c6d6f623ee8e` 完成 `created -> leased -> acked`，标题、状态、优先级和 tags 在本地事务中生效；ACK result 返回 `changed=1` 和 `applied_at`。
- 幂等与冲突：重复 `idempotency_key` 返回同一消息且 `duplicate=true`，未二次执行；使用旧 `expected_updated_at` 的消息 `ca83d5c0-af62-4a6f-a46a-42a0f36bb6ab` 进入 `dead_letter`，Edge fail outbox 返回 `TASK_VERSION_CONFLICT`、`retryable=false`，本地标题保持新值。
- 可靠删除：消息 `83bd495f-58fd-4496-aa2c-fd993743340c` 完成 `created -> leased -> acked`，ACK result 为 `deleted=true`；本地任务残留 0，并保留 `task_updated/task_deleted` 两条 `cloud_control` 来源活动。
- 生产 UI：`https://agent.1sheng.work/tasks` 显示 `v2.1.82`，任务看板、项目/客户端筛选和详情弹窗正常加载，无持续等待或空白。

## 第 6 项验收记录

- 版本：Center/Runtime `2.1.83`，Tray `3.0.10`；Git `7701596 feat(projection): retain edge snapshots while offline`。
- 镜像：`agentcenter:2.1.83` 与 `latest`，`linux/amd64` digest `sha256:9671bf3d7084bc687227143d7176e18810d6a5cc0e584a5d6e28186fdc7c5769`；生产容器健康运行并报告 `2.1.83`。
- Runtime：`client-runtime-2.1.83-darwin-aarch64.zip`，SHA-256 `1d8c815360874cd9d2eb8ffdff502f73f41b3838f948eb89343f462910ac2469`；Tray DMG 继续使用 `3.0.10`，SHA-256 `4e3cf1fb73835251ccad9e45bf7f6be60eabe7694a88077f3225e0d66f5abb08`。托盘从公网清单自动升级到 `2.1.83`，5101 服务恢复。
- 自测：Center `1172/1172`、Edge `1011/1011`；离线快照/搜索/站会聚焦 `16/16`，两端 typecheck、聚焦 lint、生产构建、Runtime 干净解压启动和发布面门禁通过。
- 在线投影：临时任务本地 ID `9`、生产稳定 ID `-4121273739760162`，对应活动本地 ID `2320`、生产稳定 ID `-3242710780153230`；任务与活动均为 `source/authority=local_runtime`、`local_live=true`。
- 真实断线：停止本地 Tray/Runtime 并确认 5101 离线后，任务与活动保持相同稳定 ID，均切换为 `source/authority=local_snapshot`、`stale=true`、`local_live=false`、`local_stale=true`，并返回各自 `snapshot_at`；生产迁移表 `work_projection_snapshots` 存在且保存 tasks/activities 两类快照。
- 离线消费：全局搜索同时找到快照任务和活动；站会将快照任务归入 `mc-edge-a8901a06c732-安全专家`，来源汇总为 `local_snapshot` 且无投影错误。浏览器任务卡显示 `local_snapshot`、`draggable=false`，详情弹窗无编辑和删除入口。
- 真实重连：重启 Tray 后约 4 秒恢复 5101，任务与活动各仅返回一条，恢复为 `local_runtime`、`local_live=true`、`local_stale=false`，稳定 ID 不变且无快照重复。临时任务及关联活动已清理，本地和生产残留均为 0。
- 兼容性：无快照的旧客户端不会伪造离线数据，租户过滤和七天保留策略由自动化测试覆盖；回滚到 `2.1.82` 时新增表可保留，旧代码不会读取该表。
