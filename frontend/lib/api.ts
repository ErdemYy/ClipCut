export const API_URL = (process.env.NEXT_PUBLIC_API_URL || "http://localhost:8008").replace(/\/$/, "");

export type Word = { text: string; start: number; end: number };
export type Segment = { id: number; start: number; end: number; text: string; words: Word[] };
export type SubtitleEditSegment = Omit<Segment, "words"> & { words?: Word[] };
export type Transcript = { language: string; segments: Segment[]; edited?: boolean; mock?: boolean; manual_segments?: boolean };
export type Operation = { type: string; [key: string]: unknown };
export type Plan = { operations: Operation[] };
export type ChatMessage = { role: "user" | "assistant"; text: string; at: string; changed?: boolean };

export type Project = {
  id: string;
  name: string;
  status: "draft" | "generating" | "ready" | "failed";
  origin: "upload" | "veo" | "storyboard";
  created_at: string;
  updated_at: string;
  duration: number;
  width: number;
  height: number;
  has_audio: boolean;
  source_url: string | null;
  thumbnail_url: string | null;
  voiceover_url?: string | null;
  has_voiceover?: boolean;
  output_url: string | null;
  render_revision?: string;
  subtitle_revision?: string;
  subtitle_time_limit?: number;
  timeline_revision?: string;
  subtitle_language: string | null;
  has_transcript: boolean;
  has_subtitles?: boolean;
  storyboard_progress?: { ready: number; total: number; assembled: boolean } | null;
  operation_count: number;
  generation_prompt?: string | null;
  transcript_language?: string | null;
  subtitles?: Transcript | null;
  plan?: Plan;
  can_undo?: boolean;
  chat?: ChatMessage[];
  output_meta?: { duration: number; width: number; height: number; rendered_at: string; timeline?: TimelineInfo } | null;
  storyboard?: Storyboard | null;
};

export type Voice = {
  id: string;
  name: string;
  gender: "male" | "female";
  language: string;
  accent: string;
  style: string;
  description: string;
};

export type Job = {
  id: string;
  project_id: string;
  kind: "generate" | "storyboard_generate" | "transcribe" | "translate" | "render" | "preview" | "export_batch" | "clip_analyze" | "clip_render" | "clip_preview" | "transcript_clip";
  status: "queued" | "running" | "done" | "failed";
  progress: number;
  message: string;
  error: string | null;
  result: Record<string, unknown> | null;
};

export type TimelineInfo = {
  source_duration: number;
  segments: [number, number][];
  speed: number;
  crossfade: number;
  output_duration: number;
  exact_output_duration?: number;
  revision?: string;
};
export type LayerTiming = { index: number; start: number; duration: number };
export type Waveform = { duration: number; has_audio: boolean; revision: string; sample_rate: number; peaks: number[] };

export type ExportFormat = "9:16" | "1:1" | "4:5" | "16:9";
export type RenderOptions = { resolution: "720p" | "1080p" | "4k"; quality: "fast" | "standard" | "high" };
export type PreviewResult = RenderOptions & {
  output: string; start: number; end: number; duration: number;
  width: number; height: number; render_revision: string;
};
export type FillMode = "blur" | "fit" | "crop";
export type ClipPreviewResult = RenderOptions & {
  output: string; start: number; end: number; duration: number;
  width: number; height: number; clip_id: number; clip_start: number; clip_end: number;
  analysis_id: string; aspect_ratio: ExportFormat; fill: FillMode; render_revision: string;
  preview_start?: number; requested_duration?: 5 | 10;
};
export type ClipRenderSnapshot = {
  analysis_id: string;
  clips: { id: number; start: number; end: number; cover_at: number }[];
  aspect_ratio?: ExportFormat; aspect_ratios?: ExportFormat[]; fill: FillMode;
  resolution: RenderOptions["resolution"]; quality: RenderOptions["quality"];
  render_revision: string;
  source_sha256?: string | null;
};
export type PublishResult = {
  archive: string;
  format_archives?: Partial<Record<ExportFormat, string>>;
  clip_archives?: { clip_index: number; start: number; end: number; archive: string }[];
  reused_outputs?: number; refreshed_covers?: number; rendered_outputs?: number;
  outputs: { label: string; aspect_ratio: ExportFormat; output: string; thumbnail: string;
    width: number; height: number; duration: number; thumbnail_fallback: boolean;
    cover_at?: number; cover_source_at?: number; clip_index?: number;
    reused?: boolean; video_reused?: boolean; cover_refreshed?: boolean;
    sha256?: string | null; thumbnail_sha256?: string | null }[];
  clip_request?: ClipRenderSnapshot;
};
export type ClipCandidate = {
  id: number; start: number; end: number; duration: number; score: number;
  speech_ratio: number; words_per_minute: number | null; excerpt: string; reason: string;
  transcript_used?: boolean; sentence_aligned?: boolean; hook_score?: number | null; topic_score?: number | null;
  signals?: { speech: number; cadence: number; boundary: number; completeness?: number; hook?: number; topic?: number };
};
export type ClipRangeOverride = { id: number; start: number; end: number };
export type ClipAnalysis = {
  clips: ClipCandidate[]; notice: string; empty_reason: string | null;
  method?: string; scoring?: string; transcript_used?: boolean;
  sentence_boundaries?: { starts: number[]; ends: number[] };
};
export type TranscriptRow = { id: number; start: number; end: number; text: string; kept_duration: number };
export type TranscriptEdit = { revision: string; language: string | null; mock: boolean; blocked_reason: string | null; segments: TranscriptRow[] };
export type TranscriptSelection = { revision: string; segment_ids: number[] };

export type StoryScene = {
  id: string; title: string; visual_prompt: string; narration: string; duration: 4 | 6 | 8;
  status: "pending" | "generating" | "ready" | "failed";
  video_url: string | null; actual_duration: number | null; error: string | null; mock: boolean | null;
  thumbnail_url: string | null; trim_start: number; trim_end: number | null; timeline_duration: number;
  transition: "cut" | "dissolve" | "fade"; transition_duration: number;
};
export type Storyboard = {
  title: string; aspect_ratio: "9:16" | "16:9"; language: "tr" | "en" | "de" | "es";
  style: string; continuity: string; voiceover: boolean; voice_id: string; auto_subtitles: boolean;
  text_model: string; video_model: string;
  scenes: StoryScene[]; revision: string; assembled_revision: string | null; mock_plan: boolean;
  pending_scenes: number; planned_duration: number; last_error: string | null;
  timeline_duration: number;
  previous_versions: { index: number; source_url: string; created_at: string; restorable: boolean; has_plan: boolean }[];
};

export type LibraryItem = { id: string; label: string; mood?: string; url: string };
export type BrollStockItem = {
  id: string;
  label: string;
  category: string;
  icon: string;
  accent: string;
  url: string;
};

export type OverlayOp = {
  type: "overlay";
  track: string;
  label?: string;
  start: number;
  duration: number;
  mode: "pip" | "fullscreen" | "sticker";
  position: "top_right" | "top_left" | "bottom_right" | "bottom_left" | "center";
  scale?: number;
  animation?: "pop" | "fade" | "slide" | "none";
  border_radius?: number;
};

export type SubtitleStyle = "classic" | "karaoke" | "word_pop" | "boxed" | "minimal" | "hormozi" | "neon";

export type SubtitlesOp = {
  type: "subtitles";
  enabled: boolean;
  style: SubtitleStyle;
  font: string;
  size: "small" | "medium" | "large";
  primary_color: string;
  highlight_color: string;
  outline_color: string;
  position: "top" | "middle" | "bottom";
  uppercase: boolean;
  max_words_per_line: number;
  auto_emojis?: boolean;
  bounce?: boolean;
};

export type Library = {
  music: LibraryItem[];
  sfx: LibraryItem[];
  broll?: BrollStockItem[];
  fonts: string[];
  languages: { code: string; name: string }[];
  subtitle_styles: string[];
  color_presets: string[];
  transitions: string[];
};

export type Template = {
  id: string;
  name: string;
  description: string;
  icon: string;
  tag: string;
  badge_color?: string;
  prompt: string;
  plan: Plan;
};

export type Health = { ok: boolean; mock: boolean; ffmpeg: string; veo_model: string; video_durations?: number[]; video_model_warning?: string | null };
export type ModelInfo = {
  id: string; label: string; kind: "text" | "video"; status: "active" | "deprecated" | "closed" | "unpriced";
  configured: boolean; selectable: boolean; note: string | null; durations: number[];
  price_per_second?: number | null; input_per_million?: number | null; output_per_million?: number | null;
};
export type ModelCatalog = {
  mock: boolean; defaults: { text_model: string; video_model: string };
  text: ModelInfo[]; video: ModelInfo[]; pricing_read_at: string; pricing_note: string;
};
export type CostComponent = { label: string; detail: string; usd: number | null };
export type CostEstimate = {
  mock: boolean; priced: boolean; video_model: ModelInfo; text_model: ModelInfo;
  video_calls: number; video_seconds: number; tts_calls: number; planning_calls: number;
  estimated_usd: number | null; components: CostComponent[]; warnings: string[];
  pricing_read_at: string; pricing_note: string;
};

export const mediaUrl = (path: string | null | undefined) => (path ? `${API_URL}${path}` : undefined);
export const downloadUrl = (path: string | null | undefined) => {
  if (!path) return undefined;
  const match = path.match(/^\/media\/projects\/([^/]+)\/(.+)$/);
  return match ? `${API_URL}/api/projects/${match[1]}/download/${match[2]}` : mediaUrl(path);
};

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: init?.body instanceof FormData ? init?.headers : { "Content-Type": "application/json", ...init?.headers },
    cache: "no-store",
  });
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const data = await res.json();
      detail = typeof data.detail === "string" ? data.detail : JSON.stringify(data.detail);
    } catch {
      /* yok */
    }
    throw new Error(detail || `İstek başarısız (${res.status})`);
  }
  return res.json() as Promise<T>;
}

const json = (body: unknown): RequestInit => ({ method: "POST", body: JSON.stringify(body) });

export const api = {
  health: () => request<Health>("/api/health"),
  aiModels: () => request<ModelCatalog>("/api/ai/models"),
  preflight: (body: { video_model?: string; text_model?: string; scene_durations?: number[]; voiceover?: boolean;
    planning_scene_count?: number; planning_chars?: number }) => request<CostEstimate>("/api/ai/preflight", json(body)),
  library: () => request<Library>("/api/library"),
  templates: () => request<Template[]>("/api/templates"),
  applyTemplate: (projectId: string, templateId: string) =>
    request<{ summary: string; project: Project }>(`/api/projects/${projectId}/apply-template/${templateId}`, { method: "POST" }),
  projects: () => request<Project[]>("/api/projects"),
  project: (id: string) => request<Project>(`/api/projects/${id}`),
  rename: (id: string, name: string) => request<Project>(`/api/projects/${id}`, { method: "PATCH", body: JSON.stringify({ name }) }),
  remove: (id: string) => request<{ ok: boolean }>(`/api/projects/${id}`, { method: "DELETE" }),
  upload: (file: File, name: string) => {
    const fd = new FormData();
    fd.append("file", file);
    fd.append("name", name);
    return request<Project>("/api/projects/upload", { method: "POST", body: fd });
  },
  generate: (body: { prompt: string; name?: string; aspect_ratio: string; duration: number; negative_prompt?: string;
    video_model?: string; max_cost_usd?: number }) =>
    request<{ project: Project; job: Job }>("/api/projects/generate", json(body)),
  createStoryboard: (body: { brief: string; scene_count: number; scene_duration: number; aspect_ratio: string; language: string; style: string;
    text_model?: string; video_model?: string; max_cost_usd?: number; confirm_api_usage: boolean }) =>
    request<Project>("/api/projects/storyboard", json(body)),
  saveStoryboard: (id: string, body: Storyboard) => request<Project>(`/api/projects/${id}/storyboard`, { method: "PUT", body: JSON.stringify(body) }),
  generateStoryboard: (id: string, body: { revision: string; scene_id?: string; confirm_api_usage: boolean; confirm_replace_source: boolean; max_cost_usd?: number }) =>
    request<Job>(`/api/projects/${id}/storyboard/generate`, json(body)),
  cancelJob: (id: string) => request<Job>(`/api/jobs/${id}/cancel`, { method: "POST" }),
  restoreStoryboardVersion: (id: string, body: { version_index: number; confirm: boolean }) =>
    request<Project>(`/api/projects/${id}/storyboard/restore`, json(body)),
  job: (id: string) => request<Job>(`/api/jobs/${id}`),
  jobs: (projectId: string) => request<Job[]>(`/api/projects/${projectId}/jobs`),
  transcribe: (id: string, target_language?: string) => request<Job>(`/api/projects/${id}/transcribe`, json({ target_language })),
  translate: (id: string, target_language: string) => request<Job>(`/api/projects/${id}/translate`, json({ target_language })),
  saveSubtitles: (id: string, segments: SubtitleEditSegment[], revision?: string) =>
    request<Project>(`/api/projects/${id}/subtitles`, { method: "PUT", body: JSON.stringify({ segments, revision }) }),
  edit: (id: string, prompt: string) =>
    request<{ summary: string; changed: boolean; project: Project }>(`/api/projects/${id}/edit`, json({ prompt })),
  setPlan: (id: string, plan: Plan) => request<Project>(`/api/projects/${id}/plan`, { method: "PUT", body: JSON.stringify({ plan }) }),
  undo: (id: string) => request<Project>(`/api/projects/${id}/plan/undo`, { method: "POST" }),
  timeline: (id: string) => request<TimelineInfo>(`/api/projects/${id}/timeline`),
  setLayerTimings: (id: string, revision: string, layers: LayerTiming[]) => request<Project>(`/api/projects/${id}/timeline/layers`,
    { method: "PATCH", body: JSON.stringify({ revision, layers }) }),
  waveform: (id: string, signal?: AbortSignal) => request<Waveform>(`/api/projects/${id}/waveform`, { signal }),
  transcriptEdit: (id: string) => request<TranscriptEdit>(`/api/projects/${id}/transcript-edit`),
  cutTranscript: (id: string, selection: TranscriptSelection) => request<Project>(`/api/projects/${id}/transcript-edit/cut`, json(selection)),
  clipTranscript: (id: string, selection: TranscriptSelection & RenderOptions & { aspect_ratio: ExportFormat; fill: FillMode }) =>
    request<Job>(`/api/projects/${id}/transcript-edit/clip`, json(selection)),
  render: (id: string, options?: RenderOptions) => request<Job>(`/api/projects/${id}/render`, json(options ?? {})),
  preview: (id: string, options: RenderOptions & { start: number; duration: 5 | 10 }) =>
    request<Job>(`/api/projects/${id}/preview`, json(options)),
  exportBatch: (id: string, options: RenderOptions & { formats: ExportFormat[]; fill: FillMode; thumbnail_at: number }) =>
    request<Job>(`/api/projects/${id}/export-batch`, json(options)),
  selectThumbnail: (id: string, at: number) =>
    request<Project>(`/api/projects/${id}/thumbnail`, { method: "PUT", body: JSON.stringify({ at }) }),
  analyzeClips: (id: string, options: { min_duration: number; max_duration: number; max_clips: number }) =>
    request<Job>(`/api/projects/${id}/clips/analyze`, json(options)),
  renderClips: (id: string, options: RenderOptions & {
    reuse_job_id?: string;
    analysis_id: string; clip_ids: number[]; aspect_ratio: ExportFormat;
    aspect_ratios?: ExportFormat[]; fill: FillMode;
    clip_ranges?: ClipRangeOverride[];
    clip_covers?: { id: number; at: number }[];
  }) => request<Job>(`/api/projects/${id}/clips/render`, json(options)),
  previewClip: (id: string, options: RenderOptions & {
    analysis_id: string; clip_id: number; clip_range?: ClipRangeOverride;
    aspect_ratio: ExportFormat; fill: FillMode; start?: number; duration?: 5 | 10;
  }) => request<Job>(`/api/projects/${id}/clips/preview`, json(options)),
  uploadAudio: (id: string, file: File) => {
    const fd = new FormData();
    fd.append("file", file);
    return request<LibraryItem>(`/api/projects/${id}/audio`, { method: "POST", body: fd });
  },
  projectAudio: (id: string) => request<LibraryItem[]>(`/api/projects/${id}/audio`),
  voices: () => request<Voice[]>("/api/voices"),
  previewVoiceover: (body: { text: string; voice: string; speed?: number }) =>
    request<{ url: string; duration: number; words: Word[]; segments: Segment[] }>("/api/voiceover/preview", json(body)),
  applyVoiceover: (
    projectId: string,
    body: { text: string; voice: string; speed?: number; auto_subtitles?: boolean; subtitle_style?: string }
  ) => request<{ summary: string; project: Project }>(`/api/projects/${projectId}/voiceover`, json(body)),
  deleteVoiceover: (projectId: string) =>
    request<{ summary: string; project: Project }>(`/api/projects/${projectId}/voiceover`, { method: "DELETE" }),
  brollLibrary: () => request<BrollStockItem[]>("/api/broll/library"),
  projectBroll: (projectId: string) => request<LibraryItem[]>(`/api/projects/${projectId}/broll`),
  suggestBroll: (projectId: string) => request<{ suggestions: OverlayOp[] }>(`/api/projects/${projectId}/broll/suggest`, { method: "POST" }),
  applyAutoBroll: (projectId: string) =>
    request<{ summary: string; count: number; project: Project }>(`/api/projects/${projectId}/broll/apply-auto`, { method: "POST" }),
  generateBroll: (projectId: string, prompt: string) =>
    request<LibraryItem>(`/api/projects/${projectId}/broll/generate`, json({ prompt })),
  uploadBroll: (projectId: string, file: File) => {
    const fd = new FormData();
    fd.append("file", file);
    return request<LibraryItem>(`/api/projects/${projectId}/broll/upload`, { method: "POST", body: fd });
  },
  subtitleExportUrl: (id: string, fmt: "srt" | "vtt") => `${API_URL}/api/projects/${id}/subtitles.${fmt}`,
};

/** Bir işi tamamlanana kadar izler. */
export async function waitForJob(id: string, onUpdate: (job: Job) => void, intervalMs = 1000): Promise<Job> {
  for (;;) {
    const job = await api.job(id);
    onUpdate(job);
    if (job.status === "done" || job.status === "failed") return job;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

export function formatTime(sec: number): string {
  if (!isFinite(sec)) return "0:00";
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export const OP_LABELS: Record<string, { label: string; icon: string }> = {
  trim: { label: "Kırpma", icon: "✂️" },
  cut_range: { label: "Bölüm Kesme", icon: "✂️" },
  remove_silence: { label: "Sessizlik Temizleme", icon: "🔇" },
  reframe: { label: "Format", icon: "📐" },
  speed: { label: "Hız", icon: "⏩" },
  color_grade: { label: "Renk", icon: "🎨" },
  subtitles: { label: "Altyazı", icon: "💬" },
  music: { label: "Müzik", icon: "🎵" },
  sfx: { label: "Ses Efekti", icon: "🔊" },
  volume: { label: "Ses Seviyesi", icon: "🎚️" },
  transition: { label: "Geçiş", icon: "🔀" },
  fade: { label: "Açılış/Kapanış", icon: "🌗" },
  text: { label: "Metin", icon: "🔤" },
  overlay: { label: "B-Roll Katmanı", icon: "🖼️" },
};

export function describeOp(op: Operation): string {
  const o = op as Record<string, unknown>;
  switch (op.type) {
    case "overlay":
      return `${o.label || String(o.track).split("/").pop()} · ${o.start}s (${o.duration}s) · ${o.mode}`;
    case "trim":
      return `${o.start}s → ${o.end ?? "son"}`;
    case "cut_range":
      return `${o.start}s – ${o.end}s çıkarıldı`;
    case "remove_silence":
      return `${o.threshold_db} dB, min ${o.min_silence_ms} ms`;
    case "reframe":
      return `${o.aspect_ratio} · ${o.mode}`;
    case "speed":
      return `x${o.factor}`;
    case "color_grade":
      return `${o.preset}${o.vignette ? " · vinyet" : ""}${o.grain ? " · gren" : ""}`;
    case "subtitles":
      return `${o.style} · ${o.font} · ${o.position}`;
    case "music":
      return `${String(o.track).replace("project:", "")} · %${Math.round(Number(o.volume) * 100)}${o.ducking ? " · ducking" : ""}`;
    case "sfx":
      return `${o.track} @ ${o.at}s`;
    case "volume":
      return `x${o.gain}${o.normalize ? " · normalize" : ""}`;
    case "transition":
      return `${o.style} · ${o.duration}s`;
    case "fade":
      return `giriş ${o.fade_in}s · çıkış ${o.fade_out}s`;
    case "text":
      return `“${o.text}” · ${o.start}s · ${o.animation}`;
    default:
      return "";
  }
}

export type JobMap = Partial<Record<Job["kind"], Job>>;

