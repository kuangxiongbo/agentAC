# Mission Control Workflow Skill (全局开发指南)

## 核心原则
> **文档先行，日志闭环，自测标记。**

### 1. 文档先行 (Documentation First)
任何功能开发、架构调整或重大 Bug 修复前，必须执行：
1.  检索 `docs/system_architecture.md` 确认是否需要更新。
2.  如果有架构变动，先在 Markdown 中描述设计思路。
3.  向用户确认文档内容。

### 2. 操作日志记录 (Operation Logging)
所有的交互结果和代码修改必须记录在 `docs/operation_logs/` 下。
*   **文件名格式**: `log_YYYY-MM-DD.md`
*   **内容结构**:
    *   **User Intent**: 用户本次的要求是什么。
    *   **Current Progress**: 已经完成了哪些文件。
    *   **Key Decisions**: 为什么这样改。
    *   **Remaining Issues**: 还有哪些没解决。

### 3. 代码质量与验证 (Validation)
1.  代码修改完成后，必须同步更新对应的 Type 定义或数据库 Migration。
2.  标记本次任务状态：`[TODO]` -> `[DONE]`。
3.  在日志中记录自测结果。

### 4. 架构约束 (Architecture Constraints)
*   **Server (5000)** 为中央网关，保持轻量级接收模式。
*   **Client (5001)** 为执行网关，负责探测、心跳和数据推送。
*   **Agent Agnostic**: 系统必须能够容纳任意类型的智能体，OpenClaw 仅为其中一员。
