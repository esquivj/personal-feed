/**
 * db.ts — SQLite database layer using @tauri-apps/plugin-sql
 */

import Database from "@tauri-apps/plugin-sql";
import type {
  DbItem,
  DbSource,
  DbUserAction,
  ItemStatus,
  Category,
  TriageBucket,
} from "../types";

let dbInstance: Database | null = null;

export async function getDb(): Promise<Database> {
  if (!dbInstance) {
    dbInstance = await Database.load("sqlite:personal-feed.db");
  }
  return dbInstance;
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
  if (filters.sourceId) { conditions.push("i.source_id = ?"); params.push(filters.sourceId); }
  if (filters.category) { conditions.push("s.category = ?"); params.push(filters.category); }
  if (filters.minScore !== undefined) { conditions.push("i.score >= ?"); params.push(filters.minScore); }

  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const orderCol = filters.orderBy ?? "published_at";
  const orderDir = filters.orderDir ?? "DESC";
  const limit = filters.limit ?? 200;
  const offset = filters.offset ?? 0;

  const sql = `
    SELECT i.*, s.name AS source_name, s.category AS source_category
    FROM items i JOIN sources s ON s.id = i.source_id
    ${where}
    ORDER BY i.${orderCol} ${orderDir}
    LIMIT ? OFFSET ?`;
  params.push(limit, offset);
  return db.select<DbItem[]>(sql, params);
}

export async function upsertItem(
  item: Omit<DbItem, "id" | "fetched_at" | "source_name" | "source_category">
): Promise<void> {
  const db = await getDb();
  await db.execute(
    `INSERT INTO items (source_id, title, url, author, published_at, content_md, content_text, summary, score, status, acted_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
     ON CONFLICT(url) DO UPDATE SET
       title = excluded.title,
       content_md = excluded.content_md,
       content_text = excluded.content_text,
       summary = COALESCE(excluded.summary, items.summary),
       score = CASE WHEN excluded.score > items.score THEN excluded.score ELSE items.score END`,
    [item.source_id, item.title, item.url, item.author ?? null, item.published_at ?? null,
     item.content_md ?? null, item.content_text ?? null, item.summary ?? null,
     item.score ?? 0, item.status ?? "unread", item.acted_at ?? null]
  );
}

export async function updateItemStatus(url: string, status: ItemStatus): Promise<void> {
  const db = await getDb();
  await db.execute(`UPDATE items SET status = ?, acted_at = datetime('now') WHERE url = ?`, [status, url]);
}

export async function getSources(enabledOnly = false): Promise<DbSource[]> {
  const db = await getDb();
  const where = enabledOnly ? "WHERE enabled = 1" : "";
  return db.select<DbSource[]>(`SELECT * FROM sources ${where} ORDER BY category, name`);
}

export async function upsertSource(source: DbSource): Promise<void> {
  const db = await getDb();
  await db.execute(
    `INSERT INTO sources (id, name, url, type, category, enabled, added_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
     ON CONFLICT(id) DO UPDATE SET
       name = excluded.name, url = excluded.url, type = excluded.type,
       category = excluded.category, enabled = excluded.enabled`,
    [source.id, source.name, source.url, source.type, source.category,
     source.enabled ? 1 : 0, source.added_at ?? new Date().toISOString()]
  );
}

export async function logAction(
  itemId: number, action: DbUserAction["action"], metadata?: Record<string, unknown>
): Promise<void> {
  const db = await getDb();
  await db.execute(
    `INSERT INTO user_actions (item_id, action, metadata_json) VALUES (?, ?, ?)`,
    [itemId, action, metadata ? JSON.stringify(metadata) : null]
  );
}

const BUCKET_TO_STATUS: Record<TriageBucket, ItemStatus> = { inbox: "unread", later: "saved", archive: "read" };
const STATUS_TO_BUCKET: Partial<Record<ItemStatus, TriageBucket>> = { unread: "inbox", saved: "later", read: "archive" };

export function bucketToStatus(bucket: TriageBucket): ItemStatus { return BUCKET_TO_STATUS[bucket]; }
export function statusToBucket(status: ItemStatus): TriageBucket | null { return STATUS_TO_BUCKET[status] ?? null; }
