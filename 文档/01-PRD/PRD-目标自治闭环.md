# PRD-目标自治闭环

## 1. 文档信息

| 项 | 内容 |
|----|------|
| 文档状态 | 草稿（待确认） |
| 当前版本 | V0.1 |
| 更新时间 | 2026-08-07 |
| 适用产品 | Agent 指挥仓 / Mission Control |
| 关联需求 | PRD-值守目标监督与受控记忆（本文档在其基础上做增量） |
| 关联能力 | 目标(supervision)、任务中心、Worker、Bridge、可靠消息、记忆库、调度器 |
| 对应任务 | 见《任务拆解-目标自治闭环.md》（GA-01～GA-19） |

> 术语说明：产品对外统一使用「目标」这一名称；代码、数据库表、API 路径中的 `supervision` 标识符保持不变，仅改前端展示文案。本文中「目标」与代码里的 `supervision goal` 是同一事物。

## 2. 背景与问题

「目标监督（supervision）」能力已落地并通过 46 个定向单测。经代码核查，其**运行期后半段已是全自动**：中心调度器 `supervision_monitor`（`mission-control/src/lib/scheduler.ts`，约 60 秒一轮，默认开启）按序自动执行「预算检查 → 遗忘旧记忆 → 监督 → 纠偏 → 验收 → 记忆学习」。目标一旦进入 `running`，派发、监督、语义纠偏、独立验收、直至 `completed` 均无需人工。

但要达到用户期望的「服务端设完目标 → 自动拆解 → 派发 Worker → 自主监督 → 不断纠偏 → 直到达成」的**全自动、生产级**效果，当前存在如下缺口：

1. **不会自动生成计划**：新建目标停在 `planning`，需人工调用「生成计划」。模型自动拆解能力 `generateSupervisionGoalPlan`（`supervision-plans.ts`）已实现，但未被调度器纳入自动闭环。
2. **计划默认需人工批准**：`requires_plan_approval` 默认为真，计划停在 `awaiting_plan_approval` 等人工 `approve_plan` 才进入 `running`。
3. **成本预算形同虚设**：`consumeSupervisionModelCall` 的 estimatedCost 恒为 0，`max_estimated_cost` 永不触发；当前仅次数（`max_model_calls`）和时长（`max_runtime_seconds`）真正生效。
4. **闭环依赖 Worker 主动回调，无兜底**：Worker 必须调用 MCP 工具 `mc_complete_supervision_task` 任务才闭环、后继任务才激活；若 Worker 只回复文本「已完成」而不调工具，任务将永久悬挂，无超时兜底或降级验收。
5. **记忆「学到即自动生效」与发布策略冲突**：`steward-memory-learning.ts` 抽取的记忆直接写入 `approved`（生效），无人工审批闸门；而 PRD 发布策略要求「默认关闭记忆自动晋升」。需统一口径。
6. **缺全自动端到端验证**：各环单测齐全，但「从建目标无人工一路跑到 `completed`」及「重规划回路（回 `planning` 后自动重新规划+派发）」没有端到端测试，也没有真实生产验证。
7. **对外命名未统一为「目标」**：服务端菜单标签仍是英文 `Supervision`，面板内文案为「值守目标监督/监督事件」等，未统一为「目标」，且菜单标签未接入多语言。

## 3. 产品目标

1. 服务端新建目标后，在满足安全护栏的前提下**无需人工介入**即可自动完成：生成计划 → 批准 → 派发 → 监督 → 纠偏 → 验收 → 达成。
2. 保留并强化安全护栏：高风险/删除数据/外发信息/扩大范围/超预算强制转人工。
3. 修复影响生产可靠性的缺陷（成本预算、Worker 回调兜底）。
4. 将产品对外名称统一为「目标」。
5. 在生产环境完成至少 3 个真实目标的全自动闭环验证。

## 4. 非目标

1. 不改动 `supervision` 相关的数据库表名、API 路径、路由 id、代码符号（仅改前端展示文案）。
2. 不取消现有安全护栏；不允许高风险动作自动执行。
3. 不引入无限自治循环；预算/次数/时长上限仍然强制生效。
4. 不改变「独立验收不得只凭 Worker 自报」这一原则。

## 5. 待确认的关键决策（默认取值已在下方标注）

| 编号 | 决策点 | 默认取值（本稿采用） | 备选 |
|----|----|----|----|
| D-1 | 自治模式默认状态 | **默认开**：新建目标默认 `requires_plan_approval=false`，自动生成并批准计划 | 默认关：保留需人工批准，自治作为每个目标可选开关 |
| D-2 | 记忆晋升 | **可切换，默认沿用现状（自动生效）**：新增设置项 `general.supervision_memory_auto_approve`，默认 true；置 false 时记忆落为 `candidate` 待人工审核 | 默认关闭自动晋升（对齐发布策略） |
| D-3 | 高风险处理 | **强制转人工**（不受 D-1 影响） | 无 |

> D-1、D-2 均做成配置开关，可在不改代码的情况下切换，降低决策风险。若用户选择更保守口径，仅需改默认值。

## 6. 功能需求

### FR-A1 目标自动规划（新增自动化）
- 调度器在 `supervision_monitor` 轮次中，扫描 `status='planning'` 且尚无 `draft`/`approved` 计划的目标，自动调用 `generateSupervisionGoalPlan` 生成计划。
- 生成受预算护栏约束（`consumeSupervisionModelCall`）；失败按有界重试（复用现有记忆学习式的 cooldown/最大次数策略），并写审计事件，不得静默失败或无界消耗额度。
- 自动规划仅针对「自治模式」目标（D-1）；非自治目标维持现有人工触发。

### FR-A2 计划自动批准（受安全护栏约束）
- 自治模式目标：计划生成后，若**不含 high/critical 风险任务**，自动置 `approved` 并将目标转 `running`（复用 `saveSupervisionGoalPlan` 中 `requiresApproval=false` 分支）。
- 含高风险任务：强制停在 `awaiting_plan_approval` 等人工批准（现状即如此，保留）。

### FR-A3 派发/监督/纠偏/验收自动闭环（现状保留 + 打通衔接）
- 保留现有自动派发、监督、纠偏、验收、记忆学习。
- 打通「重规划回路」：`request_replan` 使目标回到 `planning` 后，由 FR-A1 自动重新生成计划并继续闭环，形成完整回路。

### FR-A4 Worker 完成兜底（可靠性修复）
- 为已派发但长时间无 `mc_complete_supervision_task` 回调的任务提供兜底：超时后由监督环触发「请求进度/纠偏」，多次无回调则按现有 `escalate_human` 转人工，避免任务永久悬挂。
- 明确并强化 Worker prompt 中「必须调用完成工具」的约束。

### FR-A5 成本预算生效（缺陷修复）
- 在 `consumeSupervisionModelCall` 的所有调用点（monitor 语义判断、verifier 验收、plans 规划）传入真实的模型调用成本估算，使 `max_estimated_cost` / `GOAL_COST_BUDGET_EXCEEDED` 真正生效。

### FR-A6 记忆晋升可控（对齐决策 D-2）
- 新增设置项控制记忆是否自动生效；默认 true（沿用现状）。置 false 时抽取的记忆落为 `candidate`，需人工在目标页审核后 `approved`。
- 停用记忆的粘性（不被重复学习复活）保持不变。

### FR-A7 对外命名统一为「目标」（仅前端展示层）
- 导航菜单标签 `Supervision` → 「目标」，并补齐 `navItemTranslationKeys` 与 `messages/zh.json`、`en.json` 的 `nav.supervision` 多语言 key。
- 面板 `supervision-panel.tsx` 内硬编码文案统一为「目标」口径：主标题、服务端提示、区块标题、按钮等。
- 不改数据库表名、API 路径、路由 id `'supervision'`、URL `/supervision`、代码符号。

## 7. 验收标准

### 7.1 自动化行为（可自测）
1. 新建自治模式、且计划为低/中风险的目标后，**无任何人工操作**，目标能自动经历 `planning → running → verifying → completed`。
2. 含高风险任务的目标，自动停在 `awaiting_plan_approval`，不自动执行高风险动作。
3. 超时无 Worker 回调的任务，能被自动纠偏并在多次失败后转人工，不永久悬挂。
4. 成本预算达到上限时目标自动 `blocked` 并转人工。
5. `request_replan` 后目标能自动重新生成计划并继续闭环。
6. 新增一条 `draft/planning → completed` 全自动端到端测试通过；既有 46 项定向测试保持通过。

### 7.2 命名（可自测）
7. 中英文界面下，菜单与目标面板文案均显示为「目标」口径；数据库、API、路由 id 不变，既有契约测试与 typecheck 通过。

### 7.3 生产级验收（需真实环境）
8. 在生产环境（`agent.1sheng.work`）以真实在线 Worker，完成**至少 3 个真实目标**的全自动闭环，每个目标保留完整证据链：`goal_id`、计划版本、任务 DAG、派发/监督/纠偏事件、独立验收证据、最终状态与最终报告。
9. 3 个目标覆盖不同形态（如：单任务、多任务带依赖、含一次自动纠偏或重分派）。
10. 全程通过 goal/task/message/correlation ID 可追踪；无重复派发、无重复纠偏、无高风险自动执行。

## 8. 生产验证前置条件（依赖用户环境）

- 运行中的中心服务端；
- 至少一个在线 Edge 节点，且 `supervision_monitor` 定时任务开启；
- 一个「目标/值守」Agent（human-watch 角色）与至少一个在线可执行 Worker Agent（codex-cli / claude-code / hermes）；
- 三个真实、低/中风险、验收标准明确的目标定义。

## 9. 发布策略

1. 先在测试租户/白名单目标 Agent 打开自治模式，完成 7.1/7.2 自测。
2. 灰度到生产，完成 7.3 的 3 个目标闭环验证。
3. 高风险强制转人工、预算护栏在全过程强制生效。
4. D-1/D-2 通过配置开关控制，出现异常可随时回退为保守口径。
