-- Run these in the Supabase SQL editor to create the plugin tables.
-- (Skip any CREATE TABLE that already exists — the IF NOT EXISTS guard is safe to re-run.)

-- ── roblox_connections ────────────────────────────────────────────────────────
-- One row per active Studio session.  Deactivated on disconnect / stale heartbeat.
CREATE TABLE IF NOT EXISTS roblox_connections (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_id    uuid        NOT NULL UNIQUE,
  is_active     boolean     NOT NULL DEFAULT true,
  explorer_tree jsonb,                       -- latest explorer snapshot pushed by plugin
  connected_at  timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_roblox_connections_user_active
  ON roblox_connections (user_id, is_active);

-- ── plugin_tasks ──────────────────────────────────────────────────────────────
-- Task queue: frontend enqueues, plugin picks up via /poll, reports back via /result.
CREATE TABLE IF NOT EXISTS plugin_tasks (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_id   uuid        NOT NULL,
  task_type    text        NOT NULL,          -- INSERT_SCRIPT | CREATE_UI | …
  data         jsonb       NOT NULL DEFAULT '{}',
  status       text        NOT NULL DEFAULT 'pending', -- pending | running | done | failed
  result       jsonb,
  error        text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);

CREATE INDEX IF NOT EXISTS idx_plugin_tasks_user_status
  ON plugin_tasks (user_id, status, created_at);

-- Automatically age out completed / failed tasks after 24 hours (optional cron cleanup).
-- ALTER TABLE plugin_tasks ENABLE ROW LEVEL SECURITY;
-- (If you use RLS, add a policy so the service role can read/write unrestricted.)
