import type { Env } from "./env.js";
import { nowIso } from "./env.js";
import type { CompleteHooks } from "./ingest.js";
import type { SubRow } from "./jobs.js";
import { startSession, addProgress } from "./ai/setup.js";

/** プローブ完了を、待っている Workflow に通知 */
export async function notifyProbe(env: Env, probeId: string) {
  const p = await env.DB.prepare("SELECT session_id FROM probes WHERE id = ?").bind(probeId).first<{ session_id: string | null }>();
  if (!p?.session_id || p.session_id.startsWith("cv:")) return;
  try {
    const inst = await env.SETUP_WORKFLOW.get(p.session_id);
    await inst.sendEvent({ type: `probe-${probeId}`, payload: { probeId } });
  } catch (e) {
    console.warn("sendEvent failed", probeId, String(e));
  }
}

export async function markProbeFailed(env: Env, probeId: string, err: string) {
  await env.DB.prepare("UPDATE probes SET status = 'error', error = ?, finished_at = ? WHERE id = ? AND status NOT IN ('ok','error')").bind(err, nowIso(), probeId).run();
  await notifyProbe(env, probeId);
}

export function completeHooks(env: Env): CompleteHooks {
  return {
    // 抽出の連続失敗：修正提案を自動作成（稼働中の設定は変えない。draft として提示）
    async onExtractFailure(sub: SubRow, runId: string) {
      const running = await env.DB.prepare("SELECT id FROM setup_sessions WHERE subscription_id = ? AND status = 'running'").bind(sub.id).first();
      if (running) return;
      const recent = await env.DB.prepare("SELECT id FROM setup_sessions WHERE subscription_id = ? AND kind = 'repair' AND created_at > ?")
        .bind(sub.id, new Date(Date.now() - 20 * 3600_000).toISOString())
        .first();
      if (recent) return;
      const cv = await env.DB.prepare("SELECT json_extract(config_json, '$.source.url') AS url FROM config_versions WHERE id = ?").bind(sub.active_config_version_id).first<{ url: string }>();
      const sid = await startSession(env, sub.id, "repair", cv?.url ?? sub.input_url, runId);
      await addProgress(env, sid, "trigger", "info", `抽出が ${sub.consecutive_extract_failures} 回連続で失敗したため自動で修正案を作成します`);
    },
  };
}
