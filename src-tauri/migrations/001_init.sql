-- 001_init.sql — Initial schema for personal-feed SQLite backend

-- Sources: RSS, HTML, or email feeds we pull from
CREATE TABLE sources (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'rss',  -- rss | html | email
  category TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  added_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Items: individual feed entries
CREATE TABLE items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id TEXT NOT NULL REFERENCES sources(id),
  title TEXT NOT NULL,
  url TEXT NOT NULL UNIQUE,
  author TEXT,
  published_at TEXT,
  fetched_at TEXT NOT NULL DEFAULT (datetime('now')),
  content_md TEXT,
  content_text TEXT,
  summary TEXT,
  score REAL DEFAULT 0.0,
  status TEXT NOT NULL DEFAULT 'unread',  -- unread | read | clipped | dismissed | saved
  acted_at TEXT
);

-- Interest tags for future scoring
CREATE TABLE interest_tags (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  weight REAL NOT NULL DEFAULT 0.5,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Item-tag associations
CREATE TABLE item_tags (
  item_id INTEGER NOT NULL REFERENCES items(id),
  tag_id INTEGER NOT NULL REFERENCES interest_tags(id),
  match_score REAL DEFAULT 0.0,
  PRIMARY KEY (item_id, tag_id)
);

-- User actions log
CREATE TABLE user_actions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id INTEGER NOT NULL REFERENCES items(id),
  action TEXT NOT NULL,  -- clip | dismiss | content_idea | save | read
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  metadata_json TEXT
);

CREATE INDEX idx_items_status ON items(status);
CREATE INDEX idx_items_source ON items(source_id);
CREATE INDEX idx_items_published ON items(published_at DESC);
CREATE INDEX idx_items_score ON items(score DESC);
