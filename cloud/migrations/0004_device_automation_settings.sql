CREATE TABLE codex_target_automations (
  target_id TEXT NOT NULL REFERENCES codex_targets(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  enabled_by_user INTEGER NOT NULL DEFAULT 0 CHECK (enabled_by_user IN (0, 1)),
  quota_aware INTEGER NOT NULL DEFAULT 0 CHECK (quota_aware IN (0, 1)),
  interval_minutes INTEGER NOT NULL DEFAULT 5 CHECK (interval_minutes IN (5, 10, 15, 30, 60)),
  model TEXT NOT NULL DEFAULT 'gpt-5.5',
  reasoning_effort TEXT NOT NULL DEFAULT 'high',
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  applied_version INTEGER NOT NULL DEFAULT 0 CHECK (applied_version >= 0),
  status TEXT CHECK (status IS NULL OR status IN ('ACTIVE', 'PAUSED')),
  quota_state TEXT CHECK (quota_state IS NULL OR quota_state IN ('available', 'blocked', 'unknown', 'unavailable')),
  quota_checked_at INTEGER,
  quota_resets_at INTEGER,
  quota_reason TEXT,
  quota_windows TEXT,
  updated_at TEXT NOT NULL,
  reported_at TEXT,
  PRIMARY KEY (target_id, project_id)
);
-- statement-breakpoint

CREATE INDEX codex_target_automations_project
  ON codex_target_automations(project_id, target_id);
-- statement-breakpoint

CREATE TRIGGER codex_target_automations_revision_insert
AFTER INSERT ON codex_target_automations
BEGIN
  UPDATE global_revision SET revision = revision + 1 WHERE singleton = 1;
END;
-- statement-breakpoint

CREATE TRIGGER codex_target_automations_revision_update
AFTER UPDATE ON codex_target_automations
BEGIN
  UPDATE global_revision SET revision = revision + 1 WHERE singleton = 1;
END;
