import { describe, it, expect } from "vitest";
import { normalizeDate, normalizeValue, buildFieldQuery, itemText, completeYear, type SetField } from "../src/fields.js";

const F = (key: string, type: SetField["type"]): SetField => ({ id: `id_${key}`, set_id: "s", key, label: key, type, description: "", position: 0 });

describe("normalize", () => {
  it("dates", () => {
    expect(normalizeDate("2026-10-11")).toBe("2026-10-11");
    expect(normalizeDate("2026/1/5")).toBe("2026-01-05");
    expect(normalizeDate("2026年10月11日")).toBe("2026-10-11");
    expect(normalizeDate("2026年10月")).toBe("2026-10");
    expect(normalizeDate("2026")).toBe("2026");
    expect(normalizeDate("2026-02-30")).toBeNull();
    expect(normalizeDate("10月11日")).toBeNull();
    expect(normalizeDate(20261011)).toBeNull();
  });
  it("values by type", () => {
    expect(normalizeValue("list", ["キリン", " ゾウ ", "キリン", ""])).toEqual([{ text: "キリン" }, { text: "ゾウ" }]);
    expect(normalizeValue("list", "キリン、ゾウ")).toEqual([{ text: "キリン" }, { text: "ゾウ" }]);
    expect(normalizeValue("number", "1,200")).toEqual([{ num: 1200 }]);
    expect(normalizeValue("number", "abc")).toEqual([]);
    expect(normalizeValue("boolean", true)).toEqual([{ num: 1 }]);
    expect(normalizeValue("text", "  x ")).toEqual([{ text: "x" }]);
    expect(normalizeValue("date", null)).toEqual([]);
  });
});

describe("buildFieldQuery", () => {
  const fields = [F("start_date", "date"), F("end_date", "date"), F("animals", "list"), F("fee", "number"), F("note", "text")];
  it("range, eq, contains and sort", () => {
    const q = buildFieldQuery(fields, new URLSearchParams("f.start_date.lte=2026-11-16&f.end_date.gte=2026/11/16&f.animals=キリン&f.note.contains=50%&sort=-fee&other=1"));
    if ("error" in q) throw new Error(q.error);
    expect(q.where).toHaveLength(4);
    expect(q.where[0]).toContain("v.value_date <= ?");
    expect(q.args).toEqual(["id_start_date", "2026-11-16", "id_end_date", "2026-11-16", "id_animals", "キリン", "id_note", "%50\\%%"]);
    expect(q.order).toContain("MAX(v.value_num)");
    expect(q.orderArgs).toEqual(["id_fee", "id_fee"]);
  });
  it("rejects unknown fields and bad values", () => {
    expect(buildFieldQuery(fields, new URLSearchParams("f.nope=1"))).toEqual({ error: "unknown_field:nope" });
    expect(buildFieldQuery(fields, new URLSearchParams("f.start_date.gte=soon"))).toEqual({ error: "bad_date:start_date" });
    expect(buildFieldQuery(fields, new URLSearchParams("f.animals.gte=a"))).toEqual({ error: "range_not_supported:animals" });
    expect(buildFieldQuery(fields, new URLSearchParams("f.fee.contains=1"))).toEqual({ error: "contains_not_supported:fee" });
  });
});

describe("itemText", () => {
  it("merges list and detail values and strips html", () => {
    const list = { links: [], authors: [], contributors: [], categories: [], extensions: [], native: { format: "html", extracted_fields: {} }, title: { type: "text", value: "特別展" }, summary: { type: "text", value: "2026年10月11日～12月7日" } };
    const detail = { links: [], authors: [], contributors: [], categories: [], extensions: [], native: { format: "html", extracted_fields: {} }, content: { kind: "inline", type: "html", value: "<p>会期：<b>10月11日</b>から</p><script>x()</script>" } };
    const t = itemText({ data_json: JSON.stringify(list), detail_json: JSON.stringify(detail) });
    expect(t).toContain("タイトル: 特別展");
    expect(t).toContain("概要: 2026年10月11日～12月7日");
    expect(t).toContain("本文: 会期： 10月11日 から");
    expect(t).not.toContain("x()");
  });
  it("keeps the list summary when the detail page overrides it", () => {
    const base = { links: [], authors: [], contributors: [], categories: [], extensions: [], native: { format: "html", extracted_fields: {} } };
    const list = { ...base, title: { type: "text", value: "特別展" }, summary: { type: "text", value: "2027年10月8日（金）～12月5日（日）" } };
    const detail = { ...base, summary: { type: "text", value: "島津家の歴史と文化を紹介する特別展" } };
    const t = itemText({ data_json: JSON.stringify(list), detail_json: JSON.stringify(detail) });
    expect(t).toContain("概要: 島津家の歴史と文化を紹介する特別展");
    expect(t).toContain("一覧ページの概要: 2027年10月8日（金）～12月5日（日）");
  });
  it("passes detail-page extra fields for feed items, before the body", () => {
    const base = { links: [], authors: [], contributors: [], categories: [], extensions: [] };
    const list = { ...base, native: { format: "rss2" }, title: { type: "text", value: "特別展" }, content: { kind: "inline", type: "html", value: "<p>" + "あ".repeat(5000) + "</p>" } };
    const detail = { ...base, native: { format: "html", extracted_fields: { period: "2027年2月6日（土）〜5月5日（水・祝）" } } };
    const t = itemText({ data_json: JSON.stringify(list), detail_json: JSON.stringify(detail) });
    expect(t).toContain("period: 2027年2月6日（土）〜5月5日（水・祝）");
  });
});

describe("completeYear", () => {
  it("picks the year nearest to the reference date", () => {
    expect(completeYear("11-25", "2026-11-24")).toBe("2026-11-25");
    expect(completeYear("1/10", "2026-12-20")).toBe("2027-01-10");
    expect(completeYear("12-28", "2027-01-05")).toBe("2026-12-28");
    expect(completeYear("2-29", "2027-03-01")).toBe("2028-02-29");
    expect(completeYear("13-01", "2026-01-01")).toBeNull();
    expect(normalizeValue("date", "11-25", "2026-11-24")).toEqual([{ date: "2026-11-25" }]);
    expect(normalizeValue("date", "2020-11-25", "2026-11-24")).toEqual([{ date: "2020-11-25" }]);
  });
});

describe("normalizeValue: guessed years", () => {
  it("replaces a year the text does not mention with the one nearest the reference date", () => {
    expect(normalizeValue("date", "2020-11-11", "2026-11-26", "11月11日（水）から期間限定で新登場")).toEqual([{ date: "2026-11-11" }]);
  });
  it("keeps a year the text states", () => {
    expect(normalizeValue("date", "2020-11-11", "2026-11-26", "2020年11月11日に発売")).toEqual([{ date: "2020-11-11" }]);
  });
  it("keeps full dates when no text is given", () => {
    expect(normalizeValue("date", "2020-11-11", "2026-11-26")).toEqual([{ date: "2020-11-11" }]);
  });
});

describe("yearMentioned", () => {
  it("reads western, full-width and Japanese era years", async () => {
    const { yearMentioned } = await import("../src/fields.js");
    expect(yearMentioned("期 間 令和 ５年 ６月 ２０日 (火)", 2023)).toBe(true);
    expect(yearMentioned("～令和４年６月19日", 2022)).toBe(true);
    expect(yearMentioned("令和元年5月", 2019)).toBe(true);
    expect(yearMentioned("２０２４年度春季", 2024)).toBe(true);
    expect(yearMentioned("平成30年", 2018)).toBe(true);
    expect(yearMentioned("11月11日（水）から 2027福袋", 2020)).toBe(false);
    expect(yearMentioned("令和２年に発見", 2023)).toBe(false);
  });
  it("keeps an era year when re-normalising", () => {
    expect(normalizeValue("date", "2022-06-19", "2026-11-24", "～令和４年６月19日")).toEqual([{ date: "2022-06-19" }]);
  });
});
