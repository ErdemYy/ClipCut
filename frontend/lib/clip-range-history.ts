import { clipRangeError, type ClipRange } from "./clip-trim";

export type ClipRanges = Record<number, ClipRange>;
export type ClipRangeHistory = {
  context: string | null; present: ClipRanges; committed: ClipRanges;
  past: ClipRanges[]; future: ClipRanges[];
};
export const CLIP_HISTORY_LIMIT = 30;
export const emptyClipRangeHistory: ClipRangeHistory = {
  context: null, present: {}, committed: {}, past: [], future: [],
};

type Update = ClipRanges | ((current: ClipRanges) => ClipRanges);
export type ClipRangeHistoryAction =
  | { type: "reset"; context: string; ranges: ClipRanges }
  | { type: "preview" | "commit"; context: string; ranges: Update; duration: number }
  | { type: "undo"; context: string }
  | { type: "redo"; context: string };

export function sameClipRanges(a: ClipRanges, b: ClipRanges): boolean {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => {
    const id = Number(key);
    return !!b[id] && Object.is(a[id].start, b[id].start) && Object.is(a[id].end, b[id].end);
  });
}

export const hasUncommittedClipRanges = (state: ClipRangeHistory) => !sameClipRanges(state.present, state.committed);
export const canUndoClipRanges = (state: ClipRangeHistory) => hasUncommittedClipRanges(state) || state.past.length > 0;
export const canRedoClipRanges = (state: ClipRangeHistory) => !hasUncommittedClipRanges(state) && state.future.length > 0;

/** Previews never add history; commit once on blur, keyboard action or pointer-up. */
export function clipRangeHistoryReducer(state: ClipRangeHistory, action: ClipRangeHistoryAction): ClipRangeHistory {
  if (action.type === "reset") {
    return { context: action.context, present: action.ranges, committed: action.ranges, past: [], future: [] };
  }
  if (action.context !== state.context) return state;
  if (action.type === "undo") {
    // Invalid/unfinished numeric input is discarded before undoing saved steps.
    if (hasUncommittedClipRanges(state)) return { ...state, present: state.committed };
    if (!state.past.length) return state;
    const previous = state.past[state.past.length - 1];
    return { ...state, present: previous, committed: previous, past: state.past.slice(0, -1),
      future: [state.committed, ...state.future].slice(0, CLIP_HISTORY_LIMIT) };
  }
  if (action.type === "redo") {
    if (!canRedoClipRanges(state)) return state;
    const next = state.future[0];
    return { ...state, present: next, committed: next, future: state.future.slice(1),
      past: [...state.past, state.committed].slice(-CLIP_HISTORY_LIMIT) };
  }
  const next = typeof action.ranges === "function" ? action.ranges(state.present) : action.ranges;
  if (action.type === "preview") return { ...state, present: next };
  const keys = Object.keys(state.committed);
  const valid = keys.length === Object.keys(next).length && keys.every((key) =>
    !!next[Number(key)] && !clipRangeError(next[Number(key)], action.duration));
  if (!valid || sameClipRanges(next, state.committed)) return { ...state, present: next };
  return { ...state, present: next, committed: next,
    past: [...state.past, state.committed].slice(-CLIP_HISTORY_LIMIT), future: [] };
}
