-- Trophy matchmaking + contested hub ownership (docs/ringfall/multiplayer.md, 方向 A / TKT-195).
-- Idempotent: safe to re-run (Worker schema.ts).

-- Trophy standing for neighbour draws (was held-count). Old rows get 1000 (TROPHY.start).
ALTER TABLE island_summaries ADD COLUMN trophies INTEGER NOT NULL DEFAULT 1000;

-- Shared owner of a contested coastal hub pair for one neighbour slot this week.
-- lo_code / hi_code are the two island codes sorted; slot is NEIGHBOUR_SLOTS index on the lo side's pick
-- is not required — slot is the picker's slot when written from that player's week. For a stable key
-- we store the shore NodeId on the reporter's island (station / waterworks / robotworks / radar).
CREATE TABLE IF NOT EXISTS contested_holds (
  a_code TEXT NOT NULL,           -- island whose shore was reported
  b_code TEXT NOT NULL,           -- the neighbour facing that shore
  shore TEXT NOT NULL,            -- NodeId on a_code (NEIGHBOUR_SLOTS[].shore)
  owner_code TEXT NOT NULL,       -- who holds the contested hub now
  taken_at INTEGER NOT NULL,      -- epoch ms when ownership last flipped (UTC-day shield)
  PRIMARY KEY (a_code, b_code, shore)
);

CREATE INDEX IF NOT EXISTS contested_holds_owner ON contested_holds (owner_code);
