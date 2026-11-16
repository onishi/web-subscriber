# Web Subscriber 設計書（v0.2）

> サービス名「Web Subscriber」は仮称。
> 本書では **【確定】**＝依頼仕様で確定している要件、**【提案】**＝本書で提案する設計（要承認）、**【要判断】**＝利用者の判断が必要な事項、を区別して記す。

---

## 決定事項（2026-11-16 確認）

本書の【提案】は原則として採用。以下は利用者の判断で確定した。

| 事項 | 決定 |
|---|---|
| 実行時刻 | 時間帯を絞らず、購読IDのハッシュで1日の中に分散。将来の頻度調整に備え `schedule_interval_minutes`（既定1440）を保持 |
| 保存期間 | §6.6 のとおり（HTML/DOM/スクショ 30日、フィードXML 90日、成功時の最新スナップショットは無期限、実行履歴 1年） |
| 初回巡回範囲 | 初回も通常と同じ最大20ページ |
| robots.txt | 従う（`Web-Subscriber` トークン優先、なければ `*`。最長一致、5xx は全拒否） |
| User-Agent | `Web-Subscriber/0.0.1 (+連絡先URL)`。browser 方式は Chromium の UA の後ろに付加 |
| 利用するAI | Gemini API（`@google/genai`、既定モデル `gemini-3.5-flash-lite`（コストと軽さを優先）。`GEMINI_MODEL` で変更可） |
| 修正提案 | 自動で作成（抽出異常が2回連続、同一購読先は20時間に1回まで）。稼働中の設定は変えず draft として提示 |
| 更新された item | 未読には戻さず「更新」印（既読時刻より後に内容が変わったもの）を付ける |

## 実装メモ（設計からの具体化・差分）

- http 方式の解析も Chromium DOM で行う。取得済み HTML を `Content-Security-Policy: script-src 'none'` 付きでページに流し込み、同じ抽出バンドルを評価する（JS は実行されない）。
- クリックで URL 遷移が起きた場合は新しい文書になるため、操作後待機には `wait.initial`（文書の準備完了）を使う。遷移しない操作（replace/append）は `wait.after_paging`（既定 `items_changed`）で「期待した変化」を待つ。
- AI セッションは Workflows のステップとして耐久実行し、AI のツール呼び出し（inspect / run_extraction）はすべて VPS プローブに変換して `waitForEvent` で完了を待つ。AI の最終提出は zod で検証し、エラーはツール結果として返して修正させる。
- `GEMINI_API_KEY` 未設定時や AI 失敗時は、RSS/Atom 検出または最大の繰り返し構造による自動判定（origin=heuristic）で提案する。修正提案では現行の種類と識別方法を引き継ぐ。
- R2 キーは保存期間ごとのプレフィックス（`r30/`, `r90/`, `latest/`, `sessions/`）に分け、ライフサイクルルールで削除する。

---

## 0. 要約

| 領域 | 提案 |
|---|---|
| フロント | React + Vite の SPA。Cloudflare Workers Static Assets で配信 |
| API | Cloudflare Workers（TypeScript / Hono）。利用者API `/api/v1/*` とクローラAPI `/worker/v1/*` を分離 |
| DB | Cloudflare D1（SQLite） |
| ファイル | Cloudflare R2（生HTML・フィードXML・DOMスナップショット・スクリーンショット・プローブ結果） |
| 定期処理 | Workers Cron Trigger（5分毎）：実行予定の計算・ジョブ生成・期限切れリースの回収 |
| AI制御 | Cloudflare Workflows（長時間・多段のAIセッションを耐久実行）＋ Gemini API（`@google/genai`） |
| 認証 | 利用者：Cloudflare Access（個人利用）。クローラ：ワーカー別Bearerトークン（ハッシュ保存・スコープ付き） |
| VPS | Node.js 22 + TypeScript + Playwright（Chromium、バージョン固定）。systemdで常駐、APIをポーリングしてジョブを取得 |
| 抽出エンジン | http/browser 両方式とも **同一のChromium DOM上で同一の抽出コード** を実行（http方式はJS無効でHTMLをロード）。XMLフィードは名前空間対応XMLパーサ＋XPath 1.0 |
| 共有コード | pnpm monorepo。`packages/shared`（型・zodスキーマ・ルールDSL・正規化・ハッシュ）をAPI/VPS/フロントで共有 |

---

## 1. 全体構成

```
                 ┌────────────────────────── Cloudflare ──────────────────────────┐
 Browser ──HTTPS─▶ Access ─▶ Worker (Hono)                                         │
 (SPA)           │           ├─ /            Static Assets (React SPA)             │
                 │           ├─ /api/v1/*    利用者API（Access JWT検証）             │
                 │           └─ /worker/v1/* クローラAPI（Bearer, Accessバイパス）    │
                 │           Cron(5min) ─ スケジューラ / リース回収                   │
                 │           Workflows  ─ AI初期設定・修正提案セッション              │
                 │             └─▶ Gemini API                                       │
                 │           D1 (メタデータ・item・履歴)   R2 (生データ・スナップショット) │
                 └──────────────────────────────▲─────────────────────────────────┘
                                                │ HTTPS (poll / lease / submit)
                 ┌──────────── さくらVPS ─────────┴──────────┐
                 │ crawler daemon (Node.js)                 │
                 │  ├─ job poller / lease heartbeat         │
                 │  ├─ fetcher: http (undici)               │──▶ 対象サイト
                 │  ├─ browser: Playwright Chromium pool     │──▶ 対象サイト
                 │  ├─ extractor (DOM内で実行する宣言ルール評価器) │
                 │  ├─ feed parser (RSS/Atom/RDF)           │
                 │  └─ outbox (送信失敗時の永続再送キュー: SQLite) │
                 └──────────────────────────────────────────┘
```

### 1.1 責務分担【確定＋提案】

| 処理 | 場所 |
|---|---|
| 対象サイトへの全アクセス（定期・手動・AIプローブ・プレビュー） | VPS【確定】 |
| JS実行・待機・クリックページング・CSS/XPath評価 | VPS【確定】 |
| 新着/更新判定（差分・ハッシュ比較） | Cloudflare【提案】：既存itemの状態を持つ側で判定し、VPSはステートレスに保つ |
| 正規化（RSS/Atom/HTML→共通モデル） | VPS【提案】：`packages/shared` の同一コードで実行し、結果を送信。API側で再検証（zod） |
| AI呼び出し | Cloudflare（Workflows）【確定】。AIが試したいことは「プローブジョブ」としてVPSへ依頼 |

### 1.2 リポジトリ構成【提案】

```
apps/
  api/        Cloudflare Worker（Hono, D1, R2, Workflows, Cron）
  web/        React + Vite SPA（TanStack Router/Query）
  crawler/    VPS常駐プロセス（Node.js, Playwright）
packages/
  shared/     型, zodスキーマ, ルールDSL定義, 正規化, 識別キー/ハッシュ計算, 日付解析
  extractor/  DOM上で動く抽出評価器（ブラウザへ注入するバンドル）＋XML用評価器
  fixtures/   検証用の静的テストサイト（RSS/Atom, HTMLのみ, JS描画, replace/append ページング, 0件, 破損）
docs/
```

---

## 2. 情報モデル

### 2.1 エンティティと関係

```
Subscription 1─* ConfigVersion
Subscription 1─1 Channel ─* ChannelRevision
Subscription 1─* Item ─* ItemRevision
                    └─* ItemObservation (どの実行・どのページで見えたか)
Subscription 1─* CrawlRun ─* CrawlPage
Item 1─* ReadingState (user単位)
Subscription 1─* SetupSession (AI初期設定/修正) ─* ProbeJob
Job (キュー/リース) ─ CrawlRun | ProbeJob
```

内部ID（ULID）と配信元の `source_id` は常に別カラム【確定】。

### 2.2 共通型（`packages/shared`）

```ts
type Text = {
  type: "text" | "html" | "xhtml";
  value: string;            // xhtmlはdiv内側をシリアライズしたXML文字列
  lang?: string;            // xml:lang 等
  base?: string;            // xml:base / 文書URL
};

type Person = { name?: string; email?: string; uri?: string; raw?: string }; // RSSの "a@b (Name)" は raw も保持

type Category = { term: string; scheme?: string; label?: string };       // RSS category@domain → scheme

type Link = {
  href: string;             // 解決済み絶対URL
  href_raw?: string;        // 原文
  rel: string;              // 既定 "alternate"。添付は "enclosure"
  media_type?: string; hreflang?: string; title?: string; length_bytes?: number;
};

type Image = { url: string; title?: string; link?: string; description?: string; width?: number; height?: number };

type Generator = { name: string; uri?: string; version?: string };

type DateValue = {
  raw: string;                                   // 原文
  value: string | null;                          // 解析値: precision=date なら "2026-11-16"、datetime なら RFC3339
  precision: "year" | "month" | "date" | "datetime" | "unknown";
  tz: "explicit" | "assumed" | "none";           // assumed=補完、none=日付のみ等で付与しない
  assumed_tz?: string;                           // 補完したIANA TZ（例 "Asia/Tokyo"）
  parse_error?: string;
};

type Content =
  | { kind: "inline"; type: "text" | "html" | "xhtml"; value: string; lang?: string; base?: string }
  | { kind: "inline"; type: string /* 任意MIME */; value: string; encoding?: "base64"; lang?: string; base?: string }
  | { kind: "external"; src: string; type?: string };   // Atom content@src

type Extension = {                         // 未知のXML要素
  ns: string | null;                       // 名前空間URI（必須で保持）
  prefix?: string; local: string;
  attrs: { ns: string | null; local: string; value: string }[];
  text?: string;
  children?: Extension[];
  xml: string;                             // 元の断片XML（再現用）
};

type Inherited<T> = { explicit: T | null; effective: T | null; from?: "item" | "channel" | "feed_source" };
```

### 2.3 Channel

```ts
type ChannelData = {
  source_id?: string;                // Atom feed/id、RSSは通常なし
  title?: Text; description?: Text;  // Atom subtitle → description
  links: Link[];
  language?: string;
  authors: Person[]; contributors: Person[]; categories: Category[];
  rights?: Text;
  published_at?: DateValue;          // RSS pubDate
  updated_at?: DateValue;            // Atom updated / RSS lastBuildDate
  icon?: Image; logo?: Image;        // RSS image → logo
  generator?: Generator;
  native: ChannelNative;             // 形式固有
  extensions: Extension[];
};

type ChannelNative =
  | { format: "rss2"; version?: string; ttl?: number; skip_hours?: number[]; skip_days?: string[];
      cloud?: { domain: string; port?: number; path?: string; register_procedure?: string; protocol?: string };
      managing_editor?: Person; web_master?: Person; docs?: string; rating?: string;
      text_input?: { title: string; description: string; name: string; link: string };
      image?: Image }
  | { format: "atom"; }
  | { format: "rss1"; about?: string }
  | { format: "html"; document_url: string; extracted_fields: Record<string, unknown> };
```

### 2.4 Item

```ts
type ItemData = {
  source_id?: string;                // RSS guid / Atom id / HTMLで指定したID。URL正規化しない
  title?: Text;
  links: Link[];                     // 閲覧URL = rel=alternate。添付 = rel=enclosure
  summary?: Text;                    // Atom summary
  content?: Content;                 // Atom content / content:encoded
  authors: Person[]; contributors: Person[]; categories: Category[];
  rights?: Text; language?: string;
  published_at?: DateValue; updated_at?: DateValue;
  source?: Omit<ChannelData, never>; // 転載元。itemsを持たない（型上存在しない）
  native: ItemNative;
  extensions: Extension[];
};

type ItemNative =
  | { format: "rss2"; guid?: { value: string; is_perma_link: boolean /* 既定true */ };
      comments?: string; description_raw?: string; /* description を summary とも content とも断定しない */
      description_role: "unknown" }
  | { format: "atom" }
  | { format: "html"; extracted_fields: Record<string, unknown>; position?: never };
```

**RSS descriptionの扱い【提案】**：`summary` にも `content` にも自動で振り分けず、`native.description_raw` に保持し、表示用には `summary` に `type:"html"` として格納、`native.description_role="unknown"` を立てる。`content:encoded` があればそれを `content` とする。「短い要約」と断定しない【確定】。

**managingEditor/webMaster**：`native` にのみ保持し、`authors` へは変換しない【確定】。

**継承**：DBには明示値のみ保存。閲覧API が `effective` を算出して返す（`authors`, `rights`, `language`）。例：`{ explicit: null, effective: [...], from: "channel" }`【確定の実装方針】。

### 2.5 元形式の検証と利用可能性の検証を分離【確定】

- `format_validation`：RSS 2.0 / Atom（RFC 4287）仕様への適合。違反は **警告** として記録（例：Atomの entry に updated がない）。
- `app_validation`：アプリで使えるか。item には「識別キーが得られる」かつ「title / 閲覧リンク / summary / content のいずれか1つ」があること。HTML抽出にはRSS/Atomの必須条件を適用しない。
- 元XMLの完全再現は R2 に生XMLを保存することで担保し、共通モデルの正規化とは別要件とする。

---

## 3. データベース（D1）スキーマ【提案】

主要テーブルのみ。JSONカラムは `TEXT`（JSON）で保持、検索に使う値は列に展開。

```sql
CREATE TABLE subscriptions (
  id TEXT PRIMARY KEY,                     -- ULID
  input_url TEXT NOT NULL,
  display_title TEXT,
  status TEXT NOT NULL,                    -- setup | active | paused | archived
  active_config_version_id TEXT,
  schedule_minute_of_day INTEGER NOT NULL, -- 分散済み実行時刻(0..1439, ユーザーTZ)
  next_run_at TEXT,
  last_attempt_at TEXT, last_success_at TEXT, last_change_at TEXT,
  baseline_status TEXT NOT NULL DEFAULT 'none', -- none | partial | complete
  baseline_identity_scheme TEXT,           -- 基準作成時の識別方式ハッシュ
  health TEXT NOT NULL DEFAULT 'unknown',  -- ok | fetch_error | extract_error | degraded | unknown
  health_detail TEXT,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);

CREATE TABLE config_versions (
  id TEXT PRIMARY KEY,
  subscription_id TEXT NOT NULL REFERENCES subscriptions(id),
  version INTEGER NOT NULL,
  state TEXT NOT NULL,              -- draft | active | superseded | rejected
  config_json TEXT NOT NULL,        -- 不変（作成後更新しない）
  config_hash TEXT NOT NULL,
  identity_scheme_hash TEXT NOT NULL,  -- identity設定のみのハッシュ（照合可否の判定に使用）
  hash_scheme_hash TEXT NOT NULL,      -- change_detection設定のハッシュ
  origin TEXT NOT NULL,             -- ai_setup | ai_repair | manual | clone
  setup_session_id TEXT,
  parent_version_id TEXT,
  validation_report_key TEXT,       -- R2
  note TEXT,
  created_at TEXT NOT NULL, activated_at TEXT,
  UNIQUE(subscription_id, version)
);

CREATE TABLE channels (
  subscription_id TEXT PRIMARY KEY,
  data_json TEXT NOT NULL, content_hash TEXT NOT NULL, hash_scheme TEXT NOT NULL,
  first_seen_run_id TEXT, last_changed_run_id TEXT, updated_at TEXT
);
CREATE TABLE channel_revisions (id TEXT PRIMARY KEY, subscription_id TEXT, run_id TEXT,
  data_json TEXT, content_hash TEXT, created_at TEXT);

CREATE TABLE items (
  id TEXT PRIMARY KEY,
  subscription_id TEXT NOT NULL,
  identity_scheme TEXT NOT NULL,     -- 識別方式ハッシュ
  identity_key TEXT NOT NULL,        -- 方式に従い算出したキー（Atom idは無加工）
  source_id TEXT,
  data_json TEXT NOT NULL,           -- ItemData（明示値）
  content_hash TEXT NOT NULL, hash_scheme TEXT NOT NULL,
  title_text TEXT, primary_link TEXT, -- 一覧表示・検索用に展開
  published_sort TEXT,               -- 並び替え用（日付のみの場合は日付のみ、時刻を捏造しない）
  is_baseline INTEGER NOT NULL,      -- 初回基準データ
  first_seen_run_id TEXT NOT NULL, first_seen_at TEXT NOT NULL,
  last_seen_run_id TEXT NOT NULL, last_seen_at TEXT NOT NULL,
  last_changed_run_id TEXT, last_changed_at TEXT,
  revision_count INTEGER NOT NULL DEFAULT 1,
  UNIQUE(subscription_id, identity_scheme, identity_key)
);
CREATE TABLE item_revisions (id TEXT PRIMARY KEY, item_id TEXT, run_id TEXT,
  content_hash TEXT, data_json TEXT, change_kind TEXT /* created|updated */, created_at TEXT);
CREATE TABLE item_observations (run_id TEXT, item_id TEXT, page_seq INTEGER, position INTEGER,
  PRIMARY KEY(run_id, item_id));

CREATE TABLE jobs (                  -- キュー兼リース
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,                -- crawl | probe
  subscription_id TEXT,
  run_id TEXT, probe_id TEXT,
  status TEXT NOT NULL,              -- queued | leased | done | failed | cancelled
  not_before TEXT NOT NULL, priority INTEGER NOT NULL DEFAULT 0,
  attempt INTEGER NOT NULL DEFAULT 0, max_attempts INTEGER NOT NULL DEFAULT 3,
  lease_token TEXT, lease_owner TEXT, lease_expires_at TEXT,
  payload_json TEXT NOT NULL, created_at TEXT NOT NULL
);
-- 同一購読先の crawl を同時に1つだけ
CREATE UNIQUE INDEX jobs_one_active_crawl ON jobs(subscription_id)
  WHERE kind='crawl' AND status IN ('queued','leased');

CREATE TABLE crawl_runs (
  id TEXT PRIMARY KEY, subscription_id TEXT NOT NULL, job_id TEXT,
  trigger TEXT NOT NULL,             -- scheduled | manual | retry | activation
  config_version_id TEXT NOT NULL,
  started_at TEXT, finished_at TEXT,
  run_status TEXT NOT NULL,          -- queued | running | completed | partial | failed
  extract_status TEXT,               -- success | failed | skipped
  change_status TEXT,                -- initial | changed | unchanged | unknown
  channel_changed INTEGER, new_items INTEGER, updated_items INTEGER, seen_items INTEGER,
  pages_fetched INTEGER, actions_performed INTEGER,
  end_reason TEXT,                   -- no_next | next_disabled | cycle_detected | max_pages | max_actions | max_duration | wait_timeout | error | lease_expired | single_page
  error_stage TEXT,                  -- fetch | wait | extract | paging | submit | internal
  error_detail TEXT,
  baseline_incomplete INTEGER NOT NULL DEFAULT 0,
  worker_id TEXT, crawler_version TEXT, engine_version TEXT  -- Chromium/Playwrightバージョン
);
CREATE TABLE crawl_pages (
  run_id TEXT NOT NULL, seq INTEGER NOT NULL,
  kind TEXT NOT NULL,                -- initial | navigate | click_replace | click_append
  url TEXT, fetched_at TEXT,
  http_status INTEGER,               -- NULL = 未取得
  http_status_source TEXT,           -- main_document | none(追加読み込み)
  action_result TEXT,                -- clicked | not_found | disabled | no_change | ...
  extract_status TEXT, item_count INTEGER, new_unique_items INTEGER,
  field_failures_json TEXT,          -- {field: {no_match: n, empty: n, error: n}}
  list_signature TEXT,               -- 循環検知用
  error TEXT, snapshot_key TEXT,     -- R2
  PRIMARY KEY(run_id, seq)
);

CREATE TABLE reading_states (user_id TEXT, item_id TEXT, read_at TEXT, starred INTEGER DEFAULT 0,
  PRIMARY KEY(user_id, item_id));

CREATE TABLE setup_sessions (id TEXT PRIMARY KEY, subscription_id TEXT, kind TEXT /* setup|repair */,
  status TEXT, workflow_instance_id TEXT, progress_json TEXT, result_config_version_id TEXT,
  report_key TEXT, created_at TEXT, updated_at TEXT);
CREATE TABLE probes (id TEXT PRIMARY KEY, session_id TEXT, kind TEXT, request_json TEXT,
  status TEXT, result_key TEXT, summary_json TEXT, created_at TEXT, finished_at TEXT);

CREATE TABLE crawler_workers (id TEXT PRIMARY KEY, name TEXT, token_hash TEXT, scopes TEXT,
  last_seen_at TEXT, version TEXT, disabled INTEGER DEFAULT 0);
CREATE TABLE submissions (job_id TEXT, submission_key TEXT, response_json TEXT, created_at TEXT,
  PRIMARY KEY(job_id, submission_key));     -- 冪等性
```

将来のAI分類用に `item_annotations(item_id, kind, value_json, model, created_at)` を追加できる構造とする（初期版では作らない）。

---

## 4. 設定形式（購読設定 = ConfigVersion.config_json）【提案】

JSON（`packages/shared` の zod スキーマで検証、JSON Schemaも生成して公開）。AI生成・手動編集ともこの形式のみ。**任意のJavaScriptは表現できない**【確定】。

### 4.1 全体

```jsonc
{
  "schema_version": 1,
  "source": { "url": "https://example.com/news/", "kind": "html" },   // kind: "feed" | "html"
  "fetch": {
    "method": "browser",                     // "http" | "browser"。保存後は自動で切り替えない
    "user_agent_profile": "default",
    "headers": { "Accept-Language": "ja,en;q=0.8" },
    "timeout_ms": 30000,
    "browser": { "viewport": { "width": 1280, "height": 2000 }, "block_resource_types": ["image", "media", "font"] }
  },
  "selector_engine": { "css": "chromium@<pinned>", "xpath": "1.0" },   // 固定。保存時に記録
  "namespaces": { "dc": "http://purl.org/dc/elements/1.1/" },          // XML/XPath用
  "feed": null,                               // kind=feed の場合 { "format": "auto" }（ルール不要の組込み正規化）
  "extract": {
    "channel": { "fields": { /* FieldRule群。起点=最初の文書全体 */ } },
    "items": {
      "container": { "css": "main .news-list" },     // 一覧の存在確認（0件判定に使用）
      "select":    { "css": "li.news-item" },        // 繰り返し要素
      "empty_marker": { "css": ".news-list .no-result" }, // 任意：正常0件の明示的な印
      "zero_items_policy": "ok_if_container",        // ok_if_container | require_empty_marker | fail
      "fields": { /* FieldRule群。起点=各item要素 */ },
      "invalid_item_threshold": 0.2                  // 必須欠落itemの割合がこれを超えたら抽出失敗
    }
  },
  "identity": {
    "method": "link",                        // source_id | fields | link | content_hash
    "fields": [],                            // method=fields/content_hash のとき対象フィールド
    "link_normalization": ["strip_fragment"] // link方式のみ。source_idには適用しない
  },
  "change_detection": {
    "fields": ["title", "links", "summary", "content", "authors", "categories", "published_at", "updated_at"]
  },
  "wait": {
    "initial":      { "all": [ { "exists": { "css": "main .news-list" } }, { "stable": { "target": { "css": "main .news-list" }, "for_ms": 800 } } ], "timeout_ms": 15000 },
    "after_paging": { "all": [ { "items_changed": {} }, { "stable": { "target": { "css": "main .news-list" }, "for_ms": 800 } } ], "timeout_ms": 15000 }
  },
  "paging": {
    "mode": "append",                        // none | replace | append
    "next": { "css": "button.more" },
    "pick": "only",                          // only(複数一致はエラー) | first | last | index:N
    "disabled_when": [ { "attr": "disabled" }, { "attr_equals": ["aria-disabled", "true"] }, { "has_class": "is-disabled" } ],
    "limits": { "max_pages": 20, "max_actions": 30, "max_duration_ms": 300000 },
    "stop_on_known_items": false             // 任意の最適化。既定false【確定】
  },
  "politeness": { "min_interval_ms": 1500, "respect_robots_txt": true }
}
```

### 4.2 FieldRule（値の抽出DSL）

```jsonc
// 1) 固定値
{ "const": "alternate" }

// 2) 要素→値
{
  "from": { "css": "a.title" },          // または { "xpath": ".//a[@class='title']" }、省略=起点要素自身
  "take": "text",                        // text | inner_html | outer_html | { "attr": "href" } | "xml"
  "cardinality": "one",                  // one(複数一致エラー) | first(先頭採用を明示) | many
  "required": true,
  "transforms": ["trim", "collapse_whitespace", { "resolve_url": {} },
                 { "parse_date": { "formats": ["yyyy.MM.dd", "yyyy年M月d日"], "assume_tz": "Asia/Tokyo" } }],
  "fallback": [ { "from": { "css": "a" }, "take": { "attr": "href" }, "cardinality": "first" } ]
}

// 3) オブジェクト組み立て
{ "object": { "href": { "from": {"css":"a.title"}, "take": {"attr":"href"}, "transforms":[{"resolve_url":{}}] },
              "rel":  { "const": "alternate" } } }

// 4) 配列（ネスト可）。各要素が新たな起点
{ "array": { "select": { "css": ".tags a" }, "of": { "object": { "term": { "take": "text", "transforms": ["trim"] } } } } }
```

共通モデルへの対応：`fields` のキーは `title`, `links`, `summary`, `content`, `authors`, `categories`, `published_at`, `updated_at`, `source_id`, `language`, `rights` などItem/Channelのフィールド名。それ以外のキーは `native.extracted_fields` に入る（独自情報の保持）。`title`/`summary` に文字列が来た場合は `Text{type:"text"}`、`take: inner_html` の場合は `Text{type:"html"}` に変換。

### 4.3 変換処理（許可リスト）【提案】

`trim`, `collapse_whitespace`, `lowercase`, `uppercase`, `strip_tags`, `resolve_url`（文書URL→`<base href>`→指定baseの順）, `parse_date{formats, assume_tz, locale}`, `parse_int`, `parse_number`, `regex_extract{pattern, group}`（RE2互換サブセット、`re2-wasm`で安全実行）, `regex_replace`, `split{sep}`, `join{sep}`, `default{value}`, `nullify_if{equals}`, `prefix`, `suffix`, `decode_entities`, `json_ld{path}`（`script[type=application/ld+json]` のJSONから値を取り出す。JSONPathサブセット）。
いずれも純関数で単体テスト可能。日付は日付のみなら `precision:"date"` とし時刻を付けない【確定】。

### 4.4 実行規則【確定→実装方針】

| 状況 | 結果 |
|---|---|
| セレクタ未一致 | `no_match` |
| 一致したが値が空文字（trim後） | `empty` |
| セレクタ構文エラー・変換失敗（日付解析不可等） | `error`（理由付き） |
| `cardinality: one` で複数一致 | `error: multiple_matches`（`first` 指定時のみ先頭採用） |
| `required` が `no_match/empty/error` | item無効。理由を `field_failures` に記録 |
| fallback | 前段が `no_match`/`empty` のときのみ次を評価（`error` では評価しない＝不具合を隠さない）。どの候補を採用したか記録 |

- CSS：Chromium（Playwright固定バージョン）の `querySelectorAll` 実装。`:has()` 等も使えるが、保存時にバージョンを記録し、エンジン更新時は回帰テスト（後述）を必須化。
- XPath：1.0（HTMLはChromium `document.evaluate`、XMLは `@xmldom/xmldom` + `xpath` で名前空間マップ付き）。
- **0件と破損の区別**：`container` 未一致 → 抽出失敗（`structure_missing`）。`container` 一致かつ item 0件 → `zero_items_policy` に従い成功(0件)/失敗。`empty_marker` があればそれを優先。さらに、直近の成功実行でitemが多数あったのに0件になった場合は `health=degraded` の警告（判定は変えない）。

### 4.5 待機条件DSL【確定→実装方針】

```
Cond := { exists: Sel } | { visible: Sel } | { gone: Sel } | { hidden: Sel }
      | { item_count_changed: {} }   // 操作前のitem数と異なる（append）
      | { item_count_at_least: N }
      | { items_changed: {} }        // 先頭/末尾itemの識別キー集合の署名が変化（replace）
      | { stable: { target: Sel, for_ms: N, max_mutations?: 0 } }  // MutationObserverで一定時間無変化
      | { url_changed: {} }
      | { all: Cond[] } | { any: Cond[] } | { not: Cond }
Wait := Cond & { timeout_ms: N(必須, 上限60000) , poll_ms?: N }
```

- 初期待機 `wait.initial` と操作後待機 `wait.after_paging` を別設定【確定】。
- 「一覧の準備完了」（例：`container` 存在 or `empty_marker` 存在）と「item≥1」は別条件として表現する。AIは既定で `any: [container有, empty_marker有]` を生成し、item≥1を必須にしない。
- 固定秒数待機（`sleep`）は DSL に持たない。`stable.for_ms` は「変化しないこと」の判定であり固定待機ではない。
- タイムアウト時は `wait_timeout` として記録し、どの条件が未達だったかを評価ツリーで残す。

### 4.6 ページング実行アルゴリズム（VPS）

```
seen = {}; signatures = set()
page = open(url); wait(initial)
loop seq = 0..:
  items = extract(page); record CrawlPage(seq)
  sig = signature(item keys on current list)          // replace: 表示中一覧, append: 末尾N件
  if sig in signatures: end("cycle_detected")
  signatures.add(sig); dedupe(items by identity key) into seen
  if limits reached: end("max_pages"|"max_actions"|"max_duration")
  els = query(paging.next)
  if els.length == 0: end("no_next")                 // 正常終了
  if els.length > 1 and pick == only: fail(config_error "multiple_next")
  el = pick(els); if disabled(el): end("next_disabled")
  before = snapshot(item count, sig); click(el)        // navigationが起きたら主文書statusを記録
  ok = wait(after_paging, with before)
  if !ok: end(partial, "wait_timeout")                 // 途中失敗：取得済み分は送信済み
```

- 主文書のHTTPステータスは Playwright の `response.request().isNavigationRequest() && frame === mainFrame` のレスポンスのみ採用。サブリソースの失敗は `subresource_failures` 件数として別記録【確定】。
- URL遷移のない追加読み込みは `http_status=NULL, http_status_source='none'` とし、`action_result` と抽出結果を記録【確定】。
- 終了理由で run_status を決定：`no_next/next_disabled/single_page` → completed、`max_*`/`cycle_detected` → completed（`end_reason` で上限到達を区別、UI上は「上限到達」表示）、`wait_timeout`/エラー → partial（1件以上取得）または failed。

---

## 5. 新着・更新判定【確定→実装方針】

### 5.1 識別キー

| method | キー |
|---|---|
| `source_id` | 配信元ID（RSS guid / Atom id）を **無加工の文字列** で使用。Atom idにURL正規化を適用しない |
| `fields` | 指定フィールド値を正規化（trim）して `\u001f` 連結 → SHA-256 |
| `link` | 閲覧URL。`link_normalization` に明示した処理のみ適用（既定：fragment除去のみ） |
| `content_hash` | 明示的に選択したフィールドのみからSHA-256 |

- 方式は設定に固定し、実行時に暗黙切り替えしない。キーが得られない item は無効扱い（`identity_missing` として記録）。
- 1回の実行内で同一キーが重複した場合は最初の出現を採用し、重複数を記録。

### 5.2 変更検知ハッシュ

`change_detection.fields` の値を正規形JSON（キーソート・空配列/未定義の統一）にして SHA-256。掲載順、ページ内位置、取得時刻、ページ番号は含めない【確定】。
ハッシュ定義が変わった（`hash_scheme` 不一致）場合は、初回観測時に黙って再計算して保存し「更新」とはしない。

### 5.3 判定

| 状態 | 処理 |
|---|---|
| 初めてのキー | 新規item（`is_baseline` は後述） |
| 同キー・ハッシュ変化 | 更新。`item_revisions` に旧版を保持 |
| 同キー・同ハッシュ | 変更なし。`last_seen_*` のみ更新 |
| 一覧から消えた | 何もしない（削除しない）【確定】 |

### 5.4 変更状態（CrawlRun.change_status）

```
if baseline_status == none (この実行が初回):
    取得item>0 or channel取得 → initial（未完了なら baseline_incomplete=1, baseline_status=partial）
    何も取得できず → unknown
elif 新規 or 更新 or channel変更 を1件以上検出 → changed（未完了でも changed）
elif run_status == completed かつ extract_status == success → unchanged
else → unknown       // HTTP200でも抽出失敗なら unknown【確定】
```

### 5.5 基準データと既読【提案・要判断】

- 初回実行（および baseline_status=partial の間の実行）で得た item は `is_baseline=1`。新着一覧には出さず、購読先のitem一覧に「基準データ」として区別表示。
- 既読扱い：**提案は「基準データは未読数に数えない（未読管理の対象外）」**。個別に開けば既読になる。

### 5.6 ルール変更時の照合【提案】

- 新バージョンの `identity_scheme_hash` が旧と同じ → そのまま照合。
- 異なる → 有効化前のプレビューで、新ルールの抽出結果を旧itemと **副キー**（source_id 完全一致 → 閲覧URL一致 → タイトル+日付一致）で突き合わせ、一致率と未一致リストを提示。有効化時、一致したitemは新キーへ付け替え（`identity_key` 更新、旧キーは `item_key_aliases` に保持）、未一致の新itemは次回実行で `is_baseline=1`（再基準化）として扱い、大量の偽新着を防ぐ。この実行の change_status は `initial`、`end_reason` とは別に `rebaseline=1` を記録。

---

## 6. クロールジョブとAPI連携

### 6.1 スケジューリング【提案】

- 各購読の実行時刻 `schedule_minute_of_day = hash(subscription_id) mod 1440`（ユーザーTZ。既定 Asia/Tokyo）。必要なら時間帯ウィンドウ（例 02:00–08:00）を設定で絞れる。
- Cron（5分毎）：`status=active AND next_run_at <= now` の購読について `jobs` を `INSERT ... ON CONFLICT DO NOTHING`（部分ユニークインデックスで重複防止）し、`crawl_runs(run_status=queued)` を作成。`next_run_at` を翌日の同時刻へ。
- VPS停止時：ジョブは `queued` のまま残り、UI に「待機中・遅延 X 時間」と表示。24時間以上滞留した定期ジョブは新規生成せず、既存ジョブを1つだけ保持（溜め込まない）。

### 6.2 リース

```
POST /worker/v1/jobs/lease  {worker_id, capacity, kinds:["crawl","probe"]}
  → UPDATE jobs SET status='leased', lease_token=?, lease_expires_at=now+5min, attempt=attempt+1
     WHERE id = (SELECT id FROM jobs WHERE status='queued' AND not_before<=now ORDER BY priority DESC, not_before LIMIT 1)
     RETURNING *        // D1の単一ステートメントで原子的
  → {job, run_id, config(version固定のJSON全文), lease_token, lease_expires_at}
POST /worker/v1/jobs/:id/heartbeat {lease_token} → 期限延長（最大で max_duration + 余裕）
```

- probe（AI・手動プレビュー）は priority を高くする。
- Cron がリース期限切れを回収：`attempt < max_attempts` なら再キュー（`not_before` をバックオフ）、超えたら run を `failed(end_reason=lease_expired)`。部分送信済みページは保持。

### 6.3 結果送信（冪等）

```
POST /worker/v1/runs/:runId/pages/:seq        {lease_token, submission_key, page, items[], channel?}
POST /worker/v1/runs/:runId/complete          {lease_token, submission_key, summary}
PUT  /worker/v1/runs/:runId/artifacts/:name   (生HTML/スクリーンショットをR2へストリーム)
```

- ページ単位で逐次送信し、途中失敗時も取得済みデータがAPI側に残る【確定】。
- 冪等性：`(run_id, seq)` 主キー＋ `submissions(job_id, submission_key)`。同じ送信は保存済みレスポンスを返す。item の upsert は `(subscription_id, identity_scheme, identity_key)` で行い、同一runでの再適用は `item_observations` 主キーで検知して new/updated を二重計上しない。
- `lease_token` 不一致（別ワーカーに再割当済み）は 409。ただし同一 `run_id` の既送信は受理済みとして返す。
- VPS側 outbox：送信は SQLite outbox にまず書き、成功まで指数バックオフで再送（最大24h）。プロセス再起動後も再送【確定】。
- D1 の書き込みは `batch()` で1ページ分をトランザクション的にまとめる。1リクエスト最大 item 200件程度で分割。

### 6.4 権限分離【確定→提案】

- `/worker/v1/*` は Cloudflare Access の対象外パスとし、`Authorization: Bearer <worker token>` を検証（SHA-256ハッシュ照合、`crawler_workers.scopes`：`jobs:lease`, `runs:write`, `probes:write`）。利用者API用のトークンでは呼べない。
- 追加の防御として VPS の固定IP を WAF で許可リスト化（任意）。
- 利用者APIは Access JWT（`Cf-Access-Jwt-Assertion`）を検証。個人利用だが `user_id` は列として保持。

### 6.5 リトライ方針【提案】

| 失敗 | 同日内リトライ |
|---|---|
| DNS/接続失敗、タイムアウト、HTTP 5xx、429（`Retry-After` 尊重） | 最大2回（15分後、60分後） |
| HTTP 4xx（408/429除く） | しない |
| 抽出失敗・待機タイムアウト（構造変化の疑い） | しない。`health=extract_error`、修正提案ボタンを表示 |
| 送信失敗 | VPS outboxで再送（実行自体はやり直さない） |

上限既定値：1実行 max_pages 20 / max_actions 30 / max_duration 5分、1リクエスト30秒、文書サイズ10MB、item 1000件/実行、同一ホスト最小間隔1.5秒、ブラウザ同時2・HTTP同時4、同一ホスト同時1。

### 6.6 保存範囲・保存期間【提案・要判断】

| 種別 | 保存 | 期間 |
|---|---|---|
| フィードの生XML | 毎回（変更時のみ別キー、同一ならハッシュ参照） | 90日 |
| HTML（http方式の生レスポンス） | 毎回 gzip | 30日 |
| browser方式の最終DOM（serialize） | 毎回 gzip | 30日 |
| スクリーンショット | 失敗時・AIプローブ時のみ | 30日 |
| 成功時の最新1回分のDOM/HTML | 常に保持（修正提案の比較元） | 無期限（上書き） |
| CrawlRun/CrawlPage | DB | 1年 |
| item / revisions | DB | 無期限 |

R2 のライフサイクルルールで自動削除。

---

## 7. AIによる初期設定・修正提案

### 7.1 流れ【提案】

Cloudflare Workflows のインスタンス1つ = SetupSession 1つ。各ステップが D1 の `progress_json` を更新し、UI はポーリング（またはSSE）で進捗表示。

1. **discover プローブ**（VPS）：URLを http と browser の両方で取得。
   - 主文書ステータス、リダイレクト、Content-Type、`<link rel=alternate type=application/rss+xml|atom+xml>`、よくあるフィードパス（`/feed`, `/rss.xml` 等）の確認。
   - http版とbrowser版のテキスト量・リンク数・繰り返し構造候補の差分。
   - **圧縮DOMアウトライン**（tag/id/class/短いテキスト、繰り返し構造のクラスタ候補、ページング候補要素：「次へ」「もっと見る」「Next」「›」等のテキスト・rel=next）。HTML全文はAIに渡さず、必要部位だけを渡す。
2. **フィード判定**：フィードがあれば feed プローブで正規化結果を取得し、AIが「item数・本文の有無・HTML版との網羅性」を比較して feed 採用可否を提案（両方提示）。
3. **ルール提案ループ**（Gemini の関数呼び出し）：AIが使えるツールはすべて「VPSへのプローブジョブ」に変換される。
   - `inspect(selector, method)`：一致要素数と抜粋HTML
   - `run_extraction(config, pages:1)`：設定案での抽出結果・フィールド失敗統計
   - `try_paging(config, max_pages:3)`：ページング試行（replace/append判定、変化検知、終了条件）
   - `compare_methods(config)`：http と browser での抽出結果比較
   各ツール呼び出しは Workflow の step + `waitForEvent(probe完了)` で待つ。ツール呼び出し上限 25回・セッション上限 15分。
4. **最終検証**（AIを介さず機械的）：確定案を VPS で実行し、検証レポートを作成。
   - item数、フィールド充足率、識別キーの一意性、日付解析成功率、http/browser差分、試行ページ数と終了理由、再実行での安定性（同一キー集合になるか、2回実行）。
   - **未検証事項** を列挙（例：「最終ページまで到達していない（3ページで打ち切り）」「0件時の表示は未観測」）。
5. **プレビュー提示**：抽出結果・取得方式・ルール（JSON＋フォーム表示）・検証結果・未検証事項。ユーザーが編集→再検証→保存で `config_versions(state=active, version=1)`、即時に `trigger=activation` の初回クロールを投入。

### 7.2 AIの出力制約

- AIの最終出力は **構造化出力（JSONスキーマ準拠）で config 案＋根拠＋未検証事項** のみ。zod で検証し、不正なら1回だけ修正依頼。
- ページ内容はプロンプトインジェクション源になり得るため、ページ由来テキストは明示的にデータとして区切って渡す。AIのツールは「同一オリジン（＋ユーザー指定URL）への読み取りプローブ」のみ。VPS側でもSSRF対策（プライベートIP・メタデータIPの拒否、リダイレクト先の再検査）を実施。

### 7.3 修正提案（repair）【確定→提案】

- トリガー：抽出失敗、`container` 未一致、item 0件への急減（前回比）、待機タイムアウトが連続 N(=2) 回。UIに「修正案を作成」ボタン（自動起動はオプション、既定は手動）。
- 入力：直近成功時のDOMスナップショットと抽出結果、現在のDOM、現行設定。
- 出力：`config_versions(state=draft, origin=ai_repair, parent_version_id=現行)`。
- 比較画面：現行版 vs 修正案で同一ページを抽出した結果を並べ、識別キーの一致率・新規扱いになるitem数・フィールド差分を表示。**ユーザーが有効化するまで稼働中設定は変えない**【確定】。

### 7.4 モデルと呼び出し【提案】

- モデル：Gemini API の `gemini-3.5-flash-lite`（コスト優先、`@google/genai`、`GEMINI_MODEL` で変更可）。関数呼び出しでツールを使い、モデル応答の parts（thought signature を含む）はそのまま履歴に保持して返す。
- 安全フィルタでブロックされた場合（`promptFeedback.blockReason` や `finishReason: SAFETY` 等）は AI 提案を打ち切り、自動判定（heuristic）に切り替える。
- システムプロンプト・ツール定義・DSL仕様は固定し、会話の先頭に置く（暗黙キャッシュが効きやすい構成）。
- APIキーは Workers Secret（`GEMINI_API_KEY`）。1セッションのAIターン数は16回で打ち切る（トークン使用量の記録・金額上限は未実装）。

---

## 8. API（利用者向け `/api/v1`）【提案】

| メソッド | パス | 説明 |
|---|---|---|
| GET | `/subscriptions` | 一覧（最終試行/成功/更新検知/次回予定/方式/異常/未読数） |
| POST | `/subscriptions` | URLを登録（status=setup）し、SetupSessionを開始 |
| GET | `/subscriptions/:id` | 詳細（現行設定・health） |
| PATCH | `/subscriptions/:id` | 表示名、実行時刻、一時停止/再開（`status`） |
| DELETE | `/subscriptions/:id` | アーカイブ（データは保持） |
| GET | `/subscriptions/:id/configs` | 設定バージョン一覧 |
| GET | `/configs/:versionId` | 設定本文＋検証レポート |
| POST | `/subscriptions/:id/configs` | 手動編集した draft を作成（zod検証） |
| POST | `/configs/:versionId/validate` | draft をVPSで検証実行（probe） |
| POST | `/configs/:versionId/compare` | 現行版との比較プレビュー |
| POST | `/configs/:versionId/activate` | 有効化（旧版は superseded） |
| GET | `/setup-sessions/:id` | AIセッションの進捗・結果（SSE版 `/events` も） |
| POST | `/subscriptions/:id/repair` | 修正提案セッション開始 |
| POST | `/subscriptions/:id/crawl` | 手動クロール（`trigger=manual`、既に実行中なら409） |
| GET | `/subscriptions/:id/runs` | クロール履歴 |
| GET | `/runs/:runId` | 実行詳細＋ページ一覧＋エラー＋スナップショットリンク |
| GET | `/items?filter=new\|unread\|all&subscription_id=&cursor=` | 新着/購読先ごとのitem一覧（`baseline` は除外が既定） |
| GET | `/items/:id` | item詳細（effective値・リビジョン） |
| PUT | `/items/:id/read` / DELETE 同 | 既読/未読 |
| POST | `/items/mark-read` | 一括既読（`subscription_id`, `before`） |
| GET | `/artifacts/:key` | R2 の保存物を取得（認証付き） |

クローラAPIは 6.2/6.3 のとおり。加えて `POST /worker/v1/probes/:id/result`。

---

## 9. Web画面【確定→構成提案】

| 画面 | 内容 |
|---|---|
| 新着 | 全購読先の新着/更新item（基準データ除外）、未読フィルタ、更新itemは「更新」バッジ＋差分表示 |
| 購読先一覧 | 名称、方式(http/browser/feed)、最終試行・最終成功・最終更新検知・次回予定を **別列** で表示、異常バッジ（取得異常/抽出異常/上限到達/待機遅延）、一時停止切替 |
| 購読追加 | URL入力 → AI設定生成の進捗（discover→判定→ルール作成→検証の各ステップ） |
| プレビュー・設定 | 抽出結果テーブル、ルール（フォーム＋JSONエディタ）、検証レポート、未検証事項、再検証、保存 |
| 購読先詳細 | item一覧（新着/基準データタブ）、設定バージョン履歴、修正提案と比較 |
| クロール履歴 | 実行ごとの HTTP status / 抽出状態 / 変更状態 / ページ数 / 終了理由 / エラー段階、ページ単位の詳細、スナップショット |

表示ルール：抽出失敗・unknown の実行を「更新なし」と表示しない【確定】。`unchanged` のみ「更新なし」。

---

## 10. 技術選定の理由（要点）

- **D1**：個人利用・1日1回・購読数〜数百規模で十分。部分ユニークインデックスと単一文の `UPDATE ... RETURNING` で原子的リースが書ける。規模拡大時は Durable Objects（購読単位のロック）や Hyperdrive+Postgres へ移行可能な層構造にする。
- **Workflows**：AIセッションは数分〜十数分、VPSのプローブ待ちを挟むため、Workerの単発リクエストでは不適。`waitForEvent` でプローブ完了を待てる。
- **Queues不採用（初期）**：VPS側から「取りに行く」pull型が要件の第一候補であり、D1のjobsテーブルで足りる。
- **Playwright**：待機・クリック・主文書レスポンス判定・MutationObserver注入が容易。Node版で shared の TypeScript をそのまま使える。
- **抽出をChromium DOMに統一**：http方式とbrowser方式でCSS/XPathの解釈差をなくし、「対応範囲とバージョンの固定」を1か所で管理できる。http方式は `page.setContent(html, {javaScriptEnabled:false})` 相当（JS無効コンテキスト）でロードし、`<base>` は文書URLを設定。

---

## 11. 実装手順

| フェーズ | 内容 | 完了条件 |
|---|---|---|
| P0 基盤 | monorepo、shared型/zod、D1マイグレーション、Worker雛形、Access/ワーカートークン、VPS daemon雛形、fixtures静的サイト | VPSがジョブをリース→ダミー結果送信→D1保存 |
| P1 フィード | RSS2/RSS1/Atom パーサ・正規化・拡張保持、識別/ハッシュ、差分判定、CrawlRun/Page記録、Cron スケジューラ | RSS/Atom購読が定期取得され新着がAPIで取れる |
| P2 HTML抽出(http) | ルールDSL評価器（Chromium注入）、変換処理、0件/破損区別、手動設定での購読 | fixtures のHTML-onlyページで抽出・差分 |
| P3 browser・待機・ページング | 待機DSL、replace/append、終了・循環・上限判定、ページ単位送信、outbox再送 | JS描画・replace・append fixturesで通過 |
| P4 Web画面 | 一覧・新着・既読・履歴・手動クロール・一時停止・設定編集/検証/有効化 | ブラウザで E2E 操作可能 |
| P5 AI初期設定 | Workflows、プローブ種別、Gemini 関数呼び出しループ、検証レポート、プレビュー画面 | URL入力から保存まで一気通貫 |
| P6 修正提案 | 失敗検知、repairセッション、比較画面、再基準化 | 構造変更fixtureで修正案→比較→有効化 |
| P7 運用 | R2ライフサイクル、監視（VPS死活・滞留ジョブ）、バックアップ（D1 Time Travel） | |

### 11.1 検証（代表ケース → テスト）

`packages/fixtures` にローカルHTTPサーバ（シナリオ切替可能）を置き、VPS crawler をCIでも動かす。

| ケース | テスト |
|---|---|
| RSS 2.0/Atom 正規化 | 単体：guid isPermaLink、enclosure→Link、managingEditor非変換、日付のみ、xhtml content、未知拡張の名前空間保持、Atom id非正規化 |
| HTTPのみのHTML | 統合：http方式で抽出 |
| JS後に一覧出現 | 統合：browser方式＋`exists`待機、http方式では container 未一致→抽出失敗となること |
| replace ページング | 統合：3ページ、最終ページで next 無効→completed(next_disabled) |
| append ページング | 統合：「もっと見る」3回、ボタン消滅→no_next |
| 正常0件 vs 破損 | 0件ページ→success/unchanged、container削除→failed/unknown |
| HTTPエラー・待機タイムアウト・途中失敗 | 500→fetch失敗/unknown、待機未達→wait_timeout、2ページ目500→partial（1ページ目分は保存） |
| 同一item再取得・内容変更 | 2回目 unchanged、タイトル変更で updated＋revision |
| 再送による重複防止 | 同一 page/complete を2回送信→件数・item不変 |
| 設定バージョン対応 | 有効化後の run が新 version_id を持つ |
| 失敗を「更新なし」と表示しない | API/画面のスナップショットテスト |
| 循環 | 次へが同一一覧を返す→cycle_detected |
| 複数一致 | next 2個→設定エラー、`pick:first` で通過 |

---

## 12. 未確定事項の整理

| # | 事項 | 提案 | 区分 |
|---|---|---|---|
| 1 | Cloudflare構成 | Workers(Hono)+Static Assets+D1+R2+Workflows+Cron+Access | 【提案】 |
| 2 | DB/ファイル | D1 / R2 | 【提案】 |
| 3 | 技術選定 | React+Vite / Hono / Node+Playwright（pnpm monorepo, TypeScript統一） | 【提案】 |
| 4 | AIモデル | Gemini API `gemini-3.5-flash-lite`、関数呼び出し（プローブ経由） | 【確定】Gemini に変更 |
| 5 | 認証 | Cloudflare Access（本人メールのみ許可）。クローラはBearerトークン | 【提案】 |
| 6 | タイムゾーン・実行時刻 | Asia/Tokyo、購読IDのハッシュで1日内に分散 | 【確定】時間帯は絞らない |
| 7 | 上限・リトライ | 6.5 の既定値 | 【提案】 |
| 8 | 保存範囲・期間 | 6.6 の表 | 【確定】 |
| 9 | 初回巡回範囲 | 通常の上限（max_pages 20）まで | 【確定】 |
| 10 | 初期データの既読扱い | 基準データは未読数に含めず新着に出さない | 【確定】（提案を採用） |
| 11 | ルール変更時の照合 | 識別方式が同じなら直接照合、異なれば副キー突合＋未一致は再基準化 | 【提案】 |
| 12 | robots.txt | 尊重し、拒否は `robots_disallowed` として記録 | 【確定】 |
| 13 | User-Agent | `Web-Subscriber/0.0.1 (+連絡先URL)` | 【確定】 |
| 14 | AI修正提案の自動起動 | 自動（連続2回の抽出異常で起動、draft のみ） | 【確定】 |
| 15 | 更新itemの再未読化 | 戻さず「更新」印のみ | 【確定】 |
| 16 | AI自動分類 | 初期版対象外。`item_annotations` で後付け可能 | 【確定】将来候補 |

### 12.1 特に重要な判断事項

1. **差分判定をCloudflare側で行う**（VPSはステートレス）。VPSが既知itemを知らないため「既知item出現で終了」は将来オプションとして API から既知キー集合を渡す形で実装する。
2. **http/browserとも抽出はChromium DOMで実行**（http方式もJS無効のブラウザコンテキストを使う）。CPU負荷は増えるが、セレクタ解釈の一貫性を優先。
3. **ページ単位の逐次送信**で途中失敗時のデータ保全と冪等性を両立。
4. **AIのツールは全てVPSプローブに変換**し、AIが対象サイトに直接触れない・任意コードを実行しない。
5. **基準データの扱い**（未読に含めない）と **識別方式変更時の再基準化**。偽の大量新着を防ぐことを優先。
6. **D1の書き込み上限**：1回の送信で扱うitem数を制限し、大規模サイト（数千item/実行）は初期版の対象外とする。
