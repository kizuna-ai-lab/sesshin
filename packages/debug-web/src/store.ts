// packages/debug-web/src/store.ts
import { signal, computed } from '@preact/signals';
import type { SessionInfo, Summary, Event } from '@sesshin/shared';

export interface PendingPromptRequest {
  sessionId: string;
  requestId: string;
  origin: 'permission' | 'ask-user-question' | 'exit-plan-mode' | 'enter-plan-mode';
  toolName: string;
  toolUseId?: string;
  body?: string;
  questions: Array<{
    prompt: string;
    header?: string;
    multiSelect: boolean;
    allowFreeText: boolean;
    options: Array<{ key: string; label: string; description?: string; preview?: string; recommended?: boolean }>;
  }>;
  expiresAt: number;
}

export const sessions = signal<SessionInfo[]>([]);
export const selectedSessionId = signal<string | null>(null);
export const summariesBySession = signal<Record<string, Summary[]>>({});
export const eventsBySession = signal<Record<string, Event[]>>({});
export const rawBySession = signal<Record<string, string>>({});
export const promptRequestsBySession = signal<Record<string, PendingPromptRequest[]>>({});
export const connected = signal<boolean>(false);
export const lastEventId = signal<string | null>(null);

export const selectedSession = computed(() => sessions.value.find((s) => s.id === selectedSessionId.value) ?? null);

export function upsertSession(s: SessionInfo): void {
  const existing = sessions.value;
  const idx = existing.findIndex((x) => x.id === s.id);
  sessions.value = idx >= 0
    ? existing.map((x, i) => (i === idx ? s : x))
    : [...existing, s];
}
function deleteSessionKey<T>(
  store: ReturnType<typeof signal<Record<string, T>>>,
  id: string,
): void {
  if (!(id in store.value)) return;
  const next = { ...store.value };
  delete next[id];
  store.value = next;
}

export function removeSession(id: string): void {
  sessions.value = sessions.value.filter((s) => s.id !== id);
  // Clear session data from all keyed maps.
  // Prevents stale entries lingering after the agent exits / unregisters.
  deleteSessionKey(summariesBySession, id);
  deleteSessionKey(eventsBySession, id);
  deleteSessionKey(rawBySession, id);
  deleteSessionKey(promptRequestsBySession, id);
}

export function applyConfigChanged(sessionId: string, config: {
  pin: string | null;
  quietUntil: number | null;
  sessionGateOverride: 'disabled' | 'auto' | 'always' | null;
}): void {
  const cur = sessions.value.find((s) => s.id === sessionId);
  if (!cur) return;
  upsertSession({
    ...cur,
    pin: config.pin,
    quietUntil: config.quietUntil,
    sessionGateOverride: config.sessionGateOverride,
  });
}

export function applyChildSessionChanged(sessionId: string, claudeSessionId: string | null): void {
  const cur = sessions.value.find((s) => s.id === sessionId);
  if (!cur) return;
  upsertSession({
    ...cur,
    claudeSessionId,
  });
}

export function addSummary(s: Summary & { sessionId: string }): void {
  const cur = summariesBySession.value[s.sessionId] ?? [];
  summariesBySession.value = { ...summariesBySession.value, [s.sessionId]: [s as any, ...cur].slice(0, 50) };
}
export function addEvent(e: Event): void {
  const cur = eventsBySession.value[e.sessionId] ?? [];
  eventsBySession.value = { ...eventsBySession.value, [e.sessionId]: [e, ...cur].slice(0, 200) };
  lastEventId.value = e.eventId;
}

export function appendRaw(sessionId: string, data: string): void {
  const cur = rawBySession.value[sessionId] ?? '';
  // Keep last ~16 KiB per session to avoid unbounded memory.
  const next = (cur + data).slice(-16_384);
  rawBySession.value = { ...rawBySession.value, [sessionId]: next };
}

export function addPromptRequest(c: PendingPromptRequest): void {
  const cur = promptRequestsBySession.value[c.sessionId] ?? [];
  if (cur.some((x) => x.requestId === c.requestId)) return;
  promptRequestsBySession.value = { ...promptRequestsBySession.value, [c.sessionId]: [...cur, c] };
}
export function removePromptRequest(sessionId: string, requestId: string): void {
  const cur = promptRequestsBySession.value[sessionId] ?? [];
  const next = cur.filter((x) => x.requestId !== requestId);
  if (next.length === cur.length) return;
  promptRequestsBySession.value = { ...promptRequestsBySession.value, [sessionId]: next };
}
