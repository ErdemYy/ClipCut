import type {
  OutputStorageProtectedDir, OutputStorageProtectedPreview, OutputStorageProtectedRender,
  OutputStorageProtectedVoiceover, OutputStorageProtectedWork, OutputTrashEntry, PreviewKind,
  StorageCategoryId, WorkKind,
} from "./api";

export type TrashBatch = {
  id: string;
  entries: OutputTrashEntry[];
  bytes: number;
  newestAge: number;
};

export const STORAGE_PROTECTED_LABELS: Record<OutputStorageProtectedDir["reason"], string> = {
  referenced: "iş sonuçlarında kullanılıyor",
  recent: "yeni oluşturuldu",
  symlink: "bağlantı içeriyor",
  nested: "alt klasör içeriyor",
  special: "özel dosya içeriyor",
  unreadable: "okunamıyor",
};

export const STORAGE_RENDER_PROTECTED_LABELS: Record<OutputStorageProtectedRender["reason"], string> = {
  referenced: "proje veya iş sonucunda kullanılıyor",
  recent: "yeni oluşturuldu",
  symlink: "bağlantı içeriyor",
  special: "özel dosya içeriyor",
  unreadable: "okunamıyor",
};

export const STORAGE_PREVIEW_PROTECTED_LABELS: Record<OutputStorageProtectedPreview["reason"], string> = {
  referenced: "en güncel önizleme",
  recent: "yeni oluşturuldu",
  symlink: "bağlantı içeriyor",
  special: "özel dosya içeriyor",
  unreadable: "okunamıyor",
};

export const STORAGE_VOICEOVER_PROTECTED_LABELS: Record<OutputStorageProtectedVoiceover["reason"], string> = {
  referenced: "proje veya iş sonucunda kullanılıyor",
  recent: "yeni oluşturuldu",
  symlink: "bağlantı",
  special: "özel dosya",
  unreadable: "okunamıyor",
};

export const STORAGE_CATEGORY_LABELS: Record<StorageCategoryId, string> = {
  source: "Kaynak medya",
  renders: "Ana render MP4'leri",
  staging: "Hazırlama çıktıları",
  previews: "Önizlemeler",
  work: "work/ ara dosyaları",
  trash: "Çöp kutusu",
  other: "Diğer proje dosyaları",
};

export function storageCategoryLabel(id: string): string {
  return STORAGE_CATEGORY_LABELS[id as StorageCategoryId] ?? id;
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const rounded = unit === 0 ? Math.round(value) : value >= 100 ? Math.round(value) : Math.round(value * 10) / 10;
  return `${rounded} ${units[unit]}`;
}

export function formatMinAge(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "1 dakika";
  if (seconds >= 86400) return `${Math.round(seconds / 86400)} gün`;
  if (seconds >= 3600) return `${Math.round(seconds / 3600)} saat`;
  return `${Math.max(1, Math.round(seconds / 60))} dakika`;
}

export function storageProtectionSummary(protectedDirs: OutputStorageProtectedDir[]): string {
  const counts = new Map<string, number>();
  for (const item of protectedDirs) counts.set(item.reason, (counts.get(item.reason) ?? 0) + 1);
  return [...counts].map(([reason, count]) =>
    `${count} ${STORAGE_PROTECTED_LABELS[reason as OutputStorageProtectedDir["reason"]] ?? reason}`).join(" · ");
}

export function renderProtectionSummary(protectedRenders: OutputStorageProtectedRender[]): string {
  const counts = new Map<string, number>();
  for (const item of protectedRenders) counts.set(item.reason, (counts.get(item.reason) ?? 0) + 1);
  return [...counts].map(([reason, count]) =>
    `${count} ${STORAGE_RENDER_PROTECTED_LABELS[reason as OutputStorageProtectedRender["reason"]] ?? reason}`).join(" · ");
}

export function workProtectionSummary(protectedWork: OutputStorageProtectedWork[]): string {
  const counts = new Map<string, number>();
  for (const item of protectedWork) counts.set(item.reason, (counts.get(item.reason) ?? 0) + 1);
  return [...counts].map(([reason, count]) =>
    `${count} ${STORAGE_PROTECTED_LABELS[reason as OutputStorageProtectedWork["reason"]] ?? reason}`).join(" · ");
}

export function previewProtectionSummary(protectedPreviews: OutputStorageProtectedPreview[]): string {
  const counts = new Map<string, number>();
  for (const item of protectedPreviews) counts.set(item.reason, (counts.get(item.reason) ?? 0) + 1);
  return [...counts].map(([reason, count]) =>
    `${count} ${STORAGE_PREVIEW_PROTECTED_LABELS[reason as OutputStorageProtectedPreview["reason"]] ?? reason}`).join(" · ");
}

export function voiceoverProtectionSummary(protectedVoices: OutputStorageProtectedVoiceover[]): string {
  const counts = new Map<string, number>();
  for (const item of protectedVoices) counts.set(item.reason, (counts.get(item.reason) ?? 0) + 1);
  return [...counts].map(([reason, count]) =>
    `${count} ${STORAGE_VOICEOVER_PROTECTED_LABELS[reason as OutputStorageProtectedVoiceover["reason"]] ?? reason}`).join(" · ");
}

export function storageUsageSummary(totalBytes: number, moveableBytes: number, trashBytes: number): string {
  return `Toplam ${formatBytes(totalBytes)} · ${formatBytes(moveableBytes)} çöpe taşınabilir · ` +
    `${formatBytes(trashBytes)} çöpte.`;
}

export function storageTrashLabel(entry: { kind: "staging" | "render" | "voiceover" | WorkKind | PreviewKind; name: string }): string {
  if (entry.kind === "render") return entry.name;
  if (entry.kind === "staging") return `Hazırlama · ${entry.name.slice(0, 8)}…`;
  if (entry.kind === "voiceover") return `Seslendirme · ${entry.name.slice(0, 18)}…`;
  if (entry.kind === "work_render") return `Çalışma · ${entry.name}`;
  if (entry.kind === "work_publish") return `Yayın çalışması · ${entry.name.slice(0, 8)}…`;
  if (entry.kind === "work_preview") return `Önizleme çalışması · ${entry.name.slice(0, 8)}…`;
  if (entry.kind === "work_clip_preview") return `Klip önizlemesi · ${entry.name.slice(0, 8)}…`;
  if (entry.kind === "work_waveforms") return "Dalga formu önbelleği";
  if (entry.kind === "preview") return `Önizleme · ${entry.name.slice(0, 8)}…`;
  return `Klip önizlemesi · ${entry.name.slice(0, 8)}…`;
}

export function formatTrashExpiry(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "Süresi doldu";
  if (seconds >= 86400) return `${Math.ceil(seconds / 86400)} gün kaldı`;
  if (seconds >= 3600) return `${Math.ceil(seconds / 3600)} saat kaldı`;
  return `${Math.max(1, Math.ceil(seconds / 60))} dakika kaldı`;
}

export function trashBatches(entries: OutputTrashEntry[]): TrashBatch[] {
  const groups = new Map<string, TrashBatch>();
  for (const entry of entries) {
    const id = entry.batch_id ?? `entry:${entry.id}`;
    const group = groups.get(id);
    if (group) {
      group.entries.push(entry);
      group.bytes += entry.bytes;
      group.newestAge = Math.min(group.newestAge, entry.age_seconds);
    } else {
      groups.set(id, { id, entries: [entry], bytes: entry.bytes, newestAge: entry.age_seconds });
    }
  }
  return [...groups.values()].sort((left, right) => left.newestAge - right.newestAge);
}
