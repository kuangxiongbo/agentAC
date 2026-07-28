# 值守 Agent 真实代答闭环与稳定性跟踪

更新日期：2026-07-28

## 目标

当受管 Worker 在真实会话中等待用户确认、选择或补充信息时，值守 Agent 必须在约 5 秒内理解完整上下文，通过 MCP/可靠 Bridge 向原 Worker 会话发送有语义的回复，使 Worker 继续执行；全过程可审计、可停止、可去重且不会形成无限循环。

## 执行看板

| 项 | 范围 | 状态 | 验收门禁 |
|---|---|---|---|
| 0 | 生产基线与前置条件审计 | 已完成 | 2.1.83 的授权、绑定、会话、Bridge、MCP 和健康指标可用 |
| 1 | 可重复的真实 Worker 问询夹具 | 已完成 | 可稳定产生等待确认并保留 Worker transcript、事件和 message ID |
| 2 | 五类语义代答 | 进行中 | 确认、选择、补充信息、危险拒绝、无法判断转人工均符合问题语义 |
| 3 | 自动停止与循环保护 | 待开始 | 次数、时长、限流停止均生效；重新启用不立即再次停止 |
| 4 | 断线排队、重连与幂等 | 待开始 | Bridge 断线期间排队，重连只投递一次且回复进入原会话 |
| 5 | 端到端可观测证据 | 待开始 | UI/API 可关联触发、判断、投递、ACK、Worker 后续状态和失败原因 |
| 6 | 小范围持续稳定性 | 待开始 | 先连续 24 小时无重复回复、堆积和资源异常，再扩展到 72 小时 |

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
