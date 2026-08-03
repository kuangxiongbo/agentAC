import { z } from 'zod'

export const goalPrioritySchema = z.enum(['critical', 'high', 'medium', 'low'])

export const goalCriterionSchema = z.object({
  id: z.string().min(1).max(100),
  text: z.string().min(1).max(1000),
  evidence_type: z.enum(['test', 'metric', 'artifact', 'review', 'user_confirmation']).optional(),
})

export const goalBudgetSchema = z.object({
  max_tasks: z.number().int().min(1).max(100).default(8),
  max_parallel_workers: z.number().int().min(1).max(20).default(3),
  max_retries_per_task: z.number().int().min(0).max(20).default(3),
  max_replans: z.number().int().min(0).max(20).default(5),
  max_runtime_seconds: z.number().int().min(60).max(30 * 86400).default(86400),
  max_model_calls: z.number().int().min(1).max(10_000).default(100),
  max_estimated_cost: z.number().min(0).max(1_000_000).optional(),
})

export const createSupervisionGoalSchema = z.object({
  client_id: z.string().min(1).max(200),
  steward_local_agent_id: z.number().int().positive(),
  title: z.string().min(1).max(500),
  objective: z.string().min(1).max(10_000),
  success_criteria: z.array(goalCriterionSchema).min(1).max(50),
  constraints: z.array(z.string().min(1).max(1000)).max(50).default([]),
  allowed_worker_ids: z.array(z.number().int().positive()).max(100).default([]),
  priority: goalPrioritySchema.default('medium'),
  deadline_at: z.number().int().min(0).max(4102444800).optional(),
  budget: goalBudgetSchema.default({
    max_tasks: 8,
    max_parallel_workers: 3,
    max_retries_per_task: 3,
    max_replans: 5,
    max_runtime_seconds: 86400,
    max_model_calls: 100,
  }),
  requires_plan_approval: z.boolean().default(true),
})

export const updateSupervisionGoalSchema = z.object({
  version: z.number().int().positive(),
  title: z.string().min(1).max(500).optional(),
  objective: z.string().min(1).max(10_000).optional(),
  success_criteria: z.array(goalCriterionSchema).min(1).max(50).optional(),
  constraints: z.array(z.string().min(1).max(1000)).max(50).optional(),
  allowed_worker_ids: z.array(z.number().int().positive()).max(100).optional(),
  priority: goalPrioritySchema.optional(),
  deadline_at: z.number().int().min(0).max(4102444800).nullable().optional(),
  budget: goalBudgetSchema.optional(),
  requires_plan_approval: z.boolean().optional(),
})

export const supervisionGoalActionSchema = z.object({
  action: z.enum([
    'start_planning',
    'approve_plan',
    'reject_plan',
    'pause',
    'resume',
    'cancel',
    'request_replan',
    'start_verification',
    'accept_result',
    'reject_result',
    'fail',
  ]),
  version: z.number().int().positive(),
  reason: z.string().max(5000).optional(),
  plan_version: z.number().int().positive().optional(),
})

export const supervisionPlanTaskSchema = z.object({
  logical_key: z.string().regex(/^[a-z0-9][a-z0-9._-]*$/).max(100),
  title: z.string().min(1).max(500),
  description: z.string().min(1).max(5000),
  dependencies: z.array(z.string().min(1).max(100)).max(50).default([]),
  required_capabilities: z.array(z.string().min(1).max(100)).max(30).default([]),
  preferred_framework: z.enum(['claude-code', 'codex-cli', 'hermes']).optional(),
  goal_criteria: z.array(z.string().min(1).max(100)).min(1).max(50),
  acceptance_criteria: z.array(z.string().min(1).max(1000)).min(1).max(30),
  estimated_minutes: z.number().int().min(1).max(30 * 24 * 60).optional(),
  risk: z.enum(['low', 'medium', 'high', 'critical']).default('low'),
})

export const supervisionGoalPlanDraftSchema = z.object({
  summary: z.string().min(1).max(5000),
  tasks: z.array(supervisionPlanTaskSchema).min(1).max(100),
})

export const createSupervisionPlanSchema = z.object({
  mode: z.enum(['generate', 'submit']).default('generate'),
  draft: supervisionGoalPlanDraftSchema.optional(),
  rationale: z.string().max(5000).optional(),
  source_event_id: z.number().int().positive().optional(),
}).superRefine((value, context) => {
  if (value.mode === 'submit' && !value.draft) {
    context.addIssue({ code: 'custom', path: ['draft'], message: 'draft is required in submit mode' })
  }
})
