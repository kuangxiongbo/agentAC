import { createHash } from 'crypto'
import { readFileSync } from 'fs'
import { join } from 'path'
import type Database from 'better-sqlite3'

export type Migration = {
  id: string
  up: (db: Database.Database) => void
}

// Plugin hook: extensions can register additional migrations without modifying this file.
const extraMigrations: Migration[] = []
export function registerMigrations(newMigrations: Migration[]): void {
  extraMigrations.push(...newMigrations)
}

const migrations: Migration[] = [
  {
    id: '001_init',
    up: (db) => {
      const schemaPath = join(process.cwd(), 'src', 'lib', 'schema.sql')
      const schema = readFileSync(schemaPath, 'utf8')
      const statements = schema.split(';').filter((stmt) => stmt.trim())
      db.transaction(() => {
        for (const statement of statements) {
          db.exec(statement.trim())
        }
      })()
    }
  },
  {
    id: '002_quality_reviews',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS quality_reviews (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          task_id INTEGER NOT NULL,
          reviewer TEXT NOT NULL,
          status TEXT NOT NULL,
          notes TEXT,
          created_at INTEGER NOT NULL DEFAULT (unixepoch()),
          FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_quality_reviews_task_id ON quality_reviews(task_id);
        CREATE INDEX IF NOT EXISTS idx_quality_reviews_reviewer ON quality_reviews(reviewer);
      `)
    }
  },
  {
    id: '003_quality_review_status_backfill',
    up: (db) => {
      // Convert existing review tasks to quality_review to enforce the gate
      db.exec(`
        UPDATE tasks
        SET status = 'quality_review'
        WHERE status = 'review';
      `)
    }
  },
  {
    id: '004_messages',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS messages (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          conversation_id TEXT NOT NULL,
          from_agent TEXT NOT NULL,
          to_agent TEXT,
          content TEXT NOT NULL,
          message_type TEXT DEFAULT 'text',
          metadata TEXT,
          read_at INTEGER,
          created_at INTEGER DEFAULT (unixepoch())
        )
      `)
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id, created_at)
      `)
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_messages_agents ON messages(from_agent, to_agent)
      `)
    }
  },
  {
    id: '005_users',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS users (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          username TEXT NOT NULL UNIQUE,
          display_name TEXT NOT NULL,
          password_hash TEXT NOT NULL,
          role TEXT NOT NULL DEFAULT 'operator',
          created_at INTEGER NOT NULL DEFAULT (unixepoch()),
          updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
          last_login_at INTEGER
        );

        CREATE TABLE IF NOT EXISTS user_sessions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          token TEXT NOT NULL UNIQUE,
          user_id INTEGER NOT NULL,
          expires_at INTEGER NOT NULL,
          created_at INTEGER NOT NULL DEFAULT (unixepoch()),
          ip_address TEXT,
          user_agent TEXT,
          FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);
        CREATE INDEX IF NOT EXISTS idx_user_sessions_token ON user_sessions(token);
        CREATE INDEX IF NOT EXISTS idx_user_sessions_user_id ON user_sessions(user_id);
        CREATE INDEX IF NOT EXISTS idx_user_sessions_expires_at ON user_sessions(expires_at);
      `)
    }
  },
  {
    id: '006_workflow_templates',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS workflow_templates (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL,
          description TEXT,
          model TEXT NOT NULL DEFAULT 'sonnet',
          task_prompt TEXT NOT NULL,
          timeout_seconds INTEGER NOT NULL DEFAULT 300,
          agent_role TEXT,
          tags TEXT,
          created_by TEXT NOT NULL DEFAULT 'system',
          created_at INTEGER NOT NULL DEFAULT (unixepoch()),
          updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
          last_used_at INTEGER,
          use_count INTEGER NOT NULL DEFAULT 0
        );

        CREATE INDEX IF NOT EXISTS idx_workflow_templates_name ON workflow_templates(name);
        CREATE INDEX IF NOT EXISTS idx_workflow_templates_created_by ON workflow_templates(created_by);
      `)
    }
  },
  {
    id: '007_audit_log',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS audit_log (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          action TEXT NOT NULL,
          actor TEXT NOT NULL,
          actor_id INTEGER,
          target_type TEXT,
          target_id INTEGER,
          detail TEXT,
          ip_address TEXT,
          user_agent TEXT,
          created_at INTEGER NOT NULL DEFAULT (unixepoch())
        );

        CREATE INDEX IF NOT EXISTS idx_audit_log_action ON audit_log(action);
        CREATE INDEX IF NOT EXISTS idx_audit_log_actor ON audit_log(actor);
        CREATE INDEX IF NOT EXISTS idx_audit_log_created_at ON audit_log(created_at);
      `)
    }
  },
  {
    id: '008_webhooks',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS webhooks (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL,
          url TEXT NOT NULL,
          secret TEXT,
          events TEXT NOT NULL DEFAULT '["*"]',
          enabled INTEGER NOT NULL DEFAULT 1,
          last_fired_at INTEGER,
          last_status INTEGER,
          created_by TEXT NOT NULL DEFAULT 'system',
          created_at INTEGER NOT NULL DEFAULT (unixepoch()),
          updated_at INTEGER NOT NULL DEFAULT (unixepoch())
        );

        CREATE TABLE IF NOT EXISTS webhook_deliveries (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          webhook_id INTEGER NOT NULL,
          event_type TEXT NOT NULL,
          payload TEXT NOT NULL,
          status_code INTEGER,
          response_body TEXT,
          error TEXT,
          duration_ms INTEGER,
          created_at INTEGER NOT NULL DEFAULT (unixepoch()),
          FOREIGN KEY (webhook_id) REFERENCES webhooks(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_webhook_id ON webhook_deliveries(webhook_id);
        CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_created_at ON webhook_deliveries(created_at);
        CREATE INDEX IF NOT EXISTS idx_webhooks_enabled ON webhooks(enabled);
      `)
    }
  },
  {
    id: '009_pipelines',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS workflow_pipelines (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL,
          description TEXT,
          steps TEXT NOT NULL DEFAULT '[]',
          created_by TEXT NOT NULL DEFAULT 'system',
          created_at INTEGER NOT NULL DEFAULT (unixepoch()),
          updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
          use_count INTEGER NOT NULL DEFAULT 0,
          last_used_at INTEGER
        );

        CREATE TABLE IF NOT EXISTS pipeline_runs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          pipeline_id INTEGER NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending',
          current_step INTEGER NOT NULL DEFAULT 0,
          steps_snapshot TEXT NOT NULL DEFAULT '[]',
          started_at INTEGER,
          completed_at INTEGER,
          triggered_by TEXT NOT NULL DEFAULT 'system',
          created_at INTEGER NOT NULL DEFAULT (unixepoch()),
          FOREIGN KEY (pipeline_id) REFERENCES workflow_pipelines(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_pipeline_runs_pipeline_id ON pipeline_runs(pipeline_id);
        CREATE INDEX IF NOT EXISTS idx_pipeline_runs_status ON pipeline_runs(status);
        CREATE INDEX IF NOT EXISTS idx_workflow_pipelines_name ON workflow_pipelines(name);
      `)
    }
  },
  {
    id: '010_settings',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS settings (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL,
          description TEXT,
          category TEXT NOT NULL DEFAULT 'general',
          updated_by TEXT,
          updated_at INTEGER NOT NULL DEFAULT (unixepoch())
        );

        CREATE INDEX IF NOT EXISTS idx_settings_category ON settings(category);
      `)
    }
  },
  {
    id: '011_alert_rules',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS alert_rules (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL,
          description TEXT,
          enabled INTEGER NOT NULL DEFAULT 1,
          entity_type TEXT NOT NULL,
          condition_field TEXT NOT NULL,
          condition_operator TEXT NOT NULL,
          condition_value TEXT NOT NULL,
          action_type TEXT NOT NULL DEFAULT 'notification',
          action_config TEXT NOT NULL DEFAULT '{}',
          cooldown_minutes INTEGER NOT NULL DEFAULT 60,
          last_triggered_at INTEGER,
          trigger_count INTEGER NOT NULL DEFAULT 0,
          created_by TEXT NOT NULL DEFAULT 'system',
          created_at INTEGER NOT NULL DEFAULT (unixepoch()),
          updated_at INTEGER NOT NULL DEFAULT (unixepoch())
        );

        CREATE INDEX IF NOT EXISTS idx_alert_rules_enabled ON alert_rules(enabled);
        CREATE INDEX IF NOT EXISTS idx_alert_rules_entity_type ON alert_rules(entity_type);
      `)
    }
  },
  {
    id: '012_super_admin_tenants',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS tenants (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          slug TEXT NOT NULL UNIQUE,
          display_name TEXT NOT NULL,
          linux_user TEXT NOT NULL UNIQUE,
          plan_tier TEXT NOT NULL DEFAULT 'standard',
          status TEXT NOT NULL DEFAULT 'pending',
          openclaw_home TEXT NOT NULL,
          workspace_root TEXT NOT NULL,
          gateway_port INTEGER,
          dashboard_port INTEGER,
          config TEXT NOT NULL DEFAULT '{}',
          created_by TEXT NOT NULL DEFAULT 'system',
          created_at INTEGER NOT NULL DEFAULT (unixepoch()),
          updated_at INTEGER NOT NULL DEFAULT (unixepoch())
        );

        CREATE TABLE IF NOT EXISTS provision_jobs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          tenant_id INTEGER NOT NULL,
          job_type TEXT NOT NULL DEFAULT 'bootstrap',
          status TEXT NOT NULL DEFAULT 'queued',
          dry_run INTEGER NOT NULL DEFAULT 1,
          requested_by TEXT NOT NULL DEFAULT 'system',
          approved_by TEXT,
          runner_host TEXT,
          idempotency_key TEXT,
          request_json TEXT NOT NULL DEFAULT '{}',
          plan_json TEXT NOT NULL DEFAULT '[]',
          result_json TEXT,
          error_text TEXT,
          started_at INTEGER,
          completed_at INTEGER,
          created_at INTEGER NOT NULL DEFAULT (unixepoch()),
          updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
          FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS provision_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          job_id INTEGER NOT NULL,
          level TEXT NOT NULL DEFAULT 'info',
          step_key TEXT,
          message TEXT NOT NULL,
          data TEXT,
          created_at INTEGER NOT NULL DEFAULT (unixepoch()),
          FOREIGN KEY (job_id) REFERENCES provision_jobs(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_tenants_slug ON tenants(slug);
        CREATE INDEX IF NOT EXISTS idx_tenants_status ON tenants(status);
        CREATE INDEX IF NOT EXISTS idx_provision_jobs_tenant_id ON provision_jobs(tenant_id);
        CREATE INDEX IF NOT EXISTS idx_provision_jobs_status ON provision_jobs(status);
        CREATE INDEX IF NOT EXISTS idx_provision_jobs_created_at ON provision_jobs(created_at);
        CREATE INDEX IF NOT EXISTS idx_provision_events_job_id ON provision_events(job_id);
        CREATE INDEX IF NOT EXISTS idx_provision_events_created_at ON provision_events(created_at);
      `)
    }
  },
  {
    id: '013_tenant_owner_gateway',
    up: (db) => {
      // Check if tenants table exists (may not on fresh installs without super-admin)
      const hasTenants = (db.prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name='tenants'`
      ).get() as any)
      if (!hasTenants) return

      const columns = db.prepare(`PRAGMA table_info(tenants)`).all() as Array<{ name: string }>
      const hasOwnerGateway = columns.some((c) => c.name === 'owner_gateway')
      if (!hasOwnerGateway) {
        db.exec(`ALTER TABLE tenants ADD COLUMN owner_gateway TEXT`)
      }

      const defaultGatewayName =
        String(process.env.MC_DEFAULT_OWNER_GATEWAY || process.env.MC_DEFAULT_GATEWAY_NAME || 'primary').trim() ||
        'primary'

      // Check if gateways table exists (created lazily by gateways API, not in migrations)
      const hasGateways = (db.prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name='gateways'`
      ).get() as any)

      if (hasGateways) {
        db.prepare(`
          UPDATE tenants
          SET owner_gateway = COALESCE(
            (SELECT name FROM gateways ORDER BY is_primary DESC, id ASC LIMIT 1),
            ?
          )
          WHERE owner_gateway IS NULL OR trim(owner_gateway) = ''
        `).run(defaultGatewayName)
      } else {
        db.prepare(`
          UPDATE tenants
          SET owner_gateway = ?
          WHERE owner_gateway IS NULL OR trim(owner_gateway) = ''
        `).run(defaultGatewayName)
      }

      db.exec(`CREATE INDEX IF NOT EXISTS idx_tenants_owner_gateway ON tenants(owner_gateway)`)
    }
  },
  {
    id: '014_auth_google_approvals',
    up: (db) => {
      const userCols = db.prepare(`PRAGMA table_info(users)`).all() as Array<{ name: string }>
      const has = (name: string) => userCols.some((c) => c.name === name)

      if (!has('provider')) db.exec(`ALTER TABLE users ADD COLUMN provider TEXT NOT NULL DEFAULT 'local'`)
      if (!has('provider_user_id')) db.exec(`ALTER TABLE users ADD COLUMN provider_user_id TEXT`)
      if (!has('email')) db.exec(`ALTER TABLE users ADD COLUMN email TEXT`)
      if (!has('avatar_url')) db.exec(`ALTER TABLE users ADD COLUMN avatar_url TEXT`)
      if (!has('is_approved')) db.exec(`ALTER TABLE users ADD COLUMN is_approved INTEGER NOT NULL DEFAULT 1`)
      if (!has('approved_by')) db.exec(`ALTER TABLE users ADD COLUMN approved_by TEXT`)
      if (!has('approved_at')) db.exec(`ALTER TABLE users ADD COLUMN approved_at INTEGER`)

      db.exec(`
        UPDATE users
        SET provider = COALESCE(NULLIF(provider, ''), 'local'),
            is_approved = COALESCE(is_approved, 1)
      `)

      db.exec(`
        CREATE TABLE IF NOT EXISTS access_requests (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          provider TEXT NOT NULL DEFAULT 'google',
          email TEXT NOT NULL,
          provider_user_id TEXT,
          display_name TEXT,
          avatar_url TEXT,
          status TEXT NOT NULL DEFAULT 'pending',
          requested_at INTEGER NOT NULL DEFAULT (unixepoch()),
          last_attempt_at INTEGER NOT NULL DEFAULT (unixepoch()),
          attempt_count INTEGER NOT NULL DEFAULT 1,
          reviewed_by TEXT,
          reviewed_at INTEGER,
          review_note TEXT,
          approved_user_id INTEGER,
          FOREIGN KEY (approved_user_id) REFERENCES users(id) ON DELETE SET NULL
        )
      `)

      db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_access_requests_email_provider ON access_requests(email, provider)`)
      db.exec(`CREATE INDEX IF NOT EXISTS idx_access_requests_status ON access_requests(status)`)
      db.exec(`CREATE INDEX IF NOT EXISTS idx_users_provider ON users(provider)`)
      db.exec(`CREATE INDEX IF NOT EXISTS idx_users_email ON users(email)`)
    }
  },
  {
    id: '015_missing_indexes',
    up: (db) => {
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_notifications_read_at ON notifications(read_at);
        CREATE INDEX IF NOT EXISTS idx_notifications_recipient_read ON notifications(recipient, read_at);
        CREATE INDEX IF NOT EXISTS idx_activities_actor ON activities(actor);
        CREATE INDEX IF NOT EXISTS idx_activities_entity ON activities(entity_type, entity_id);
        CREATE INDEX IF NOT EXISTS idx_messages_read_at ON messages(read_at);
      `)
    }
  },
  {
    id: '016_direct_connections',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS direct_connections (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          agent_id INTEGER NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
          tool_name TEXT NOT NULL,
          tool_version TEXT,
          connection_id TEXT NOT NULL UNIQUE,
          status TEXT NOT NULL DEFAULT 'connected',
          last_heartbeat INTEGER,
          metadata TEXT,
          created_at INTEGER NOT NULL DEFAULT (unixepoch()),
          updated_at INTEGER NOT NULL DEFAULT (unixepoch())
        );
        CREATE INDEX IF NOT EXISTS idx_direct_connections_agent_id ON direct_connections(agent_id);
        CREATE INDEX IF NOT EXISTS idx_direct_connections_connection_id ON direct_connections(connection_id);
        CREATE INDEX IF NOT EXISTS idx_direct_connections_status ON direct_connections(status);
      `)
    }
  },
  {
    id: '017_github_sync',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS github_syncs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          repo TEXT NOT NULL,
          last_synced_at INTEGER NOT NULL DEFAULT (unixepoch()),
          issue_count INTEGER NOT NULL DEFAULT 0,
          sync_direction TEXT NOT NULL DEFAULT 'inbound',
          status TEXT NOT NULL DEFAULT 'success',
          error TEXT,
          created_at INTEGER NOT NULL DEFAULT (unixepoch())
        );
        CREATE INDEX IF NOT EXISTS idx_github_syncs_repo ON github_syncs(repo);
        CREATE INDEX IF NOT EXISTS idx_github_syncs_created_at ON github_syncs(created_at);
      `)
    }
  },
  {
    id: '018_token_usage',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS token_usage (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          model TEXT NOT NULL,
          session_id TEXT NOT NULL,
          input_tokens INTEGER NOT NULL DEFAULT 0,
          output_tokens INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL DEFAULT (unixepoch())
        );
        CREATE INDEX IF NOT EXISTS idx_token_usage_session_id ON token_usage(session_id);
        CREATE INDEX IF NOT EXISTS idx_token_usage_created_at ON token_usage(created_at);
        CREATE INDEX IF NOT EXISTS idx_token_usage_model ON token_usage(model);
      `)
    }
  },
  {
    id: '019_webhook_retry',
    up: (db) => {
      // Add retry columns to webhook_deliveries
      const deliveryCols = db.prepare(`PRAGMA table_info(webhook_deliveries)`).all() as Array<{ name: string }>
      const hasCol = (name: string) => deliveryCols.some((c) => c.name === name)

      if (!hasCol('attempt')) db.exec(`ALTER TABLE webhook_deliveries ADD COLUMN attempt INTEGER NOT NULL DEFAULT 0`)
      if (!hasCol('next_retry_at')) db.exec(`ALTER TABLE webhook_deliveries ADD COLUMN next_retry_at INTEGER`)
      if (!hasCol('is_retry')) db.exec(`ALTER TABLE webhook_deliveries ADD COLUMN is_retry INTEGER NOT NULL DEFAULT 0`)
      if (!hasCol('parent_delivery_id')) db.exec(`ALTER TABLE webhook_deliveries ADD COLUMN parent_delivery_id INTEGER`)

      // Add circuit breaker column to webhooks
      const webhookCols = db.prepare(`PRAGMA table_info(webhooks)`).all() as Array<{ name: string }>
      if (!webhookCols.some((c) => c.name === 'consecutive_failures')) {
        db.exec(`ALTER TABLE webhooks ADD COLUMN consecutive_failures INTEGER NOT NULL DEFAULT 0`)
      }

      // Partial index for retry queue processing
      db.exec(`CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_retry ON webhook_deliveries(next_retry_at) WHERE next_retry_at IS NOT NULL`)
    }
  },
  {
    id: '020_claude_sessions',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS claude_sessions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          session_id TEXT NOT NULL UNIQUE,
          project_slug TEXT NOT NULL,
          project_path TEXT,
          model TEXT,
          git_branch TEXT,
          user_messages INTEGER NOT NULL DEFAULT 0,
          assistant_messages INTEGER NOT NULL DEFAULT 0,
          tool_uses INTEGER NOT NULL DEFAULT 0,
          input_tokens INTEGER NOT NULL DEFAULT 0,
          output_tokens INTEGER NOT NULL DEFAULT 0,
          estimated_cost REAL NOT NULL DEFAULT 0,
          first_message_at TEXT,
          last_message_at TEXT,
          last_user_prompt TEXT,
          is_active INTEGER NOT NULL DEFAULT 0,
          scanned_at INTEGER NOT NULL,
          created_at INTEGER NOT NULL DEFAULT (unixepoch()),
          updated_at INTEGER NOT NULL DEFAULT (unixepoch())
        )
      `)
      db.exec(`CREATE INDEX IF NOT EXISTS idx_claude_sessions_active ON claude_sessions(is_active) WHERE is_active = 1`)
      db.exec(`CREATE INDEX IF NOT EXISTS idx_claude_sessions_project ON claude_sessions(project_slug)`)
    }
  },
  {
    id: '021_workspace_isolation_phase1',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS workspaces (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          slug TEXT NOT NULL UNIQUE,
          name TEXT NOT NULL,
          created_at INTEGER NOT NULL DEFAULT (unixepoch()),
          updated_at INTEGER NOT NULL DEFAULT (unixepoch())
        );
      `)

      db.prepare(`
        INSERT OR IGNORE INTO workspaces (id, slug, name, created_at, updated_at)
        VALUES (1, 'default', 'Default Workspace', unixepoch(), unixepoch())
      `).run()

      const addWorkspaceIdColumn = (table: string) => {
        const tableExists = db
          .prepare(`SELECT 1 as ok FROM sqlite_master WHERE type = 'table' AND name = ?`)
          .get(table) as { ok?: number } | undefined
        if (!tableExists?.ok) return

        const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
        if (!cols.some((c) => c.name === 'workspace_id')) {
          db.exec(`ALTER TABLE ${table} ADD COLUMN workspace_id INTEGER NOT NULL DEFAULT 1`)
        }
        db.exec(`UPDATE ${table} SET workspace_id = COALESCE(workspace_id, 1)`)
      }

      const scopedTables = [
        'users',
        'user_sessions',
        'tasks',
        'agents',
        'comments',
        'activities',
        'notifications',
        'quality_reviews',
        'standup_reports',
      ]

      for (const table of scopedTables) {
        addWorkspaceIdColumn(table)
      }

      db.exec(`CREATE INDEX IF NOT EXISTS idx_workspaces_slug ON workspaces(slug)`)
      db.exec(`CREATE INDEX IF NOT EXISTS idx_users_workspace_id ON users(workspace_id)`)
      db.exec(`CREATE INDEX IF NOT EXISTS idx_user_sessions_workspace_id ON user_sessions(workspace_id)`)
      db.exec(`CREATE INDEX IF NOT EXISTS idx_tasks_workspace_id ON tasks(workspace_id)`)
      db.exec(`CREATE INDEX IF NOT EXISTS idx_agents_workspace_id ON agents(workspace_id)`)
      db.exec(`CREATE INDEX IF NOT EXISTS idx_comments_workspace_id ON comments(workspace_id)`)
      db.exec(`CREATE INDEX IF NOT EXISTS idx_activities_workspace_id ON activities(workspace_id)`)
      db.exec(`CREATE INDEX IF NOT EXISTS idx_notifications_workspace_id ON notifications(workspace_id)`)
      db.exec(`CREATE INDEX IF NOT EXISTS idx_quality_reviews_workspace_id ON quality_reviews(workspace_id)`)
      db.exec(`CREATE INDEX IF NOT EXISTS idx_standup_reports_workspace_id ON standup_reports(workspace_id)`)
    }
  },
  {
    id: '022_workspace_isolation_phase2',
    up: (db) => {
      const addWorkspaceIdColumn = (table: string) => {
        const tableExists = db
          .prepare(`SELECT 1 as ok FROM sqlite_master WHERE type = 'table' AND name = ?`)
          .get(table) as { ok?: number } | undefined
        if (!tableExists?.ok) return

        const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
        if (!cols.some((c) => c.name === 'workspace_id')) {
          db.exec(`ALTER TABLE ${table} ADD COLUMN workspace_id INTEGER NOT NULL DEFAULT 1`)
        }
        db.exec(`UPDATE ${table} SET workspace_id = COALESCE(workspace_id, 1)`)
      }

      const scopedTables = [
        'messages',
        'alert_rules',
        'direct_connections',
        'github_syncs',
        'workflow_pipelines',
        'pipeline_runs',
      ]

      for (const table of scopedTables) {
        addWorkspaceIdColumn(table)
      }

      db.exec(`CREATE INDEX IF NOT EXISTS idx_messages_workspace_id ON messages(workspace_id)`)
      db.exec(`CREATE INDEX IF NOT EXISTS idx_alert_rules_workspace_id ON alert_rules(workspace_id)`)
      db.exec(`CREATE INDEX IF NOT EXISTS idx_direct_connections_workspace_id ON direct_connections(workspace_id)`)
      db.exec(`CREATE INDEX IF NOT EXISTS idx_github_syncs_workspace_id ON github_syncs(workspace_id)`)
      db.exec(`CREATE INDEX IF NOT EXISTS idx_workflow_pipelines_workspace_id ON workflow_pipelines(workspace_id)`)
      db.exec(`CREATE INDEX IF NOT EXISTS idx_pipeline_runs_workspace_id ON pipeline_runs(workspace_id)`)
    }
  },
  {
    id: '023_workspace_isolation_phase3',
    up: (db) => {
      const addWorkspaceIdColumn = (table: string) => {
        const tableExists = db
          .prepare(`SELECT 1 as ok FROM sqlite_master WHERE type = 'table' AND name = ?`)
          .get(table) as { ok?: number } | undefined
        if (!tableExists?.ok) return

        const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
        if (!cols.some((c) => c.name === 'workspace_id')) {
          db.exec(`ALTER TABLE ${table} ADD COLUMN workspace_id INTEGER NOT NULL DEFAULT 1`)
        }
        db.exec(`UPDATE ${table} SET workspace_id = COALESCE(workspace_id, 1)`)
      }

      const scopedTables = [
        'workflow_templates',
        'webhooks',
        'webhook_deliveries',
        'token_usage',
      ]

      for (const table of scopedTables) {
        addWorkspaceIdColumn(table)
      }

      db.exec(`CREATE INDEX IF NOT EXISTS idx_workflow_templates_workspace_id ON workflow_templates(workspace_id)`)
      db.exec(`CREATE INDEX IF NOT EXISTS idx_webhooks_workspace_id ON webhooks(workspace_id)`)
      db.exec(`CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_workspace_id ON webhook_deliveries(workspace_id)`)
      db.exec(`CREATE INDEX IF NOT EXISTS idx_token_usage_workspace_id ON token_usage(workspace_id)`)
    }
  },
  {
    id: '024_projects_support',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS projects (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          workspace_id INTEGER NOT NULL DEFAULT 1,
          name TEXT NOT NULL,
          slug TEXT NOT NULL,
          description TEXT,
          ticket_prefix TEXT NOT NULL,
          ticket_counter INTEGER NOT NULL DEFAULT 0,
          status TEXT NOT NULL DEFAULT 'active',
          created_at INTEGER NOT NULL DEFAULT (unixepoch()),
          updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
          UNIQUE(workspace_id, slug),
          UNIQUE(workspace_id, ticket_prefix)
        )
      `)
      db.exec(`CREATE INDEX IF NOT EXISTS idx_projects_workspace_status ON projects(workspace_id, status)`)

      const taskCols = db.prepare(`PRAGMA table_info(tasks)`).all() as Array<{ name: string }>
      if (!taskCols.some((c) => c.name === 'project_id')) {
        db.exec(`ALTER TABLE tasks ADD COLUMN project_id INTEGER`)
      }
      if (!taskCols.some((c) => c.name === 'project_ticket_no')) {
        db.exec(`ALTER TABLE tasks ADD COLUMN project_ticket_no INTEGER`)
      }
      db.exec(`CREATE INDEX IF NOT EXISTS idx_tasks_workspace_project ON tasks(workspace_id, project_id)`)

      const workspaceRows = db.prepare(`SELECT id FROM workspaces ORDER BY id ASC`).all() as Array<{ id: number }>
      const ensureDefaultProject = db.prepare(`
        INSERT OR IGNORE INTO projects (workspace_id, name, slug, description, ticket_prefix, ticket_counter, status, created_at, updated_at)
        VALUES (?, 'General', 'general', 'Default project for uncategorized tasks', 'TASK', 0, 'active', unixepoch(), unixepoch())
      `)
      const getDefaultProject = db.prepare(`
        SELECT id, ticket_counter FROM projects
        WHERE workspace_id = ? AND slug = 'general'
        LIMIT 1
      `)
      const setTaskProject = db.prepare(`
        UPDATE tasks SET project_id = ?
        WHERE workspace_id = ? AND (project_id IS NULL OR project_id = 0)
      `)
      const listProjectTasks = db.prepare(`
        SELECT id FROM tasks
        WHERE workspace_id = ? AND project_id = ?
        ORDER BY created_at ASC, id ASC
      `)
      const setTaskNo = db.prepare(`UPDATE tasks SET project_ticket_no = ? WHERE id = ?`)
      const setProjectCounter = db.prepare(`UPDATE projects SET ticket_counter = ?, updated_at = unixepoch() WHERE id = ?`)

      for (const workspace of workspaceRows) {
        ensureDefaultProject.run(workspace.id)
        const defaultProject = getDefaultProject.get(workspace.id) as { id: number; ticket_counter: number } | undefined
        if (!defaultProject) continue

        setTaskProject.run(defaultProject.id, workspace.id)

        const projectRows = db.prepare(`
          SELECT id FROM projects
          WHERE workspace_id = ?
          ORDER BY id ASC
        `).all(workspace.id) as Array<{ id: number }>

        for (const project of projectRows) {
          const tasks = listProjectTasks.all(workspace.id, project.id) as Array<{ id: number }>
          let counter = 0
          for (const task of tasks) {
            counter += 1
            setTaskNo.run(counter, task.id)
          }
          setProjectCounter.run(counter, project.id)
        }
      }
    }
  },
  {
    id: '025_token_usage_task_attribution',
    up: (db) => {
      const hasTokenUsageTable = db
        .prepare(`SELECT 1 as ok FROM sqlite_master WHERE type = 'table' AND name = 'token_usage'`)
        .get() as { ok?: number } | undefined

      if (!hasTokenUsageTable?.ok) return

      const cols = db.prepare(`PRAGMA table_info(token_usage)`).all() as Array<{ name: string }>
      const hasCol = (name: string) => cols.some((c) => c.name === name)

      if (!hasCol('task_id')) {
        db.exec(`ALTER TABLE token_usage ADD COLUMN task_id INTEGER`)
      }

      db.exec(`CREATE INDEX IF NOT EXISTS idx_token_usage_task_id ON token_usage(task_id)`)
      db.exec(`CREATE INDEX IF NOT EXISTS idx_token_usage_workspace_task_time ON token_usage(workspace_id, task_id, created_at)`)
    }
  },
  {
    id: '026_task_outcome_tracking',
    up: (db) => {
      const hasTasks = db
        .prepare(`SELECT 1 as ok FROM sqlite_master WHERE type = 'table' AND name = 'tasks'`)
        .get() as { ok?: number } | undefined
      if (!hasTasks?.ok) return

      const taskCols = db.prepare(`PRAGMA table_info(tasks)`).all() as Array<{ name: string }>
      const hasCol = (name: string) => taskCols.some((c) => c.name === name)

      if (!hasCol('outcome')) db.exec(`ALTER TABLE tasks ADD COLUMN outcome TEXT`)
      if (!hasCol('error_message')) db.exec(`ALTER TABLE tasks ADD COLUMN error_message TEXT`)
      if (!hasCol('resolution')) db.exec(`ALTER TABLE tasks ADD COLUMN resolution TEXT`)
      if (!hasCol('feedback_rating')) db.exec(`ALTER TABLE tasks ADD COLUMN feedback_rating INTEGER`)
      if (!hasCol('feedback_notes')) db.exec(`ALTER TABLE tasks ADD COLUMN feedback_notes TEXT`)
      if (!hasCol('retry_count')) db.exec(`ALTER TABLE tasks ADD COLUMN retry_count INTEGER NOT NULL DEFAULT 0`)
      if (!hasCol('completed_at')) db.exec(`ALTER TABLE tasks ADD COLUMN completed_at INTEGER`)

      db.exec(`CREATE INDEX IF NOT EXISTS idx_tasks_outcome ON tasks(outcome)`)
      db.exec(`CREATE INDEX IF NOT EXISTS idx_tasks_completed_at ON tasks(completed_at)`)
      db.exec(`CREATE INDEX IF NOT EXISTS idx_tasks_workspace_outcome ON tasks(workspace_id, outcome, completed_at)`)
    }
  },
  {
    id: '027_enhanced_projects',
    up: (db) => {
      const hasProjects = db
        .prepare(`SELECT 1 as ok FROM sqlite_master WHERE type = 'table' AND name = 'projects'`)
        .get() as { ok?: number } | undefined
      if (!hasProjects?.ok) return

      const cols = db.prepare(`PRAGMA table_info(projects)`).all() as Array<{ name: string }>
      const hasCol = (name: string) => cols.some((c) => c.name === name)

      if (!hasCol('github_repo')) db.exec(`ALTER TABLE projects ADD COLUMN github_repo TEXT`)
      if (!hasCol('deadline')) db.exec(`ALTER TABLE projects ADD COLUMN deadline INTEGER`)
      if (!hasCol('color')) db.exec(`ALTER TABLE projects ADD COLUMN color TEXT`)
      if (!hasCol('metadata')) db.exec(`ALTER TABLE projects ADD COLUMN metadata TEXT`)

      db.exec(`
        CREATE TABLE IF NOT EXISTS project_agent_assignments (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          project_id INTEGER NOT NULL,
          agent_name TEXT NOT NULL,
          role TEXT DEFAULT 'member',
          assigned_at INTEGER NOT NULL DEFAULT (unixepoch()),
          FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
          UNIQUE(project_id, agent_name)
        );
        CREATE INDEX IF NOT EXISTS idx_paa_project ON project_agent_assignments(project_id);
        CREATE INDEX IF NOT EXISTS idx_paa_agent ON project_agent_assignments(agent_name);
      `)
    }
  },
  {
    id: '028_github_sync_v2',
    up: (db) => {
      // Tasks: promote GitHub fields from metadata JSON to proper columns
      const taskCols = db.prepare(`PRAGMA table_info(tasks)`).all() as Array<{ name: string }>
      const hasTaskCol = (name: string) => taskCols.some((c) => c.name === name)

      if (!hasTaskCol('github_issue_number')) db.exec(`ALTER TABLE tasks ADD COLUMN github_issue_number INTEGER`)
      if (!hasTaskCol('github_repo')) db.exec(`ALTER TABLE tasks ADD COLUMN github_repo TEXT`)
      if (!hasTaskCol('github_synced_at')) db.exec(`ALTER TABLE tasks ADD COLUMN github_synced_at INTEGER`)
      if (!hasTaskCol('github_branch')) db.exec(`ALTER TABLE tasks ADD COLUMN github_branch TEXT`)
      if (!hasTaskCol('github_pr_number')) db.exec(`ALTER TABLE tasks ADD COLUMN github_pr_number INTEGER`)
      if (!hasTaskCol('github_pr_state')) db.exec(`ALTER TABLE tasks ADD COLUMN github_pr_state TEXT`)

      // Unique index for dedup (partial — only rows with issue numbers)
      db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_github_issue
          ON tasks(workspace_id, github_repo, github_issue_number)
          WHERE github_issue_number IS NOT NULL
      `)

      // Projects: sync control columns
      const projCols = db.prepare(`PRAGMA table_info(projects)`).all() as Array<{ name: string }>
      const hasProjCol = (name: string) => projCols.some((c) => c.name === name)

      if (!hasProjCol('github_sync_enabled')) db.exec(`ALTER TABLE projects ADD COLUMN github_sync_enabled INTEGER NOT NULL DEFAULT 0`)
      if (!hasProjCol('github_labels_initialized')) db.exec(`ALTER TABLE projects ADD COLUMN github_labels_initialized INTEGER NOT NULL DEFAULT 0`)
      if (!hasProjCol('github_default_branch')) db.exec(`ALTER TABLE projects ADD COLUMN github_default_branch TEXT DEFAULT 'main'`)

      // Enhanced sync history columns
      const syncCols = db.prepare(`PRAGMA table_info(github_syncs)`).all() as Array<{ name: string }>
      const hasSyncCol = (name: string) => syncCols.some((c) => c.name === name)

      if (!hasSyncCol('project_id')) db.exec(`ALTER TABLE github_syncs ADD COLUMN project_id INTEGER`)
      if (!hasSyncCol('changes_pushed')) db.exec(`ALTER TABLE github_syncs ADD COLUMN changes_pushed INTEGER NOT NULL DEFAULT 0`)
      if (!hasSyncCol('changes_pulled')) db.exec(`ALTER TABLE github_syncs ADD COLUMN changes_pulled INTEGER NOT NULL DEFAULT 0`)
      db.exec(`CREATE INDEX IF NOT EXISTS idx_github_syncs_project ON github_syncs(project_id)`)

      // Data migration: copy existing metadata JSON values into new columns
      db.exec(`
        UPDATE tasks
        SET github_repo = json_extract(metadata, '$.github_repo'),
            github_issue_number = json_extract(metadata, '$.github_issue_number'),
            github_synced_at = CAST(strftime('%s', json_extract(metadata, '$.github_synced_at')) AS INTEGER)
        WHERE json_extract(metadata, '$.github_repo') IS NOT NULL
          AND github_repo IS NULL
      `)
    }
  },
  {
    id: '029_link_workspaces_to_tenants',
    up: (db) => {
      const hasWorkspaces = db
        .prepare(`SELECT 1 as ok FROM sqlite_master WHERE type = 'table' AND name = 'workspaces'`)
        .get() as { ok?: number } | undefined
      if (!hasWorkspaces?.ok) return

      const hasTenants = db
        .prepare(`SELECT 1 as ok FROM sqlite_master WHERE type = 'table' AND name = 'tenants'`)
        .get() as { ok?: number } | undefined
      if (!hasTenants?.ok) return

      const workspaceCols = db.prepare(`PRAGMA table_info(workspaces)`).all() as Array<{ name: string }>
      const hasWorkspaceTenantId = workspaceCols.some((c) => c.name === 'tenant_id')
      if (!hasWorkspaceTenantId) {
        db.exec(`ALTER TABLE workspaces ADD COLUMN tenant_id INTEGER`)
      }

      const tenantCount = (db.prepare(`SELECT COUNT(*) as c FROM tenants`).get() as { c: number } | undefined)?.c || 0
      let defaultTenantId: number
      if (tenantCount > 0) {
        const existing = db.prepare(`
          SELECT id
          FROM tenants
          ORDER BY CASE WHEN status = 'active' THEN 0 ELSE 1 END, id ASC
          LIMIT 1
        `).get() as { id: number } | undefined
        if (!existing?.id) throw new Error('Failed to resolve default tenant')
        defaultTenantId = existing.id
      } else {
        const rawHost = String(process.env.MC_HOSTNAME || 'default').trim().toLowerCase()
        const slug = rawHost.replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || 'default'
        const linuxUser = (String(process.env.USER || 'local').trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-') || 'local').slice(0, 30)
        const home = String(process.env.HOME || '/tmp').trim() || '/tmp'
        const insert = db.prepare(`
          INSERT INTO tenants (slug, display_name, linux_user, plan_tier, status, openclaw_home, workspace_root, config, created_by, owner_gateway)
          VALUES (?, ?, ?, 'standard', 'active', ?, ?, '{}', 'system', ?)
        `).run(
          slug,
          'Local Owner',
          linuxUser,
          `${home}/.openclaw`,
          `${home}/workspace`,
          process.env.MC_DEFAULT_OWNER_GATEWAY || process.env.MC_DEFAULT_GATEWAY_NAME || 'primary'
        )
        defaultTenantId = Number(insert.lastInsertRowid)
      }

      db.prepare(`UPDATE workspaces SET tenant_id = ? WHERE tenant_id IS NULL`).run(defaultTenantId)

      // Ensure session rows can carry tenant context derived from workspace.
      const sessionCols = db.prepare(`PRAGMA table_info(user_sessions)`).all() as Array<{ name: string }>
      if (!sessionCols.some((c) => c.name === 'tenant_id')) {
        db.exec(`ALTER TABLE user_sessions ADD COLUMN tenant_id INTEGER`)
      }
      db.exec(`
        UPDATE user_sessions
        SET tenant_id = (
          SELECT w.tenant_id
          FROM users u
          JOIN workspaces w ON w.id = COALESCE(user_sessions.workspace_id, u.workspace_id, 1)
          WHERE u.id = user_sessions.user_id
          LIMIT 1
        )
        WHERE tenant_id IS NULL
      `)
      db.prepare(`UPDATE user_sessions SET tenant_id = ? WHERE tenant_id IS NULL`).run(defaultTenantId)

      const workspaceFk = db.prepare(`PRAGMA foreign_key_list(workspaces)`).all() as Array<{ table: string; from: string; to: string }>
      const hasTenantFk = workspaceFk.some((fk) => fk.table === 'tenants' && fk.from === 'tenant_id' && fk.to === 'id')
      const tenantCol = (db.prepare(`PRAGMA table_info(workspaces)`).all() as Array<{ name: string; notnull: number }>).find((c) => c.name === 'tenant_id')
      const tenantColNotNull = tenantCol?.notnull === 1

      if (!hasTenantFk || !tenantColNotNull) {
        db.exec(`ALTER TABLE workspaces RENAME TO workspaces__legacy`)
        db.exec(`
          CREATE TABLE workspaces (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            slug TEXT NOT NULL UNIQUE,
            name TEXT NOT NULL,
            tenant_id INTEGER NOT NULL,
            created_at INTEGER NOT NULL DEFAULT (unixepoch()),
            updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
            FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
          )
        `)
        db.prepare(`
          INSERT INTO workspaces (id, slug, name, tenant_id, created_at, updated_at)
          SELECT id, slug, name, COALESCE(tenant_id, ?), created_at, updated_at
          FROM workspaces__legacy
        `).run(defaultTenantId)
        db.exec(`DROP TABLE workspaces__legacy`)
      }

      db.exec(`CREATE INDEX IF NOT EXISTS idx_workspaces_slug ON workspaces(slug)`)
      db.exec(`CREATE INDEX IF NOT EXISTS idx_workspaces_tenant_id ON workspaces(tenant_id)`)
      db.exec(`CREATE INDEX IF NOT EXISTS idx_user_sessions_tenant_id ON user_sessions(tenant_id)`)
      db.exec(`CREATE INDEX IF NOT EXISTS idx_user_sessions_workspace_tenant ON user_sessions(workspace_id, tenant_id)`)
    }
  },
  {
    id: '032_adapter_configs',
    up(db: Database.Database) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS adapter_configs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          workspace_id INTEGER NOT NULL,
          framework TEXT NOT NULL,
          config TEXT DEFAULT '{}',
          enabled INTEGER NOT NULL DEFAULT 1,
          created_at INTEGER NOT NULL DEFAULT (unixepoch()),
          updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
          FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
        )
      `)
      db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_adapter_configs_workspace_framework ON adapter_configs(workspace_id, framework)`)
    }
  },
  {
    id: '033_skills',
    up(db: Database.Database) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS skills (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL,
          source TEXT NOT NULL,
          path TEXT NOT NULL,
          description TEXT,
          content_hash TEXT,
          registry_slug TEXT,
          registry_version TEXT,
          security_status TEXT DEFAULT 'unchecked',
          installed_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now')),
          UNIQUE(source, name)
        )
      `)
      db.exec(`CREATE INDEX IF NOT EXISTS idx_skills_name ON skills(name)`)
      db.exec(`CREATE INDEX IF NOT EXISTS idx_skills_source ON skills(source)`)
      db.exec(`CREATE INDEX IF NOT EXISTS idx_skills_registry_slug ON skills(registry_slug)`)
    }
  },
  {
    id: '034_agents_source',
    up(db: Database.Database) {
      const cols = db.prepare(`PRAGMA table_info(agents)`).all() as Array<{ name: string }>
      if (!cols.some(c => c.name === 'source')) {
        db.exec(`ALTER TABLE agents ADD COLUMN source TEXT DEFAULT 'manual'`)
      }
      if (!cols.some(c => c.name === 'content_hash')) {
        db.exec(`ALTER TABLE agents ADD COLUMN content_hash TEXT`)
      }
      if (!cols.some(c => c.name === 'workspace_path')) {
        db.exec(`ALTER TABLE agents ADD COLUMN workspace_path TEXT`)
      }
      db.exec(`CREATE INDEX IF NOT EXISTS idx_agents_source ON agents(source)`)
    }
  },
  {
    id: '035_api_keys_v2',
    up(db: Database.Database) {
      // Previous migrations (027/030) may have created an api_keys table with a different schema.
      // Drop and recreate with the full user-scoped schema.
      const existing = db
        .prepare(`SELECT 1 as ok FROM sqlite_master WHERE type = 'table' AND name = 'api_keys'`)
        .get() as { ok?: number } | undefined

      if (existing?.ok) {
        db.exec(`DROP TABLE api_keys`)
      }

      db.exec(`
        CREATE TABLE api_keys (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL,
          label TEXT NOT NULL,
          key_prefix TEXT NOT NULL,
          key_hash TEXT NOT NULL UNIQUE,
          role TEXT NOT NULL DEFAULT 'viewer',
          scopes TEXT,
          expires_at INTEGER,
          last_used_at INTEGER,
          last_used_ip TEXT,
          workspace_id INTEGER NOT NULL DEFAULT 1,
          tenant_id INTEGER NOT NULL DEFAULT 1,
          is_revoked INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL DEFAULT (unixepoch()),
          updated_at INTEGER NOT NULL DEFAULT (unixepoch())
        )
      `)
      db.exec(`CREATE INDEX IF NOT EXISTS idx_api_keys_key_hash ON api_keys(key_hash)`)
      db.exec(`CREATE INDEX IF NOT EXISTS idx_api_keys_user_id ON api_keys(user_id)`)
      db.exec(`CREATE INDEX IF NOT EXISTS idx_api_keys_workspace_id ON api_keys(workspace_id)`)
      db.exec(`CREATE INDEX IF NOT EXISTS idx_api_keys_prefix ON api_keys(key_prefix)`)
    }
  },
  {
    id: '036_recurring_tasks_index',
    up(db: Database.Database) {
      // Index to efficiently find recurring task templates
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_tasks_recurring
        ON tasks(workspace_id)
        WHERE json_extract(metadata, '$.recurrence.enabled') = 1
      `)
    }
  },
  {
    id: '037_security_audit',
    up(db: Database.Database) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS security_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          event_type TEXT NOT NULL,
          severity TEXT NOT NULL DEFAULT 'info',
          source TEXT,
          agent_name TEXT,
          detail TEXT,
          ip_address TEXT,
          workspace_id INTEGER NOT NULL DEFAULT 1,
          tenant_id INTEGER NOT NULL DEFAULT 1,
          created_at INTEGER NOT NULL DEFAULT (unixepoch())
        )
      `)
      db.exec(`CREATE INDEX IF NOT EXISTS idx_security_events_event_type ON security_events(event_type)`)
      db.exec(`CREATE INDEX IF NOT EXISTS idx_security_events_severity ON security_events(severity)`)
      db.exec(`CREATE INDEX IF NOT EXISTS idx_security_events_created_at ON security_events(created_at)`)
      db.exec(`CREATE INDEX IF NOT EXISTS idx_security_events_agent_name ON security_events(agent_name)`)
      db.exec(`CREATE INDEX IF NOT EXISTS idx_security_events_workspace_id ON security_events(workspace_id)`)

      db.exec(`
        CREATE TABLE IF NOT EXISTS agent_trust_scores (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          agent_name TEXT NOT NULL,
          trust_score REAL NOT NULL DEFAULT 1.0,
          auth_failures INTEGER NOT NULL DEFAULT 0,
          injection_attempts INTEGER NOT NULL DEFAULT 0,
          rate_limit_hits INTEGER NOT NULL DEFAULT 0,
          secret_exposures INTEGER NOT NULL DEFAULT 0,
          successful_tasks INTEGER NOT NULL DEFAULT 0,
          failed_tasks INTEGER NOT NULL DEFAULT 0,
          last_anomaly_at INTEGER,
          workspace_id INTEGER NOT NULL DEFAULT 1,
          updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
          UNIQUE(agent_name, workspace_id)
        )
      `)

      db.exec(`
        CREATE TABLE IF NOT EXISTS mcp_call_log (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          agent_name TEXT,
          mcp_server TEXT,
          tool_name TEXT,
          success INTEGER NOT NULL DEFAULT 1,
          duration_ms INTEGER,
          error TEXT,
          workspace_id INTEGER NOT NULL DEFAULT 1,
          created_at INTEGER NOT NULL DEFAULT (unixepoch())
        )
      `)
      db.exec(`CREATE INDEX IF NOT EXISTS idx_mcp_call_log_agent_name ON mcp_call_log(agent_name)`)
      db.exec(`CREATE INDEX IF NOT EXISTS idx_mcp_call_log_created_at ON mcp_call_log(created_at)`)
      db.exec(`CREATE INDEX IF NOT EXISTS idx_mcp_call_log_tool_name ON mcp_call_log(tool_name)`)
    }
  },
  {
    id: '038_agent_evals',
    up(db: Database.Database) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS eval_runs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          agent_name TEXT NOT NULL,
          eval_layer TEXT NOT NULL,
          score REAL,
          passed INTEGER,
          detail TEXT,
          golden_dataset_id INTEGER,
          workspace_id INTEGER NOT NULL DEFAULT 1,
          created_at INTEGER NOT NULL DEFAULT (unixepoch())
        )
      `)
      db.exec(`CREATE INDEX IF NOT EXISTS idx_eval_runs_agent_name ON eval_runs(agent_name)`)
      db.exec(`CREATE INDEX IF NOT EXISTS idx_eval_runs_eval_layer ON eval_runs(eval_layer)`)
      db.exec(`CREATE INDEX IF NOT EXISTS idx_eval_runs_created_at ON eval_runs(created_at)`)

      db.exec(`
        CREATE TABLE IF NOT EXISTS eval_golden_sets (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL,
          description TEXT,
          entries TEXT NOT NULL DEFAULT '[]',
          created_by TEXT,
          workspace_id INTEGER NOT NULL DEFAULT 1,
          created_at INTEGER NOT NULL DEFAULT (unixepoch()),
          updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
          UNIQUE(name, workspace_id)
        )
      `)

      db.exec(`
        CREATE TABLE IF NOT EXISTS eval_traces (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          agent_name TEXT NOT NULL,
          task_id INTEGER,
          trace TEXT NOT NULL DEFAULT '[]',
          convergence_score REAL,
          total_steps INTEGER,
          optimal_steps INTEGER,
          workspace_id INTEGER NOT NULL DEFAULT 1,
          created_at INTEGER NOT NULL DEFAULT (unixepoch())
        )
      `)
      db.exec(`CREATE INDEX IF NOT EXISTS idx_eval_traces_agent_name ON eval_traces(agent_name)`)
      db.exec(`CREATE INDEX IF NOT EXISTS idx_eval_traces_task_id ON eval_traces(task_id)`)
    }
  },
  {
    id: '039_session_costs',
    up(db: Database.Database) {
      const columns = db.prepare(`PRAGMA table_info(token_usage)`).all() as Array<{ name: string }>
      const existing = new Set(columns.map((c) => c.name))

      if (!existing.has('cost_usd')) {
        db.exec(`ALTER TABLE token_usage ADD COLUMN cost_usd REAL`)
      }
      if (!existing.has('agent_name')) {
        db.exec(`ALTER TABLE token_usage ADD COLUMN agent_name TEXT`)
      }
      if (!existing.has('task_id')) {
        db.exec(`ALTER TABLE token_usage ADD COLUMN task_id INTEGER`)
      }
    }
  },
  {
    id: '040_agent_api_keys',
    up(db: Database.Database) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS agent_api_keys (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          agent_id INTEGER NOT NULL,
          workspace_id INTEGER NOT NULL DEFAULT 1,
          name TEXT NOT NULL,
          key_hash TEXT NOT NULL,
          key_prefix TEXT NOT NULL,
          scopes TEXT NOT NULL DEFAULT '[]',
          expires_at INTEGER,
          revoked_at INTEGER,
          last_used_at INTEGER,
          created_by TEXT,
          created_at INTEGER NOT NULL DEFAULT (unixepoch()),
          updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
          UNIQUE(workspace_id, key_hash)
        )
      `)
      db.exec(`CREATE INDEX IF NOT EXISTS idx_agent_api_keys_agent_id ON agent_api_keys(agent_id)`)
      db.exec(`CREATE INDEX IF NOT EXISTS idx_agent_api_keys_workspace_id ON agent_api_keys(workspace_id)`)
      db.exec(`CREATE INDEX IF NOT EXISTS idx_agent_api_keys_expires_at ON agent_api_keys(expires_at)`)
      db.exec(`CREATE INDEX IF NOT EXISTS idx_agent_api_keys_revoked_at ON agent_api_keys(revoked_at)`)
    }
  },
  {
    id: '041_gateway_health_logs',
    up(db: Database.Database) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS gateway_health_logs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          gateway_id INTEGER NOT NULL,
          status TEXT NOT NULL,
          latency INTEGER,
          probed_at INTEGER NOT NULL DEFAULT (unixepoch()),
          error TEXT
        )
      `)
      db.exec(`CREATE INDEX IF NOT EXISTS idx_gateway_health_logs_gateway_id ON gateway_health_logs(gateway_id)`)
      db.exec(`CREATE INDEX IF NOT EXISTS idx_gateway_health_logs_probed_at ON gateway_health_logs(probed_at)`)
    }
  },
  {
    id: '042_agent_hidden',
    up(db: Database.Database) {
      db.exec(`ALTER TABLE agents ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0`)
    }
  },
  {
    id: '043_hash_session_tokens',
    up(db: Database.Database) {
      // Migrate existing plaintext session tokens to SHA-256 hashes.
      // After this migration, session tokens are stored as hashes — raw tokens
      // are only returned to the client on creation. Existing sessions will be
      // invalidated (users need to re-login).
      const rows = db.prepare('SELECT id, token FROM user_sessions').all() as Array<{ id: number; token: string }>
      const update = db.prepare('UPDATE user_sessions SET token = ? WHERE id = ?')
      for (const row of rows) {
        const hashed = createHash('sha256').update(row.token).digest('hex')
        update.run(hashed, row.id)
      }
    }
  },
  {
    id: '044_spawn_history',
    up(db: Database.Database) {
      db.exec([
        `CREATE TABLE IF NOT EXISTS spawn_history (`,
        `  id INTEGER PRIMARY KEY AUTOINCREMENT,`,
        `  agent_id INTEGER,`,
        `  agent_name TEXT NOT NULL,`,
        `  spawn_type TEXT NOT NULL DEFAULT 'claude-code',`,
        `  session_id TEXT,`,
        `  trigger TEXT,`,
        `  status TEXT NOT NULL DEFAULT 'started',`,
        `  exit_code INTEGER,`,
        `  error TEXT,`,
        `  duration_ms INTEGER,`,
        `  workspace_id INTEGER NOT NULL DEFAULT 1,`,
        `  created_at INTEGER NOT NULL DEFAULT (unixepoch()),`,
        `  finished_at INTEGER,`,
        `  FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE SET NULL`,
        `)`,
      ].join('\n'))
      db.exec(`CREATE INDEX IF NOT EXISTS idx_spawn_history_agent ON spawn_history(agent_name)`)
      db.exec(`CREATE INDEX IF NOT EXISTS idx_spawn_history_created ON spawn_history(created_at)`)
      db.exec(`CREATE INDEX IF NOT EXISTS idx_spawn_history_status ON spawn_history(status)`)
    }
  },
  {
    id: '045_task_dispatch_attempts',
    up(db: Database.Database) {
      const cols = db.prepare(`PRAGMA table_info(tasks)`).all() as Array<{ name: string }>
      if (!cols.some(c => c.name === 'dispatch_attempts')) {
        db.exec(`ALTER TABLE tasks ADD COLUMN dispatch_attempts INTEGER NOT NULL DEFAULT 0`)
      }
      db.exec(`CREATE INDEX IF NOT EXISTS idx_tasks_stale_inprogress ON tasks(status, updated_at) WHERE status = 'in_progress'`)
    }
  },
  {
    id: '046_agent_runs',
    up(db: Database.Database) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS runs (
          id TEXT PRIMARY KEY,
          agent_id TEXT NOT NULL,
          agent_name TEXT,
          model TEXT,
          provider TEXT,
          runtime TEXT DEFAULT 'mission-control',
          runtime_version TEXT,
          trigger_type TEXT,
          parent_run_id TEXT,
          task_id TEXT,
          status TEXT NOT NULL DEFAULT 'pending',
          outcome TEXT,
          started_at TEXT NOT NULL,
          ended_at TEXT,
          duration_ms INTEGER,
          steps TEXT DEFAULT '[]',
          tools_available TEXT DEFAULT '[]',
          cost_input_tokens INTEGER DEFAULT 0,
          cost_output_tokens INTEGER DEFAULT 0,
          cost_cache_read_tokens INTEGER,
          cost_cache_write_tokens INTEGER,
          cost_usd REAL,
          cost_model TEXT,
          run_hash TEXT,
          parent_run_hash TEXT,
          lineage TEXT DEFAULT '[]',
          model_version TEXT,
          config_hash TEXT,
          provenance_runtime TEXT,
          signed_by TEXT,
          signature TEXT,
          provenance_created_at TEXT,
          eval_task_type TEXT,
          eval_layer TEXT,
          eval_pass INTEGER,
          eval_score REAL,
          eval_detail TEXT,
          eval_metrics TEXT,
          eval_benchmark_id TEXT,
          error TEXT,
          git_branch TEXT,
          git_commit TEXT,
          workspace_id INTEGER DEFAULT 1,
          tags TEXT DEFAULT '[]',
          metadata TEXT DEFAULT '{}',
          spawn_history_id INTEGER,
          created_at INTEGER DEFAULT (unixepoch())
        )
      `)
      db.exec(`CREATE INDEX IF NOT EXISTS idx_runs_agent_id ON runs(agent_id)`)
      db.exec(`CREATE INDEX IF NOT EXISTS idx_runs_status ON runs(status)`)
      db.exec(`CREATE INDEX IF NOT EXISTS idx_runs_created_at ON runs(created_at)`)
      db.exec(`CREATE INDEX IF NOT EXISTS idx_runs_workspace ON runs(workspace_id)`)
      db.exec(`CREATE INDEX IF NOT EXISTS idx_runs_run_hash ON runs(run_hash)`)
      db.exec(`CREATE INDEX IF NOT EXISTS idx_runs_task_id ON runs(task_id)`)
    }
  },
  {
    id: '047_agent_working_memory',
    up(db: Database.Database) {
      const cols = db.prepare(`PRAGMA table_info(agents)`).all() as Array<{ name: string }>
      if (!cols.some(c => c.name === 'working_memory')) {
        db.exec(`ALTER TABLE agents ADD COLUMN working_memory TEXT DEFAULT ''`)
      }
    }
  },
  {
    id: '048_memory_fts',
    up(db: Database.Database) {
      db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
          path,
          title,
          content,
          tokenize='porter unicode61'
        )
      `)
      db.exec(`
        CREATE TABLE IF NOT EXISTS memory_fts_meta (
          key TEXT PRIMARY KEY,
          value TEXT
        )
      `)
    }
  },
  {
    id: '049_remote_task_sync',
    up: (db) => {
      const taskCols = db.prepare(`PRAGMA table_info(tasks)`).all() as Array<{ name: string }>
      if (!taskCols.some(c => c.name === 'remote_id')) {
        db.exec(`ALTER TABLE tasks ADD COLUMN remote_id TEXT`)
      }
      if (!taskCols.some(c => c.name === 'remote_notified')) {
        db.exec(`ALTER TABLE tasks ADD COLUMN remote_notified INTEGER`)
      }
      db.exec(`CREATE INDEX IF NOT EXISTS idx_tasks_remote_id ON tasks(remote_id)`)
    }
  },
  {
    id: '050_message_sync',
    up: (db) => {
      const msgCols = db.prepare(`PRAGMA table_info(messages)`).all() as Array<{ name: string }>
      if (!msgCols.some(c => c.name === 'synced')) {
        db.exec(`ALTER TABLE messages ADD COLUMN synced INTEGER NOT NULL DEFAULT 0`)
      }
      db.exec(`CREATE INDEX IF NOT EXISTS idx_messages_synced ON messages(synced)`)
    }
  },
  {
    id: '051_agent_node_id',
    up: (db) => {
      const agentCols = db.prepare(`PRAGMA table_info(agents)`).all() as Array<{ name: string }>
      if (!agentCols.some(c => (c as any).name === 'node_id')) {
        db.exec(`ALTER TABLE agents ADD COLUMN node_id TEXT`)
      }
      db.exec(`CREATE INDEX IF NOT EXISTS idx_agents_node_id ON agents(node_id)`)
    }
  },
  {
    id: '052_agent_framework',
    up: (db) => {
      // Add framework column to distinguish agent types (OpenClaw, Claude, Cursor, etc.)
      const agentCols = db.prepare(`PRAGMA table_info(agents)`).all() as Array<{ name: string }>
      if (!agentCols.some(c => (c as any).name === 'framework')) {
        db.exec(`ALTER TABLE agents ADD COLUMN framework TEXT DEFAULT 'openclaw'`)
      }
      db.exec(`CREATE INDEX IF NOT EXISTS idx_agents_framework ON agents(framework)`)
    }
  },
  {
    id: '053_agent_hierarchy',
    up: (db) => {
      // Add parent_id for hierarchical agents (sub-agents)
      const agentCols = db.prepare(`PRAGMA table_info(agents)`).all() as Array<{ name: string }>
      if (!agentCols.some(c => (c as any).name === 'parent_id')) {
        db.exec(`ALTER TABLE agents ADD COLUMN parent_id INTEGER`)
      }
      db.exec(`CREATE INDEX IF NOT EXISTS idx_agents_parent_id ON agents(parent_id)`)
    }
  },
  {
    id: '054_sync_clients',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS sync_clients (
          client_id TEXT PRIMARY KEY,
          client_name TEXT NOT NULL,
          agent_count INTEGER NOT NULL DEFAULT 0,
          last_seen INTEGER NOT NULL DEFAULT (unixepoch()),
          last_sync_source TEXT,
          created_at INTEGER NOT NULL DEFAULT (unixepoch()),
          updated_at INTEGER NOT NULL DEFAULT (unixepoch())
        )
      `)
      db.exec(`CREATE INDEX IF NOT EXISTS idx_sync_clients_last_seen ON sync_clients(last_seen)`)
      db.exec(`CREATE INDEX IF NOT EXISTS idx_sync_clients_name ON sync_clients(client_name)`)
    }
  },
  {
    id: '055_sync_sessions',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS sync_sessions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          client_id TEXT NOT NULL,
          client_name TEXT NOT NULL,
          session_id TEXT NOT NULL,
          session_key TEXT,
          session_kind TEXT NOT NULL,
          runtime_group TEXT,
          agent TEXT,
          model TEXT,
          tokens TEXT,
          age TEXT,
          active INTEGER NOT NULL DEFAULT 0,
          start_time INTEGER,
          last_activity INTEGER,
          working_dir TEXT,
          last_user_prompt TEXT,
          created_at INTEGER NOT NULL DEFAULT (unixepoch()),
          updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
          UNIQUE(client_id, session_kind, session_id)
        )
      `)
      db.exec(`CREATE INDEX IF NOT EXISTS idx_sync_sessions_client_id ON sync_sessions(client_id)`)
      db.exec(`CREATE INDEX IF NOT EXISTS idx_sync_sessions_last_activity ON sync_sessions(last_activity)`)
    }
  },
  {
    id: '056_sync_skills',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS sync_skills (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          client_id TEXT NOT NULL,
          client_name TEXT NOT NULL,
          name TEXT NOT NULL,
          source TEXT NOT NULL,
          path TEXT NOT NULL,
          description TEXT,
          registry_slug TEXT,
          security_status TEXT,
          created_at INTEGER NOT NULL DEFAULT (unixepoch()),
          updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
          UNIQUE(client_id, source, name)
        )
      `)
      db.exec(`CREATE INDEX IF NOT EXISTS idx_sync_skills_client_id ON sync_skills(client_id)`)
      db.exec(`CREATE INDEX IF NOT EXISTS idx_sync_skills_source ON sync_skills(source)`)
    }
  },
  {
    id: '057_sync_memory_agents',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS sync_memory_agents (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          client_id TEXT NOT NULL,
          client_name TEXT NOT NULL,
          agent_name TEXT NOT NULL,
          db_size INTEGER NOT NULL DEFAULT 0,
          total_chunks INTEGER NOT NULL DEFAULT 0,
          total_files INTEGER NOT NULL DEFAULT 0,
          files_json TEXT NOT NULL DEFAULT '[]',
          created_at INTEGER NOT NULL DEFAULT (unixepoch()),
          updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
          UNIQUE(client_id, agent_name)
        )
      `)
      db.exec(`CREATE INDEX IF NOT EXISTS idx_sync_memory_agents_client_id ON sync_memory_agents(client_id)`)
      db.exec(`CREATE INDEX IF NOT EXISTS idx_sync_memory_agents_agent_name ON sync_memory_agents(agent_name)`)
    }
  },
  {
    id: '058_users_portal_tenant_role',
    up(db: Database.Database) {
      const cols = db.prepare(`PRAGMA table_info(users)`).all() as Array<{ name: string }>
      if (!cols.some((c) => c.name === 'portal_tenant_role')) {
        db.exec(`ALTER TABLE users ADD COLUMN portal_tenant_role TEXT`)
      }
    },
  },
  {
    id: '059_sync_agent_index',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS sync_agent_index (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          client_id TEXT NOT NULL,
          client_name TEXT NOT NULL,
          local_agent_id INTEGER NOT NULL,
          original_name TEXT NOT NULL,
          remote_name TEXT NOT NULL,
          role TEXT NOT NULL DEFAULT 'agent',
          status TEXT NOT NULL DEFAULT 'idle',
          framework TEXT,
          parent_local_id INTEGER,
          updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
          UNIQUE(client_id, local_agent_id)
        )
      `)
      db.exec(`CREATE INDEX IF NOT EXISTS idx_sync_agent_index_client_id ON sync_agent_index(client_id)`)
      db.exec(`CREATE INDEX IF NOT EXISTS idx_sync_agent_index_updated_at ON sync_agent_index(updated_at)`)
    },
  },
  {
    id: '060_human_watch',
    up(db: Database.Database) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS human_watch_bindings (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          workspace_id INTEGER NOT NULL,
          tenant_id INTEGER,
          client_id TEXT NOT NULL,
          worker_sync_index_id INTEGER,
          worker_local_agent_id INTEGER,
          worker_name TEXT,
          steward_sync_index_id INTEGER,
          steward_local_agent_id INTEGER,
          steward_name TEXT,
          worker_session_id TEXT,
          worker_session_kind TEXT,
          enabled INTEGER NOT NULL DEFAULT 1,
          mode TEXT NOT NULL DEFAULT 'auto_send',
          rules_override TEXT,
          created_at INTEGER NOT NULL DEFAULT (unixepoch()),
          updated_at INTEGER NOT NULL DEFAULT (unixepoch())
        )
      `)
      db.exec(`CREATE INDEX IF NOT EXISTS idx_human_watch_bindings_workspace ON human_watch_bindings(workspace_id)`)
      db.exec(`CREATE INDEX IF NOT EXISTS idx_human_watch_bindings_client ON human_watch_bindings(client_id)`)
      db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_human_watch_bindings_worker
        ON human_watch_bindings(workspace_id, client_id, worker_sync_index_id, worker_local_agent_id)
        WHERE worker_sync_index_id IS NOT NULL OR worker_local_agent_id IS NOT NULL`)

      db.exec(`
        CREATE TABLE IF NOT EXISTS human_watch_interventions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          workspace_id INTEGER NOT NULL,
          tenant_id INTEGER,
          client_id TEXT NOT NULL,
          binding_id INTEGER,
          worker_sync_index_id INTEGER,
          worker_local_agent_id INTEGER,
          worker_name TEXT,
          steward_sync_index_id INTEGER,
          steward_local_agent_id INTEGER,
          steward_name TEXT,
          worker_session_id TEXT,
          event_type TEXT NOT NULL,
          decision TEXT,
          rules_hit TEXT,
          fingerprint TEXT,
          prompt_preview TEXT,
          prompt_sha256 TEXT,
          outcome TEXT,
          error_message TEXT,
          bridge_request_id TEXT,
          message_id TEXT,
          correlation_id TEXT,
          llm_sweep INTEGER NOT NULL DEFAULT 0,
          skip_reason TEXT,
          created_at INTEGER NOT NULL DEFAULT (unixepoch()),
          FOREIGN KEY (binding_id) REFERENCES human_watch_bindings(id) ON DELETE SET NULL
        )
      `)
      db.exec(`CREATE INDEX IF NOT EXISTS idx_hw_interventions_workspace_created
        ON human_watch_interventions(workspace_id, created_at DESC)`)
      db.exec(`CREATE INDEX IF NOT EXISTS idx_hw_interventions_binding
        ON human_watch_interventions(binding_id, created_at DESC)`)
      db.exec(`CREATE INDEX IF NOT EXISTS idx_hw_interventions_client
        ON human_watch_interventions(client_id, created_at DESC)`)
      db.exec(`CREATE INDEX IF NOT EXISTS idx_hw_interventions_message
        ON human_watch_interventions(message_id, created_at DESC)`)
      db.exec(`CREATE INDEX IF NOT EXISTS idx_hw_interventions_correlation
        ON human_watch_interventions(correlation_id, created_at DESC)`)
      db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_hw_interventions_idempotent_success
        ON human_watch_interventions(binding_id, fingerprint)
        WHERE event_type = 'intervention_completed'
          AND outcome = 'success'
          AND fingerprint IS NOT NULL
          AND binding_id IS NOT NULL
      `)
    },
  },
  {
    id: '061_human_watch_tenant_flag',
    up(db: Database.Database) {
      const columns = db.prepare(`PRAGMA table_info(tenants)`).all() as Array<{ name: string }>
      const hasFlag = columns.some((col) => col.name === 'human_watch_enabled')
      if (!hasFlag) {
        db.exec(
          `ALTER TABLE tenants ADD COLUMN human_watch_enabled INTEGER NOT NULL DEFAULT 0`,
        )
      }
    },
  },
  {
    id: '063_sync_agent_index_session_key',
    up: (db) => {
      const cols = db.prepare(`PRAGMA table_info(sync_agent_index)`).all() as Array<{ name: string }>
      if (!cols.some((c) => c.name === 'session_key')) {
        db.exec(`ALTER TABLE sync_agent_index ADD COLUMN session_key TEXT`)
      }
    },
  },
  {
    id: '062_human_watch_global_rules',
    up(db: Database.Database) {
      const columns = db.prepare(`PRAGMA table_info(tenants)`).all() as Array<{ name: string }>
      if (!columns.some((col) => col.name === 'human_watch_rules_json')) {
        db.exec(`ALTER TABLE tenants ADD COLUMN human_watch_rules_json TEXT`)
      }
    },
  },
  {
    id: '064_sync_clients_workspace',
    up(db: Database.Database) {
      const columns = db.prepare(`PRAGMA table_info(sync_clients)`).all() as Array<{ name: string }>
      if (!columns.some((col) => col.name === 'workspace_id')) {
        db.exec(`ALTER TABLE sync_clients ADD COLUMN workspace_id INTEGER NOT NULL DEFAULT 1`)
      }
      db.exec(`CREATE INDEX IF NOT EXISTS idx_sync_clients_workspace_last_seen ON sync_clients(workspace_id, last_seen DESC)`)
    },
  },
  {
    id: '065_permission_requests',
    up(db: Database.Database) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS permission_requests (
          id TEXT PRIMARY KEY,
          workspace_id INTEGER NOT NULL,
          tenant_id INTEGER,
          client_id TEXT,
          binding_id INTEGER,
          worker_sync_index_id INTEGER,
          worker_local_agent_id INTEGER,
          worker_name TEXT,
          worker_session_id TEXT,
          steward_sync_index_id INTEGER,
          steward_local_agent_id INTEGER,
          steward_name TEXT,
          request_type TEXT NOT NULL,
          title TEXT NOT NULL,
          prompt TEXT NOT NULL,
          risk TEXT NOT NULL DEFAULT 'medium',
          status TEXT NOT NULL DEFAULT 'pending',
          options_json TEXT NOT NULL,
          context_json TEXT,
          selected_option_id TEXT,
          decision_reason TEXT,
          decider_type TEXT,
          decider_user_id INTEGER,
          decider_agent_id TEXT,
          decided_at INTEGER,
          expires_at INTEGER,
          created_at INTEGER NOT NULL DEFAULT (unixepoch()),
          updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
          FOREIGN KEY (binding_id) REFERENCES human_watch_bindings(id) ON DELETE SET NULL
        )
      `)
      db.exec(`
        CREATE TABLE IF NOT EXISTS permission_request_decisions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          request_id TEXT NOT NULL,
          option_id TEXT NOT NULL,
          reason TEXT,
          decider_type TEXT NOT NULL,
          decider_user_id INTEGER,
          decider_agent_id TEXT,
          created_at INTEGER NOT NULL DEFAULT (unixepoch()),
          FOREIGN KEY (request_id) REFERENCES permission_requests(id) ON DELETE CASCADE
        )
      `)
      db.exec(`CREATE INDEX IF NOT EXISTS idx_permission_requests_workspace_status ON permission_requests(workspace_id, status, created_at DESC)`)
      db.exec(`CREATE INDEX IF NOT EXISTS idx_permission_requests_worker ON permission_requests(client_id, worker_local_agent_id, created_at DESC)`)
      db.exec(`CREATE INDEX IF NOT EXISTS idx_permission_requests_steward ON permission_requests(steward_local_agent_id, created_at DESC)`)
      db.exec(`CREATE INDEX IF NOT EXISTS idx_permission_decisions_request ON permission_request_decisions(request_id, created_at DESC)`)
    },
  },
  {
    id: '066_human_watch_events',
    up(db: Database.Database) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS human_watch_events (
          id TEXT PRIMARY KEY,
          workspace_id INTEGER NOT NULL,
          tenant_id INTEGER,
          client_id TEXT NOT NULL,
          binding_id INTEGER,
          worker_sync_index_id INTEGER,
          worker_local_agent_id INTEGER,
          worker_name TEXT,
          worker_session_id TEXT,
          steward_sync_index_id INTEGER,
          steward_local_agent_id INTEGER,
          steward_name TEXT,
          permission_request_id TEXT,
          source TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending',
          priority TEXT NOT NULL DEFAULT 'medium',
          title TEXT NOT NULL,
          summary TEXT NOT NULL,
          context_json TEXT,
          latest_worker_message TEXT,
          suggested_action TEXT,
          claimed_by_type TEXT,
          claimed_by_user_id INTEGER,
          claimed_by_agent_id TEXT,
          claimed_at INTEGER,
          resolved_action TEXT,
          resolved_note TEXT,
          resolved_by_type TEXT,
          resolved_by_user_id INTEGER,
          resolved_by_agent_id TEXT,
          resolved_at INTEGER,
          dedupe_key TEXT,
          created_at INTEGER NOT NULL DEFAULT (unixepoch()),
          updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
          FOREIGN KEY (binding_id) REFERENCES human_watch_bindings(id) ON DELETE SET NULL,
          FOREIGN KEY (permission_request_id) REFERENCES permission_requests(id) ON DELETE SET NULL
        )
      `)
      db.exec(`CREATE INDEX IF NOT EXISTS idx_hw_events_workspace_status_created
        ON human_watch_events(workspace_id, status, created_at DESC)`)
      db.exec(`CREATE INDEX IF NOT EXISTS idx_hw_events_client_status_created
        ON human_watch_events(client_id, status, created_at DESC)`)
      db.exec(`CREATE INDEX IF NOT EXISTS idx_hw_events_worker_session
        ON human_watch_events(worker_session_id, status, created_at DESC)`)
      db.exec(`CREATE INDEX IF NOT EXISTS idx_hw_events_permission_request
        ON human_watch_events(permission_request_id, status, created_at DESC)`)
      db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_hw_events_dedupe_pending
        ON human_watch_events(workspace_id, client_id, dedupe_key)
        WHERE dedupe_key IS NOT NULL
          AND status IN ('pending', 'visible', 'claimed')`)
    },
  },
  {
    id: '067_edge_messages',
    up(db: Database.Database) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS edge_messages (
          id TEXT PRIMARY KEY,
          schema_version INTEGER NOT NULL DEFAULT 1,
          workspace_id INTEGER NOT NULL,
          tenant_id INTEGER,
          client_id TEXT NOT NULL,
          direction TEXT NOT NULL,
          type TEXT NOT NULL,
          status TEXT NOT NULL,
          correlation_id TEXT NOT NULL,
          idempotency_key TEXT NOT NULL,
          agent_ref_json TEXT,
          session_ref_json TEXT,
          payload_json TEXT NOT NULL,
          result_json TEXT,
          lease_owner TEXT,
          lease_expires_at INTEGER,
          attempt_count INTEGER NOT NULL DEFAULT 0,
          max_attempts INTEGER NOT NULL DEFAULT 5,
          next_attempt_at INTEGER,
          last_error_code TEXT,
          last_error_message TEXT,
          created_at INTEGER NOT NULL DEFAULT (unixepoch()),
          updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
          completed_at INTEGER,
          cancelled_at INTEGER
        )
      `)
      db.exec(`
        CREATE TABLE IF NOT EXISTS edge_message_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          message_id TEXT NOT NULL,
          event_type TEXT NOT NULL,
          from_status TEXT,
          to_status TEXT,
          detail_json TEXT,
          created_at INTEGER NOT NULL DEFAULT (unixepoch()),
          FOREIGN KEY (message_id) REFERENCES edge_messages(id) ON DELETE CASCADE
        )
      `)
      db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_edge_messages_idempotency
        ON edge_messages(tenant_id, client_id, idempotency_key)`)
      db.exec(`CREATE INDEX IF NOT EXISTS idx_edge_messages_pull
        ON edge_messages(client_id, status, next_attempt_at, created_at)`)
      db.exec(`CREATE INDEX IF NOT EXISTS idx_edge_messages_correlation
        ON edge_messages(correlation_id, created_at)`)
      db.exec(`CREATE INDEX IF NOT EXISTS idx_edge_message_events_message
        ON edge_message_events(message_id, created_at)`)
    },
  },
  {
    id: '068_human_watch_intervention_message_trace',
    up(db: Database.Database) {
      const cols = db.prepare(`PRAGMA table_info(human_watch_interventions)`).all() as Array<{ name: string }>
      const hasCol = (name: string) => cols.some((col) => col.name === name)
      if (!hasCol('message_id')) db.exec(`ALTER TABLE human_watch_interventions ADD COLUMN message_id TEXT`)
      if (!hasCol('correlation_id')) db.exec(`ALTER TABLE human_watch_interventions ADD COLUMN correlation_id TEXT`)
      db.exec(`CREATE INDEX IF NOT EXISTS idx_hw_interventions_message
        ON human_watch_interventions(message_id, created_at DESC)`)
      db.exec(`CREATE INDEX IF NOT EXISTS idx_hw_interventions_correlation
        ON human_watch_interventions(correlation_id, created_at DESC)`)
    },
  },
  {
    id: '069_human_watch_binding_session_kind',
    up(db: Database.Database) {
      const cols = db.prepare(`PRAGMA table_info(human_watch_bindings)`).all() as Array<{ name: string }>
      if (!cols.some((col) => col.name === 'worker_session_kind')) {
        db.exec(`ALTER TABLE human_watch_bindings ADD COLUMN worker_session_kind TEXT`)
      }
      db.exec(`
        UPDATE human_watch_bindings
        SET worker_session_kind = (
          SELECT ss.session_kind
          FROM sync_sessions ss
          WHERE ss.client_id = human_watch_bindings.client_id
            AND ss.session_id = human_watch_bindings.worker_session_id
            AND ss.session_kind IN ('claude-code', 'codex-cli', 'hermes')
          ORDER BY ss.updated_at DESC
          LIMIT 1
        )
        WHERE (worker_session_kind IS NULL OR worker_session_kind = '')
          AND worker_session_id IS NOT NULL
          AND worker_session_id != ''
      `)
      db.exec(`
        UPDATE human_watch_bindings
        SET worker_session_kind = (
          SELECT CASE lower(coalesce(sai.framework, ''))
            WHEN 'claude' THEN 'claude-code'
            WHEN 'claude-code' THEN 'claude-code'
            WHEN 'claude-sdk' THEN 'claude-code'
            WHEN 'codex' THEN 'codex-cli'
            WHEN 'codex-cli' THEN 'codex-cli'
            WHEN 'openai' THEN 'codex-cli'
            WHEN 'hermes' THEN 'hermes'
            ELSE NULL
          END
          FROM sync_agent_index sai
          WHERE sai.client_id = human_watch_bindings.client_id
            AND sai.local_agent_id = human_watch_bindings.worker_local_agent_id
          LIMIT 1
        )
        WHERE (worker_session_kind IS NULL OR worker_session_kind = '')
      `)
      db.exec(`CREATE INDEX IF NOT EXISTS idx_human_watch_bindings_session_kind
        ON human_watch_bindings(client_id, worker_session_id, worker_session_kind)`)
    },
  },
  {
    id: '070_supervision_goals_and_memories',
    up(db: Database.Database) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS supervision_goals (
          id TEXT PRIMARY KEY,
          workspace_id INTEGER NOT NULL,
          tenant_id INTEGER,
          client_id TEXT NOT NULL,
          steward_local_agent_id INTEGER NOT NULL,
          steward_session_id TEXT,
          title TEXT NOT NULL,
          objective TEXT NOT NULL,
          success_criteria_json TEXT NOT NULL,
          constraints_json TEXT NOT NULL DEFAULT '[]',
          allowed_workers_json TEXT NOT NULL DEFAULT '[]',
          status TEXT NOT NULL DEFAULT 'draft',
          priority TEXT NOT NULL DEFAULT 'medium',
          budget_json TEXT NOT NULL,
          usage_json TEXT NOT NULL DEFAULT '{}',
          current_plan_version INTEGER NOT NULL DEFAULT 0,
          requires_plan_approval INTEGER NOT NULL DEFAULT 1,
          deadline_at INTEGER,
          created_by TEXT NOT NULL,
          version INTEGER NOT NULL DEFAULT 1,
          created_at INTEGER NOT NULL DEFAULT (unixepoch()),
          updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
          completed_at INTEGER
        )
      `)
      db.exec(`
        CREATE TABLE IF NOT EXISTS supervision_goal_plans (
          id TEXT PRIMARY KEY,
          goal_id TEXT NOT NULL,
          version INTEGER NOT NULL,
          status TEXT NOT NULL DEFAULT 'draft',
          plan_json TEXT NOT NULL,
          rationale TEXT,
          source_event_id INTEGER,
          created_by_type TEXT NOT NULL,
          created_at INTEGER NOT NULL DEFAULT (unixepoch()),
          FOREIGN KEY (goal_id) REFERENCES supervision_goals(id) ON DELETE CASCADE,
          UNIQUE(goal_id, version)
        )
      `)
      db.exec(`
        CREATE TABLE IF NOT EXISTS supervision_goal_tasks (
          goal_id TEXT NOT NULL,
          task_id INTEGER NOT NULL,
          plan_version INTEGER NOT NULL,
          logical_task_key TEXT NOT NULL,
          dependencies_json TEXT NOT NULL DEFAULT '[]',
          acceptance_criteria_json TEXT NOT NULL DEFAULT '[]',
          assigned_agent_id TEXT,
          assigned_session_id TEXT,
          retry_count INTEGER NOT NULL DEFAULT 0,
          reassignment_count INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL DEFAULT (unixepoch()),
          updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
          PRIMARY KEY (goal_id, task_id),
          FOREIGN KEY (goal_id) REFERENCES supervision_goals(id) ON DELETE CASCADE,
          FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE,
          UNIQUE(goal_id, logical_task_key, plan_version)
        )
      `)
      db.exec(`
        CREATE TABLE IF NOT EXISTS supervision_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          workspace_id INTEGER NOT NULL,
          tenant_id INTEGER,
          goal_id TEXT NOT NULL,
          task_id INTEGER,
          event_type TEXT NOT NULL,
          actor_type TEXT NOT NULL,
          actor_id TEXT,
          decision TEXT,
          reason TEXT,
          evidence_json TEXT,
          action_json TEXT,
          message_id TEXT,
          correlation_id TEXT,
          idempotency_key TEXT,
          created_at INTEGER NOT NULL DEFAULT (unixepoch()),
          FOREIGN KEY (goal_id) REFERENCES supervision_goals(id) ON DELETE CASCADE,
          FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE SET NULL
        )
      `)
      db.exec(`
        CREATE TABLE IF NOT EXISTS supervision_leases (
          goal_id TEXT PRIMARY KEY,
          owner_id TEXT NOT NULL,
          lease_expires_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
          FOREIGN KEY (goal_id) REFERENCES supervision_goals(id) ON DELETE CASCADE
        )
      `)
      db.exec(`
        CREATE TABLE IF NOT EXISTS steward_memories (
          id TEXT PRIMARY KEY,
          workspace_id INTEGER NOT NULL,
          tenant_id INTEGER,
          scope_type TEXT NOT NULL,
          scope_id TEXT NOT NULL,
          category TEXT NOT NULL,
          content TEXT NOT NULL,
          summary TEXT,
          source_refs_json TEXT NOT NULL DEFAULT '[]',
          evidence_json TEXT NOT NULL DEFAULT '[]',
          confidence REAL NOT NULL DEFAULT 0.5,
          status TEXT NOT NULL DEFAULT 'candidate',
          supersedes_id TEXT,
          effective_at INTEGER,
          expires_at INTEGER,
          created_by_type TEXT NOT NULL,
          reviewed_by TEXT,
          created_at INTEGER NOT NULL DEFAULT (unixepoch()),
          updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
          FOREIGN KEY (supersedes_id) REFERENCES steward_memories(id) ON DELETE SET NULL
        )
      `)
      db.exec(`
        CREATE TABLE IF NOT EXISTS steward_memory_usage (
          id TEXT PRIMARY KEY,
          workspace_id INTEGER NOT NULL,
          tenant_id INTEGER,
          memory_id TEXT NOT NULL,
          goal_id TEXT,
          intervention_id INTEGER,
          query_text TEXT,
          adopted INTEGER,
          outcome TEXT,
          score REAL,
          created_at INTEGER NOT NULL DEFAULT (unixepoch()),
          updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
          FOREIGN KEY (memory_id) REFERENCES steward_memories(id) ON DELETE CASCADE,
          FOREIGN KEY (goal_id) REFERENCES supervision_goals(id) ON DELETE SET NULL,
          FOREIGN KEY (intervention_id) REFERENCES human_watch_interventions(id) ON DELETE SET NULL
        )
      `)
      db.exec(`CREATE INDEX IF NOT EXISTS idx_supervision_goals_workspace_status
        ON supervision_goals(workspace_id, status, updated_at DESC)`)
      db.exec(`CREATE INDEX IF NOT EXISTS idx_supervision_goals_steward
        ON supervision_goals(client_id, steward_local_agent_id, status)`)
      db.exec(`CREATE INDEX IF NOT EXISTS idx_supervision_plans_goal
        ON supervision_goal_plans(goal_id, version DESC)`)
      db.exec(`CREATE INDEX IF NOT EXISTS idx_supervision_events_goal
        ON supervision_events(goal_id, created_at DESC)`)
      db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_supervision_events_idempotency
        ON supervision_events(workspace_id, idempotency_key)
        WHERE idempotency_key IS NOT NULL`)
      db.exec(`CREATE INDEX IF NOT EXISTS idx_steward_memories_scope_status
        ON steward_memories(workspace_id, tenant_id, scope_type, scope_id, status, updated_at DESC)`)
      db.exec(`CREATE INDEX IF NOT EXISTS idx_steward_memory_usage_memory
        ON steward_memory_usage(memory_id, created_at DESC)`)
    },
  },
]

export function runMigrations(db: Database.Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id TEXT PRIMARY KEY,
      applied_at INTEGER NOT NULL DEFAULT (unixepoch())
    )
  `)

  const applied = new Set(
    db.prepare('SELECT id FROM schema_migrations').all().map((row: any) => row.id)
  )

  for (const migration of [...migrations, ...extraMigrations]) {
    if (applied.has(migration.id)) continue
    db.transaction(() => {
      migration.up(db)
      db.prepare('INSERT OR IGNORE INTO schema_migrations (id) VALUES (?)').run(migration.id)
    })()
  }
}
