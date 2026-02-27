import { DEFAULT_FEEDS } from "./constants";
import { getSources, upsertSource } from "./db";
import type { DbSource, SourceType } from "../types";

export async function seedDefaultSources(): Promise<void> {
  const existing = await getSources();
  if (existing.length > 0) return;

  for (const feed of DEFAULT_FEEDS) {
    const source: DbSource = {
      id: feed.id, name: feed.source, url: feed.url,
      type: feed.type as SourceType, category: feed.category,
      enabled: true, added_at: new Date().toISOString(),
    };
    await upsertSource(source);
  }
  console.log(`[db-seed] Inserted ${DEFAULT_FEEDS.length} default sources`);
}
