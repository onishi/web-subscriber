// 購読設定（docs/design.md §4）。AI生成・手動編集ともこの形式のみ。任意JSは表現できない。
import { z } from "zod";

export const SelectorSchema = z.union([
  z.object({ css: z.string().min(1) }).strict(),
  z.object({ xpath: z.string().min(1) }).strict(),
]);
export type Selector = z.infer<typeof SelectorSchema>;

// ---- 変換処理（許可リスト） ----
export const TransformSchema = z.union([
  z.enum(["trim", "collapse_whitespace", "lowercase", "uppercase", "strip_tags", "decode_entities", "parse_int", "parse_number"]),
  z.object({ resolve_url: z.object({ base: z.string().optional() }).strict() }).strict(),
  z
    .object({
      parse_date: z
        .object({
          formats: z.array(z.string()).optional(),
          assume_tz: z.string().optional(),
        })
        .strict(),
    })
    .strict(),
  z.object({ regex_extract: z.object({ pattern: z.string(), group: z.number().int().min(0).default(1), flags: z.string().regex(/^[imsu]*$/).optional() }).strict() }).strict(),
  z.object({ regex_replace: z.object({ pattern: z.string(), replacement: z.string(), flags: z.string().regex(/^[gimsu]*$/).optional() }).strict() }).strict(),
  z.object({ split: z.object({ sep: z.string() }).strict() }).strict(),
  z.object({ join: z.object({ sep: z.string() }).strict() }).strict(),
  z.object({ default: z.object({ value: z.string() }).strict() }).strict(),
  z.object({ nullify_if: z.object({ equals: z.array(z.string()) }).strict() }).strict(),
  z.object({ prefix: z.object({ value: z.string() }).strict() }).strict(),
  z.object({ suffix: z.object({ value: z.string() }).strict() }).strict(),
]);
export type Transform = z.infer<typeof TransformSchema>;

export const TakeSchema = z.union([
  z.enum(["text", "inner_html", "outer_html"]),
  z.object({ attr: z.string().min(1) }).strict(),
]);
export type Take = z.infer<typeof TakeSchema>;

export type FieldRule =
  | { const: unknown }
  | {
      from?: Selector;
      take?: Take;
      cardinality?: "one" | "first" | "many";
      required?: boolean;
      transforms?: Transform[];
      fallback?: FieldRule[];
    }
  | { object: Record<string, FieldRule>; required?: boolean }
  | { array: { select: Selector; of: FieldRule }; required?: boolean };

export const FieldRuleSchema: z.ZodType<FieldRule> = z.lazy(() =>
  z.union([
    z.object({ const: z.unknown() }).strict(),
    z.object({ object: z.record(z.string(), FieldRuleSchema), required: z.boolean().optional() }).strict(),
    z
      .object({
        array: z.object({ select: SelectorSchema, of: FieldRuleSchema }).strict(),
        required: z.boolean().optional(),
      })
      .strict(),
    z
      .object({
        from: SelectorSchema.optional(),
        take: TakeSchema.optional(),
        cardinality: z.enum(["one", "first", "many"]).optional(),
        required: z.boolean().optional(),
        transforms: z.array(TransformSchema).optional(),
        fallback: z.array(FieldRuleSchema).optional(),
      })
      .strict(),
  ]),
) as z.ZodType<FieldRule>;

// ---- 待機条件 ----
export type Cond =
  | { exists: Selector }
  | { visible: Selector }
  | { gone: Selector }
  | { hidden: Selector }
  | { item_count_changed: Record<string, never> }
  | { item_count_at_least: number }
  | { items_changed: Record<string, never> }
  | { stable: { target: Selector; for_ms: number } }
  | { url_changed: Record<string, never> }
  | { all: Cond[] }
  | { any: Cond[] }
  | { not: Cond };

export const CondSchema: z.ZodType<Cond> = z.lazy(() =>
  z.union([
    z.object({ exists: SelectorSchema }).strict(),
    z.object({ visible: SelectorSchema }).strict(),
    z.object({ gone: SelectorSchema }).strict(),
    z.object({ hidden: SelectorSchema }).strict(),
    z.object({ item_count_changed: z.object({}).strict() }).strict(),
    z.object({ item_count_at_least: z.number().int().min(0) }).strict(),
    z.object({ items_changed: z.object({}).strict() }).strict(),
    z.object({ stable: z.object({ target: SelectorSchema, for_ms: z.number().int().min(50).max(10000) }).strict() }).strict(),
    z.object({ url_changed: z.object({}).strict() }).strict(),
    z.object({ all: z.array(CondSchema).min(1) }).strict(),
    z.object({ any: z.array(CondSchema).min(1) }).strict(),
    z.object({ not: CondSchema }).strict(),
  ]),
) as z.ZodType<Cond>;

export const WaitSchema = z
  .object({
    cond: CondSchema,
    timeout_ms: z.number().int().min(100).max(60000),
    poll_ms: z.number().int().min(50).max(2000).optional(),
  })
  .strict();
export type Wait = z.infer<typeof WaitSchema>;

export const DisabledWhenSchema = z.union([
  z.object({ attr: z.string() }).strict(),
  z.object({ attr_equals: z.tuple([z.string(), z.string()]) }).strict(),
  z.object({ has_class: z.string() }).strict(),
]);

/**
 * item のリンク先（詳細ページ）からの追加取得。一覧に本文がないサイト向け。
 * fields は詳細ページの文書全体を起点に評価する（item 抽出と同じ FieldRule）。
 */
export const DetailSchema = z
  .object({
    fetch: z
      .object({ method: z.enum(["http", "browser"]), timeout_ms: z.number().int().min(1000).max(60000).default(30000) })
      .strict()
      .default({ method: "http", timeout_ms: 30000 }),
    /** browser 方式での準備完了待ち（exists / visible / stable などの文書に対する条件） */
    wait: WaitSchema.optional(),
    fields: z.record(z.string(), FieldRuleSchema),
    /** always: 全 item / missing_content: 一覧で summary も content も取れなかった item のみ */
    when: z.enum(["always", "missing_content"]).default("always"),
    /** 1回の実行で取得する詳細ページ数の上限（残りは次回） */
    max_per_run: z.number().int().min(1).max(100).default(30),
  })
  .strict();
export type DetailConfig = z.infer<typeof DetailSchema>;

export const ITEM_FIELD_NAMES = [
  "source_id",
  "title",
  "links",
  "link",
  "summary",
  "content",
  "authors",
  "author",
  "contributors",
  "categories",
  "rights",
  "language",
  "published_at",
  "updated_at",
] as const;

export const CHANGE_FIELDS = ["title", "links", "summary", "content", "authors", "contributors", "categories", "rights", "language", "published_at", "updated_at", "source_id"] as const;

export const ConfigSchema = z
  .object({
    schema_version: z.literal(1),
    source: z.object({ url: z.string().url(), kind: z.enum(["feed", "html"]) }).strict(),
    fetch: z
      .object({
        method: z.enum(["http", "browser"]),
        headers: z.record(z.string(), z.string()).default({}),
        timeout_ms: z.number().int().min(1000).max(60000).default(30000),
        browser: z
          .object({
            viewport: z.object({ width: z.number().int(), height: z.number().int() }).strict().optional(),
            block_resource_types: z.array(z.enum(["image", "media", "font", "stylesheet"])).default(["image", "media", "font"]),
          })
          .strict()
          .default({ block_resource_types: ["image", "media", "font"] }),
      })
      .strict(),
    selector_engine: z
      .object({ css: z.string(), xpath: z.literal("1.0") })
      .strict()
      .optional(),
    feed: z.object({ format: z.enum(["auto", "rss2", "rss1", "atom"]).default("auto") }).strict().nullable().default(null),
    extract: z
      .object({
        channel: z.object({ fields: z.record(z.string(), FieldRuleSchema).default({}) }).strict().default({ fields: {} }),
        items: z
          .object({
            container: SelectorSchema,
            select: SelectorSchema,
            empty_marker: SelectorSchema.optional(),
            zero_items_policy: z.enum(["ok_if_container", "require_empty_marker", "fail"]).default("ok_if_container"),
            fields: z.record(z.string(), FieldRuleSchema),
            invalid_item_threshold: z.number().min(0).max(1).default(0.2),
          })
          .strict(),
      })
      .strict()
      .nullable()
      .default(null),
    identity: z
      .object({
        method: z.enum(["source_id", "fields", "link", "content_hash"]),
        fields: z.array(z.string()).default([]),
        link_normalization: z.array(z.enum(["strip_fragment", "strip_query"])).default(["strip_fragment"]),
      })
      .strict(),
    change_detection: z
      .object({ fields: z.array(z.enum(CHANGE_FIELDS)).min(1) })
      .strict()
      .default({ fields: ["title", "links", "summary", "content", "authors", "categories", "published_at", "updated_at"] }),
    wait: z
      .object({ initial: WaitSchema.optional(), after_paging: WaitSchema.optional() })
      .strict()
      .default({}),
    paging: z
      .object({
        mode: z.enum(["none", "replace", "append"]),
        next: SelectorSchema.optional(),
        pick: z.union([z.enum(["only", "first", "last"]), z.string().regex(/^index:\d+$/)]).default("only"),
        disabled_when: z.array(DisabledWhenSchema).default([{ attr: "disabled" }, { attr_equals: ["aria-disabled", "true"] }]),
        limits: z
          .object({
            max_pages: z.number().int().min(1).max(100).default(20),
            max_actions: z.number().int().min(0).max(200).default(30),
            max_duration_ms: z.number().int().min(5000).max(900000).default(300000),
            /** 取得した item の合計がこの件数に達したらページングをやめる（省略時は無制限） */
            max_items: z.number().int().min(1).max(5000).optional(),
          })
          .strict()
          .default({ max_pages: 20, max_actions: 30, max_duration_ms: 300000 }),
        stop_on_known_items: z.literal(false).default(false),
      })
      .strict()
      .default({ mode: "none", pick: "only", disabled_when: [], limits: { max_pages: 20, max_actions: 30, max_duration_ms: 300000 }, stop_on_known_items: false }),
    politeness: z
      .object({ min_interval_ms: z.number().int().min(0).default(1500), respect_robots_txt: z.boolean().default(true) })
      .strict()
      .default({ min_interval_ms: 1500, respect_robots_txt: true }),
    timezone: z.string().default("Asia/Tokyo"),
    detail: DetailSchema.nullable().default(null),
  })
  .strict()
  .superRefine((c, ctx) => {
    if (c.source.kind === "html" && !c.extract) ctx.addIssue({ code: "custom", message: "kind=html には extract が必要", path: ["extract"] });
    if (c.source.kind === "feed" && c.fetch.method !== "http") ctx.addIssue({ code: "custom", message: "feed は http 方式のみ", path: ["fetch", "method"] });
    if (c.paging.mode !== "none" && !c.paging.next) ctx.addIssue({ code: "custom", message: "paging.next が必要", path: ["paging", "next"] });
    if (c.paging.mode !== "none" && c.fetch.method !== "browser")
      ctx.addIssue({ code: "custom", message: "クリックによるページングは browser 方式が必要", path: ["paging", "mode"] });
    if (c.detail && Object.keys(c.detail.fields).length === 0) ctx.addIssue({ code: "custom", message: "detail.fields が必要", path: ["detail", "fields"] });
    if ((c.identity.method === "fields" || c.identity.method === "content_hash") && c.identity.fields.length === 0)
      ctx.addIssue({ code: "custom", message: "identity.fields が必要", path: ["identity", "fields"] });
  });

export type SubscriptionConfig = z.infer<typeof ConfigSchema>;
export type SubscriptionConfigInput = z.input<typeof ConfigSchema>;

export function parseConfig(input: unknown): { ok: true; config: SubscriptionConfig } | { ok: false; errors: string[] } {
  const r = ConfigSchema.safeParse(input);
  if (r.success) return { ok: true, config: r.data };
  return { ok: false, errors: r.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`) };
}

/** 識別・ハッシュ方式の同一性判定に使う部分 */
export function identityScheme(c: SubscriptionConfig) {
  return { method: c.identity.method, fields: c.identity.fields, link_normalization: c.identity.link_normalization };
}
/** 詳細ページ取得の方式。変わったら取得済みの item も取り直す */
export function detailScheme(d: DetailConfig) {
  return { method: d.fetch.method, fields: d.fields };
}
export function hashScheme(c: SubscriptionConfig) {
  return { fields: [...c.change_detection.fields].sort() };
}
