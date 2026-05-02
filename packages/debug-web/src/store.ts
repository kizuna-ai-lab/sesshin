// packages/debug-web/src/store.ts
import { signal, computed } from '@preact/signals';
import type { SessionInfo, Summary, Event } from '@sesshin/shared';

export const sessions = signal<SessionInfo[]>([]);
export const selectedSessionId = signal<string | null>(null);
export const summariesBySession = signal<Record<string, Summary[]>>({});
export const eventsBySession = signal<Record<string, Event[]>>({});
export const rawBySession = signal<Record<string, string>>({});
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
export function removeSession(id: string): void { sessions.value = sessions.value.filter((s) => s.id !== id); }

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
