"use client";

import { useCallback, useEffect, useRef, useState } from "react";

type State<T> = { key: string; cacheKey: string; dataKey: string | null; data: T | null; pending: boolean; error: string | null };

/** Non-list media reads; keep compatible cached data, but never call it current for a new key. */
export function useReadResource<T>(key: string, cacheKey: string, read: (signal: AbortSignal) => Promise<T>,
  { enabled = true, timeoutMs = 15000, delayMs = 0 } = {}) {
  const [state, setState] = useState<State<T>>({ key, cacheKey, dataKey: null, data: null, pending: enabled, error: null });
  const owner = useRef<string | null>(key);
  const request = useRef<AbortController | null>(null);
  const flight = useRef<Promise<T | null> | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reload = useCallback((): Promise<T | null> => {
    if (!enabled || owner.current !== key) return Promise.resolve(null);
    if (flight.current) return flight.current;
    if (timer.current !== null) { clearTimeout(timer.current); timer.current = null; }
    const controller = new AbortController();
    request.current = controller;
    setState((current) => ({ key, cacheKey, data: current.cacheKey === cacheKey ? current.data : null,
      dataKey: current.cacheKey === cacheKey ? current.dataKey : null, pending: true, error: current.key === key ? current.error : null }));
    const promise = Promise.resolve().then(async () => {
      try {
        const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(timeoutMs)]);
        signal.throwIfAborted();
        const data = await read(signal);
        signal.throwIfAborted();
        if (owner.current !== key || request.current !== controller) return null;
        setState({ key, cacheKey, dataKey: key, data, pending: false, error: null });
        return data;
      } catch (error) {
        if (!controller.signal.aborted && owner.current === key && request.current === controller) {
          const message = (error as Error).name === "TimeoutError" ? "İstek zaman aşımına uğradı." : (error as Error).message;
          setState((current) => ({ ...current, pending: false, error: message }));
        }
        return null;
      }
    }).finally(() => {
      if (request.current === controller) { request.current = null; flight.current = null; }
    });
    flight.current = promise;
    return promise;
  }, [key, cacheKey, read, enabled, timeoutMs]);

  // Used only for an explicitly fetched/validated timeline, never for optimistic mutations.
  const publish = useCallback((data: T) => {
    if (!enabled || owner.current !== key) return false;
    if (timer.current !== null) { clearTimeout(timer.current); timer.current = null; }
    request.current?.abort(); request.current = null; flight.current = null;
    setState({ key, cacheKey, dataKey: key, data, pending: false, error: null });
    return true;
  }, [key, cacheKey, enabled]);

  useEffect(() => {
    let disposed = false;
    owner.current = key;
    if (enabled) {
      if (delayMs > 0) timer.current = setTimeout(() => { timer.current = null; void reload(); }, delayMs);
      else void Promise.resolve().then(() => { if (!disposed) return reload(); });
    }
    return () => {
      disposed = true; owner.current = null;
      if (timer.current !== null) { clearTimeout(timer.current); timer.current = null; }
      request.current?.abort(); request.current = null; flight.current = null;
    };
  }, [key, reload, enabled, delayMs]);

  const data = enabled && state.cacheKey === cacheKey ? state.data : null;
  return { enabled, data, current: data !== null && state.dataKey === key, pending: enabled && (state.key !== key || state.pending),
    error: state.key === key ? state.error : null, reload, publish };
}
