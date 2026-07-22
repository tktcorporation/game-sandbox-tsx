-- Apply locally:  wrangler d1 execute game-sandbox-tsx-db --local --file=worker/schema.sql
-- Apply to prod:  wrangler d1 execute game-sandbox-tsx-db --remote --file=worker/schema.sql

CREATE TABLE IF NOT EXISTS players (
  id TEXT PRIMARY KEY,
  token TEXT NOT NULL,
  name TEXT NOT NULL,
  rating INTEGER NOT NULL DEFAULT 1000,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS squads (
  player_id TEXT PRIMARY KEY REFERENCES players(id),
  dex_count INTEGER NOT NULL DEFAULT 0,
  monsters TEXT NOT NULL,
  power INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_players_rating ON players(rating DESC);
CREATE INDEX IF NOT EXISTS idx_squads_power ON squads(power DESC);
