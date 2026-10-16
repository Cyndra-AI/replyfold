import { useEffect, useState, useSyncExternalStore } from "react";
import { api } from "./api";

type Entry = { data?: unknown; error?: Error; loading: boolean; promise?: Promise<void>; version: number };

const cache = new Map<string, Entry>();
const listeners = new Set<() => void>();
let generation = 0;

function notify() {
  generation += 1;
  for (const listener of listeners) listener();
}

function load(path: string) {
  const entry = cache.get(path) ?? { loading: false, version: 0 };
  if (entry.promise) return entry.promise;
  entry.loading = true;
  entry.promise = api(path)
    .then((data) => {
      entry.data = data;
      entry.error = undefined;
    })
    .catch((error: Error) => {
      entry.error = error;
    })
    .finally(() => {
      entry.loading = false;
      entry.promise = undefined;
      entry.version += 1;
      notify();
    });
  cache.set(path, entry);
  return entry.promise;
}

/** Refetches every cached path that starts with one of the prefixes. Stale data stays visible meanwhile. */
export function invalidate(...prefixes: string[]) {
  for (const path of cache.keys()) if (prefixes.some((prefix) => path.startsWith(prefix))) void load(path);
}

export function setCached<T>(path: string, update: (current: T | undefined) => T) {
  const entry = cache.get(path) ?? { loading: false, version: 0 };
  entry.data = update(entry.data as T | undefined);
  cache.set(path, entry);
  notify();
}

/** Cached GET with stale-while-revalidate. A null path skips the request. */
export function useResource<T>(path: string | null): { data: T | undefined; error: Error | undefined; loading: boolean; reload: () => Promise<void> } {
  useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => generation,
  );
  useEffect(() => {
    if (path && !cache.get(path)?.data) void load(path);
  }, [path]);
  const entry = path ? cache.get(path) : undefined;
  return {
    data: entry?.data as T | undefined,
    error: entry?.error,
    loading: Boolean(path) && (!entry || entry.loading),
    reload: () => (path ? load(path) : Promise.resolve()),
  };
}

type ServerEvent = { type: "inbox" | "conversation" | "mailboxes" | "notifications"; conversationId?: string };

/** Keeps cached data fresh from the server's event stream. Reconnects with backoff. */
export function useLiveEvents(enabled: boolean) {
  const [connected, setConnected] = useState(false);
  useEffect(() => {
    if (!enabled) return;
    let source: EventSource | null = null;
    let retry = 1000;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const connect = () => {
      source = new EventSource("/api/events");
      source.onopen = () => {
        retry = 1000;
        setConnected(true);
      };
      source.onmessage = (message) => {
        const event = JSON.parse(message.data) as ServerEvent;
        if (event.type === "inbox") invalidate("/api/inbox");
        if (event.type === "conversation" && event.conversationId) invalidate(`/api/conversations/${event.conversationId}`, "/api/inbox");
        if (event.type === "mailboxes") invalidate("/api/mailboxes");
        if (event.type === "notifications") invalidate("/api/notifications");
      };
      source.onerror = () => {
        setConnected(false);
        source?.close();
        timer = setTimeout(connect, retry);
        retry = Math.min(retry * 2, 30_000);
      };
    };
    connect();
    return () => {
      clearTimeout(timer);
      source?.close();
    };
  }, [enabled]);
  return connected;
}
