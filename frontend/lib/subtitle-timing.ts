import type { Segment, Word } from "./api";

const round = (value: number) => Math.round(value * 1e6) / 1e6;
const normalized = (text: string) => text.trim().split(/\s+/).filter(Boolean).join(" ");
const cloneWords = (words: Word[]) => words.map(({ text, start, end }) => ({ text, start, end }));

export function distributeSubtitleWords(text: string, start: number, end: number): Word[] {
  const tokens = text.trim().split(/\s+/).filter(Boolean);
  const total = tokens.reduce((sum, token) => sum + Array.from(token).length + 1, 0);
  let cursor = start;
  return tokens.map((token, index) => {
    const next = index === tokens.length - 1 ? end : cursor + (end - start) * (Array.from(token).length + 1) / total;
    const word = { text: token, start: round(cursor), end: round(next) };
    cursor = next;
    return word;
  });
}

export function prepareSubtitleSegments(segments: Segment[]): Segment[] {
  return [...segments].sort((a, b) => a.start - b.start).map((segment) => ({
    id: segment.id, start: segment.start, end: segment.end, text: segment.text,
    words: segment.words?.length && normalized(segment.text) === normalized(segment.words.map((word) => word.text).join(" "))
      ? cloneWords(segment.words) : distributeSubtitleWords(segment.text, segment.start, segment.end),
  }));
}

export function subtitleText(segment: Segment, text: string): Segment {
  return { ...segment, text, words: normalized(text) === normalized(segment.text) ? cloneWords(segment.words)
    : distributeSubtitleWords(text, segment.start, segment.end) };
}

export function subtitleBounds(segment: Segment, start: number, end: number): Segment {
  const span = segment.end - segment.start;
  const words = span > 0 && end > start ? segment.words.map((word, index) => ({
    ...word,
    start: index === 0 ? start : round(start + (word.start - segment.start) / span * (end - start)),
    end: index === segment.words.length - 1 ? end : round(start + (word.end - segment.start) / span * (end - start)),
  })) : end > start ? distributeSubtitleWords(segment.text, start, end) : cloneWords(segment.words);
  return { ...segment, start, end, words };
}

export function splitSubtitle(segments: Segment[], index: number, after: number): Segment[] {
  const segment = segments[index];
  if (!segment || after < 1 || after >= segment.words.length) throw new Error("Bölmek için iki kelime arasını seçin.");
  const left = cloneWords(segment.words.slice(0, after));
  const right = cloneWords(segment.words.slice(after));
  const nextId = Math.max(0, ...segments.map((row) => row.id)) + 1;
  return [...segments.slice(0, index),
    { ...segment, end: left[left.length - 1].end, text: left.map((word) => word.text).join(" "), words: left },
    { id: nextId, start: right[0].start, end: segment.end, text: right.map((word) => word.text).join(" "), words: right },
    ...segments.slice(index + 1)];
}

export function mergeSubtitle(segments: Segment[], index: number): Segment[] {
  const first = segments[index], second = segments[index + 1];
  if (!first || !second) throw new Error("Birleştirmek için sonraki satır bulunamadı.");
  return [...segments.slice(0, index), { ...first, end: second.end, text: `${first.text.trim()} ${second.text.trim()}`,
    words: [...cloneWords(first.words), ...cloneWords(second.words)] }, ...segments.slice(index + 2)];
}

export function shiftSubtitles(segments: Segment[], offset: number, limit: number): Segment[] {
  if (!Number.isFinite(offset)) throw new Error("Geçerli bir kaydırma süresi girin.");
  const shifted = segments.map((segment) => ({ ...segment, start: round(segment.start + offset), end: round(segment.end + offset),
    words: segment.words.map((word) => ({ ...word, start: round(word.start + offset), end: round(word.end + offset) })) }));
  const error = subtitleTimingError(shifted, limit);
  if (error) throw new Error(error);
  return shifted;
}

export function subtitleTimingError(segments: Segment[], limit: number): string | null {
  const seen = new Set<number>();
  let previousEnd = 0;
  for (const [index, segment] of segments.entries()) {
    const label = `${index + 1}. satır`;
    if (!Number.isInteger(segment.id) || segment.id < 0 || seen.has(segment.id)) return `${label}: satır kimliği geçersiz veya yinelenmiş.`;
    seen.add(segment.id);
    if (![segment.start, segment.end].every(Number.isFinite) || segment.start < 0 || segment.end <= segment.start || segment.end > limit + 1e-6)
      return `${label}: süreler 0–${limit.toFixed(3)} sn içinde olmalı ve bitiş başlangıçtan sonra gelmeli.`;
    if (segment.start < previousEnd - 1e-6) return `${label}: satırlar birbiriyle örtüşemez.`;
    if (!normalized(segment.text) || !segment.words.length || normalized(segment.text) !== normalized(segment.words.map((word) => word.text).join(" ")))
      return `${label}: metin ve kelimeler eşleşmeli ve boş olmamalı.`;
    let end = segment.start;
    for (const word of segment.words) {
      if (![word.start, word.end].every(Number.isFinite) || word.start < end - 1e-6 || word.end <= word.start || word.end > segment.end + 1e-6 || !word.text.trim())
        return `${label}: kelime zamanları sıralı ve satır sınırları içinde olmalı.`;
      end = word.end;
    }
    previousEnd = segment.end;
  }
  return null;
}
