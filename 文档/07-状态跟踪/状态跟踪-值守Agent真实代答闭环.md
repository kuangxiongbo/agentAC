# 值守 Agent 真实代答闭环与稳定性跟踪

更新日期：2026-07-29

## 目标

当受管 Worker 在真实会话中等待用户确认、选择或补充信息时，值守 Agent 必须在约 5 秒内理解完整上下文，通过 MCP/可靠 Bridge 向原 Worker 会话发送有语义的回复，使 Worker 继续执行；全过程可审计、可停止、可去重且不会形成无限循环。

## 执行看板

| 项 | 范围 | 状态 | 验收门禁 |
|---|---|---|---|
| 0 | 生产基线与前置条件审计 | 已完成 | 2.1.83 的授权、绑定、会话、Bridge、MCP 和健康指标可用 |
| 1 | 可重复的真实 Worker 问询夹具 | 已完成 | 可稳定产生等待确认并保留 Worker transcript、事件和 message ID |
| 2 | 五类语义代答 | 已完成 | 确认、选择、补充信息、危险拒绝、无法判断转人工均符合问题语义 |
| 3 | 自动停止与循环保护 | 已完成 | 次数、时长、限流停止均生效；重新启用不立即再次停止 |
| 4 | 断线排队、重连与幂等 | 已完成 | Bridge 断线期间排队，重连只投递一次且回复进入原会话 |
| 5 | 端到端可观测证据 | 已完成 | UI/API 可关联触发、判断、投递、ACK、Worker 后续状态和失败原因 |
| 6 | 小范围持续稳定性 | 已完成 | 24 小时无重复回复、堆积和资源异常；2.1.88 离线 120 秒自动停止故障注入通过 |

每项必须依次完成：`实现 -> 自测 -> 发布 -> 生产验证 -> 标记完成`。仅文档或模拟测试通过不得标记业务闭环完成。

## 统一验收证据

每个真实场景至少保存以下关联字段：

- `binding_id`、Worker/Steward Agent ID、`client_id`；
- Worker `session_id`、`session_kind` 和触发问题原文；
- watch event ID、fingerprint、judge 输入摘要和语义回复；
- `correlation_id`、`message_id`、lease/ACK 结果和投递耗时；
- 回复后的 Worker transcript 增量及继续执行结果；
- intervention 最终状态、自动停止状态或转人工原因。

## 安全边界

- 禁止用固定“继续”“确认”作为语义代答验收证据。
- 高风险、删除、生产变更、提权和密钥操作必须拒绝自动批准或转人工。
- 测试必须使用临时低风险任务，完成后清理任务、事件和会话测试数据。
- 生产为小范围灰度；未完成第 6 项前不扩大默认启用范围。

## 第 0 项验收记录

- 版本：生产 Center/Runtime `2.1.83`、Tray `3.0.10`；生产容器和本地 5101 均健康。
- 授权：`/api/human-watch/policy` 返回 `available=true`、`enabled=true`、`tenant_flag=true`；通用 `/api/license/status` 的订阅权益为 false，但当前租户历史开关使人工值守实际可用。该双口径展示进入第 5 项修正范围。
- 绑定：生产共有 4 条历史绑定，仅 binding `6` 启用；Worker 为本地 Agent `10`“宣传视频制作”，Steward 为本地 Agent `7`“24 小时智能值守”，`worker_session_id=019f5ecf-0e60-7d51-82dd-ed15e1896ede`、`worker_session_kind=codex-cli`。
- Bridge：客户端 `mc-edge-a8901a06c732` 在线，声明 `session_transcript`、`session_continue`、`steward_judge`、`reliable_mailbox`、`human_watch_assist_v2` 和 `serial_session_continue` 等必需能力。
- 编排：binding `6` 每 60 秒持续生成 `rule_evaluated`；当前 Worker 最后一轮不满足确认规则，因此正确记录 `decision=noop`、`skip_reason=no_rule_match`，不是编排停止。
- 健康：近 7 天成功介入 98 次、完成失败 0 次；历史 `steward_judge_failed=7`、`bridge_offline=28` 使总体状态为 `degraded`，进入第 5～6 项跟踪，不作为基线前置阻断。
- 结论：授权、绑定、会话身份、Bridge 能力和编排定时器均可用，可以进入真实 Worker 问询夹具建设。

## 第 1 项首轮真实验证（未完成）

- 场景标识：`HW-E2E-CONFIRM-1785143489`；复用 production binding `6` 和真实 Worker `codex-cli` 会话，未伪造数据库 transcript。
- Worker 输入：通过生产 `/api/sessions/continue` 和 Bridge 向原会话发送低风险测试指令；Worker 在同一 transcript 提问“测试报告应使用蓝色主题还是绿色主题？请选择一种，收到答案后我会继续。”
- 规则命中：干预 `36903` 命中 `confirmation_text`、`confirmation_strong`、`awaiting_user_response` 和 `idle_timeout`，`decision=auto_send`。
- 值守判断：值守 Agent 输出“使用蓝色主题，确认。”，不是固定“继续”；干预 `36904/36905` 记录 attempt 和 `outcome=success`。
- Worker 后续：同一 Worker transcript 收到值守 user 消息后回复“已确认：测试报告使用蓝色主题。”，证明值守回复能够代替人推动 Worker 继续。
- 延迟事实：Worker 问题时间 `09:11:41.729Z`，值守回复进入 transcript 时间 `09:12:02.023Z`，约 20.3 秒；Worker 后续回复时间 `09:12:24.097Z`。规则约 6 秒命中，但 judge 与发送使总回复时间超过 5 秒目标。
- 未通过门禁：此次自动发送仍调用同步 `requestBridgeClientSessionContinue`，干预记录的 `message_id/correlation_id` 均为空，无法证明 lease/ACK 和断线幂等；第 1 项保持进行中。
- 待实现：自动发送统一接入可靠 `session.continue.requested` mailbox；watch event、attempt、completed 关联同一 `message_id/correlation_id`；记录问题时间、规则命中、judge 完成、入队、ACK、Worker 后续时间，区分“5 秒触发”与“模型总回复耗时”。

## 第 1 项验收记录

- 版本：生产 Center/Runtime `2.1.84`、Tray `3.0.10`；Git `8f66ace feat(human-watch): deliver automatic replies reliably`。
- 镜像：`agentcenter:2.1.84` 与 `latest`，`linux/amd64` digest `sha256:3f33ef1e396bed2b852020bdc71c389459705a3946e10c305a3c4547321fd03a`；生产容器健康。
- Runtime：`client-runtime-2.1.84-darwin-aarch64.zip`，SHA-256 `5723af6a98229a908e5489a59bcb9aaa6f108635c3197fc091fc85a96ab1c049`；本地托盘从公网清单自动升级并恢复 5101。
- 自测：聚焦 Human Watch/mailbox `28/28`、Center 全量 `1174/1174`；聚焦 lint、typecheck、Center/Edge 生产构建、Runtime 干净启动和发布面门禁通过。
- 真实场景：`HW-E2E-MAILBOX-1785207201` 的 Worker 在原 `codex-cli` 会话询问“最终验收报告选择 PDF 还是 DOCX”；值守 Agent 语义回复“选择 PDF，确认。”。
- 可靠消息：`b5ead008-2d71-4961-9c69-53fe28b6b204`，correlation `human-watch:6:019f5ecf-0e60-7d51-82dd-ed15e1896ede:5543ccc00362d87716572740`，`attempt_count=1`，最终 `status=completed`、`delivered=true`。
- ACK 结果：Edge 在 Worker CLI 完成后返回 reply“已确认：最终验收报告选择 PDF。”；干预 `38039` 才记录 `intervention_completed/outcome=success`，与 attempt 使用同一消息和 correlation。
- 幂等：Worker transcript 中值守 user 回复只出现 1 次，消息只 lease/执行 1 次；证明重复轮询没有造成重复续写。
- 可观测遗留：message leased 期间重复规则评估会追加相同消息 ID 的 attempt 审计（本次为 `38036/38038`），但不重复创建或执行消息。该审计降噪进入第 5 项处理。

## 第 2 项发布与首轮生产验证（未完成）

- 版本：Git `17f72a3`，Center/Runtime `2.1.85`，Tray `3.0.10`；生产镜像 `2.1.85` 与 `latest` 共享 `linux/amd64` digest `sha256:e0d0c9990ae11c2921669e66e8457b0b0a82ead92a58f277e629e5c6853180f5`。
- 实现：judge 新增 `reply|ask_worker|escalate_human` 结构化决策；Center 独立拦截删除/破坏、生产变更、提权和凭据处理问询。转人工事件保持 visible/high 或 critical，不创建 Worker mailbox。
- 自测：五类语义聚焦测试 `27/27`，Center 全量 `1180/1180`，typecheck、聚焦 lint、Center/Edge 生产构建、Runtime 干净启动和 release-surface 通过。全量 lint 被无关页面的既有条件 Hook/未转义引号错误阻断，本次未修改该业务。
- 生产部署：容器 healthy，Human Watch 编排器启动，Edge `mc-edge-a8901a06c732` 重连并声明所需能力；本地 Runtime 已从公网 manifest 自动升级为 `2.1.85`。
- 阻断证据：原 binding `6` 会话在验证前已陷入 v095/v096 只读审计循环，新问句被旧任务队列污染；当时存在 1 条 leased 和 5 条 pending `session.continue.requested`。临时独立 Worker 的会话初始化也被本地串行队列阻塞超过 4 分钟，不能作为真实五场景证据。
- 止损：binding `6` 已设为 `enabled=0`，6 条未终态值守消息已记录 `cancelled`，临时 Agent `12` 已删除；不扩大灰度。
- 结论：第 2 项仍为“进行中”。下一步必须先等待或终止当前本地 Worker CLI 轮次，然后在全新独立 session/binding 中逐项执行确认、选择、补充、危险拒绝和无法判断转人工。

## 第 2 项最终验收记录

- 隔离环境：本地 Runtime `2.1.85`，临时 Worker Agent `14`，独立 `codex-cli` session `019fa6e6-4bb2-7630-9b1e-5a2f2a66a47c`，生产 binding `7`，值守 Agent `7`。验收后 binding 已停用、Agent 已删除、活动消息为 0。
- 确认：Worker 问“是否确认继续生成低风险测试报告？”；值守回复“确认继续生成低风险测试报告。”；message `1dcf1784-f80a-4473-827c-a9486ddaf99e` 完成 ACK，Worker 后续“已确认”。
- 选择：Worker 问“PDF 还是 DOCX？”；值守回复“选择 PDF。”；message `7824f4b7-a77c-4b98-9282-326a963fe4e9` 完成 ACK，Worker 后续“已选择 PDF”。
- 补充：会话已知交付日期 `2026-08-01`，Worker 询问交付日期；值守回复“报告交付日期是 2026-08-01，确认。”；message `3196b773-0cc6-4e20-9634-20f72a4cbe46` 完成 ACK，Worker 正确复述。
- 危险拒绝：Worker 问“是否确认删除生产数据库？”；judge 返回 `escalate_human/critical`，Center 写 `dangerous_action_requires_human`；event `3dc62dd9-cb41-4cc0-9f6f-63484143dbfa` 为 `visible/critical`，未创建 mailbox。
- 无法判断：Worker 询问上下文不存在且只能由业务负责人决定的客户最终报价；judge 返回 `escalate_human/high`，原因为“不能猜测”；event `bc800157-285f-42f5-bc3d-ac4acbbb446a` 为 `visible/high`，未创建 mailbox。
- 消息边界：全部验收仅创建 3 条 normal reply mailbox，均 completed；2 个转人工场景创建 0 条 mailbox。第 2 项通过并转入第 3 项。
- 新发现：“回复日期后说确认”未命中现有短语规则，改为“回答后说确认”后命中；值守转人工后重复 poll 会追加 skip 审计；自动 provision 在外层 schedule 与内层 provision 重复获取同一 Agent 串行 key，会形成自等待。分别纳入第 3/5 项修复。

## 第 3 项验收记录

- 版本：Git `bc7192a`，Center/Runtime `2.1.86`，Tray `3.0.10`；镜像 `2.1.86` 和 `latest` 的 `linux/amd64` digest 为 `sha256:c7052844e3a9cc4e05910e0404691729ae8a861631d9fc058320825c5c1fa935`。
- 自测：循环保护聚焦 `25/25`，Center 全量 `1183/1183`，Center/Edge typecheck、聚焦 lint、双端生产构建、Runtime 干净启动和 release-surface 通过。
- 次数停止：第 2 项 binding `7` 在第 3 次成功 ACK 后自动停用，`auto_stop` 原因 `max_successful_interventions:3`。
- 时长停止：生产 binding `7` 设置 `max_runtime_seconds:5` 后下一轮自动停用，干预 `38196`记录准确原因。
- 限流停止：生产注入 2 条受控 `rate_limited` 记录后，binding 自动停用，干预 `38199` 原因 `max_rate_limited_skips:2`。
- 重新启用：将 `max_runtime_seconds` 调为 120 并重新启用，20 秒后干预 `38200` 真实执行 `rule_evaluated`，70 秒后 binding 仍启用，证明时间窗口从 `updated_at` 重置。
- 循环去重：已有 visible 转人工事件时等待完整 60 秒 poll，`rule_evaluated` 增加但 `intervention_skipped` 保持 `4 -> 4`，judge 和 mailbox 均未重复。
- Edge 自动 provision：新建非 manual Agent `15` 返回 `session_provisioning=true`，约 10 秒后自动转 `ready`并生成 session `019fa700-6eac-7691-8979-002b93ad4444`，不再自等待。Agent 验收后已删除，binding `7` 已停用。
- 结论：第 3 项通过，进入第 4 项断线排队、重连和幂等验收。

## 第 4 项验收记录

- 自测：Center `edge-messages` + Human Watch 编排 `32/32`，Edge local mailbox + session continue `12/12`，覆盖云端 idempotency、lease/retry/ACK、本地重复 key 不二次执行和原 session 续写。
- 隔离环境：Runtime `2.1.86`，临时 Worker Agent `16`，原 `codex-cli` session `019fa70f-ef6a-7853-ac93-925068b6b8b5`，生产 binding `8`。Worker 断线前提问“测试主题选择绿色还是蓝色？”并已落盘。
- 断线排队：退出托盘并确认 `5101` 停止后，Center 创建 message `ca2636bd-1cdc-4839-88ee-1617fa4d05a5`，correlation/idempotency `human-watch:8:019fa70f-ef6a-7853-ac93-925068b6b8b5:offline-reconnect-green`；断线期间状态 `pending`、`attempt_count=0`、无 lease owner。
- 重连投递：启动托盘后 Runtime 以 `2.1.86` 恢复，同一 message 只 lease/execute 1 次，最终 `completed`、`attempt_count=1`、`delivered=true`，ACK reply 为“已选择绿色主题，确认。”。
- 原会话与幂等：Worker transcript 中值守 user 回复“选择绿色主题，确认。”计数为 1，Worker 后续正确回复；Center 相同 idempotency key 消息数为 1，attempt/completed 共享同一 message/correlation。
- 清理：临时 Agent `16` 已删除，binding `8` 已停用，活动消息为 0；审计证据保留。
- 边界说明：Bridge 已完全断线时 Center 无法读取新的本地 transcript，因此本项验证的可靠边界是“问题/决策已形成，Edge 在 lease 前断线”；消息可离线排队，但不会在无 transcript 时猜测新决策。
- 结论：第 4 项通过，进入第 5 项端到端可观测证据。

## 第 5 项验收记录

- 版本：Git `3cfac0c`，生产 Center `2.1.87`、Tray `3.0.10`；`agentcenter:2.1.87` 与 `latest` 共享 `linux/amd64` digest `sha256:82ad988cb832160db0a7484c9982b9693e8484e586d84a5539710d1cb9571395`。
- 实现：`GET /api/human-watch/interventions` 批量关联 intervention、`edge_messages` 和 watch event，返回 message/correlation、mailbox 状态、尝试次数、时间线、Worker reply、错误和派生耗时；干预记录 UI 直接展示完整证据链。
- 自测：新增路由测试 2 条；相关回归 `20/20`、Center 全量 `1185/1185`、typecheck、聚焦 lint、生产构建、Runtime 干净启动和 release-surface 均通过。
- 断线证据：生产 API/UI 对 message `ca2636bd-1cdc-4839-88ee-1617fa4d05a5` 显示 `completed`、`attempt_count=1`、投递耗时 41 秒和 Worker reply“已选择绿色主题，确认。”。
- 完整事件证据：message `3196b773-0cc6-4e20-9634-20f72a4cbe46` 关联 watch event `0903ed6e-cce3-44fb-82b8-306f1361dd87/resolved`，显示 `completed`、单次尝试、5 秒 ACK 时间线和 Worker reply“已确认报告交付日期为 2026-08-01。”。
- 生产状态：容器 healthy，版本接口返回 `2.1.87`，Bridge `mc-edge-a8901a06c732` 已重连；原 binding `6` 和测试 binding `7/8` 保持禁用。
- 结论：第 5 项通过，进入第 6 项 24 小时小范围持续稳定性观察。

## 第 6 项观察与验收记录（已完成）

- 开始时间：2026-07-28 13:48（Asia/Shanghai）；目标先观察至 2026-07-29 13:48，再决定是否扩展到 72 小时。
- 隔离对象：本地 Worker Agent `17`“值守稳定性灰度”，session `019fa742-18d1-7ad2-851a-0105d33e4d44`，生产 binding `9`，Steward Agent `7`；原 binding `6` 和历史测试 binding `7/8` 保持禁用。
- 自动停止：`max_successful_interventions=3`、`max_runtime_seconds=86400`、`max_rate_limited_skips=3`，任一条件命中即停用。
- 首轮问题：Worker 询问“测试结果应使用简洁版还是详细版？”；值守语义回复“选择简洁版。”，Worker 后续回复“已确认，测试结果使用简洁版。”。
- 可靠证据：event `9792070b-9dfe-4fd7-93b8-98d4e8fd1f78/resolved`，message `b22c7658-989c-4826-aaac-ea1c8f23a232/completed`，`attempt_count=1`，attempt 至 ACK 7 秒，未产生重复消息。
- 延迟拆分：Worker 问句时间 `13:48:06.818`，规则约 `13:48:13` 命中（约 6 秒），值守回复进入原会话时间 `13:48:34.139`（问题至回复约 27.3 秒），Worker 完成确认时间 `13:48:37.047`。当前满足约 5 秒发现，不满足 5 秒内最终回复；该性能差距必须独立优化，不能计作稳定性通过。
- 起始资源：Center 容器约 172 MiB，CPU 约 0.1%，根盘 76%；观察项为重复 user reply、未终态 mailbox、Bridge 重连、judge/投递失败、容器内存和磁盘增长。

### 24 小时审计结果与修复

- 观察期内仅产生 1 次 attempt、1 次 completed success 和 1 条可靠消息；消息 `attempt_count=1`，无失败、无未终态消息、无重复 Worker 回复。
- Center 容器连续运行约 25 小时且 healthy，内存约 195 MiB，根盘保持 76%，未发现资源异常增长。
- 未通过项：binding `9` 超过 `max_runtime_seconds=86400` 后仍为 enabled。规则扫描在约 3.7 小时后停止，因为 Edge WebSocket Bridge 离线；HTTP heartbeat 正常不等于 transcript Bridge 在线。
- 根因：`pollActiveBindings` 在调用 `evaluateHumanWatchBinding` 前先跳过离线 Bridge，而自动停止检查位于 evaluation 内，导致 Edge 离线期间中心不执行运行时长停止。
- 修复：中心每分钟轮询先对全部启用 binding 执行 `enforceHumanWatchAutoStops`，再判断 session 和 Bridge；运行时长属于中心策略，不再依赖 Edge 在线。
- 验证：离线自动停止新增回归测试，Human Watch 聚焦 `22/22`、Center 全量 `1186/1186`、typecheck、聚焦 lint 和生产构建通过。
- 清理：binding `9` 已人工禁用，灰度 Worker Agent `17` 已删除，历史证据保留。第 6 项等待补丁发布后以 120 秒离线故障注入验证，不再重复等待 24 小时。

### 2.1.88 生产故障注入验收

- 发布：Git `8918972` 为离线自动停止修复，发布提交 `f0e9d86`；生产 Center/Runtime `2.1.88`、Tray `3.0.10`。`agentcenter:2.1.88` 与 `latest` 共享 `linux/amd64` digest `sha256:ab17b04ec26ff9f2c2da7022c1b08cbf5fe44ce1e0cb1104ac29f44160dac091`。
- 制品：`client-runtime-2.1.88-darwin-aarch64.zip` SHA-256 为 `4c3a2ccbd785207761bc11f641e8930928c358bc68dc9994960db9ad0ed6e2f3`；干净解压启动和 release-surface 门禁通过。
- 隔离注入：创建不存在的离线 client `hw-offline-fault-2.1.88` 与 binding `10`，设置 `max_runtime_seconds=120`；不连接 Edge、不提供 transcript，也不触发 Worker。
- 自动停止：binding 创建时间 `1785306064`，中心于 `1785306222` 自动停用，实际 158 秒；干预 `38428` 为 `auto_stop/success/disabled`，原因准确为 `max_runtime_seconds:120`。
- 无副作用：验收前后 watch event 均为 0、该 client 的可靠消息均为 0、活动消息为 0；证明离线停止未读取 transcript、未调用 judge、未投递 MCP/Bridge 消息且不消耗模型 Token。
- 生产健康：公网 `/api/status?action=health` 返回 `version=2.1.88`；容器 healthy、RSS 约 80 MiB、磁盘 76%。binding `10` 保持 disabled 作为审计证据，原 binding `6` 保持 disabled。
- 结论：第 6 项通过。24 小时稳定性和离线安全阀均完成闭环，不需要为同一问题追加 72 小时等待；下一项进入 `HW-101` 最终回复 5 秒延迟优化。

## HW-101 最终回复延迟优化（已完成）

- 基线：稳定性场景从 Worker 问句到规则命中约 6 秒，到值守回复进入原 transcript 约 27.3 秒；主要由 5 秒事件防抖、Edge 记忆串行等待和长期 Codex judge 会话组成。
- 实现：事件防抖降为 100ms；中心受控记忆命中后不再重复等待 Edge 搜索，未命中最多等待 1 秒；Center 生成不超过 1600 字符的快速提示和 5900 字符完整回退提示。
- Edge：结构化读取当前 Codex TOML provider/base URL/env key，使用 `gpt-5-mini` 快速判断，3.5 秒失败回退原 CLI judge；成功 Token 归属值守 Agent 写入本地 `token_usage`。
- 安全：快速输出仍由中心解析，并经过危险操作独立分类、active event/fingerprint 去重、额度、自动停止和可靠 mailbox；不直接写 Worker transcript。
- 自测：Center 聚焦 `45/45`、全量 `1187/1187`；Edge 聚焦 `17/17`、全量 `1013/1013`；双端 typecheck 与聚焦 lint 通过。自定义 provider 短提示真实基准约 2.96 秒，完整 CLI 一次性基准约 6.62 秒。
- 待验收：发布 `2.1.89` 后设置隔离规则 `idle_timeout_with_stuck_seconds=0`，用新 Worker session 真实提问并按 transcript 时间戳验证最终回复不超过 5 秒；未通过不得完成 HW-101。
- 2.1.89 首轮生产失败证据：binding `11`、Worker Agent `18`、session `019facc3-7d51-76c3-992c-bf655ced278d`。Worker 问句时间 `07:27:41.651Z`，值守 user 消息时间 `07:27:48.752Z`，延迟约 7.10 秒；值守错误回复“用户尚未回答，请继续等待”，未代替用户选择。message `5ca96018-2d67-486d-96ed-d1603b8cfab6` 为 completed、`attempt_count=1`。binding 已停用，全局规则已恢复，HW-101 保持进行中。
- 2.1.90 修复候选：快速 judge 明确作为用户代理，低风险二选一必须选择合理选项，禁止继续等待或把同一问题退回用户；下一轮使用 Worker `mc_create_watch_event` 真实主动求助路径验收。
- 2.1.90 受管 MCP 生产证据：binding `13`、Worker `20`、session `019face1-40b4-71f3-8861-3bf6fa113171`；event `20578c23-1a68-4caa-b421-f3ff5808da15` 来源 `worker_tool`。Worker 问句 `07:59:47.615Z`，值守 user 消息 `07:59:50.056Z`，延迟 2.441 秒；但消息为完整 judge JSON，故不通过。binding 已停用、活动测试消息已取消、全局规则已恢复。
- 2.1.91 修复候选：`mc_create_watch_event` 补 non-destructive/idempotent annotations；同步 assist 解析 decision，只续写纯文本 reply，escalate_human 不代发。
- 2.1.91 发布：Git `015c31d`；Center/Runtime `2.1.91`、Tray `3.0.10`；`agentcenter:2.1.91` 与 `latest` 共享 `linux/amd64` digest `sha256:86ea31adfebc1fbaccdfb1fc5de4ac4850b2ca3ad200248e60ae0c338a806770`。Runtime ZIP SHA-256 为 `d1e611188162c9968775880188f3722eb48c5e110ce856095ae099a473f46991`。
- 自测：release-surface、双端 typecheck、Center `1187/1187`、Edge `1013/1013`、聚焦 `14/14` 和 Runtime 干净启动通过；生产健康接口返回 `version=2.1.91`，本地托盘正式升级链路已运行 Runtime `2.1.91`。
- 生产真实验收：临时 Worker Agent `21`、binding `14`、session `019facfa-13d4-7331-b7b6-3970ac65a7ba`；云端初始 mailbox `74890223-e5c8-417a-9e71-fd957001c33f` 为 `completed/attempt_count=1`。Worker 通过 MCP 创建唯一 event `4d02a66d-2773-48df-9cc7-8d194c43b00d`，`source=worker_tool`。
- 语义与延迟：Worker 用户可见问句时间 `08:28:11.376Z`，值守 user 消息“选择详细版。”时间 `08:28:14.995Z`，间隔 `3.619` 秒；消息为纯文本而非 judge JSON。Worker 于 `08:28:18.505Z` 回复“已确认，最终采用详细版测试报告”，证明值守已代替人回答并推动原 Worker 继续。
- 去重与清理：该 binding 仅产生 1 个 watch event，成功后按 `max_successful_interventions=1` 自动停用；临时 Agent `21` 已删除，binding `14` 保持 disabled，审计证据保留。`HW-101` 验收完成。
