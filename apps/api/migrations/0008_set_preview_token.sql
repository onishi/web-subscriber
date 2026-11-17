-- 非公開のセットを、トークン付き URL（?token=...）でプレビューするためのトークン
ALTER TABLE sets ADD COLUMN public_preview_token TEXT;
