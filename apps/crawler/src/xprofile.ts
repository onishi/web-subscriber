// X（旧 Twitter）のプロフィールページ（ログインなしで見える HTML）に埋め込まれた
// タイムラインの JSON から、最近の投稿を共通モデルへ変換する（feed.format = "x_profile"）。
// 取れるのは固定ポストと最近の数件だけ。X 側の変更で壊れやすいので、見つからなければ例外にする。
import { emptyChannel, emptyItem, parseDate, type ChannelData, type ItemData, type Link } from "@ws/shared";

export interface ParsedXProfile {
  channel: ChannelData;
  items: ItemData[];
}

type J = Record<string, unknown>;
const obj = (v: unknown): J | undefined => (v && typeof v === "object" && !Array.isArray(v) ? (v as J) : undefined);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

/** HTML の JS 文字列リテラルのうち、タイムラインを含むものを JSON として読む */
function embeddedPayloads(html: string): unknown[] {
  const out: unknown[] = [];
  for (const m of html.matchAll(/"((?:[^"\\]|\\.)*?(?:full_text|user_result_by_screen_name)(?:[^"\\]|\\.)*)"/g)) {
    try {
      const s = JSON.parse(`"${m[1].replace(/\\x([0-9a-fA-F]{2})/g, "\\u00$1").replace(/\\'/g, "'")}"`) as string;
      out.push(JSON.parse(s));
    } catch {
      /* JSON でない文字列は飛ばす */
    }
  }
  return out;
}

/** オブジェクトをたどって __typename が Tweet / User のものを集める */
function collect(root: unknown, tweets: J[], users: J[]) {
  const stack: unknown[] = [root];
  const seen = new Set<unknown>();
  while (stack.length) {
    const v = stack.pop();
    if (!v || typeof v !== "object" || seen.has(v)) continue;
    seen.add(v);
    if (Array.isArray(v)) {
      stack.push(...v);
      continue;
    }
    const o = v as J;
    if (o.__typename === "Tweet" && str(o.rest_id)) tweets.push(o);
    if (o.__typename === "User" && obj(o.core)?.screen_name) users.push(o);
    stack.push(...Object.values(o));
  }
}

/** t.co の短縮 URL を元の URL に戻し、末尾の画像リンク（t.co）を取り除く */
function cleanText(t: J, text: string): string {
  // 表示範囲（末尾の画像リンクを除いた本文）で切ってから、短縮 URL を元に戻す
  let s = text;
  const range = arr(obj(t.details)?.display_text_range ?? obj(t.legacy)?.display_text_range);
  if (range.length === 2 && typeof range[1] === "number") s = [...s].slice(0, range[1] as number).join("");
  for (const e of arr(t.url_entities)) {
    const u = obj(e);
    const short = str(u?.url);
    const full = str(u?.expanded_url);
    if (short && full) s = s.split(short).join(full);
  }
  return s.replace(/\s*https:\/\/t\.co\/\w+\s*$/, "").trim();
}

export function parseXProfile(html: string, pageUrl: string): ParsedXProfile {
  const screen = /^\/([A-Za-z0-9_]{1,15})\/?$/.exec(new URL(pageUrl).pathname)?.[1];
  if (!screen) throw new Error("x_profile: URL は https://x.com/<ユーザー名> の形にしてください");
  const tweets: J[] = [];
  const users: J[] = [];
  for (const p of embeddedPayloads(html)) collect(p, tweets, users);
  // 同じユーザーが複数の断片に分かれて入っているので、項目を寄せ集める
  const mine = users.filter((u) => String(obj(u.core)?.screen_name).toLowerCase() === screen.toLowerCase());
  const user: J | undefined = mine.length ? mine.reduce<J>((acc, u) => ({ ...acc, ...u, core: { ...obj(acc.core), ...obj(u.core) } }), {}) : undefined;
  if (!user && !tweets.length) throw new Error("x_profile: ページに投稿のデータが見つかりません（X 側の変更、またはアカウントが非公開・存在しない）");

  const profileUrl = `https://x.com/${screen}`;
  const channel = emptyChannel({ format: "html", document_url: pageUrl, extracted_fields: {} });
  const name = str(obj(user?.core)?.name);
  if (name) channel.title = { type: "text", value: name };
  const bio = str(obj(user?.profile_bio)?.description);
  if (bio) channel.description = { type: "text", value: bio };
  channel.links = [{ href: profileUrl, rel: "alternate", media_type: "text/html" }];
  const avatar = str(obj(user?.avatar)?.image_url);
  if (avatar) channel.logo = { url: avatar.replace(/_normal(\.\w+)$/, "_400x400$1") };

  const items: ItemData[] = [];
  const done = new Set<string>();
  for (const t of tweets) {
    const id = str(t.rest_id)!;
    if (done.has(id)) continue;
    // 他人の投稿（引用元など）は除く
    const author = obj(obj(obj(t.core)?.user_results)?.result);
    const authorScreen = str(obj(author?.core)?.screen_name);
    if (authorScreen && authorScreen.toLowerCase() !== screen.toLowerCase()) continue;
    const details = obj(t.details) ?? obj(t.legacy) ?? {};
    const raw = str(details.full_text);
    if (raw === undefined) continue;
    done.add(id);
    const text = cleanText(t, raw);
    const it = emptyItem({ format: "html", extracted_fields: { tweet_id: id } });
    it.source_id = id;
    const firstLine = text.split("\n").map((l) => l.trim()).find((l) => /[\p{L}\p{N}]/u.test(l)) ?? text;
    it.title = { type: "text", value: [...firstLine].length > 80 ? [...firstLine].slice(0, 80).join("") + "…" : firstLine };
    it.content = { kind: "inline", type: "text", value: text };
    const links: Link[] = [{ href: `${profileUrl}/status/${id}`, rel: "alternate", media_type: "text/html" }];
    for (const m of [...arr(t.media_entities2), ...arr(obj(obj(t.legacy)?.entities)?.media)]) {
      const mu = obj(m);
      const src = str(mu?.media_url_https);
      if (src && !links.some((l) => l.href === src)) links.push({ href: src, rel: "enclosure", media_type: /\.png(\?|$)/i.test(src) ? "image/png" : "image/jpeg" });
    }
    it.links = links;
    const ms = Number(details.created_at_ms);
    if (Number.isFinite(ms) && ms > 0) it.published_at = parseDate(new Date(ms).toISOString());
    else if (str(details.created_at)) it.published_at = parseDate(str(details.created_at)!);
    it.authors = [{ name: name ?? screen, uri: profileUrl }];
    items.push(it);
  }
  if (!items.length) throw new Error("x_profile: 投稿を1件も読み取れませんでした（X 側の変更の可能性）");
  // 新しい順（固定ポストが先頭に来ないように）
  items.sort((a, b) => String(b.published_at?.value ?? "").localeCompare(String(a.published_at?.value ?? "")));
  return { channel, items };
}
