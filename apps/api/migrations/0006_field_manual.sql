-- カスタムフィールドの手動修正
-- ロック：手で直した (item, フィールド)。AI の再抽出はロックされたフィールドの値を変更しない（値なしに直した場合も行は残る）
CREATE TABLE item_field_locks (
  item_id TEXT NOT NULL,
  set_id TEXT NOT NULL,
  field_id TEXT NOT NULL,
  locked_by TEXT NOT NULL,
  locked_at TEXT NOT NULL,
  PRIMARY KEY (item_id, field_id)
);
CREATE INDEX ifl_set ON item_field_locks(set_id);

-- 修正履歴（手動での変更・AIの値への戻し）
CREATE TABLE item_field_edits (
  id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL,
  set_id TEXT NOT NULL,
  field_id TEXT NOT NULL,
  action TEXT NOT NULL,          -- set（手で変更）| revert（AIの値に戻す）
  before_json TEXT NOT NULL,     -- 変更前の値（配列）
  after_json TEXT,               -- 変更後の値（配列。revert は再抽出前なので NULL）
  user_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX ife_item ON item_field_edits(item_id, created_at DESC);
