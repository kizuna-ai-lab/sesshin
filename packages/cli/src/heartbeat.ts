// packages/cli/src/heartbeat.ts
export function startHeartbeat(opts: { hubUrl: string; sessionId: string; intervalMs?: number }): () => void {
  const intervalMs = opts.intervalMs ?? 10_000;
  const tick = (): void => {
    void fetch(`${opts.hubUrl}/api/sessions/${opts.sessionId}/heartbeat`, { method: 'POST' }).catch(() => {});
  };
  tick();
  const handle = setInterval(tick, intervalMs);
  return () => clearInterval(handle);
}
