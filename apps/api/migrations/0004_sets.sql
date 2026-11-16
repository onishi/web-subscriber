-- セット：複数の購読先をまとめて名前を付けたもの（例「京都の美術館」）。1つの購読先は複数のセットに入れられる
CREATE TABLE sets (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE set_members (
  set_id TEXT NOT NULL,
  subscription_id TEXT NOT NULL,
  added_at TEXT NOT NULL,
  PRIMARY KEY (set_id, subscription_id)
);
CREATE INDEX set_members_sub ON set_members(subscription_id);
