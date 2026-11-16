-- item 画像（配信元データの画像、またはリンク先の og:image）
ALTER TABLE items ADD COLUMN image_url TEXT;
ALTER TABLE items ADD COLUMN image_source TEXT;      -- feed | og_image
ALTER TABLE items ADD COLUMN image_checked_at TEXT;  -- リンク先を確認した日時（見つからなかった場合も記録し、再取得しない）
-- リンク先 og:image の取得：NULL=未判定（次回の実行で試行）| og_image=取得する | off=取得しない
ALTER TABLE subscriptions ADD COLUMN item_image_mode TEXT;
