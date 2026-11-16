import { describe, it, expect } from "vitest";
import { normalizeDate, normalizeValue, buildFieldQuery, itemText, type SetField } from "../src/fields.js";

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
});
