PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL,
  username_key TEXT NOT NULL UNIQUE,
  password_salt TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  password_iterations INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  remember INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS sessions_user_id_idx ON sessions(user_id);
CREATE INDEX IF NOT EXISTS sessions_expires_at_idx ON sessions(expires_at);

CREATE TABLE IF NOT EXISTS auth_attempts (
  attempt_key TEXT PRIMARY KEY,
  attempt_count INTEGER NOT NULL,
  first_at INTEGER NOT NULL,
  blocked_until INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS assets (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('reference', 'target')),
  name TEXT NOT NULL,
  content_type TEXT NOT NULL,
  size INTEGER NOT NULL,
  object_key TEXT NOT NULL UNIQUE,
  metadata_json TEXT,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS assets_user_created_idx ON assets(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS styles (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  serialized TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS styles_user_updated_idx ON styles(user_id, updated_at DESC);
