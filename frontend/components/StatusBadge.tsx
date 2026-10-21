import type { Project } from "@/lib/api";

const LABELS: Record<Project["status"], string> = {
  ready: "Hazır",
  generating: "Üretiliyor",
  failed: "Hata",
  draft: "Taslak",
};

export default function StatusBadge({ status }: { status: Project["status"] }) {
  return (
    <span className={`badge badge-${status}`}>
      <span className={`dot ${status === "generating" ? "dot-pulse" : ""}`} />
      {LABELS[status]}
    </span>
  );
}
