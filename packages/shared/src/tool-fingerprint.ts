import { createHash } from 'node:crypto';

const STR_MAX = 240;
const ARR_MAX = 16;
const KEY_MAX = 32;
const DEPTH_MAX = 6;

/**
 * Bounded structural normalization for fingerprinting. Caps:
 * - strings to 240 chars (suffix '…' marker on truncation)
 * - arrays to 16 elements
 * - object keys to 32 (sorted lexicographically)
 * - depth to 6 (deeper levels collapse to null)
 *
 * Port of clawd-on-desk's normalizeToolMatchValue. The bounds keep the hash
 * stable on logically-equivalent payloads (object key order, long strings)
 * while preventing pathological inputs from doing unbounded work.
 */
export function normalizeToolInput(value: unknown, depth = 0): unknown {
  if (depth > DEPTH_MAX) return null;
  if (Array.isArray(value)) {
    return value.slice(0, ARR_MAX).map((entry) => normalizeToolInput(entry, depth + 1));
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    const keys = Object.keys(value as Record<string, unknown>).sort().slice(0, KEY_MAX);
    for (const key of keys) {
      out[key] = normalizeToolInput((value as Record<string, unknown>)[key], depth + 1);
    }
    return out;
  }
  if (typeof value === 'string') {
    return value.length > STR_MAX ? `${value.slice(0, STR_MAX - 1)}…` : value;
  }
  return value ?? null;
}

/** sha1 hex digest of the JSON-serialized normalized value. Always 40 hex chars. */
export function fingerprintToolInput(input: unknown): string {
  const norm = normalizeToolInput(input);
  return createHash('sha1').update(JSON.stringify(norm)).digest('hex');
}
