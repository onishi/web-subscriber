import { describe, it, expect } from "vitest";
import { normalizePublicOptions } from "../src/public.js";
import type { SetField } from "../src/fields.js";

const F = (key: string, type: SetField["type"]): SetField => ({ id: `id_${key}`, set_id: "s", key, label: key, type, description: "", position: 0 });
const fields = [F("start_date", "date"), F("end_date", "date"), F("tags", "list")];

describe("normalizePublicOptions: sections", () => {
  it("builds 開催中 / これから from the old period setting", () => {
    const o = normalizePublicOptions({ period: { start: "start_date", end: "end_date" }, default_tab: "upcoming" }, fields);
    expect(o.sections.map((s) => [s.id, s.label, s.tab])).toEqual([
      ["now", "開催中", true],
      ["upcoming", "これから", true],
    ]);
    expect(o.sections[0].conditions).toEqual([
      { key: "f:start_date", op: "until_today" },
      { key: "f:end_date", op: "future" },
    ]);
    expect(o.all_tab).toBe(true);
    expect(o.default_tab).toBe("upcoming");
    expect(o.sort.now).toEqual({ key: "period_end", dir: "asc" });
    expect(o.sort.all).toEqual({ key: "published", dir: "desc" });
  });
  it("validates sections and conditions", () => {
    const o = normalizePublicOptions(
      {
        sections: [
          { id: "soon", label: " まもなく終了 ", conditions: [{ key: "f:end_date", op: "next_days", value: "7.4" as unknown as number }, { key: "f:nope", op: "future" }], tab: false, badge: true, hidden: false },
          { id: "soon", label: "重複", conditions: [], tab: true, badge: false, hidden: false },
          { id: "all", label: "予約語", conditions: [], tab: true, badge: false, hidden: false },
          { id: "ended", label: "終了", conditions: [{ key: "f:end_date", op: "past" }], tab: true, badge: true, hidden: true },
          { id: "x", label: "", conditions: [], tab: true, badge: false, hidden: false },
        ],
        all_tab: false,
        default_tab: "ended",
      },
      fields,
    );
    expect(o.sections).toEqual([
      { id: "soon", label: "まもなく終了", conditions: [{ key: "f:end_date", op: "next_days", value: 7 }], tab: false, badge: true, hidden: false },
      // 非表示の区分はタブ・バッジにしない
      { id: "ended", label: "終了", conditions: [{ key: "f:end_date", op: "past" }], tab: false, badge: false, hidden: true },
    ]);
    // タブにする区分がなければ「すべて」だけ
    expect(o.all_tab).toBe(true);
    expect(o.default_tab).toBe("all");
  });
  it("drops day conditions without a number and ops of the wrong kind", () => {
    const o = normalizePublicOptions({ filters: [{ key: "published", op: "last_days" }, { key: "f:tags", op: "future" }, { key: "published", op: "until_today" }] }, fields);
    expect(o.filters).toEqual([{ key: "published", op: "until_today" }]);
  });
  it("keeps per-section sort when grouping by section", () => {
    const o = normalizePublicOptions(
      {
        sections: [
          { id: "now", label: "開催中", conditions: [{ key: "f:end_date", op: "future" }], tab: false, badge: false, hidden: false },
          { id: "ended", label: "終了", conditions: [], tab: false, badge: false, hidden: true },
        ],
        group_sections: true,
        sort: { now: { key: "f:end_date", dir: "asc" }, ended: { key: "title", dir: "asc" } },
      },
      fields,
    );
    expect(o.group_sections).toBe(true);
    expect(o.sort.now).toEqual({ key: "f:end_date", dir: "asc" });
    expect(o.sort.ended).toBeUndefined();
    expect(o.sort.all).toEqual({ key: "published", dir: "desc" });
  });
  it("picks the calendar date key", () => {
    expect(normalizePublicOptions({ layout: "calendar" }, fields).calendar_key).toBe("published");
    expect(normalizePublicOptions({ layout: "calendar", period: { start: "start_date", end: "end_date" } }, fields).calendar_key).toBe("f:start_date");
    expect(normalizePublicOptions({ layout: "calendar", calendar_key: "f:end_date" }, fields).calendar_key).toBe("f:end_date");
    // 日付でないフィールドは使えない
    expect(normalizePublicOptions({ layout: "calendar", calendar_key: "f:tags" }, fields).calendar_key).toBe("published");
  });
});
