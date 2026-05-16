-- Run this in the Supabase SQL editor (Dashboard → SQL Editor → New query).
-- Safe to run multiple times — ALTER COLUMN IF NOT EXISTS guards prevent errors.

-- Discord OAuth columns (guild IDs the user is admin/owner of)
ALTER TABLE users ADD COLUMN IF NOT EXISTS discord_guild_ids  TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS discord_user_id    TEXT;

-- The single guild the user picked to build with the bot
ALTER TABLE users ADD COLUMN IF NOT EXISTS discord_guild_id   TEXT;

-- Optional: user's own Discord bot token (connect flow in Settings)
ALTER TABLE users ADD COLUMN IF NOT EXISTS discord_bot_token  TEXT;
