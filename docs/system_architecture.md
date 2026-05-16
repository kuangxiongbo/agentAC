# Mission Control 核心架构与需求文档 (v1.0)

## 1. 项目定位
本项目致力于构建一个**通用的智能体协调与控制中心 (Universal Agent Orchestration Hub)**。
核心定位是：**去中心化的执行，中心化的监控与协调**。

### 核心角色
1.  **Mission Control Server (Port 5000)**: 
    *   **角色**: 中央控制塔 (The Hub)。
    *   **职能**: 接收各边缘节点上报的状态。
    *   **全局视图**: 监控所有节点、所有类型的智能体活动。架构支持父子关系 (`parent_id`)，用于展示多级智能体结构。

2.  **Mission Control Node / Client (Port 5001)**:
    *   **角色**: 边缘执行节点 (The Edge)。
    *   **职能**: 本地运行监测与数据推送。

3.  **智能体 (Agents)**:
    *   不再局限于 OpenClaw。类型包括 Claude, Cursor, CodeX, OpenClaw 等。
    *   **父子结构 (Sub-Agents)**: 
        *   支持 `parent_id` 及其对应的继承逻辑。
        *   例如：OpenClaw 本身作为一个 Agent，其内部创建的子智能体将其关联为 `parent_id`。

---

## 2. 数据 Schema 变更
### 2.1 Agents 表 (053_agent_hierarchy)
*   **framework**: TEXT (openclaw, claude, cursor 等)。已完成。
*   **parent_id**: INTEGER (关联 agents.id)。支持无限级或至少两级父子嵌套。

---

## 2. 核心流程需求

### 2.1 智能体识别与新建
*   **多框架支持**: 新建智能体时，必须先选择其所属框架 (`framework`)。
*   **条件化供应**: 
    *   对于 `openclaw` 类型，客户端可以执行本地 Provisioning (工作区初始化)。
    *   对于 `claude`, `cursor` 等类型，客户端执行监测与会话抓取。
*   **统一上报**: 所有类型的智能体都遵循统一的格式通过 Bridge 汇聚到 5000 服务端。

### 2.2 多节点隔离
*   **node_id**: 每个客户端拥有唯一的标识。
*   **筛选机制**: 服务端 UI 必须支持按 `node_id` 进行智能体过滤，以便区分不同物理机器上的 Agent。

---

## 3. 开发流程规范 (Workflow Skill)
为了保障代码质量与进度的可追溯性，遵循以下规范：

1.  **文档先行**: 任何代码修改前，必须先更新本架构文档或相关的技术方案文档。
2.  **日志记录**: 每次操作（功能实现、Bug 修复）必须记录到 `docs/operation_logs/` 下。
3.  **自测闭环**: 代码完成后需进行本地验证，确认功能点与文档描述一致后，方可标记为“完成”。

---

## 4. 后续任务安排 (Roadmap)
- [x] 多平台框架 (`framework`) 字段引入与 UI 适配。
- [x] 多节点 (`node_id`) 数据库同步与前端筛选。
- [ ] **OpenClaw 类型转换**: 在代码中彻底将 OpenClaw Gateway 作为一个 Agent 处理，而不再是系统的硬性依赖。
- [ ] **增强监测**: 实现对 `Claude Code` 或 `Cursor` 会话的自动感知与上报（技术调研中）。
- [ ] **全局搜索与聚合**: 服务端实现跨节点的全局搜索。
