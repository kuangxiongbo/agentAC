# TODO-人工值守-三端协同通信优化

## 0. 当前目标

把人工值守从“Bridge 在线实时调用”升级为“云端可排队、本地可恢复、托盘可唤醒”的三端可靠通信机制。

核心验收：

- 客户端离线时，`/api/human-watch/assist` 返回 `queued=true`，云端可查 pending 消息。
- 客户端上线后，pending assist 自动执行并写回 Worker。
- 本地 Web 重启后，已领取未 ack 的消息可恢复处理，且不会重复写入 Worker。
- 云端 UI/API 能查到 pending、leased、failed、dead letter 和最近错误。

## 1. P0 云端 Relay

- [x] `HW-COMM-001` 新增中心 migration：`edge_messages`。
- [x] `HW-COMM-001` 新增中心 migration：`edge_message_events`。
- [x] `HW-COMM-002` 实现 `edge-message-service` 的 `createMessage`。
- [x] `HW-COMM-002` 实现 `leaseMessages`，支持 `lease_owner`、`lease_expires_at`。
- [x] `HW-COMM-002` 实现 `ackMessage`。
- [x] `HW-COMM-002` 实现 `failMessage`，支持 retry 和 dead letter。
- [x] `HW-COMM-002` 实现 `cancelMessage`。
- [x] `HW-COMM-002` 实现幂等键：`tenant_id + client_id + idempotency_key`。
- [x] `HW-COMM-002` 实现同 `serial_key` 单条 leased 限制。
- [x] `HW-COMM-003` 新增 `POST /api/edge/messages`。
- [x] `HW-COMM-004` 新增 `POST /api/edge/messages/lease`。
- [x] `HW-COMM-005` 新增 `POST /api/edge/messages/{id}/ack`。
- [x] `HW-COMM-005` 新增 `POST /api/edge/messages/{id}/fail`。
- [x] `HW-COMM-005` 新增 `POST /api/edge/messages/{id}/cancel`。
- [x] `HW-COMM-005` 新增 `GET /api/edge/messages`。
- [x] `HW-COMM-005` 新增 `GET /api/edge/messages/{id}`。
- [x] `HW-COMM-006` Bridge hello 上报 `reliable_mailbox` 等 capability。
- [x] `HW-COMM-006` 服务端 Bridge welcome 返回可靠消息 capability。
- [x] `HW-COMM-006` `/api/bridge/clients` 返回客户端 capability。
- [x] `HW-COMM-025` 增加灰度开关 `MC_RELIABLE_EDGE_MESSAGES`。

## 2. P0 本地 Mailbox

- [x] `HW-COMM-007` 新增本地 migration：`local_message_inbox`。
- [x] `HW-COMM-007` 新增本地 migration：`local_message_outbox`。
- [x] `HW-COMM-008` 实现 `local-mailbox-service.pullAndLease`。
- [x] `HW-COMM-008` 实现云端消息落本地 inbox。
- [x] `HW-COMM-008` 实现本地执行前状态更新为 processing。
- [x] `HW-COMM-008` 实现执行结果落 local outbox。
- [x] `HW-COMM-008` 实现 outbox 上传和云端 ack/fail。
- [x] `HW-COMM-008` 实现本地重启后恢复未完成 inbox。
- [x] `HW-COMM-018` 实现同一 `session_ref.serial_key` 串行执行锁。
- [x] `HW-COMM-018` 实现本地幂等执行记录，避免重复 continue。

## 3. P0 人工值守接入

- [x] `HW-COMM-014` 实现 `human_watch.assist.requested` 本地执行器。
- [x] `HW-COMM-014` 执行器读取 Worker transcript。
- [x] `HW-COMM-014` 执行器调用值守 judge。
- [x] `HW-COMM-014` 执行器调用 Worker `sessions/continue`。
- [x] `HW-COMM-015` `/api/human-watch/assist` 支持 `delivery_mode=auto`。
- [x] `HW-COMM-015` `/api/human-watch/assist` 支持 `queue_if_offline=true`。
- [x] `HW-COMM-015` 支持新客户端离线时返回 `queued=true`。
- [x] `HW-COMM-015` 保留旧客户端实时 Bridge RPC fallback。
- [x] `HW-COMM-020` `human_watch_interventions` 增加 `message_id`。
- [x] `HW-COMM-020` `human_watch_interventions` 增加 `correlation_id`。
- [x] `HW-COMM-021` MCP `mc_create_watch_event` 展示 queued 语义。

## 4. P1 托盘和状态展示

- [x] `HW-COMM-009` 新增本地 `GET /api/local/mailbox/status`。
- [x] `HW-COMM-010` 新增本地 `POST /api/local/mailbox/drain`。
- [x] `HW-COMM-011` 托盘读取 mailbox status。
- [x] `HW-COMM-011` 托盘展示 pending / failed / last_error。
- [x] `HW-COMM-012` 托盘本地 Web 启动成功后触发 drain。
- [x] `HW-COMM-012` 托盘 Bridge 连接成功后触发 drain。
- [x] `HW-COMM-012` 托盘定时触发 drain。
- [x] `HW-COMM-013` Bridge 新增消息 wakeup 事件。
- [x] `HW-COMM-019` 中心客户端详情展示 mailbox backlog。
- [x] `HW-COMM-019` 中心人工值守页面展示 failed/dead letter。

## 5. P1 其他可靠消息类型

- [x] `HW-COMM-016` 实现 `session.continue.requested` 执行器。
- [x] `HW-COMM-016` 云端 continue 调用支持可靠消息投递。
- [x] `HW-COMM-017` 实现 `permission.decision.requested` 执行器。
- [x] `HW-COMM-017` 权限决策边缘补偿接入 outbox。

## 6. 测试 Todo

- [x] `HW-COMM-022` 云端消息状态机单测：create。
- [x] `HW-COMM-022` 云端消息状态机单测：lease。
- [x] `HW-COMM-022` 云端消息状态机单测：ack。
- [x] `HW-COMM-022` 云端消息状态机单测：fail retry。
- [x] `HW-COMM-022` 云端消息状态机单测：dead letter。
- [x] `HW-COMM-022` 云端消息状态机单测：cancel。
- [x] `HW-COMM-022` 幂等单测：相同 key 只创建一条。
- [x] `HW-COMM-022` 串行单测：同 serial_key 只 lease 一条。
- [x] `HW-COMM-020` 审计单测：intervention 记录可靠消息 `message_id/correlation_id`。
- [x] `HW-COMM-021` MCP 脚本级验证：prompt-only 请求默认 `delivery_mode=auto` 且返回 queued 追踪信息。
- [x] `HW-COMM-023` 本地 mailbox 单测：pull 后落 inbox。
- [x] `HW-COMM-023` 本地 mailbox 单测：执行结果落 outbox。
- [x] `HW-COMM-023` 本地 mailbox 单测：重启恢复 processing。
- [x] `HW-COMM-017` 本地 mailbox 单测：权限决策补偿写入 outbox。
- [x] `HW-COMM-018` 本地 mailbox 单测：重复 idempotency_key 不重复执行。
- [x] `HW-COMM-018` 本地 mailbox 单测：同 serial_key 一次只处理一条。
- [x] `HW-COMM-024` 集成测试：客户端离线 assist 返回 queued。
- [x] `HW-COMM-024` 集成测试：客户端上线后 queued assist 自动执行。
- [x] `HW-COMM-024` 集成测试：重复消息不重复写 Worker。
- [x] `HW-COMM-024` 集成测试：值守 Agent judge 参与回复并写回 Worker session。
- [x] 回归测试：值守 Agent 仍不能批准 high/critical 权限请求。

## 7. 发布 Todo

- [x] 默认关闭 `MC_RELIABLE_EDGE_MESSAGES`。
- [x] 发布前运行服务端 typecheck。
- [x] 发布前运行本地 Web typecheck。
- [x] 发布前运行新增消息状态机和 mailbox 单测。
- [x] 灰度环境开启 `MC_RELIABLE_EDGE_MESSAGES=1`。
- [x] 验证 assist 离线 queued、上线补偿。
- [x] 生产环境验证通过。
- [x] 验证关闭灰度开关后回到 2.1.18 实时 RPC 行为。
- [x] 更新 release notes 和运维排障文档。

## 8. 相关文档

- `文档/01-PRD/PRD-人工值守-三端协同通信优化.md`
- `文档/03-架构设计/架构设计-人工值守-三端协同通信优化.md`
- `文档/04-程序设计/接口设计-人工值守-三端协同通信优化.md`
- `文档/05-任务拆解/任务拆解-人工值守-三端协同通信优化.md`
