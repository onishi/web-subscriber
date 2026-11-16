-- セットごとのカスタムフィールド（例：美術館セットの「開始日」「終了日」、動物園セットの「動物」）
-- item の本文から生成AIで値を取り出して保存し、検索・並べ替えに使う。
CREATE TABLE set_fields (
  id TEXT PRIMARY KEY,
  set_id TEXT NOT NULL,
  key TEXT NOT NULL,                 -- 検索パラメータ・AI出力で使う識別子（英数字と _）
  label TEXT NOT NULL,               -- 表示名
  type TEXT NOT NULL,                -- text | list | date | number | boolean
  description TEXT NOT NULL DEFAULT '', -- AIへの説明（何をどう取り出すか）
  position INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (set_id, key)
);
-- フィールド定義のハッシュ。変わったらセット内の item を取り直す
ALTER TABLE sets ADD COLUMN fields_hash TEXT;

-- 値：1値1行。型ごとの列にだけ値を入れ、列ごとの索引で範囲検索・一致検索する
--   text/list → value_text（list は ord で複数行）、date → value_date（YYYY / YYYY-MM / YYYY-MM-DD、辞書順で比較可能）、
--   number → value_num、boolean → value_num（0/1）
CREATE TABLE item_field_values (
  item_id TEXT NOT NULL,
  field_id TEXT NOT NULL,
  set_id TEXT NOT NULL,
  ord INTEGER NOT NULL DEFAULT 0,
  value_text TEXT,
  value_num REAL,
  value_date TEXT,
  PRIMARY KEY (item_id, field_id, ord)
);
CREATE INDEX ifv_text ON item_field_values(field_id, value_text);
CREATE INDEX ifv_num ON item_field_values(field_id, value_num);
CREATE INDEX ifv_date ON item_field_values(field_id, value_date);

-- 抽出状況（item × セット）。schema_hash がセットの fields_hash と一致すれば抽出済み
CREATE TABLE item_field_extractions (
  item_id TEXT NOT NULL,
  set_id TEXT NOT NULL,
  schema_hash TEXT NOT NULL,
  status TEXT NOT NULL,              -- ok | error
  attempts INTEGER NOT NULL DEFAULT 1,
  error TEXT,
  model TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (item_id, set_id)
);
CREATE INDEX ife_set ON item_field_extractions(set_id, status);
