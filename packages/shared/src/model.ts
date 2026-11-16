// 共通情報モデル（docs/design.md §2）

export type TextType = "text" | "html" | "xhtml";

export interface Text {
  type: TextType;
  value: string;
  lang?: string;
  base?: string;
}

export interface Person {
  name?: string;
  email?: string;
  uri?: string;
  /** 元表記（RSS の "a@example.com (Name)" など） */
  raw?: string;
}

export interface Category {
  term: string;
  scheme?: string;
  label?: string;
}

export interface Link {
  href: string;
  href_raw?: string;
  rel: string;
  media_type?: string;
  hreflang?: string;
  title?: string;
  length_bytes?: number;
}

export interface Image {
  url: string;
  title?: string;
  link?: string;
  description?: string;
  width?: number;
  height?: number;
}

export interface Generator {
  name: string;
  uri?: string;
  version?: string;
}

export type DatePrecision = "year" | "month" | "date" | "datetime" | "unknown";

export interface DateValue {
  raw: string;
  /** precision=date なら YYYY-MM-DD、datetime なら RFC3339。架空の時刻は付けない */
  value: string | null;
  precision: DatePrecision;
  tz: "explicit" | "assumed" | "none";
  assumed_tz?: string;
  parse_error?: string;
}

export type Content =
  | { kind: "inline"; type: string; value: string; encoding?: "base64"; lang?: string; base?: string }
  | { kind: "external"; src: string; type?: string };

export interface ExtensionAttr {
  ns: string | null;
  local: string;
  value: string;
}

export interface Extension {
  ns: string | null;
  prefix?: string;
  local: string;
  attrs: ExtensionAttr[];
  text?: string;
  children?: Extension[];
  /** 元XML断片 */
  xml: string;
}

export interface RssCloud {
  domain?: string;
  port?: number;
  path?: string;
  register_procedure?: string;
  protocol?: string;
}

export interface RssTextInput {
  title?: string;
  description?: string;
  name?: string;
  link?: string;
}

export type ChannelNative =
  | {
      format: "rss2";
      version?: string;
      ttl?: number;
      skip_hours?: number[];
      skip_days?: string[];
      cloud?: RssCloud;
      managing_editor?: Person;
      web_master?: Person;
      docs?: string;
      rating?: string;
      text_input?: RssTextInput;
      image?: Image;
    }
  | { format: "rss1"; about?: string; image?: Image; text_input?: RssTextInput }
  | { format: "atom" }
  | { format: "html"; document_url: string; extracted_fields: Record<string, unknown> };

export interface ChannelData {
  source_id?: string;
  title?: Text;
  description?: Text;
  links: Link[];
  language?: string;
  authors: Person[];
  contributors: Person[];
  categories: Category[];
  rights?: Text;
  published_at?: DateValue;
  updated_at?: DateValue;
  icon?: Image;
  logo?: Image;
  generator?: Generator;
  native: ChannelNative;
  extensions: Extension[];
}

/** Item.source：転載元。items は持たない */
export type SourceChannel = Omit<ChannelData, "native"> & { native?: ChannelNative };

export type ItemNative =
  | {
      format: "rss2" | "rss1";
      guid?: { value: string; is_perma_link: boolean };
      comments?: string;
      /** RSS description 原文。要約とも全文とも断定しない */
      description_raw?: string;
      description_role?: "unknown";
      about?: string;
    }
  | { format: "atom" }
  | { format: "html"; extracted_fields: Record<string, unknown> };

export interface ItemData {
  source_id?: string;
  title?: Text;
  links: Link[];
  summary?: Text;
  content?: Content;
  authors: Person[];
  contributors: Person[];
  categories: Category[];
  rights?: Text;
  language?: string;
  published_at?: DateValue;
  updated_at?: DateValue;
  source?: SourceChannel;
  native: ItemNative;
  extensions: Extension[];
}

export function emptyChannel(native: ChannelNative): ChannelData {
  return { links: [], authors: [], contributors: [], categories: [], native, extensions: [] };
}

export function emptyItem(native: ItemNative): ItemData {
  return { links: [], authors: [], contributors: [], categories: [], native, extensions: [] };
}

/** 閲覧用URL（rel=alternate の先頭） */
export function primaryLink(item: Pick<ItemData, "links">): string | undefined {
  return item.links.find((l) => l.rel === "alternate")?.href;
}

const MEDIA_RSS_NS = "http://search.yahoo.com/mrss/";
const IMAGE_EXT = /\.(jpe?g|png|gif|webp|avif)(\?|#|$)/i;

/** 配信元データ自体が指定している item 画像（enclosure / Media RSS / HTML抽出の image・thumbnail フィールド） */
export function itemImageFromData(item: ItemData): string | undefined {
  const enc = item.links.find((l) => l.rel === "enclosure" && (l.media_type?.startsWith("image/") || (!l.media_type && IMAGE_EXT.test(l.href))));
  if (enc) return enc.href;
  const walk = (exts: Extension[]): string | undefined => {
    for (const e of exts) {
      if (e.ns === MEDIA_RSS_NS) {
        const attr = (n: string) => e.attrs.find((a) => a.local === n && !a.ns)?.value;
        const url = attr("url");
        if (url && (e.local === "thumbnail" || (e.local === "content" && (attr("medium") === "image" || attr("type")?.startsWith("image/") || IMAGE_EXT.test(url))))) return url;
        if (e.children?.length) {
          const u = walk(e.children);
          if (u) return u;
        }
      }
    }
    return undefined;
  };
  const media = walk(item.extensions);
  if (media) return media;
  if (item.native.format === "html") {
    for (const k of ["image", "thumbnail"]) {
      const v = item.native.extracted_fields[k];
      const s = Array.isArray(v) ? v[0] : v;
      if (typeof s === "string" && /^https?:\/\//.test(s)) return s;
    }
  }
  return undefined;
}

/**
 * 一覧の item に詳細ページから取得した値を重ねる。詳細側で取れたフィールドを優先し、
 * 取れなかったフィールドは一覧の値を残す。閲覧URL（alternate）は一覧のものを保つ。
 */
export function mergeDetail(item: ItemData, detail: ItemData | null | undefined): ItemData {
  if (!detail) return item;
  const out: ItemData = { ...item };
  for (const k of ["title", "summary", "content", "rights", "language", "published_at", "updated_at"] as const) {
    if (detail[k] !== undefined) (out as unknown as Record<string, unknown>)[k] = detail[k];
  }
  if (detail.authors.length) out.authors = detail.authors;
  if (detail.contributors.length) out.contributors = detail.contributors;
  if (detail.categories.length) out.categories = detail.categories;
  const extra = detail.links.filter((l) => l.rel !== "alternate" && !item.links.some((x) => x.href === l.href && x.rel === l.rel));
  if (extra.length) out.links = [...item.links, ...extra];
  if (item.native.format === "html" && detail.native.format === "html")
    out.native = { ...item.native, extracted_fields: { ...item.native.extracted_fields, ...detail.native.extracted_fields } };
  return out;
}

// ---- 検証（元形式とアプリ利用可否を分離） ----

export interface ValidationIssue {
  level: "warning" | "error";
  code: string;
  message: string;
  path?: string;
}

/** アプリで利用可能か（RSS/Atom の必須条件とは別） */
export function appValidateItem(item: ItemData): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const hasDisplay =
    !!item.title?.value || !!primaryLink(item) || !!item.summary?.value || (item.content?.kind === "inline" && !!item.content.value);
  if (!hasDisplay) issues.push({ level: "error", code: "no_displayable_field", message: "title/link/summary/content のいずれもない" });
  return issues;
}
