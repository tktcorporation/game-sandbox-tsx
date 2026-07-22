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

-- A server-issued, single-use ticket for one specific /api/opponent match: it pins the
-- opponent squad, opponent rating, and combat rng seed at the moment they were shown to the
-- player, so /api/battle/result can resolve the fight from data the client never controls.
CREATE TABLE IF NOT EXISTS matches (
  id TEXT PRIMARY KEY,
  player_id TEXT NOT NULL REFERENCES players(id),
  opponent_id TEXT NOT NULL,
  opponent_rating INTEGER NOT NULL,
  opponent_monsters TEXT NOT NULL,
  battle_seed INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_players_rating ON players(rating DESC);
CREATE INDEX IF NOT EXISTS idx_squads_power ON squads(power DESC);
CREATE INDEX IF NOT EXISTS idx_matches_player ON matches(player_id);
