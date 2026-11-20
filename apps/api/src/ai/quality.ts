// AI 設定時の抽出結果の品質チェック
const GENERIC_TITLE = /^(read\s*more|more|view\s*more|see\s*more|learn\s*more|more\s*info|details?|continue(\s*reading)?|click\s*here|link|詳しく(は|見る|はこちら)?|詳細(を見る|はこちら|へ)?|もっと(見る|読む)|続きを(読む|見る)|一覧(を見る|へ)?|こちら|ここ|リンク|MORE|VIEW)$/i;

/** 抽出された item のタイトルの品質問題（定型リンク文字・重複・長すぎ）を列挙する */
export function titleWarnings(items: { title?: unknown }[]): string[] {
  const titles = items.map((i) => (typeof i.title === "string" ? i.title : "").replace(/[\s　>＞»→›・|]+/g, " ").trim()).filter(Boolean);
  if (!titles.length) return [];
  const out: string[] = [];
  const generic = titles.filter((t) => GENERIC_TITLE.test(t));
  if (generic.length)
    out.push(
      `${generic.length}/${titles.length} 件のタイトルが「${[...new Set(generic)].slice(0, 3).join("」「")}」のような定型のリンク文字です。title は見出し（h2/h3/strong 等、記事名・催し名）から取ってください。リンク文字しか無い場合は from を見出しにし、link だけを a[href] から取ります。`,
    );
  const counts = new Map<string, number>();
  for (const t of titles) counts.set(t, (counts.get(t) ?? 0) + 1);
  const [topT, topN] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  if (topN >= 2 && topN / titles.length >= 0.3 && !GENERIC_TITLE.test(topT)) out.push(`${topN}/${titles.length} 件のタイトルが同じ「${topT.slice(0, 40)}」です。item ごとに異なる見出しを指すセレクタにしてください。`);
  const long = titles.filter((t) => t.length > 100);
  if (long.length / titles.length >= 0.3) out.push(`${long.length}/${titles.length} 件のタイトルが100字を超えています。見出し以外（本文・日付・ラベル）まで連結している可能性があります。`);
  return out;
}
