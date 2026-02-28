import type { Category, ItemStatus, SourceType } from "../types";
import {
  getSources,
  getMetadataValue,
  setMetadataValue,
  upsertItem,
  upsertSource,
  type UpsertItemInput,
  type UpsertSourceInput,
} from "./db";

const VPS_FEED_ENDPOINT = "http://localhost:18800/feed/items";
export const LAST_SYNC_METADATA_KEY = "sync.last_success_at";

const CATEGORY_VALUES: readonly Category[] = ["Crypto", "Marketing", "Tech", "General"];
const STATUS_VALUES: readonly ItemStatus[] = ["unread", "read", "clipped", "dismissed", "saved"];
const SOURCE_TYPE_VALUES: readonly SourceType[] = ["rss", "html", "email"];

interface SyncCandidate {
  item: UpsertItemInput;
  source: UpsertSourceInput;
  cursor: string | null;
}

export interface SyncResult {
  lastSync: string;
  previousSync: string | null;
  itemCount: number;
  skippedCount: number;
}

interface FetchEnvelope {
  items?: unknown;
  data?: unknown;
}

function toStringValue(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function parseCategory(value: unknown): Category {
  const candidate = toStringValue(value);
  if (candidate && CATEGORY_VALUES.includes(candidate as Category)) {
    return candidate as Category;
  }
  return "General";
}

function parseStatus(value: unknown): ItemStatus {
  const candidate = toStringValue(value);
  if (candidate && STATUS_VALUES.includes(candidate as ItemStatus)) {
    return candidate as ItemStatus;
  }
  return "unread";
}

function parseSourceType(value: unknown): SourceType {
  const candidate = toStringValue(value);
  if (candidate && SOURCE_TYPE_VALUES.includes(candidate as SourceType)) {
    return candidate as SourceType;
  }
  return "rss";
}

function parseNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function toIsoTimestamp(value: unknown): string | null {
  const candidate = toStringValue(value);
  if (!candidate) return null;
  const parsed = new Date(candidate);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString();
}

function normalizeUrl(value: unknown): string | null {
  const candidate = toStringValue(value);
  if (!candidate) return null;

  try {
    return new URL(candidate).toString();
  } catch {
    return null;
  }
}

function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
    .slice(0, 80);
  return slug.length > 0 ? slug : "unknown-source";
}

function deriveSourceId(sourceName: string | null, sourceUrl: string | null): string | null {
  if (sourceName) return slugify(sourceName);
  if (!sourceUrl) return null;

  try {
    return slugify(new URL(sourceUrl).hostname);
  } catch {
    return null;
  }
}

function getObjectValue(record: Record<string, unknown>, ...keys: string[]): unknown {
  for (const key of keys) {
    if (key in record) return record[key];
  }
  return undefined;
}

function normalizeSyncCandidate(raw: unknown): SyncCandidate | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;

  const title = toStringValue(getObjectValue(record, "title"));
  const url = normalizeUrl(getObjectValue(record, "url", "link"));

  if (!title || !url) return null;

  const sourceName = toStringValue(getObjectValue(record, "source_name", "sourceName", "source"));
  const sourceUrl = normalizeUrl(getObjectValue(record, "source_url", "sourceUrl"));
  const sourceId =
    toStringValue(getObjectValue(record, "source_id", "sourceId")) ??
    deriveSourceId(sourceName, sourceUrl);

  if (!sourceId) return null;

  const category = parseCategory(getObjectValue(record, "category"));
  const sourceType = parseSourceType(getObjectValue(record, "source_type", "sourceType", "type"));
  const publishedAt = toIsoTimestamp(getObjectValue(record, "published_at", "publishedAt", "pubDate"));

  const item: UpsertItemInput = {
    source_id: sourceId,
    title,
    url,
    author: toStringValue(getObjectValue(record, "author")),
    published_at: publishedAt,
    content_md: toStringValue(getObjectValue(record, "content_md", "contentMd")),
    content_text: toStringValue(getObjectValue(record, "content_text", "contentText")),
    summary: toStringValue(getObjectValue(record, "summary")),
    score: parseNumber(getObjectValue(record, "score")) ?? 0,
    status: parseStatus(getObjectValue(record, "status")),
    acted_at: toIsoTimestamp(getObjectValue(record, "acted_at", "actedAt")),
  };

  const source: UpsertSourceInput = {
    id: sourceId,
    name: sourceName ?? sourceId,
    url: sourceUrl ?? url,
    type: sourceType,
    category,
    enabled: true,
  };

  const cursor =
    toIsoTimestamp(getObjectValue(record, "updated_at", "updatedAt")) ??
    toIsoTimestamp(getObjectValue(record, "fetched_at", "fetchedAt")) ??
    publishedAt;

  return { item, source, cursor };
}

function extractPayloadItems(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== "object") return [];
  const envelope = payload as FetchEnvelope;
  if (Array.isArray(envelope.items)) return envelope.items;
  if (Array.isArray(envelope.data)) return envelope.data;
  if (envelope.data && typeof envelope.data === "object") {
    const nested = envelope.data as FetchEnvelope;
    if (Array.isArray(nested.items)) return nested.items;
  }
  return [];
}

async function getFetchImpl(): Promise<typeof fetch> {
  if (typeof window !== "undefined" && "__TAURI_INTERNALS__" in window) {
    const tauriHttp = await import("@tauri-apps/plugin-http");
    return tauriHttp.fetch;
  }
  return fetch;
}

export async function syncFromVps(): Promise<SyncResult> {
  const previousSync = await getMetadataValue(LAST_SYNC_METADATA_KEY);
  const fetchImpl = await getFetchImpl();
  const requestUrl = `${VPS_FEED_ENDPOINT}?since=${encodeURIComponent(previousSync ?? "")}`;

  const response = await fetchImpl(requestUrl, {
    method: "GET",
    headers: {
      Accept: "application/json",
    },
  });

  if (!response.ok) {
    const details = await response.text();
    throw new Error(`Sync request failed (${response.status}): ${details}`);
  }

  const payload: unknown = await response.json();
  const rawItems = extractPayloadItems(payload);

  const candidates = rawItems
    .map(normalizeSyncCandidate)
    .filter((candidate): candidate is SyncCandidate => candidate !== null);

  const existingSources = await getSources();
  const existingSourceById = new Map(existingSources.map((source) => [source.id, source]));
  const sourcesById = new Map<string, UpsertSourceInput>();
  for (const candidate of candidates) {
    sourcesById.set(candidate.source.id, candidate.source);
  }

  for (const source of sourcesById.values()) {
    const existingSource = existingSourceById.get(source.id);
    await upsertSource({
      ...source,
      enabled: existingSource?.enabled ?? source.enabled,
      added_at: existingSource?.added_at ?? source.added_at,
    });
  }

  let cursor: string | null = null;
  let upsertedCount = 0;

  for (const candidate of candidates) {
    await upsertItem(candidate.item);
    upsertedCount += 1;

    if (candidate.cursor && (!cursor || candidate.cursor > cursor)) {
      cursor = candidate.cursor;
    }
  }

  const lastSync = cursor ?? new Date().toISOString();
  await setMetadataValue(LAST_SYNC_METADATA_KEY, lastSync);

  return {
    lastSync,
    previousSync,
    itemCount: upsertedCount,
    skippedCount: rawItems.length - candidates.length,
  };
}
