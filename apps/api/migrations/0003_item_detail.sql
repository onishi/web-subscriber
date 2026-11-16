-- item のリンク先（詳細ページ）から取得した値。変更検知（content_hash）の対象外
ALTER TABLE items ADD COLUMN detail_json TEXT;        -- ItemData（詳細ページで取れたフィールドのみ）
ALTER TABLE items ADD COLUMN detail_scheme TEXT;      -- 取得時の詳細取得方式のハッシュ（変わったら取り直す）
ALTER TABLE items ADD COLUMN detail_status TEXT;      -- ok | failed
ALTER TABLE items ADD COLUMN detail_checked_at TEXT;
