"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { getItems, type ItemFilters } from "../lib/db";
import { CATEGORIES, type Category, type DbItem, type FeedItem } from "../types";

const CATEGORY_SET = new Set<string>(CATEGORIES);

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return "Failed to load items from local database";
}

function normalizeCategory(value: Category | string | undefined): Category {
  if (value && CATEGORY_SET.has(value)) {
    return value as Category;
  }
  return "General";
}

function mapDbItemToFeedItem(item: DbItem): FeedItem {
  return {
    title: item.title,
    link: item.url,
    pubDate: item.published_at ?? item.fetched_at,
    source: item.source_name ?? item.source_id,
    category: normalizeCategory(item.source_category),
    summary: item.summary ?? item.content_text ?? item.content_md ?? "",
  };
}

export interface UseDbItemsResult {
  items: FeedItem[];
  loading: boolean;
  error: string | null;
  lastUpdated: Date | null;
  reload: () => Promise<void>;
  refresh: () => Promise<void>;
}

export function useDbItems(filters: ItemFilters = {}): UseDbItemsResult {
  const [items, setItems] = useState<FeedItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const mountedRef = useRef(true);

  const reload = useCallback(async () => {
    if (mountedRef.current) {
      setLoading(true);
      setError(null);
    }

    try {
      const dbItems = await getItems(filters);
      if (!mountedRef.current) return;
      setItems(dbItems.map(mapDbItemToFeedItem));
      setLastUpdated(new Date());
    } catch (loadError: unknown) {
      if (!mountedRef.current) return;
      setError(getErrorMessage(loadError));
    } finally {
      if (mountedRef.current) {
        setLoading(false);
      }
    }
  }, [filters]);

  useEffect(() => {
    mountedRef.current = true;
    void reload();

    return () => {
      mountedRef.current = false;
    };
  }, [reload]);

  return { items, loading, error, lastUpdated, reload, refresh: reload };
}
