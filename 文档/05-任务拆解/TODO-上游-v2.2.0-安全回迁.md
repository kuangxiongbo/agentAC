# TODO：上游 Mission Control v2.2.0 安全回迁

> 创建日期：2026-07-22
>
> 基线：E-AgentCenter 2.1.59 (`ac71144`)
>
> 原则：行为级回迁；禁止整体 merge/cherry-pick；每批测试通过后再进入下一批。

## 批次 A：低耦合高风险修复

- [x] A1 Server/Edge WebSocket 保持最后成功 URL 重连
- [x] A2 安全 dotenv 数据解析，替换 Docker/standalone Shell source
- [x] A3 Runtime 在线安装默认关闭、SHA-256/精确版本固定
- [x] A4 Markdown 原始 HTML 拒绝
- [x] A5 schedule/memory 解析复杂度限制
- [x] A6 Server/Edge MCP/CLI API 目标地址校验
- [x] A7 批次 A 单测、typecheck、build 和兼容性测试

## 批次 B：自主执行安全

- [x] B1 task-dispatch allowed tools、cwd、单任务预算
- [x] B2 Goal/Plan 权限只能收紧 Agent 默认权限
- [x] B3 目标累计预算与单任务预算联动
- [x] B4 Skill 下载 256 KiB 上限（当前仅单 SKILL.md，无压缩包解压路径）
- [x] B5 原子配置写入 helper 及关键写入点迁移
- [x] B6 文件 canonical path、软链接和 TOCTOU 加固
- [x] B7 批次 B 单测、typecheck、build 和越权测试

## 批次 C：租户和审计闭环

- [x] C1 `071` 迁移为 audit_log 增加 workspace_id
- [x] C2 审计写入、查询、导出、搜索、统计和清理按 Workspace 约束
- [x] C3 Agent 名称改为 Workspace 内唯一，保留本地扩展字段
- [x] C4 Event、scheduler、background sync 携带 Workspace 上下文
- [x] C5 Edge 回执和值守/监督跨表归属校验
- [x] C6 双 Tenant/双 Workspace 数据库迁移与越权测试

## 批次 D：strict Workspace

- [x] D1 定义 Tenant/Workspace/Client/Agent/Session/Kind 统一归属模型
- [x] D2 Gateway、sync client、session index、permission request 完整归属
- [x] D3 shared/strict 策略、管理接口和 fail-closed helper
- [x] D4 值守和监督链路适配 strict Workspace
- [x] D5 两个 Edge、两个 Workspace 的跨域访问测试

## 批次 E：CI 和发布供应链

- [x] E1 根目录三包 CodeQL/OSV 检查
- [x] E2 GitHub Actions 固定审核后的 commit SHA
- [x] E3 定制 standalone/Docker 产物边界检查
- [x] E4 固定 Docker 基础镜像 digest并保留国内代理
- [x] E5 安全属性测试与 release hard gate

## 发布门禁

- [x] 主 PRD、主架构、主接口文档同步
- [x] Server/Edge 全量单测通过
- [x] Server/Edge typecheck 和 production build 通过
- [x] 数据库从生产 schema 升级、重复迁移和备份恢复通过
- [x] Human Watch 真实问答自动回复通过
- [ ] 监督目标生成、派发、纠偏和完成证明通过
- [x] Edge runtime/tray 发布面校验通过
- [x] 新版本 Git 提交和推送完成
- [x] version/latest 镜像摘要一致
- [x] 生产灰度部署、健康、资源和真实链路验证通过

## 证据记录

| 批次 | 提交 | 测试报告 | 发布版本 | 生产证据 |
|---|---|---|---|---|
| A | `a0bfb27` | Server 111、Edge 114 项聚焦测试；双端 typecheck/build；双端 Dockerfile check | 2.1.60 | 待完成 |
| B | `7d66b60` | Server 23、Edge 21 项安全测试；沙箱链路额外 Server 9、Edge 29 项；双端 typecheck/build | 2.1.60 | 待完成 |
| C | `f7a6250` | 迁移/租户/值守/监督综合测试纳入 C-D 49+11 项 | 2.1.60 | 生产 SQLite 快照重复迁移通过 |
| D | `f7a6250` | strict Workspace owned Edge、跨 Workspace 和权限请求测试通过 | 2.1.60 | 待完成 |
| E | `f7a6250` | 双端 typecheck/build、Tray build、action pin、Docker check、产物边界通过 | 2.1.60 | 待完成 |
| 生产补验 | `390eb0e` | 2.1.65 值守授权产物修复报告；值守/授权聚焦 42 项、双端 typecheck/build、发布面和产物边界通过 | 2.1.65 | 事件 `6fb6f19c-93d0-4507-aa05-025a2326ffb5`；干预 `34621` success；同 Worker session 收到并复述 A（只读通过）；binding 4 已关闭 |
