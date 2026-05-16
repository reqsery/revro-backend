-- ═══════════════════════════════════════════════════════════════════
-- Run ALL of this in Supabase → SQL Editor → New query → Run
-- Safe to run multiple times (IF NOT EXISTS / IF NOT EXISTS guards).
-- ═══════════════════════════════════════════════════════════════════

-- ── 1. Discord columns (fixes "Connect Discord" never working) ────────────────
ALTER TABLE users ADD COLUMN IF NOT EXISTS discord_guild_ids  TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS discord_user_id    TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS discord_guild_id   TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS discord_bot_token  TEXT;

-- ── 2. Plugin tables (fixes Roblox Studio plugin) ────────────────────────────
CREATE TABLE IF NOT EXISTS roblox_connections (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_id    uuid        NOT NULL UNIQUE,
  is_active     boolean     NOT NULL DEFAULT true,
  explorer_tree jsonb,
  connected_at  timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_roblox_connections_user_active
  ON roblox_connections (user_id, is_active);

CREATE TABLE IF NOT EXISTS plugin_tasks (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_id   uuid        NOT NULL,
  task_type    text        NOT NULL,
  data         jsonb       NOT NULL DEFAULT '{}',
  status       text        NOT NULL DEFAULT 'pending',
  result       jsonb,
  error        text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);

CREATE INDEX IF NOT EXISTS idx_plugin_tasks_user_status
  ON plugin_tasks (user_id, status, created_at);
