# PRD-人工值守-三端协同通信优化

## 1. 文档信息

| 项 | 内容 |
|----|------|
| 文档状态 | 待评审 |
| 当前版本 | V0.1 |
| 更新时间 | 2026-07-05 |
| 适用产品 | Agent 指挥仓 / Mission Control |
| 关联能力 | 人工值守、托盘客户端、本地 Web、云端服务端、Bridge、MCP |
| 设计来源 | 2.1.18 人工值守 assist 上线复盘、`claude_codex_bridge` mailbox/daemon 设计思路 |

## 2. 背景

当前产品存在三种运行形态：

1. 云端服务端 `mission-control`：控制面、授权、审计、策略和远程 Bridge 入口。
2. 本地 Web/Edge `mission-control-client`：本机 API、会话读写、CLI 执行、MCP 工具代理。
3. 托盘客户端 `mission-control-tray`：常驻 supervisor、启动本地 Web、安装/升级 runtime、保持本机入口。

2.1.18 已经补齐 Worker prompt-only MCP 主动求助到 `/api/human-watch/assist` 的服务端闭环。但真实线上验证暴露出一个关键问题：服务端能生成 assist 投递请求，Bridge 也正常启动，但目标本地 Edge/托盘不在线时，消息只能返回 `Bridge client is offline`，不能进入可恢复的异步队列。

人工值守不应依赖“云端调用时本地刚好在线”。它需要一个跨三端的可靠通信机制：本地可以离线缓存，云端可以持久排队，托盘负责本机 supervisor，本地 Web 负责执行面，本地恢复在线后自动拉取/确认/回放。

## 3. 问题定义

### 3.1 在线耦合过强

当前云端 assist、continue、transcript 等操作主要依赖 Bridge 在线实时 RPC。客户端离线、重启、本地 Web 未启动、托盘未拉起 runtime 时，云端只能失败，无法保留待投递消息。

### 3.2 三端职责边界不够清晰

托盘、本地 Web 和云端都承担了一部分“连接/执行/同步”职责，但缺少统一消息模型，导致：

- 托盘不知道云端是否有待处理任务。
- 云端不知道本地 Web 未启动还是 Bridge token 错误。
- 本地 Web 重启后不能从云端可靠恢复未完成命令。
- 人工值守消息、权限审批、session continue、runtime 指令缺少统一 ack/retry 语义。

### 3.3 人工值守回复缺少异步补偿

当 Worker 通过 MCP 请求值守回复时，如果值守 Agent 或 Worker 所在边缘节点离线，当前请求只能失败。用户看到的现象是“机制触发了但没有智能回复”，排障需要查多处状态。

### 3.4 通信缺少可观测状态

现在 Bridge health 能看到 connectedClients，但不能回答：

- 云端待投递多少消息？
- 哪条消息卡在 ack、lease、执行、回写？
- 客户端最后一次 pull/ack 是什么时候？
- 是 token 错误、版本不兼容、runtime 未启动、还是执行失败？

## 4. 产品目标

1. 建立三端统一通信内核：云端 relay + 本地 mailbox + 托盘 supervisor。
2. 人工值守、权限请求、session continue、runtime 控制使用统一消息信封和状态机。
3. Bridge 在线时实时推送，Bridge 离线时落库排队，本地恢复在线后自动拉取处理。
4. 所有跨端消息必须有 `message_id`、`correlation_id`、`ack`、`lease`、`retry`、`dead_letter`。
5. 云端 UI 能展示客户端在线、runtime 健康、mailbox backlog、最近错误和待处理人工值守消息。
6. 不破坏现有同步和实时 RPC；V1 采用兼容增量方式，把关键链路先接入可靠消息。

## 5. 非目标

1. V1 不替换全部 Bridge RPC；只把人工值守 assist、permission decision、session continue 投递纳入可靠队列。
2. V1 不实现 P2P 或局域网穿透；云端 relay 仍是跨网络控制面。
3. V1 不让云端直接执行本机 CLI；执行仍在本地 Web/Edge。
4. V1 不要求用户手动操作消息队列；UI 只展示状态和重试/取消。
5. V1 不把普通聊天 transcript 全量同步为消息队列；transcript 仍使用现有读取接口。

## 6. 角色与使用场景

| 角色 | 诉求 |
|------|------|
| 租户管理员 | 看到每个客户端是否在线、是否有待投递值守消息、失败原因和重试入口 |
| 平台操作者 | Worker 卡住时值守回复能自动补偿，不因本地短暂离线丢失 |
| 本地用户 | 托盘启动后能自动恢复云端下发的任务，无需手动刷新 |
| 值守 Agent | 通过 MCP/API 发送结构化协助请求后，平台负责可靠投递 |
| 运维人员 | 能通过统一消息状态定位云端、托盘、本地 Web、CLI 哪一层失败 |

## 7. 核心概念

| 概念 | 定义 |
|------|------|
| Cloud Relay | 云端持久消息中转，按租户、客户端、Agent、会话分区 |
| Local Mailbox | 本地 Web 的持久 inbox/outbox，保存待执行和待上报消息 |
| Tray Supervisor | 托盘常驻进程，负责启动 runtime、健康检查、触发本地 sync |
| Message Envelope | 统一消息信封，包含类型、目标、载荷、幂等键、重试策略 |
| Lease | 客户端领取消息后的处理租约，超时未 ack 自动释放重试 |
| Ack | 客户端或云端确认消息处理完成 |
| Dead Letter | 超过重试次数或不可恢复错误后的失败队列 |
| Correlation ID | 贯穿 Worker MCP、云端 assist、值守 judge、Worker continue 的追踪 ID |
| Serial Inbox | 单 Agent/单会话串行队列，避免并发 continue 写乱 Worker 会话 |

## 8. 用户故事

### US-001 Worker 请求值守，客户端在线

Worker 调用 `mc_create_watch_event(prompt)`，本地或云端创建 `human_watch.assist.requested` 消息；云端立即推送给对应客户端；客户端读取 Worker transcript，调用值守 judge，写回 Worker；云端状态变为 `completed`，UI 显示一次成功介入。

### US-002 Worker 请求值守，客户端离线

Worker 调用 MCP 时云端发现目标客户端离线。平台不直接丢弃，而是创建 pending 消息并提示“已排队，等待客户端上线”。托盘恢复后本地 Web 拉取消息并执行。执行完成后云端 audit 显示延迟投递成功。

### US-003 云端下发 session continue，本地 Web 重启

云端创建 `session.continue.requested`。本地 Web 领取 lease 后重启，未 ack。lease 超时后云端重新开放消息；本地恢复后再次领取。由于幂等键相同，本地检测未写入过该 continue 时才执行，避免重复发消息。

### US-004 值守 judge 成功但 Worker continue 失败

消息状态进入 `failed_retryable`，记录 `stage=worker_continue`、错误原因和下一次重试时间。UI 可以手动重试或取消。超过最大次数后进入 dead letter。

### US-005 本地先完成审批，云端短暂不可达

本地将 decision 写入 Local Outbox。网络恢复后上传到 Cloud Relay。云端根据幂等键写入权限请求状态，重复上传不产生重复决策。

## 9. 功能需求

### FR-001 统一消息信封

所有可靠跨端操作使用统一 envelope：

- `message_id`：全局唯一。
- `tenant_id`、`workspace_id`。
- `client_id`：目标客户端。
- `agent_ref`：可选，目标 Agent。
- `session_ref`：可选，目标会话。
- `type`：消息类型。
- `direction`：`cloud_to_edge`、`edge_to_cloud`。
- `correlation_id`：链路追踪。
- `idempotency_key`：业务幂等键。
- `payload`：JSON 载荷。
- `status`：消息状态。
- `lease_owner`、`lease_expires_at`。
- `attempt_count`、`max_attempts`、`next_attempt_at`。
- `created_at`、`updated_at`、`completed_at`。
- `last_error_code`、`last_error_message`。

### FR-002 消息类型

V1 必须支持：

| 类型 | 方向 | 说明 |
|------|------|------|
| `human_watch.assist.requested` | cloud_to_edge | 云端要求本地执行值守 assist |
| `human_watch.assist.completed` | edge_to_cloud | 本地回传 assist 结果 |
| `session.continue.requested` | cloud_to_edge | 云端要求本地向 Worker 写入 user 消息 |
| `session.continue.completed` | edge_to_cloud | 本地回传 continue 执行结果 |
| `permission.decision.requested` | cloud_to_edge | 云端同步审批决策给边缘 |
| `permission.decision.completed` | edge_to_cloud | 边缘确认决策已应用 |
| `client.status.heartbeat` | edge_to_cloud | 本地状态、runtime、backlog、错误摘要 |

V1.1 可扩展：

- `transcript.snapshot.requested`
- `runtime.ensure.requested`
- `agent.sync.requested`

### FR-003 云端 Relay

云端新增持久消息表和 API：

1. 支持按 `client_id` 查询 pending 消息。
2. 支持客户端批量领取消息并设置 lease。
3. 支持 ack、fail、retry、dead letter。
4. 支持单会话串行：同一 `client_id + session_ref` 下 `session.continue.requested` 不能并发执行。
5. Bridge 在线时可推送“有新消息”通知；客户端仍以 pull + lease 为准，避免推送丢失。

### FR-004 本地 Mailbox

本地 Web 新增本地消息表：

1. `local_inbox`：保存云端下发并已领取的消息。
2. `local_outbox`：保存待上传云端的完成/失败/状态消息。
3. 本地执行前先落库，执行后再 ack 云端。
4. 本地重启后继续处理未完成 inbox；上传 outbox。
5. 本地按 Agent/Session 串行执行，避免同一 Worker 被并发写入。

### FR-005 托盘 Supervisor

托盘新增职责：

1. 启动或恢复本地 Web runtime。
2. 监控 `127.0.0.1:5101/api/status?action=health`。
3. 发现本地 Web 未启动时自动拉起。
4. 定期调用本地 Web sync 接口，触发 mailbox drain。
5. 在 UI/日志中展示：中心 URL、client_id、Bridge 在线、runtime 版本、mailbox backlog。

### FR-006 人工值守接入可靠消息

`/api/human-watch/assist` 的行为改造为：

1. 如果目标 Bridge 在线且支持可靠消息，创建 envelope 并可立即触发 push。
2. 如果 Bridge 离线，仍创建 pending envelope，返回 `queued: true`。
3. 对实时调用方返回：
   - `delivered: true`：已执行并写回 Worker。
   - `queued: true`：已排队。
   - `failed: true`：不可恢复错误。
4. `human_watch_events/interventions` 记录 `message_id`、`correlation_id`、queue 状态。
5. 服务端不再把“客户端离线”视为 assist 业务失败；它是待投递状态。

### FR-007 状态与可观测

中心 UI/API 必须展示：

- 客户端在线状态。
- Bridge 连接状态。
- 本地 Web runtime 状态。
- pending / processing / failed / dead letter 消息数。
- 最近 20 条失败消息。
- 指定 Worker/会话的消息链路。

### FR-008 安全与授权

1. 消息创建、领取、ack 必须校验租户、workspace 和 client 归属。
2. Edge 客户端只能领取自身 `client_id` 的消息。
3. 消息 payload 不写入 API key、token、私钥。
4. 高风险审批仍走权限请求状态机，不允许值守绕过。
5. 所有人工值守 continue 必须落 audit。

## 10. 状态机

```text
pending
  -> leased
  -> completed
  -> failed_retryable -> pending
  -> dead_letter
  -> cancelled
```

规则：

- `leased` 超过 `lease_expires_at` 未 ack，回到 `pending`。
- `attempt_count >= max_attempts` 后进入 `dead_letter`。
- 非法目标、授权失败、payload 不兼容进入 `dead_letter`。
- 用户手动取消进入 `cancelled`。

## 11. 验收标准

1. 客户端离线时调用 assist 返回 `queued=true`，云端可查 pending 消息。
2. 客户端重新上线后，pending assist 自动执行并写回 Worker。
3. 本地 Web 在领取消息后重启，lease 超时后可重新处理且不重复写入 continue。
4. UI 能看到每个客户端的 mailbox backlog 和最近失败原因。
5. `human_watch_interventions` 能通过 `correlation_id/message_id` 追踪到完整链路。
6. 权限请求高危审批不因新消息机制被绕过。
7. 服务端、本地 Web、托盘 typecheck 和关键单测通过。

## 12. 风险与灰度

| 风险 | 缓解 |
|------|------|
| 消息重复执行 | 幂等键 + 本地执行记录 + 单会话串行 |
| 队列堆积 | 配额、限流、dead letter、UI 告警 |
| 客户端版本不兼容 | envelope `schema_version` + capability 握手 |
| 本地 outbox 丢失 | 本地 SQLite 落库后再执行/ack |
| Bridge 推送和 pull 冲突 | push 只作为唤醒，pull + lease 为事实 |
| 复杂度过高 | V1 只接入人工值守、continue、权限决策三条链路 |

