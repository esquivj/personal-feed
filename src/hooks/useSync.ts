"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { initializeDb } from "../lib/db-init";
import { syncFromVps } from "../lib/sync";

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return "Failed to sync feed items";
}

export interface UseSyncResult {
  syncing: boolean;
  lastSync: string | null;
  itemCount: number;
  error: string | null;
  resync: () => Promise<void>;
}

export function useSync(): UseSyncResult {
  const [syncing, setSyncing] = useState(false);
  const [lastSync, setLastSync] = useState<string | null>(null);
  const [itemCount, setItemCount] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(true);
  const syncingRef = useRef(false);

  const resync = useCallback(async () => {
    if (syncingRef.current) return;

    syncingRef.current = true;
    if (mountedRef.current) {
      setSyncing(true);
      setError(null);
    }

    try {
      const result = await syncFromVps();
      if (!mountedRef.current) return;

      setLastSync(result.lastSync);
      setItemCount(result.itemCount);
    } catch (syncError: unknown) {
      if (!mountedRef.current) return;
      setError(getErrorMessage(syncError));
    } finally {
      syncingRef.current = false;
      if (mountedRef.current) {
        setSyncing(false);
      }
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;

    void (async () => {
      if (syncingRef.current) return;

      syncingRef.current = true;
      if (mountedRef.current) {
        setSyncing(true);
        setError(null);
      }

      try {
        const result = await initializeDb();
        if (!mountedRef.current) return;
        setLastSync(result.lastSync);
        setItemCount(result.itemCount);
      } catch (syncError: unknown) {
        if (!mountedRef.current) return;
        setError(getErrorMessage(syncError));
      } finally {
        syncingRef.current = false;
        if (mountedRef.current) {
          setSyncing(false);
        }
      }
    })();

    return () => {
      mountedRef.current = false;
    };
  }, []);

  return { syncing, lastSync, itemCount, error, resync };
}
