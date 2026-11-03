-- RINGFALL players and their islands' summaries (docs/ringfall/multiplayer.md, サーバー).
-- Times are epoch milliseconds.

CREATE TABLE players (
  id TEXT PRIMARY KEY,          -- the anonymous UUID the browser made
  name TEXT NOT NULL,           -- display name, 1 to 24 characters
  created_at INTEGER NOT NULL,
  seen_at INTEGER NOT NULL
);

-- The island as of the player's last settled raid: one row a player.
CREATE TABLE island_summaries (
  player_id TEXT PRIMARY KEY REFERENCES players(id),
  day INTEGER NOT NULL,         -- the island's day after the raid
  held INTEGER NOT NULL,        -- nodes the player holds
  enemy INTEGER NOT NULL,       -- nodes the enemy holds
  rival INTEGER NOT NULL,       -- nodes other players hold
  factory INTEGER NOT NULL,     -- the camp's factory level
  strength INTEGER NOT NULL,    -- the enemy's strength level
  updated_at INTEGER NOT NULL
);

CREATE TABLE raids (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  player_id TEXT NOT NULL REFERENCES players(id),
  day INTEGER NOT NULL,         -- the island's day the raid was played on
  outcome TEXT NOT NULL,        -- 'extracted' or 'dead'
  captured INTEGER NOT NULL,    -- cores the raid captured
  at INTEGER NOT NULL
);

CREATE INDEX raids_player_at ON raids (player_id, at);
