-- Which player owns which island code (docs/ringfall/multiplayer.md, お隣の島). Written only by the
-- server: when it hands a code out (a claim) and when the island takes its owner's report.
-- Times are epoch milliseconds.

CREATE TABLE islands (
  code TEXT PRIMARY KEY,        -- the island's public code (meta/island-code.ts)
  player_id TEXT NOT NULL,      -- the owner's anonymous id
  created_at INTEGER NOT NULL
);

CREATE INDEX islands_player ON islands (player_id);
