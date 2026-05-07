import type Database from 'better-sqlite3';

export const SCHEMA_V1 = `
CREATE TABLE IF NOT EXISTS sessions (
  id                TEXT PRIMARY KEY,
  name              TEXT NOT NULL,
  agent             TEXT NOT NULL,
  cwd               TEXT NOT NULL,
  pid               INTEGER,
  session_file_path TEXT,
  started_at        INTEGER NOT NULL,
  ended_at          INTEGER,
  end_reason        TEXT,
  last_state        TEXT NOT NULL,
  claude_session_id TEXT,
  hidden            INTEGER NOT NULL DEFAULT 0,
  metadata          TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_sessions_started_at ON sessions(started_at DESC);
CREATE INDEX IF NOT EXISTS idx_sessions_state      ON sessions(last_state);

CREATE TABLE IF NOT EXISTS messages (
  id                  TEXT PRIMARY KEY,
  session_id          TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  sender_type         TEXT NOT NULL,
  content             TEXT NOT NULL,
  format              TEXT NOT NULL DEFAULT 'text',
  requires_user_input INTEGER NOT NULL DEFAULT 0,
  created_at          INTEGER NOT NULL,
  source_event_ids    TEXT
);
CREATE INDEX IF NOT EXISTS idx_messages_session_created ON messages(session_id, created_at);

CREATE TABLE IF NOT EXISTS actions (
  id           TEXT PRIMARY KEY,
  session_id   TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  kind         TEXT NOT NULL,
  payload      TEXT,
  performed_by TEXT,
  created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_actions_session_created ON actions(session_id, created_at);
`;

export function runMigrations(raw: Database.Database): void {
  const current = raw.pragma('user_version', { simple: true }) as number;
  if (current === 0) {
    raw.exec(SCHEMA_V1);
    raw.pragma('user_version = 1');
  }
  // Future migrations: if (current < 2) { ... pragma user_version = 2 }
}
