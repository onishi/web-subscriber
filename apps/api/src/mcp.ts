// MCP サーバー（Streamable HTTP・ステートレス）。AI クライアントから Web Subscriber の全機能を操作する。
// 各ツールは利用者 API（/api/v1）への内部リクエストに変換するので、権限・検証・副作用は画面からの操作と同じ。
import type { Env } from "./env.js";
import { tokenUser } from "./auth.js";

type Json = Record<string, unknown>;
type Call = (method: string, path: string, body?: unknown) => Promise<{ status: number; data: unknown }>;

interface Tool {
  name: string;
  description: string;
  inputSchema: Json;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean; title?: string };
  run: (a: Json, call: Call) => Promise<{ status: number; data: unknown }>;
}

const PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];

const str = (description: string) => ({ type: "string", description });
const obj = (properties: Json, required: string[] = []) => ({ type: "object", properties, required, additionalProperties: false });
const enc = encodeURIComponent;
const qs = (a: Json, keys: string[]) => {
  const p = new URLSearchParams();
  for (const k of keys) if (a[k] !== undefined && a[k] !== null && a[k] !== "") p.set(k, typeof a[k] === "boolean" ? (a[k] ? "1" : "0") : String(a[k]));
  const s = p.toString();
  return s ? `?${s}` : "";
};
const pick = (a: Json, keys: string[]) => Object.fromEntries(keys.filter((k) => a[k] !== undefined).map((k) => [k, a[k]]));

const PUBLIC_OPTIONS_DOC = `options（公開ページの表示設定。指定したキーだけ現在の設定に上書きされる。配列やオブジェクトはまるごと置き換え）:
- layout: "list" | "cards" | "compact" | "table" | "calendar"
- width: "normal"(860px) | "wide"(1200px) | "full"
- display: 表示する項目と順番。"date" | "source" | "title" | "period" | "excerpt" | "f:<フィールドkey>"
- show: { image?: boolean }（画像の表示。display があるときは image だけ使われる）
- fields: 表示するカスタムフィールドの key の配列
- period: { start: "<日付フィールドkey>", end: "<日付フィールドkey>" } | null（期間表示）
- sections: 区分の配列。上から順に条件を見て最初に当てはまった区分に入る。各要素 { id: /^[a-z0-9_-]{1,24}$/, label, conditions: Filter[], tab: bool（タブにする）, badge: bool（バッジを付ける）, hidden: bool（どこにも出さない） }
- all_tab: bool（「すべて」タブを出す）, group_sections: bool（「すべて」で区分ごとに見出しを付けてまとめる）, default_tab: "all" | 区分id
- sort: { "<all または 区分id>": { key: "published" | "first_seen" | "title" | "f:<key>", dir: "asc" | "desc" } }
- filters: Filter[]（すべてのタブにかかる絞り込み）
- facet: 絞り込みチップに使う list/text フィールドの key | null
- source_filter: bool（情報源ごとの絞り込みボタン）
- theme: "warm"（テラコッタ・既定）| "ink"（モノクロ）| "indigo"（藍）| "forest"（森）| "ocean"（海）| "sakura"（桜）
- color_mode: "auto"（端末の設定に合わせる・既定）| "light" | "dark"
- calendar_key: "published" | "f:<日付フィールドkey>"（calendar 表示でマスに置く日付）
- excerpt_length: number, per_page: number
Filter = { key: "published" | "image" | "excerpt" | "f:<key>", op, value? }
op: not_empty / empty（共通）, future（今日以降）/ past（昨日まで）/ until_today（今日まで）/ next_days・last_days（value=日数）（日付）, eq / ne（テキスト・複数値, value）, gte / lte（数値, value）, true / false（真偽）
例「開催中」: { id:"now", label:"開催中", conditions:[{key:"f:start_date",op:"until_today"},{key:"f:end_date",op:"future"}], tab:false, badge:true, hidden:false }`;

const TOOLS: Tool[] = [
  // ---- 購読先 ----
  {
    name: "list_subscriptions",
    description: "購読先（監視しているWebページ/フィード）の一覧。状態・未読数・item数・所属セット・最後の実行結果を含む。",
    inputSchema: obj({}),
    annotations: { readOnlyHint: true },
    run: (_a, call) => call("GET", "/subscriptions"),
  },
  {
    name: "get_subscription",
    description: "購読先の詳細。稼働中の取得設定(config)、設定の版の一覧（draft/active/rejected と検証結果）、実行中のAIセッション、セットごとのカスタムフィールド抽出状況。",
    inputSchema: obj({ id: str("購読先ID") }, ["id"]),
    annotations: { readOnlyHint: true },
    run: (a, call) => call("GET", `/subscriptions/${enc(String(a.id))}`),
  },
  {
    name: "add_subscription",
    description:
      "購読先を追加する。config を省略すると AI が取得方法と抽出ルールを自動で調査・検証して下書きを作る（setup_session_id が返る。get_setup_session で進み具合を確認し、できた下書きを activate_config で有効化する）。config を渡すとその設定で直接作る。",
    inputSchema: obj({ url: str("購読したいページ/フィードのURL"), title: str("表示名（省略可）"), config: { type: "object", description: "取得設定（省略時はAIが作る）" } }, ["url"]),
    run: (a, call) => call("POST", "/subscriptions", pick(a, ["url", "title", "config"])),
  },
  {
    name: "update_subscription",
    description: "購読先を変更する。status: active（稼働）/ paused（停止）/ archived（削除扱い）。display_title（空文字でソースのタイトルに戻す）、取得時刻（0〜1439分、JST）、間隔（分、60以上）、item_image_mode: og_image | off | null（null で再判定）。",
    inputSchema: obj({
      id: str("購読先ID"),
      status: { type: "string", enum: ["active", "paused", "archived"] },
      display_title: { type: ["string", "null"] },
      schedule_minute_of_day: { type: "integer", minimum: 0, maximum: 1439 },
      schedule_interval_minutes: { type: "integer", minimum: 60 },
      item_image_mode: { type: ["string", "null"], enum: ["og_image", "off", null] },
    }, ["id"]),
    run: (a, call) => call("PATCH", `/subscriptions/${enc(String(a.id))}`, pick(a, ["status", "display_title", "schedule_minute_of_day", "schedule_interval_minutes", "item_image_mode"])),
  },
  {
    name: "crawl_now",
    description: "購読先をすぐに取得する（クローラのキューに入れる）。結果は list_runs / get_run で確認。",
    inputSchema: obj({ id: str("購読先ID") }, ["id"]),
    run: (a, call) => call("POST", `/subscriptions/${enc(String(a.id))}/crawl`),
  },
  {
    name: "review_subscription_with_ai",
    description:
      "AI に取得設定を見直させる（「AIで設定を見直す」）。instruction で方針を指示できる（例:「展覧会一覧ページ https://… から取って、タイトルは h3」）。新しい設定は draft として作られるので、get_setup_session で完了を待ち、検証結果を確認して activate_config する。",
    inputSchema: obj({ id: str("購読先ID"), instruction: str("AIへの指示（省略可）") }, ["id"]),
    run: (a, call) => call("POST", `/subscriptions/${enc(String(a.id))}/repair`, a.instruction ? { instruction: a.instruction } : {}),
  },
  {
    name: "setup_detail_with_ai",
    description: "一覧に本文がない購読先について、各 item のリンク先（詳細ページ）から概要・本文・会期などを取るルールを AI に作らせる（draft ができる）。",
    inputSchema: obj({ id: str("購読先ID") }, ["id"]),
    run: (a, call) => call("POST", `/subscriptions/${enc(String(a.id))}/detail-setup`),
  },
  {
    name: "get_setup_session",
    description: "AI 設定セッションの状態（running / ready / failed）、進捗ログ、できた設定の版ID（result_config_version_id）。",
    inputSchema: obj({ id: str("セッションID") }, ["id"]),
    annotations: { readOnlyHint: true },
    run: (a, call) => call("GET", `/setup-sessions/${enc(String(a.id))}`),
  },
  {
    name: "list_runs",
    description: "購読先の取得実行の履歴（新しい順）。",
    inputSchema: obj({ subscription_id: str("購読先ID"), limit: { type: "integer", minimum: 1, maximum: 200 } }, ["subscription_id"]),
    annotations: { readOnlyHint: true },
    run: (a, call) => call("GET", `/subscriptions/${enc(String(a.subscription_id))}/runs${qs(a, ["limit"])}`),
  },
  {
    name: "get_run",
    description: "取得実行1回分の詳細（ページごとのHTTP状態・抽出結果・エラー）。",
    inputSchema: obj({ id: str("実行ID") }, ["id"]),
    annotations: { readOnlyHint: true },
    run: (a, call) => call("GET", `/runs/${enc(String(a.id))}`),
  },
  // ---- 取得設定（版） ----
  {
    name: "get_config",
    description: "取得設定の版を1つ取得（config_json、状態、検証結果）。",
    inputSchema: obj({ id: str("設定の版ID") }, ["id"]),
    annotations: { readOnlyHint: true },
    run: (a, call) => call("GET", `/configs/${enc(String(a.id))}`),
  },
  {
    name: "create_config",
    description: "購読先に取得設定の新しい版（draft）を手で作る。既存の設定を get_config で取り、直したものを渡すのが基本。作ったら validate_config で検証し activate_config で有効化。",
    inputSchema: obj({ subscription_id: str("購読先ID"), config: { type: "object", description: "取得設定(schema_version 1)" }, note: str("メモ") }, ["subscription_id", "config"]),
    run: (a, call) => call("POST", `/subscriptions/${enc(String(a.subscription_id))}/configs`, pick(a, ["config", "note"])),
  },
  {
    name: "validate_config_schema",
    description: "取得設定の JSON がスキーマに合うかだけを確認する（取得はしない）。",
    inputSchema: obj({ config: { type: "object" } }, ["config"]),
    annotations: { readOnlyHint: true },
    run: (a, call) => call("POST", "/configs/validate-schema", a.config),
  },
  {
    name: "validate_config",
    description: "設定の版で実際に取得・抽出を試す（VPS のプローブ）。probe_id が返るので get_probe で結果を見る。",
    inputSchema: obj({ id: str("設定の版ID") }, ["id"]),
    run: (a, call) => call("POST", `/configs/${enc(String(a.id))}/validate`),
  },
  {
    name: "get_probe",
    description: "プローブ（検証のための試し取得）の状態と結果。",
    inputSchema: obj({ id: str("プローブID") }, ["id"]),
    annotations: { readOnlyHint: true },
    run: (a, call) => call("GET", `/probes/${enc(String(a.id))}`),
  },
  {
    name: "activate_config",
    description: "設定の版（draft）を有効化して稼働中にする。それより古い draft は取り下げられる。",
    inputSchema: obj({ id: str("設定の版ID") }, ["id"]),
    run: (a, call) => call("POST", `/configs/${enc(String(a.id))}/activate`),
  },
  {
    name: "reject_config",
    description: "設定の版（draft）を取り下げる。",
    inputSchema: obj({ id: str("設定の版ID") }, ["id"]),
    run: (a, call) => call("POST", `/configs/${enc(String(a.id))}/reject`),
  },
  // ---- item ----
  {
    name: "list_items",
    description:
      "取得した item（記事・催し等）の一覧。view: new（新着順, 既定）/ all / baseline / updated。subscription_id または set_id で絞れる（set_id 指定時はセットのカスタムフィールドの値 set_fields も付く）。unread=true で未読のみ。",
    inputSchema: obj({
      view: { type: "string", enum: ["new", "all", "baseline", "updated"] },
      subscription_id: str("購読先ID"),
      set_id: str("セットID"),
      unread: { type: "boolean" },
      limit: { type: "integer", minimum: 1, maximum: 200 },
      offset: { type: "integer", minimum: 0 },
    }),
    annotations: { readOnlyHint: true },
    run: (a, call) => call("GET", `/items${qs(a, ["view", "subscription_id", "set_id", "unread", "limit", "offset"])}`),
  },
  {
    name: "get_item",
    description: "item 1件の全データ（本文・リンク・日付・抽出フィールド・変更履歴）。",
    inputSchema: obj({ id: str("item ID") }, ["id"]),
    annotations: { readOnlyHint: true },
    run: (a, call) => call("GET", `/items/${enc(String(a.id))}`),
  },
  {
    name: "mark_read",
    description: "item を既読にする。item_ids、または subscription_id / set_id でまとめて既読。",
    inputSchema: obj({ item_ids: { type: "array", items: { type: "string" } }, subscription_id: str("購読先ID"), set_id: str("セットID") }),
    run: (a, call) => call("POST", "/items/mark-read", pick(a, ["item_ids", "subscription_id", "set_id"])),
  },
  {
    name: "mark_unread",
    description: "item を未読に戻す。",
    inputSchema: obj({ id: str("item ID") }, ["id"]),
    run: (a, call) => call("DELETE", `/items/${enc(String(a.id))}/read`),
  },
  // ---- セット ----
  {
    name: "list_sets",
    description: "セット（購読先をまとめたもの）の一覧。",
    inputSchema: obj({}),
    annotations: { readOnlyHint: true },
    run: (_a, call) => call("GET", "/sets"),
  },
  {
    name: "get_set",
    description: "セットの詳細：メンバーの購読先、カスタムフィールド定義、抽出状況、公開ページの設定（is_public, public_slug, public_title, public_description, public_options_json）と公開URLのベース。",
    inputSchema: obj({ id: str("セットID") }, ["id"]),
    annotations: { readOnlyHint: true },
    run: (a, call) => call("GET", `/sets/${enc(String(a.id))}`),
  },
  {
    name: "create_set",
    description: "セットを作る（名前は一意）。subscription_ids で最初のメンバーを入れられる。",
    inputSchema: obj({ name: str("セット名"), subscription_ids: { type: "array", items: { type: "string" } } }, ["name"]),
    run: (a, call) => call("POST", "/sets", pick(a, ["name", "subscription_ids"])),
  },
  {
    name: "update_set",
    description: "セットの名前・並び順を変える。",
    inputSchema: obj({ id: str("セットID"), name: str("新しい名前"), position: { type: "integer" } }, ["id"]),
    run: (a, call) => call("PATCH", `/sets/${enc(String(a.id))}`, pick(a, ["name", "position"])),
  },
  {
    name: "delete_set",
    description: "セットを削除する（購読先そのものは消えない）。",
    inputSchema: obj({ id: str("セットID") }, ["id"]),
    annotations: { destructiveHint: true },
    run: (a, call) => call("DELETE", `/sets/${enc(String(a.id))}`),
  },
  {
    name: "add_to_set",
    description: "購読先をセットに入れる。",
    inputSchema: obj({ set_id: str("セットID"), subscription_id: str("購読先ID") }, ["set_id", "subscription_id"]),
    run: (a, call) => call("PUT", `/sets/${enc(String(a.set_id))}/members/${enc(String(a.subscription_id))}`),
  },
  {
    name: "remove_from_set",
    description: "購読先をセットから外す（そのセットでのカスタムフィールドの値も消える）。",
    inputSchema: obj({ set_id: str("セットID"), subscription_id: str("購読先ID") }, ["set_id", "subscription_id"]),
    annotations: { destructiveHint: true },
    run: (a, call) => call("DELETE", `/sets/${enc(String(a.set_id))}/members/${enc(String(a.subscription_id))}`),
  },
  // ---- カスタムフィールド ----
  {
    name: "add_set_field",
    description:
      "セットにカスタムフィールドを足す。セット内の各 item から AI が値を取り出す（例: 開始日 date, 終了日 date, 会場 text, ジャンル list, 料金 number, 無料 boolean）。description は AI への説明（何をどう取り出すか）。key は英小文字・数字・_（省略時は自動）。",
    inputSchema: obj({
      set_id: str("セットID"),
      label: str("表示名"),
      type: { type: "string", enum: ["text", "list", "date", "number", "boolean"] },
      key: str("キー（^[a-z][a-z0-9_]{0,39}$）"),
      description: str("AIへの説明"),
    }, ["set_id", "label", "type"]),
    run: (a, call) => call("POST", `/sets/${enc(String(a.set_id))}/fields`, pick(a, ["label", "type", "key", "description"])),
  },
  {
    name: "update_set_field",
    description: "カスタムフィールドの表示名・型・キー・説明を変える（定義が変わると item から取り直す）。field_id は get_set の fields[].id。",
    inputSchema: obj({
      set_id: str("セットID"),
      field_id: str("フィールドID"),
      label: str("表示名"),
      type: { type: "string", enum: ["text", "list", "date", "number", "boolean"] },
      key: str("キー"),
      description: str("AIへの説明"),
    }, ["set_id", "field_id"]),
    run: (a, call) => call("PATCH", `/sets/${enc(String(a.set_id))}/fields/${enc(String(a.field_id))}`, pick(a, ["label", "type", "key", "description"])),
  },
  {
    name: "delete_set_field",
    description: "カスタムフィールドを削除する（値も消える）。",
    inputSchema: obj({ set_id: str("セットID"), field_id: str("フィールドID") }, ["set_id", "field_id"]),
    annotations: { destructiveHint: true },
    run: (a, call) => call("DELETE", `/sets/${enc(String(a.set_id))}/fields/${enc(String(a.field_id))}`),
  },
  {
    name: "extract_set_fields",
    description: "セットのカスタムフィールドの抽出を今すぐ進める（未抽出の item を最大40件）。通常は5分ごとに自動で進む。",
    inputSchema: obj({ set_id: str("セットID") }, ["set_id"]),
    run: (a, call) => call("POST", `/sets/${enc(String(a.set_id))}/fields/extract`),
  },
  {
    name: "get_field_values",
    description: "フィールドの値の分布（text/list は値ごとの件数、date/number は範囲）。",
    inputSchema: obj({ set_id: str("セットID"), key: str("フィールドのキー") }, ["set_id", "key"]),
    annotations: { readOnlyHint: true },
    run: (a, call) => call("GET", `/sets/${enc(String(a.set_id))}/fields/${enc(String(a.key))}/values`),
  },
  {
    name: "set_item_field",
    description: "item のカスタムフィールドの値を手で設定する（AIの抽出で上書きされなくなる）。values は値の配列（date は YYYY-MM-DD、単数型は1要素）。",
    inputSchema: obj({ item_id: str("item ID"), set_id: str("セットID"), key: str("フィールドのキー"), values: { type: "array", items: {} } }, ["item_id", "set_id", "key", "values"]),
    run: (a, call) => call("PUT", `/items/${enc(String(a.item_id))}/fields/${enc(String(a.set_id))}/${enc(String(a.key))}`, { values: a.values }),
  },
  {
    name: "clear_item_field",
    description: "item のカスタムフィールドの手動の値を外して、AI の抽出に戻す。",
    inputSchema: obj({ item_id: str("item ID"), set_id: str("セットID"), key: str("フィールドのキー") }, ["item_id", "set_id", "key"]),
    run: (a, call) => call("DELETE", `/items/${enc(String(a.item_id))}/fields/${enc(String(a.set_id))}/${enc(String(a.key))}`),
  },
  // ---- 公開ページ ----
  {
    name: "publish_set",
    description:
      "セットの公開ページ（radar）を作成・更新・調整する。指定しなかった項目は今の設定のまま（options もキー単位で上書き）。is_public=false で非公開（URL・設定は残る）。slug は英小文字・数字・ハイフン。公開URLは get_set の public_base_url + slug。\n" +
      PUBLIC_OPTIONS_DOC,
    inputSchema: obj({
      set_id: str("セットID"),
      is_public: { type: "boolean" },
      slug: str("URLの名前（例 kyoto-museums）"),
      title: str("ページのタイトル（空ならセット名）"),
      description: str("ページの説明文"),
      options: { type: "object", description: "表示設定（説明を参照）" },
    }, ["set_id"]),
    run: async (a, call) => {
      const cur = await call("GET", `/sets/${enc(String(a.set_id))}`);
      if (cur.status !== 200) return cur;
      const st = (cur.data as { set: Json }).set;
      let curOpts: Json = {};
      try {
        curOpts = st.public_options_json ? (JSON.parse(String(st.public_options_json)) as Json) : {};
      } catch {
        /* 壊れていれば空から */
      }
      const body = {
        is_public: a.is_public ?? !!st.is_public,
        slug: a.slug ?? st.public_slug ?? "",
        title: a.title ?? st.public_title ?? "",
        description: a.description ?? st.public_description ?? "",
        options: { ...curOpts, ...((a.options as Json) ?? {}) },
      };
      const r = await call("PUT", `/sets/${enc(String(a.set_id))}/publish`, body);
      if (r.status !== 200) return r;
      const after = await call("GET", `/sets/${enc(String(a.set_id))}`);
      const s2 = (after.data as { set: Json }).set;
      return {
        status: 200,
        data: {
          ok: true,
          is_public: !!s2.is_public,
          url: s2.public_slug ? `${s2.public_base_url}${s2.public_slug}` : null,
          preview_url: s2.public_slug && s2.public_preview_token ? `${s2.public_base_url}${s2.public_slug}?token=${s2.public_preview_token}` : null,
          options: (() => {
            try {
              return JSON.parse(String(s2.public_options_json));
            } catch {
              return null;
            }
          })(),
        },
      };
    },
  },
  {
    name: "regenerate_preview_token",
    description: "非公開ページのプレビューURL用トークンを作り直す（以前のプレビューURLは無効になる）。",
    inputSchema: obj({ set_id: str("セットID") }, ["set_id"]),
    run: (a, call) => call("POST", `/sets/${enc(String(a.set_id))}/publish/preview-token`),
  },
  // ---- 汎用 ----
  {
    name: "api_request",
    description:
      "上のツールにない操作のための、利用者 API（/api/v1）への直接リクエスト。path は /api/v1 以降（例 /subscriptions, /items?limit=5）。トークン管理（/tokens）は使えない。",
    inputSchema: obj({ method: { type: "string", enum: ["GET", "POST", "PUT", "PATCH", "DELETE"] }, path: str("/api/v1 以降のパス"), body: { description: "JSON ボディ" } }, ["method", "path"]),
    run: (a, call) => {
      const path = String(a.path);
      if (!path.startsWith("/") || path.startsWith("//") || /^\/tokens(\/|\?|$)/.test(path)) return Promise.resolve({ status: 400, data: { error: "bad_path" } });
      return call(String(a.method), path, a.body);
    },
  },
];

const INSTRUCTIONS = `Web Subscriber: Webページやフィードを定期取得して、新しい item（記事・催し・展覧会など）を集めるサービス。
- 購読先(subscription) → 取得設定の版(config: draft/active) → 取得実行(run) → item。
- 購読の追加・見直しは AI が設定の下書きを作る（非同期）。get_setup_session で ready を待ち、get_subscription の versions で検証結果(checks)を確認してから activate_config する。
- セット(set)は購読先のまとまり。カスタムフィールド（開始日・会場など）を定義すると各 item から AI が値を取り出す。
- セットは公開ページ（radar）にできる：publish_set（区分・並び順・絞り込み・表示形式を options で調整）。
- 日時はUTCのISO文字列、日付の判定はJST。`;

function rpcResult(id: unknown, result: unknown) {
  return { jsonrpc: "2.0", id, result };
}
function rpcError(id: unknown, code: number, message: string) {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}

/** 大きすぎる応答を AI に渡せる大きさに縮める */
function shrink(v: unknown, depth = 0): unknown {
  if (typeof v === "string") return v.length > 4000 ? `${v.slice(0, 4000)}…(${v.length - 4000}文字省略)` : v;
  if (Array.isArray(v)) return v.map((x) => shrink(x, depth + 1));
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, shrink(x, depth + 1)]));
  return v;
}

async function handleRpc(msg: Json, call: Call): Promise<unknown | null> {
  const id = msg.id;
  const method = String(msg.method ?? "");
  const isNotification = id === undefined;
  if (msg.jsonrpc !== "2.0" || !method) return isNotification ? null : rpcError(id, -32600, "Invalid Request");
  if (isNotification) return null;
  const params = (msg.params ?? {}) as Json;
  switch (method) {
    case "initialize": {
      const asked = String(params.protocolVersion ?? "");
      return rpcResult(id, {
        protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "web-subscriber", title: "Web Subscriber", version: "1.0.0" },
        instructions: INSTRUCTIONS,
      });
    }
    case "ping":
      return rpcResult(id, {});
    case "tools/list":
      return rpcResult(id, { tools: TOOLS.map(({ run: _r, ...t }) => t) });
    case "tools/call": {
      const tool = TOOLS.find((t) => t.name === params.name);
      if (!tool) return rpcError(id, -32602, `Unknown tool: ${String(params.name)}`);
      try {
        const r = await tool.run((params.arguments ?? {}) as Json, call);
        const ok = r.status >= 200 && r.status < 300;
        const text = JSON.stringify(shrink(r.data), null, 1);
        return rpcResult(id, { content: [{ type: "text", text: ok ? text : `HTTP ${r.status}: ${text}` }], isError: !ok });
      } catch (e) {
        return rpcResult(id, { content: [{ type: "text", text: `エラー: ${(e as Error).message}` }], isError: true });
      }
    }
    case "resources/list":
      return rpcResult(id, { resources: [] });
    case "prompts/list":
      return rpcResult(id, { prompts: [] });
    default:
      return rpcError(id, -32601, `Method not found: ${method}`);
  }
}

/**
 * /mcp の処理。api は「/api/v1 へのリクエストを処理する関数」（index.ts のアプリ）。
 * 認証は個人アクセストークン（Authorization: Bearer wst_…）。
 */
export async function handleMcp(req: Request, env: Env, ctx: ExecutionContext, api: (r: Request) => Promise<Response>): Promise<Response> {
  const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Authorization, Content-Type, Mcp-Session-Id, Mcp-Protocol-Version", "Access-Control-Allow-Methods": "POST, OPTIONS" };
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (req.method !== "POST") return new Response("Method Not Allowed", { status: 405, headers: { ...cors, Allow: "POST, OPTIONS" } });
  const auth = req.headers.get("Authorization") ?? undefined;
  const uid = await tokenUser(env, auth, ctx);
  if (!uid)
    return Response.json(rpcError(null, -32001, "Unauthorized: Authorization: Bearer <アクセストークン> が必要です（reader の「設定」で発行）"), {
      status: 401,
      headers: { ...cors, "WWW-Authenticate": 'Bearer realm="web-subscriber"' },
    });

  let payload: unknown;
  try {
    payload = await req.json();
  } catch {
    return Response.json(rpcError(null, -32700, "Parse error"), { status: 400, headers: cors });
  }

  const origin = new URL(req.url).origin;
  const call: Call = async (method, path, body) => {
    const r = await api(
      new Request(`${origin}/api/v1${path}`, {
        method,
        headers: { Authorization: auth!, ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
        body: body !== undefined && method !== "GET" ? JSON.stringify(body) : undefined,
      }),
    );
    const text = await r.text();
    let data: unknown = text;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      /* JSON 以外はそのまま */
    }
    return { status: r.status, data };
  };

  const batch = Array.isArray(payload);
  const msgs = (batch ? payload : [payload]) as Json[];
  const out = (await Promise.all(msgs.map((m) => handleRpc(m && typeof m === "object" ? m : {}, call)))).filter((x) => x !== null);
  if (!out.length) return new Response(null, { status: 202, headers: cors });
  return Response.json(batch ? out : out[0], { headers: cors });
}

export const MCP_TOOL_NAMES = TOOLS.map((t) => t.name);
