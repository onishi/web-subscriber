import { useEffect, useState } from "react";
import { isTypingTarget } from "./pages/Items.js";

const KEYS: [string, string][] = [
  ["j / k", "次 / 前の情報（読み進めたものは既読に）"],
  ["o / Enter", "詳細を開く・閉じる（開いたまま j / k で次々に読める）"],
  ["v", "元のページを新しいタブで開く"],
  ["m", "既読 / 未読を切り替える"],
  ["g / G", "先頭 / 最後へ"],
  ["u", "未読のみ表示を切り替える"],
  ["d", "表示を切り替える（詳しく / 1行）"],
  ["r", "読み込み直す"],
  ["Shift + A", "この一覧をすべて既読にする"],
  ["[ / ]", "前 / 次のセットへ（新着のページ）"],
  ["1 〜 9", "N 番目のタブへ（1 は すべて）"],
  ["Esc", "詳細やこのヘルプを閉じる"],
  ["?", "このヘルプ"],
];

/** ? でショートカットの一覧を出す */
export function KeyboardHelp() {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
      else if (e.key === "?" && !isTypingTarget(e)) {
        e.preventDefault();
        setOpen((x) => !x);
      }
    };
    const onShow = () => setOpen(true);
    window.addEventListener("keydown", onKey);
    window.addEventListener("ws-help", onShow);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("ws-help", onShow);
    };
  }, []);
  if (!open) return null;
  return (
    <div className="help-backdrop" onClick={() => setOpen(false)}>
      <div className="help panel" role="dialog" aria-modal="true" aria-label="キーボードショートカット" onClick={(e) => e.stopPropagation()}>
        <div className="row">
          <h3 style={{ margin: 0 }}>キーボードショートカット</h3>
          <span className="spacer" />
          <button className="link" onClick={() => setOpen(false)} aria-label="閉じる">
            ✕
          </button>
        </div>
        <table className="small">
          <tbody>
            {KEYS.map(([k, d]) => (
              <tr key={k}>
                <td className="nowrap">
                  {k.split(" / ").map((x, i) => (
                    <span key={x}>
                      {i > 0 && " / "}
                      <kbd>{x}</kbd>
                    </span>
                  ))}
                </td>
                <td>{d}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
