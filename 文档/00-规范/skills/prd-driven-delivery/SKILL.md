---
name: prd-driven-delivery
description: Use when the user requires a documentation-first / 文档先行 software delivery workflow: create or update PRD first, then test cases, architecture design, program design, task breakdown, implementation, self-test, and status tracking. Especially for repositories that keep all delivery documents in a repo-root 文档 directory.
---

# PRD Driven Delivery

Use this skill when coding work must follow a strict document-first process.

## Goal

Turn every requirement into a traceable chain:

1. PRD
2. Test cases
3. Architecture design
4. Program design
5. Task breakdown
6. Implementation
7. Test report
8. Requirement and task status update

## Required workflow

1. Find the repo-root `文档` directory. If it does not exist, create it first.
2. Identify the active requirement topic and use one consistent topic name across all documents.
3. Before any code edit, create or update these files:
   - `文档/01-PRD/PRD-<topic>.md`
   - `文档/02-测试用例/测试用例-<topic>.md`
   - `文档/03-架构设计/框架设计-<topic>.md`
   - `文档/04-程序设计/程序设计-<topic>.md`
   - `文档/05-任务拆解/任务拆解-<topic>.md`
   - `文档/06-测试报告/测试报告-<topic>.md`
   - `文档/07-状态跟踪/需求状态-<topic>.md`
4. Only start coding after the requirement, test, design, and task documents are updated for the current iteration.
5. Code against the task breakdown, not against ad hoc chat memory.
6. After coding, run self-tests or verification commands.
7. Record the executed commands, environment, results, failures, and residual risks in the test report.
8. Update both task status and requirement status at the end of the iteration.

## Minimum content expectations

### PRD

Include:

- background
- problem statement
- goals and non-goals
- users and roles
- key scenarios
- functional requirements
- non-functional requirements
- acceptance criteria

### Test cases

Include:

- requirement traceability
- case ID
- scenario
- preconditions
- steps
- expected result

### Architecture design

Include:

- deployment shape
- module boundaries
- data flow
- integration points
- risk and compatibility notes

### Program design

Include:

- impacted files/modules
- interfaces and contracts
- data structures
- execution flow
- fallback/error handling

### Task breakdown

Include:

- task ID
- objective
- dependencies
- affected files
- status
- completion criteria

### Test report

Include:

- scope
- environment
- commands
- actual results
- failed or skipped items
- conclusion

### Status tracking

Include:

- requirement status
- task-by-task status
- current iteration summary
- next actions

## Operating rules

1. Small fixes do not skip documentation. They may use lighter updates, but the affected PRD, tests, tasks, and status docs must still be touched.
2. If implementation deviates from the design, update the design docs in the same iteration.
3. If tests are impossible to run, record why in the test report instead of omitting the section.
4. Final responses should cite the updated docs and summarize test status and remaining risk.
