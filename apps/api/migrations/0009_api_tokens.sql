-- MCP / API 用の個人アクセストークン（平文は発行時に一度だけ返す。保存はハッシュのみ）
CREATE TABLE api_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  prefix TEXT NOT NULL,              -- 一覧で見分けるための先頭数文字
  created_at TEXT NOT NULL,
  last_used_at TEXT,
  revoked_at TEXT
);
CREATE INDEX api_tokens_user ON api_tokens(user_id);
