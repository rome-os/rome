import { createContext, useContext, useSyncExternalStore } from "react";

export interface WorkspaceStore {
  get<T>(key: string): T | undefined;
  set<T>(key: string, value: T): void;
  subscribe<T>(key: string, listener: (value: T | undefined) => void): () => void;
}

export function createWorkspaceStore(): WorkspaceStore {
  const data = new Map<string, unknown>();
  const subs = new Map<string, Set<(value: unknown) => void>>();

  return {
    get: (key) => data.get(key) as never,
    set: (key, value) => {
      data.set(key, value);
      subs.get(key)?.forEach((fn) => fn(value));
    },
    subscribe: (key, listener) => {
      let bucket = subs.get(key);
      if (!bucket) {
        bucket = new Set();
        subs.set(key, bucket);
      }
      bucket.add(listener as (value: unknown) => void);
      return () => {
        bucket!.delete(listener as (value: unknown) => void);
      };
    },
  };
}

export const WorkspaceStoreContext = createContext<WorkspaceStore | null>(null);

export function useWorkspaceStore(): WorkspaceStore {
  const store = useContext(WorkspaceStoreContext);
  if (!store) throw new Error("useWorkspaceStore must be used within WorkspaceStoreContext");
  return store;
}

export function useWorkspaceValue<T>(key: string): T | undefined {
  const store = useWorkspaceStore();
  return useSyncExternalStore(
    (cb) => store.subscribe(key, cb),
    () => store.get<T>(key),
  );
}
