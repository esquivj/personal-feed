/**
 * db.ts — SQLite database layer using @tauri-apps/plugin-sql
 */

import Database from "@tauri-apps/plugin-sql";
import type {
  Category,
  DbItem,
  DbItemUpsertInput,
  DbSource,
  DbSourceUpsertInput,
  ItemStatus,
  SourceType,
  TriageBucket,
  UserActionType,
} from "../types";
import { CATEGORIES } from "../types";

let dbInstance: Database | null = null;
let dbInitPromise: Promise<Database> | null = null;
let metadataReady = false;

const SOURCE_TYPES = ["rss", "html", "email"] as const;
const ITEM_STATUSES = ["unread", "read", "clipped", "dismissed", "saved"] as const;

interface DbItemRow {
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
  score: number | null;
  status: string;
  acted_at: string | null;
  source_name?: string | null;
  source_category?: string | null;
}

interface DbSourceRow {
  id: string;
  name: string;
  url: string;
  type: string;
  category: string;
  enabled: number | boolean;
  added_at: string;
}

interface DbMetadataRow {
  value: string | null;
}

export type UpsertItemInput = DbItemUpsertInput;
export type UpsertSourceInput = DbSourceUpsertInput;

function parseCategory(value: string): Category {
  if ((CATEGORIES as readonly string[]).includes(value)) {
    return value as Category;
  }
  return "General";
}

function parseSourceType(value: string): SourceType {
  if ((SOURCE_TYPES as readonly string[]).includes(value)) {
    return value as SourceType;
  }
  return "rss";
}

function parseItemStatus(value: string): ItemStatus {
  if ((ITEM_STATUSES as readonly string[]).includes(value)) {
    return value as ItemStatus;
  }
  return "unread";
}

function mapDbItem(row: DbItemRow): DbItem {
  return {
    id: Number(row.id),
    source_id: row.source_id,
    title: row.title,
    url: row.url,
    author: row.author,
    published_at: row.published_at,
    fetched_at: row.fetched_at,
    content_md: row.content_md,
    content_text: row.content_text,
    summary: row.summary,
    score: typeof row.score === "number" ? row.score : 0,
    status: parseItemStatus(row.status),
    acted_at: row.acted_at,
    source_name: row.source_name ?? undefined,
    source_category: row.source_category ? parseCategory(row.source_category) : undefined,
  };
}

function mapDbSource(row: DbSourceRow): DbSource {
  return {
    id: row.id,
    name: row.name,
    url: row.url,
    type: parseSourceType(row.type),
    category: parseCategory(row.category),
    enabled: typeof row.enabled === "boolean" ? row.enabled : Number(row.enabled) === 1,
    added_at: row.added_at,
  };
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return "Unknown database error";
}

export async function getDb(): Promise<Database> {
  if (dbInstance) {
    return dbInstance;
  }

  if (!dbInitPromise) {
    dbInitPromise = (async () => {
      const db = await Database.load("sqlite:personal-feed.db");
      await db.execute("PRAGMA foreign_keys = ON");
      dbInstance = db;
      return db;
    })();
  }

  return dbInitPromise;
}

async function ensureMetadataTable(): Promise<void> {
  if (metadataReady) return;

  const db = await getDb();
  await db.execute(
    `CREATE TABLE IF NOT EXISTS metadata (
      key TEXT PRIMARY KEY,
      value TEXT
    )`
  );
  metadataReady = true;
}

export interface ItemFilters {
  status?: ItemStatus | ItemStatus[];
  sourceId?: string;
  category?: Category;
  minScore?: number;
  limit?: number;
  offset?: number;
  orderBy?: "published_at" | "fetched_at" | "score";
  orderDir?: "ASC" | "DESC";
}

export async function getItems(filters: ItemFilters = {}): Promise<DbItem[]> {
  const db = await getDb();
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (filters.status) {
    const statuses = Array.isArray(filters.status) ? filters.status : [filters.status];
    conditions.push(`i.status IN (${statuses.map(() => "?").join(", ")})`);
    params.push(...statuses);
  }
  if (filters.sourceId) {
    conditions.push("i.source_id = ?");
    params.push(filters.sourceId);
  }
  if (filters.category) {
    conditions.push("s.category = ?");
    params.push(filters.category);
  }
  if (filters.minScore !== undefined) {
    conditions.push("i.score >= ?");
    params.push(filters.minScore);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const orderCol = filters.orderBy ?? "published_at";
  const orderDir = filters.orderDir ?? "DESC";
  const orderExpr =
    orderCol === "published_at" ? "COALESCE(i.published_at, i.fetched_at)" : `i.${orderCol}`;
  const limit = filters.limit ?? 200;
  const offset = filters.offset ?? 0;

  const sql = `
    SELECT i.*, s.name AS source_name, s.category AS source_category
    FROM items i JOIN sources s ON s.id = i.source_id
    ${where}
    ORDER BY ${orderExpr} ${orderDir}
    LIMIT ? OFFSET ?`;

  params.push(limit, offset);
  const rows = await db.select<DbItemRow[]>(sql, params);
  return rows.map(mapDbItem);
}

export async function upsertItem(item: UpsertItemInput): Promise<void> {
  const db = await getDb();

  if (!item.source_id.trim()) throw new Error("upsertItem requires source_id");
  if (!item.url.trim()) throw new Error("upsertItem requires url");
  if (!item.title.trim()) throw new Error("upsertItem requires title");

  try {
    await db.execute(
      `INSERT INTO items (source_id, title, url, author, published_at, content_md, content_text, summary, score, status, acted_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
       ON CONFLICT(url) DO UPDATE SET
         source_id = excluded.source_id,
         title = excluded.title,
         author = COALESCE(excluded.author, items.author),
         published_at = COALESCE(excluded.published_at, items.published_at),
         content_md = COALESCE(excluded.content_md, items.content_md),
         content_text = COALESCE(excluded.content_text, items.content_text),
         summary = COALESCE(excluded.summary, items.summary),
         score = CASE WHEN excluded.score > items.score THEN excluded.score ELSE items.score END,
         fetched_at = datetime('now')`,
      [
        item.source_id,
        item.title,
        item.url,
        item.author ?? null,
        item.published_at ?? null,
        item.content_md ?? null,
        item.content_text ?? null,
        item.summary ?? null,
        item.score ?? 0,
        item.status ?? "unread",
        item.acted_at ?? null,
      ]
    );
  } catch (error: unknown) {
    throw new Error(`Failed to upsert item "${item.url}": ${getErrorMessage(error)}`);
  }
}

export async function updateItemStatus(url: string, status: ItemStatus): Promise<void> {
  const db = await getDb();
  const result = await db.execute(
    `UPDATE items SET status = ?, acted_at = datetime('now') WHERE url = ?`,
    [status, url]
  );

  if (result.rowsAffected === 0) {
    throw new Error(`No item found for url "${url}"`);
  }
}

export async function getSources(enabledOnly = false): Promise<DbSource[]> {
  const db = await getDb();
  const where = enabledOnly ? "WHERE enabled = 1" : "";
  const rows = await db.select<DbSourceRow[]>(`SELECT * FROM sources ${where} ORDER BY category, name`);
  return rows.map(mapDbSource);
}

export async function upsertSource(source: UpsertSourceInput): Promise<void> {
  const db = await getDb();

  if (!source.id.trim()) throw new Error("upsertSource requires id");
  if (!source.url.trim()) throw new Error("upsertSource requires url");
  if (!source.name.trim()) throw new Error("upsertSource requires name");

  try {
    await db.execute(
      `INSERT INTO sources (id, name, url, type, category, enabled, added_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name,
         url = excluded.url,
         type = excluded.type,
         category = excluded.category,
         enabled = excluded.enabled`,
      [
        source.id,
        source.name,
        source.url,
        source.type,
        source.category,
        source.enabled === false ? 0 : 1,
        source.added_at ?? new Date().toISOString(),
      ]
    );
  } catch (error: unknown) {
    throw new Error(`Failed to upsert source "${source.id}": ${getErrorMessage(error)}`);
  }
}

export async function logAction(
  itemId: number,
  action: UserActionType,
  metadata?: Record<string, unknown>
): Promise<void> {
  const db = await getDb();
  await db.execute(`INSERT INTO user_actions (item_id, action, metadata_json) VALUES (?, ?, ?)`, [
    itemId,
    action,
    metadata ? JSON.stringify(metadata) : null,
  ]);
}

export async function getMetadataValue(key: string): Promise<string | null> {
  if (!key.trim()) throw new Error("getMetadataValue requires key");

  await ensureMetadataTable();
  const db = await getDb();
  const rows = await db.select<DbMetadataRow[]>(`SELECT value FROM metadata WHERE key = ? LIMIT 1`, [
    key,
  ]);
  return rows[0]?.value ?? null;
}

export async function setMetadataValue(key: string, value: string): Promise<void> {
  if (!key.trim()) throw new Error("setMetadataValue requires key");

  await ensureMetadataTable();
  const db = await getDb();
  await db.execute(
    `INSERT INTO metadata (key, value) VALUES (?1, ?2)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    [key, value]
  );
}

const BUCKET_TO_STATUS: Record<TriageBucket, ItemStatus> = {
  inbox: "unread",
  later: "saved",
  archive: "read",
};

const STATUS_TO_BUCKET: Partial<Record<ItemStatus, TriageBucket>> = {
  unread: "inbox",
  saved: "later",
  read: "archive",
};

export function bucketToStatus(bucket: TriageBucket): ItemStatus {
  return BUCKET_TO_STATUS[bucket];
}

export function statusToBucket(status: ItemStatus): TriageBucket | null {
  return STATUS_TO_BUCKET[status] ?? null;
}
