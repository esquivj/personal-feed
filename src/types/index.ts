export const CATEGORIES = ["Crypto", "Marketing", "Tech", "General"] as const;
export type Category = (typeof CATEGORIES)[number];

export interface FeedItem {
  title: string;
  link: string;
  pubDate: string;
  source: string;
  category: Category;
  summary: string;
}

export type FeedType = "rss" | "html";
export type FeedParserKey = "ournetwork" | "vitalik";

export interface FeedSourceDefinition {
  id: string;
  url: string;
  source: string;
  type: FeedType;
  category: Category;
  filter?: RegExp;
  parserKey?: FeedParserKey;
}

export interface FeedSource extends FeedSourceDefinition {
  enabled: boolean;
  builtIn: boolean;
}

export interface CustomFeedSource {
  id: string;
  url: string;
  source: string;
  category: Category;
  enabled: boolean;
  createdAt: string;
}

export interface AISummary {
  tldr: string;
  bullets: string[];
  loading: boolean;
  error?: string;
}

export interface FeedFetchIssue {
  feedId: string;
  source: string;
  category: Category;
  url: string;
  message: string;
}

export type SourceHealthStatus = "idle" | "healthy" | "error" | "disabled";

export interface SourceHealth {
  status: SourceHealthStatus;
  lastCheckedAt?: string;
  lastSuccessAt?: string;
  lastError?: string;
  failureCount: number;
  lastItemsCount: number;
  latencyMs?: number;
}

export interface SourceProfile {
  about: string;
  pulling: string;
  scrapedFrom: string;
  scrapedAt: string;
}

export type TriageBucket = "inbox" | "later" | "archive";
export type ReadingMode = "headline" | "expanded";

export interface ItemTriageState {
  bucket: TriageBucket;
  read: boolean;
  updatedAt: string;
}

export interface SavedSourceView {
  id: string;
  category: Category;
  source: string;
}

export interface ScrollIndicator {
  visible: boolean;
  top: number;
  height: number;
}

export interface FeedFetchResult {
  feedId: string;
  items: FeedItem[];
  issue?: FeedFetchIssue;
  latencyMs: number;
  checkedAt: string;
}

// DB-aligned types (SQLite migration)

export type SourceType = "rss" | "html" | "email";
export type ItemStatus = "unread" | "read" | "clipped" | "dismissed" | "saved";
export type UserActionType = "clip" | "dismiss" | "content_idea" | "save" | "read";

export interface DbSource {
  id: string;
  name: string;
  url: string;
  type: SourceType;
  category: Category;
  enabled: boolean;
  added_at: string;
}

export interface DbItem {
  id: number;
  source_id: string;
  title: string;
  url: string;
  author: string | null;
  published_at: string | null;
  fetched_at: string;
  content_md: string | null;
  content_text: string | null;
  summary: string | null;
  score: number;
  status: ItemStatus;
  acted_at: string | null;
  source_name?: string;
  source_category?: Category;
}

export interface DbInterestTag {
  id: number;
  name: string;
  weight: number;
  created_at: string;
  updated_at: string;
}

export interface DbUserAction {
  id: number;
  item_id: number;
  action: UserActionType;
  created_at: string;
  metadata_json: string | null;
}

export interface DbMetadata {
  key: string;
  value: string | null;
}

export interface DbItemUpsertInput {
  source_id: string;
  title: string;
  url: string;
  author?: string | null;
  published_at?: string | null;
  content_md?: string | null;
  content_text?: string | null;
  summary?: string | null;
  score?: number;
  status?: ItemStatus;
  acted_at?: string | null;
}

export interface DbSourceUpsertInput {
  id: string;
  name: string;
  url: string;
  type: SourceType;
  category: Category;
  enabled?: boolean;
  added_at?: string;
}
