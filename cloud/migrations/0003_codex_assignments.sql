ALTER TABLE comment_mentions ADD COLUMN instruction TEXT;
-- statement-breakpoint
ALTER TABLE comment_mentions ADD COLUMN mention_order INTEGER NOT NULL DEFAULT 0 CHECK (mention_order >= 0);
-- statement-breakpoint

CREATE TABLE codex_execution_checkpoints (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  comment_id TEXT NOT NULL,
  target_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('completed', 'failed')),
  summary TEXT NOT NULL,
  changed_files TEXT NOT NULL DEFAULT '[]',
  base_commit TEXT,
  result_commit TEXT,
  branch TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (comment_id, target_id),
  FOREIGN KEY (comment_id, target_id)
    REFERENCES codex_trigger_deliveries(comment_id, target_id)
    ON DELETE CASCADE
);
-- statement-breakpoint

CREATE INDEX codex_execution_checkpoints_task_created
  ON codex_execution_checkpoints(task_id, created_at DESC, id DESC);
-- statement-breakpoint

CREATE TABLE codex_issue_leases (
  task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
  comment_id TEXT NOT NULL,
  target_id TEXT NOT NULL,
  claim_token TEXT NOT NULL UNIQUE,
  claimed_at TEXT NOT NULL,
  lease_expires_at TEXT NOT NULL,
  FOREIGN KEY (comment_id, target_id)
    REFERENCES codex_trigger_deliveries(comment_id, target_id)
    ON DELETE CASCADE
);
