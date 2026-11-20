-- Which player owns which island code (docs/ringfall/multiplayer.md, お隣の島). Written only by the
-- server: when it hands a code out (a claim) and when the island takes its owner's report.
-- Times are epoch milliseconds.

CREATE TABLE islands (
  code TEXT PRIMARY KEY,        -- the island's public code (meta/island-code.ts)
  player_id TEXT NOT NULL,      -- the owner's anonymous id
  created_at INTEGER NOT NULL
);

CREATE INDEX islands_player ON islands (player_id);

-- Each island's neighbours for a week, drawn once (the first time it asks that week) and kept, each
-- in the slot at sea it stands in, so nodes changing hands in the week neither swap a neighbour
-- nor move one onto another sea route.
CREATE TABLE neighbour_picks (
  player_id TEXT NOT NULL,      -- whose neighbours
  week INTEGER NOT NULL,        -- the week they were drawn for (epoch ms / one week, floored)
  slot INTEGER NOT NULL,        -- the slot at sea (NEIGHBOUR_SLOTS in meta/neighbours.ts)
  code TEXT NOT NULL,           -- the neighbour's island code
  PRIMARY KEY (player_id, week, slot)
);
