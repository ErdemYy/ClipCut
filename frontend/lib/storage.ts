import type { OutputStorageProtectedDir } from "./api";

export const STORAGE_PROTECTED_LABELS: Record<OutputStorageProtectedDir["reason"], string> = {
  referenced: "iş sonuçlarında kullanılıyor",
  recent: "yeni oluşturuldu",
  symlink: "bağlantı içeriyor",
  nested: "alt klasör içeriyor",
  special: "özel dosya içeriyor",
  unreadable: "okunamıyor",
};

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
