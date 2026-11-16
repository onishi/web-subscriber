-- セットの公開ページ（/p/<public_slug>）。認証なしで閲覧できる新着一覧
ALTER TABLE sets ADD COLUMN is_public INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sets ADD COLUMN public_slug TEXT;
ALTER TABLE sets ADD COLUMN public_title TEXT;
ALTER TABLE sets ADD COLUMN public_description TEXT;
-- {"fields": [表示するフィールドのキー], "period": {"start": キー, "end": キー}, "facet": 絞り込みに使う複数値フィールドのキー}
ALTER TABLE sets ADD COLUMN public_options_json TEXT;
CREATE UNIQUE INDEX sets_public_slug ON sets(public_slug) WHERE public_slug IS NOT NULL;
