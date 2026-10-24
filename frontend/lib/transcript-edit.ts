import type { TranscriptRow } from "./api";

export function transcriptSelection(rows: TranscriptRow[], ids: number[]) {
  const selected = rows.filter((row) => ids.includes(row.id));
  const indices = rows.map((row, index) => ids.includes(row.id) ? index : -1).filter((index) => index >= 0);
  const contiguous = indices.length > 0 && indices.every((index, i) => index === indices[0] + i);
  return {
    rows: selected, contiguous,
    start: selected.length ? Math.min(...selected.map((row) => row.start)) : 0,
    end: selected.length ? Math.max(...selected.map((row) => row.end)) : 0,
  };
}

export function toggleTranscriptRow(ids: number[], id: number) {
  return ids.includes(id) ? ids.filter((value) => value !== id) : [...ids, id];
}
