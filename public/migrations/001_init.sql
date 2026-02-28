-- 001_init.sql — Initial schema for personal-feed SQLite backend

-- Sources: RSS, HTML, or email feeds we pull from
CREATE TABLE IF NOT EXISTS sources (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'rss' CHECK (type IN ('rss', 'html', 'email')),
  category TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  added_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Items: individual feed entries
CREATE TABLE IF NOT EXISTS items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  url TEXT NOT NULL UNIQUE,
  author TEXT,
  published_at TEXT,
  fetched_at TEXT NOT NULL DEFAULT (datetime('now')),
  content_md TEXT,
  content_text TEXT,
  summary TEXT,
  score REAL DEFAULT 0.0,
  status TEXT NOT NULL DEFAULT 'unread' CHECK (status IN ('unread', 'read', 'clipped', 'dismissed', 'saved')),
  acted_at TEXT
);

-- Interest tags for future scoring
CREATE TABLE IF NOT EXISTS interest_tags (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  weight REAL NOT NULL DEFAULT 0.5,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Item-tag associations
CREATE TABLE IF NOT EXISTS item_tags (
  item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  tag_id INTEGER NOT NULL REFERENCES interest_tags(id) ON DELETE CASCADE,
  match_score REAL DEFAULT 0.0,
  PRIMARY KEY (item_id, tag_id)
);

-- User actions log
CREATE TABLE IF NOT EXISTS user_actions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  action TEXT NOT NULL CHECK (action IN ('clip', 'dismiss', 'content_idea', 'save', 'read')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  metadata_json TEXT
);

-- App metadata key/value store (sync cursors, version flags, etc.)
CREATE TABLE IF NOT EXISTS metadata (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE INDEX IF NOT EXISTS idx_items_status ON items(status);
CREATE INDEX IF NOT EXISTS idx_items_source ON items(source_id);
CREATE INDEX IF NOT EXISTS idx_items_published ON items(published_at DESC);
CREATE INDEX IF NOT EXISTS idx_items_score ON items(score DESC);
