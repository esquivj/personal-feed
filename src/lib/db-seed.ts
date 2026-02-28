import { DEFAULT_FEEDS } from "./constants";
import { getSources, upsertSource } from "./db";
import type { DbSource } from "../types";

export async function seedDefaultSources(): Promise<void> {
  const existing = await getSources();
  const existingById = new Set(existing.map((source) => source.id));
  const now = new Date().toISOString();
  let insertedCount = 0;

  for (const feed of DEFAULT_FEEDS) {
    if (existingById.has(feed.id)) {
      continue;
    }

    const source: DbSource = {
      id: feed.id, name: feed.source, url: feed.url,
      type: feed.type, category: feed.category,
      enabled: true, added_at: now,
    };
    await upsertSource(source);
    insertedCount += 1;
  }

  if (insertedCount > 0) {
    console.log(`[db-seed] Inserted ${insertedCount} default source(s)`);
  }
}
