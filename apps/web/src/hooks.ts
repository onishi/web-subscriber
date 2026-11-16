import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./api.js";

export function useApi<T>(path: string | null, opts: { pollMs?: number; until?: (d: T) => boolean } = {}) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const optsRef = useRef(opts);
  optsRef.current = opts;
  const load = useCallback(async () => {
    if (!path) return;
    setLoading(true);
    try {
      const d = await api<T>(path);
      setData(d);
      setError(null);
      return d;
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [path]);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let stop = false;
    const tick = async () => {
      const d = await load();
      const o = optsRef.current;
      if (!stop && o.pollMs && !(d && o.until?.(d))) timer = setTimeout(tick, o.pollMs);
    };
    void tick();
    return () => {
      stop = true;
      if (timer) clearTimeout(timer);
    };
  }, [load]);
  return { data, error, loading, reload: load, setData };
}
