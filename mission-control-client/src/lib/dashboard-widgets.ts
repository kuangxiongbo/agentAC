export interface DashboardWidget {
  id: string
  labelKey: string
  descriptionKey: string
  category: 'health' | 'sessions' | 'tasks' | 'metrics' | 'integrations' | 'events'
  modes: ('local' | 'full')[]
  defaultSize: 'sm' | 'md' | 'lg' | 'full'
  component: string
}

export const WIDGET_CATALOG: DashboardWidget[] = [
  {
    id: 'metric-cards',
    labelKey: 'catalogMetricCardsLabel',
    descriptionKey: 'catalogMetricCardsDescription',
    category: 'metrics',
    modes: ['local', 'full'],
    defaultSize: 'full',
    component: 'MetricCardsWidget',
  },
  {
    id: 'runtime-health',
    labelKey: 'catalogRuntimeHealthLabel',
    descriptionKey: 'catalogRuntimeHealthDescription',
    category: 'health',
    modes: ['local'],
    defaultSize: 'md',
    component: 'RuntimeHealthWidget',
  },
  {
    id: 'gateway-health',
    labelKey: 'catalogGatewayHealthLabel',
    descriptionKey: 'catalogGatewayHealthDescription',
    category: 'health',
    modes: ['full'],
    defaultSize: 'md',
    component: 'GatewayHealthWidget',
  },
  {
    id: 'session-workbench',
    labelKey: 'catalogSessionWorkbenchLabel',
    descriptionKey: 'catalogSessionWorkbenchDescription',
    category: 'sessions',
    modes: ['local', 'full'],
    defaultSize: 'md',
    component: 'SessionWorkbenchWidget',
  },
  {
    id: 'event-stream',
    labelKey: 'catalogEventStreamLabel',
    descriptionKey: 'catalogEventStreamDescription',
    category: 'events',
    modes: ['local', 'full'],
    defaultSize: 'md',
    component: 'EventStreamWidget',
  },
  {
    id: 'task-flow',
    labelKey: 'catalogTaskFlowLabel',
    descriptionKey: 'catalogTaskFlowDescription',
    category: 'tasks',
    modes: ['local', 'full'],
    defaultSize: 'sm',
    component: 'TaskFlowWidget',
  },
  {
    id: 'github-signal',
    labelKey: 'catalogGithubSignalLabel',
    descriptionKey: 'catalogGithubSignalDescription',
    category: 'integrations',
    modes: ['local'],
    defaultSize: 'sm',
    component: 'GithubSignalWidget',
  },
  {
    id: 'security-audit',
    labelKey: 'catalogSecurityAuditLabel',
    descriptionKey: 'catalogSecurityAuditDescription',
    category: 'events',
    modes: ['full'],
    defaultSize: 'sm',
    component: 'SecurityAuditWidget',
  },
  {
    id: 'maintenance',
    labelKey: 'catalogMaintenanceLabel',
    descriptionKey: 'catalogMaintenanceDescription',
    category: 'health',
    modes: ['full'],
    defaultSize: 'sm',
    component: 'MaintenanceWidget',
  },
  {
    id: 'quick-actions',
    labelKey: 'catalogQuickActionsLabel',
    descriptionKey: 'catalogQuickActionsDescription',
    category: 'sessions',
    modes: ['local', 'full'],
    defaultSize: 'full',
    component: 'QuickActionsWidget',
  },
]

export const LOCAL_DEFAULT_LAYOUT = [
  'metric-cards',
  'runtime-health',
  'session-workbench',
  'event-stream',
  'task-flow',
  'github-signal',
  'quick-actions',
]

export const GATEWAY_DEFAULT_LAYOUT = [
  'metric-cards',
  'gateway-health',
  'session-workbench',
  'event-stream',
  'task-flow',
  'security-audit',
  'maintenance',
  'quick-actions',
]

export function getDefaultLayout(mode: 'local' | 'full'): string[] {
  return mode === 'local' ? LOCAL_DEFAULT_LAYOUT : GATEWAY_DEFAULT_LAYOUT
}

export function getWidgetById(id: string): DashboardWidget | undefined {
  return WIDGET_CATALOG.find((w) => w.id === id)
}

export function getAvailableWidgets(mode: 'local' | 'full'): DashboardWidget[] {
  return WIDGET_CATALOG.filter((w) => w.modes.includes(mode))
}
