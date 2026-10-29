"use client";

import { useCallback, useEffect, useRef, useState } from "react";

type ListState<T> = { scope: string; items: T[]; pending: boolean; error: string | null; loaded: boolean };
const initial = <T,>(scope: string): ListState<T> => ({ scope, items: [], pending: true, error: null, loaded: false });

/** Read-only panel lists: manual recovery, scoped cache, cancellation and no mutation replay. */
export function useReadList<T extends { id: string }>(scope: string,
  read: (scope: string, signal: AbortSignal) => Promise<T[]>) {
  const [state, setState] = useState<ListState<T>>(() => initial(scope));
  const owner = useRef<string | null>(scope);
  const request = useRef<AbortController | null>(null);
  const version = useRef(0);
  const local = useRef(new Map<string, { version: number; item: T }>());

  const reload = useCallback(async () => {
    if (owner.current !== scope || request.current) return;
    const controller = new AbortController();
    request.current = controller;
    const before = version.current;
    setState((current) => ({ ...(current.scope === scope ? current : initial<T>(scope)), pending: true }));
    try {
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]);
      const items = await read(scope, signal);
      signal.throwIfAborted();
      if (owner.current !== scope || request.current !== controller) return;
      // A GET begun before an upload completed must not remove that newly uploaded item.
      const merged = new Map(items.map((item) => [item.id, item]));
      local.current.forEach((change, id) => {
        if (change.version > before) merged.set(id, change.item);
        else local.current.delete(id);
      });
      setState({ scope, items: [...merged.values()], pending: false, error: null, loaded: true });
    } catch (error) {
      if (!controller.signal.aborted && owner.current === scope && request.current === controller) {
        const message = (error as Error).name === "TimeoutError" ? "İstek zaman aşımına uğradı." : (error as Error).message;
        setState((current) => ({ ...current, pending: false, error: message }));
      }
    } finally {
      if (request.current === controller) request.current = null;
    }
  }, [scope, read]);

  const upsert = useCallback((item: T) => {
    if (owner.current !== scope) return false;
    local.current.set(item.id, { version: ++version.current, item });
    setState((current) => {
      const value = current.scope === scope ? current : initial<T>(scope);
      return { ...value, items: [...value.items.filter((existing) => existing.id !== item.id), item] };
    });
    return true;
  }, [scope]);

  useEffect(() => {
    let disposed = false;
    owner.current = scope;
    local.current.clear();
    void Promise.resolve().then(() => { if (!disposed) return reload(); });
    return () => {
      disposed = true;
      owner.current = null;
      request.current?.abort();
      request.current = null;
    };
  }, [scope, reload]);

  return { ...(state.scope === scope ? state : initial<T>(scope)), reload, upsert };
}
