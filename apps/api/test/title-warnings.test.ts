import { describe, expect, it } from "vitest";
import { titleWarnings } from "../src/ai/quality";

describe("titleWarnings", () => {
  it("flags generic link text", () => {
    const w = titleWarnings([{ title: "Read More" }, { title: "ジュエリーは、誰を夢みる" }, { title: "詳しく見る →" }]);
    expect(w).toHaveLength(1);
    expect(w[0]).toContain("2/3");
  });
  it("flags repeated titles and long titles", () => {
    expect(titleWarnings([{ title: "お知らせ" }, { title: "お知らせ" }, { title: "別" }])[0]).toContain("同じ");
    expect(titleWarnings([{ title: "あ".repeat(120) }])[0]).toContain("100字");
  });
  it("accepts normal titles", () => {
    expect(titleWarnings([{ title: "禅とジブリ" }, { title: "モネ展" }, { title: "More Than Words 展" }])).toEqual([]);
  });
});
