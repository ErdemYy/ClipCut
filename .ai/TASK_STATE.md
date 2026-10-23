# ClipCut — Storyboard studio and publishing

## Current task — Senaryodan çok sahneli video (2026-10-23)
- Implemented: separate plan approval, 2–12 editable/reorderable scenes, shared visual continuity, per-scene prompts/narration/durations, optional Edge TTS and subtitles, single-scene regeneration, checkpoint reuse and assembly into an editor source.
- Contracts/cache safety: `backend/app/storyboard.py`. Single-call Gemini/mock planning: `backend/app/ai/storyboard.py`. Checkpointed worker and FFmpeg normalization/concat: `backend/app/storyboard_jobs.py`. API integration: `backend/app/main.py`.
- UI: `frontend/components/StoryboardForm.tsx`, `frontend/components/editor/StoryboardPanel.tsx`, create/editor pages and typed API client. Create defaults to Senaryodan Üret; old single-scene/upload modes remain available.
- Persistence: nullable JSON `Project.storyboard` added via idempotent additive migration; migration tests preserve legacy projects. Restarted jobs retain scene/raw checkpoints. No API credentials or OpenCode global settings changed.
- Generation never starts at planning time. Real text planning and real generation require separate explicit consent. No automatic provider/model switching; no hard monetary budget or live-account entitlement claim.
- Scenes normalize to 720p/30fps. Longer narration holds the last frame, max 30s per scene. Combined caption times use actual scene offsets. Captions burn through the existing render pipeline, not into the assembled source.
- Only changed scene fingerprints invalidate prepared media. Narration-only changes reuse compatible raw video; scene order/title changes do not regenerate raw footage. SDK/provider requests that start but yield no downloadable result can still incur costs; no exactly-once billing guarantee.
- Reassembly archives earlier source and editor state rather than deleting them, then starts the new timeline with optional subtitles. Previous sources are linked; restoring old editor state via UI is not implemented.
- Demo narration is explicitly synthetic, not actual speech. Mock mode makes no TTS network call; real storyboard TTS errors stop rather than silently replacing speech with tones.
- Model caveat: configured default Veo 3.0 Fast is deprecated in current Google docs and restricted to 8s scenes in real mode; Veo 3.1 Preview retirement is surfaced as a warning. No provider migration was attempted and real account access was not tested.

### Scene timeline and local trim (2026-10-23)
- `frontend/components/editor/SceneTimeline.tsx` + `frontend/lib/scene-timeline.ts`: thumbnail strip (cached JPEG endpoint), duration distribution, drag/drop plus accessible left/right move buttons, draft total/offsets, per-scene preview clamped to the trim range (requestAnimationFrame check so it stops exactly at the cut), and start/end sliders with a 0.25s minimum.
- Trim/reorder are stored as plan fields, excluded from scene fingerprints: saving them never invalidates prepared scene media and never starts AI generation. Resetting a recovered generation mismatch (`trim_start=0, trim_end=null`) is required when visual settings change.
- `backend/app/storyboard.py`: `trim_start`/`trim_end` validation (finite, within actual duration, ≥0.25s), `trim_range`, `trim_transcript_segments` (clips word intervals and shifts them to assembled time, deriving words via `distribute_words` when words are absent), public `timeline_duration` and `thumbnail_url`.
- `backend/app/storyboard_jobs.py`: assembly re-encodes only trimmed scenes (`trim/atrim`), measures each prepared file again, derives subtitle offsets from the measured durations, and re-validates trim against the newly generated duration before reuse.
- `backend/app/main.py`: `GET /api/projects/{id}/storyboard/scenes/{scene}/thumbnail` generates/caches a JPEG from the ready scene and returns 404 for unknown/not-ready scenes; save maps contract errors to 422.
- Unsaved trim changes are previewed only; the timeline has a different drafting state than the runtime project. Switching format/language/style/voiceover or editing prompts/narration/duration resets trims for affected scenes, matching backend invalidation.

### Scene transitions (2026-10-23)
- `SceneDraft`/`SceneInput` gained `transition` (`cut`/`dissolve`/`fade`, default cut) and `transition_duration` (0.2–2.0s, default 0.6). Both are excluded from scene fingerprints, so changing a transition never invalidates prepared media or starts AI generation. The first scene is normalized to `cut`.
- `storyboard.transition_overlap` caps the effective overlap at 2s and 40% of either neighbour; below 0.2s the edge falls back to a cut. `public_storyboard.timeline_duration` subtracts these overlaps so the API total matches the merged source.
- `storyboard_jobs.assemble_scenes`: all-cut plans keep the stream-copy concat path; any transition switches to one filter graph combining `xfade` (`fade` for dissolve, `fadeblack` for fade) with `acrossfade` and `concat` for cut edges. It returns each scene's start time, which drives subtitle word offsets. Output is validated for video, audio, and expected duration.
- UI: `StoryboardPanel` shows per-scene transition controls (scene 2+); `SceneTimeline` displays effective transitions, recalculated offsets and total. The distribution bar subtracts half of each shared overlap from its neighbours. Transition edits are saved like trims and applied only on re-merge.
- Limits: two narrations briefly overlap during a transition; fade-to-black is an overlap transition, not an added black gap; transitions exist only in the assembled source, not in per-scene files.

### Production control center (2026-10-23)
- `backend/app/jobs.py`: cooperative cancellation registry (`_cancels` + lock), `submit(..., cancellable=False)` that appends the event as the last positional argument for cancellable tasks, `cancel(job_id)` (fails for unknown/finished jobs or events already released), and `_run` cleanup in `finally`.
- `backend/app/storyboard_jobs.py`: `task_generate_storyboard(..., cancel=)` checks the event before each scene; finished scenes stay usable, the in-flight scene completes (its provider request may already be billed), remaining scenes are skipped, and the run returns `{assembled: False, stopped: True, remaining, message}` without `last_error`. If the stop arrives during the final scene and all scenes end up ready, assembly still completes (local, unpaid). Project status returns to ready/draft, so edits and resume are available again.
- `backend/app/main.py`: storyboard generate submits with `cancellable=True`; new `POST /api/jobs/{job_id}/cancel` returns 404 for unknown jobs, 409 for other kinds (they cannot be stopped safely mid-render) and 409 for already finished jobs.
- UI: `StoryboardPanel` shows a control center while the job runs (active scene title from the generating scene status, remaining count, `JobProgress`, stop button with semantics note); `api.cancelJob`; generate-completion toasts distinguish stopped/assembled/partial results; the resume button is labeled `Kalan N sahneyi üret ve birleştir` with a note that unready-only scenes regenerate.
- Resume regenerates only non-ready scenes and assembles when all are ready, reusing the existing checkpoints.

### Version restore (2026-10-23)
- `storyboard_jobs.finish()` now stores `source_spec` (the exact spec that produced the current source) on every assembly, and archives it inside each `previous_versions` entry together with the editor state (`plan`, `plan_history`, transcript/subtitles incl. `subtitle_language`, output file/meta, thumbnail, voiceover). `merge_saved_spec` carries `source_spec` across saves. Version list is capped at 6 recent assemblies (files stay on disk).
- `POST /api/projects/{id}/storyboard/restore` (body `{version_index, confirm}`) under `_storyboard_lock`: 409 while generating, 422 without explicit consent, 404 for unknown index, 422 for legacy archives without a spec snapshot, 409 when the archived video is missing/invalid on disk. Restore swaps the project to the archived source + editor state + scene plan, re-probes media metadata (duration/width/height/has_audio), archives the pre-restore state as a new protected entry (so restore is reversible both ways), and keeps `assembled_revision == revision`.
- `public_storyboard.previous_versions` gained `index`, `restorable`, `has_plan`.
- UI: `StoryboardPanel` "Korunan sürümler" section shows per-version video link, per-version restore button (enabled only after an explicit consent checkbox and not while busy) and an honest note for legacy non-restorable entries; `api.restoreStoryboardVersion`; on success `setProject` swaps the editor to the restored revision (panel remounts, drafts reset to the restored plan).
- Rules: only scenes/media of the target version come back; no AI generation and no new paid request is triggered by restore. Older archives (pre-snapshot, created before this change) are link-only. The editor plan restored is the one at the archived assembly's moment; edits made after that moment are not retroactively removed from media (they are just swapped away with the current version entry).

### Duplicate job guard (2026-10-23)
- `jobs.submit` now enforces one active job per project and kind: a project+kind+(`queued`/`running`) check runs inside a lock together with the insert, so a double submission cannot slip through the race window. `jobs.DuplicateJobError` carries a user-visible message.
- `main.app` registers a FastAPI exception handler mapping `DuplicateJobError` to a plain-text 409 for every submitting endpoint (generate, transcribe, translate, render, export_batch, clip_analyze, clip_render). No frontend change needed: the existing error toast shows the message; buttons already disable while a job of the kind is tracked.
- Rationale: storyboard generation already had a project-status guard; the other kinds would previously allow stacking duplicate paid provider calls (transcribe/translate) or duplicate long local runs (render/export). Restart recovery still fails leftover queued/running rows first, so the guard never blocks after a server restart.

### Dashboard scene progress + download shortcuts (2026-10-23)
- `serialize()` (both list and full project responses) now reports `has_subtitles` and, for storyboard projects, `storyboard_progress = {ready, total, assembled}` where `assembled` compares `assembled_revision` to `revision`. Derived read-only from `p.storyboard`; no new tables or dependencies.
- Dashboard cards show a `🎬 ready/total sahne üretildi` chip while a storyboard is generating or incomplete, and a downloads row reusing the existing `downloadUrl()` attachment links: `⬇ Kaynak` (source), `⬇ Çıkış` (last render), and `⬇ SRT` (`GET /api/projects/{id}/subtitles.srt`) shown only when subtitles exist. No new API endpoints; no consent/paid-AI surface changed.
- Bug fixed along the way: the subtitle export endpoint raised `UnicodeEncodeError` (latin-1 header) for project names with Turkish characters — i.e. every storyboard project whose name defaults to the brief text. The `Content-Disposition` header now carries an ASCII fallback filename plus the RFC 5987 `filename*=UTF-8''` percent-encoded UTF-8 form (`urllib.parse.quote`).
- Validation: new `test_project_list_reports_storyboard_progress_and_subtitles` asserts the list payload flips `{ready:0,total:2,assembled:False}` → `{ready:2,total:2,assembled:True}` and `has_subtitles`, then downloads the real SRT (200 + cue arrows). Backend: 51 tests passed. Frontend: `tsc --noEmit`, targeted ESLint (`app/dashboard/page.tsx`, `lib/api.ts`), `npm test` (6 tests) and `npm run build` passed.

### Current validation
- Backend: 50 tests passed (one pre-existing Starlette/httpx deprecation warning). New control-center tests: cancel endpoint rules (200/409/404), `cancellable=True` submit passes the event and cleans the registry, stop between scenes keeps the finished checkpoint and resumes into an 8s assembled source with subtitles, stop before the first scene makes zero provider calls, duplicate-job tests (real submit rejects a second same-kind submission while one is live, different kinds stay independent, the guard releases after completion and maps to HTTP 409), and version tests: full restore round trip (source + editor state + scene plan revert, pre-restore state becomes a restorable entry, switch back), legacy spec-less archive refuses restore with no side effects, restore blocked while a job runs. Rest of the suite unchanged: consent/duplicate-submission storyboard guards, trusted runtime-field isolation, cache invalidation/reuse, legacy migration, fake SDK contract, real local FFmpeg narration/normalization/concat, trim schema/forgery rejection, reordered+trimmed assembly, cached thumbnail endpoint, transition schema/overlap caps, and real dissolve/fadeblack assembly with frame colors, audio, and shifted caption starts.
- Frontend: `npm test` (6 pure helper tests), targeted ESLint (`StoryboardPanel.tsx`, `api.ts`), `tsc --noEmit` and `npm run build` passed.
- Browser smoke test on an isolated temporary DB (mock, 6 × 4s scenes): the control center appears while the job runs and live-updates via project polling every 3s (`Üretiliyor: Sahne N` plus a shrinking remaining count), "Kalan üretimi durdur" stops between scenes (in-flight scene 4/5 finished, later scenes skipped), project returned to draft with `last_error` unset, the resume button showed `Kalan N sahneyi üret ve birleştir`, and resuming produced the 24.02s assembled source with `assembled: true`. `cancel` on a non-generate job returned 409 on the real server. Run logs show no AI/TTS provider calls (mock). Test servers on :3000/:8008 were stopped afterward.
- Limitation: the control-center heading can lag the backend by up to the 3s polling interval; a stop pressed near a scene boundary may skip the next already-started scene only after it finishes (its provider request may be billed).
- Restore smoke test (second isolated DB): the versions section showed the archived v1 with `restorable`, the button stayed disabled until the consent checkbox was set, restore succeeded with the toast, the project flipped back to revision/assets of v1 (scene title "Sahne 1", source at the first assembly), the pre-restore v2 appeared as the new protected entry, and the player streamed the restored 8.02s source (readyState 3+, correct URL). Test servers on :3000/:8008 were stopped afterward.
- Browser smoke test on an isolated temporary DB: generate a 2 × 4s demo storyboard; drag/button reorder; set trim 1.25–3.50; save (pending_scenes stayed 0, timeline 6.25s); reload persisted order/trim/thumbnails; check replace consent; local re-merge produced a 6.271s source, `assembled_revision === revision`, one archived previous source and a playable player (readyState 4). Preview starts at 1.25 and pauses exactly at 3.50. Then set the second scene to dissolve/0.5: save reported timeline 5.75s, timeline card showed `Çözünme · 0.50 sn` and start 3.50, re-merge produced a playable 5.75s source with two archived versions and caption ends inside the result. No AI provider call was made.
- Temporary frontend/backend test servers stopped afterward.

## Previous delivered work — Multi-platform exporter / Long-to-Shorts

## Scope and status
- Feature + UI + tests, LARGE cross-system change. Implemented on 2026-10-23.
- No existing project index/knowledge graph/handoff was available; source and direct callers were inspected.
- Pre-existing uncommitted resolution/quality changes in `backend/app/edit/renderer.py` were preserved and connected to the API/UI.

## Implementation
- `backend/app/publishing.py`: validated requests, immutable format/clip plans, deterministic local speech-activity ranking (not semantic/virality prediction).
- `backend/app/jobs.py`: snapshot-based sequential batches, unique output directories, thumbnail source/output time mapping, ZIP and independent clips.
- `backend/app/main.py`: batch export, cover selection, clip analysis/render, safe attachment downloads and backward-compatible single-render options.
- `frontend/components/editor/ExportPanel.tsx`, `ClipperPanel.tsx`, `PublishingControls.tsx`: platform selection, cover scrubber, analysis/preview/selection, progress, result downloads.
- `frontend/lib/api.ts`, `frontend/app/editor/[id]/page.tsx`: typed endpoints/job kinds and job-result recovery after reload.

## Constraints / decisions
- No dependency added and no paid AI request. Existing OpenCode/provider configuration is outside this task.
- Batch retains current edit plan; clips use source time/audio and inherit only subtitle/color styling. No source/project plan mutation or destructive database migration.
- Free-form AI cannot issue FFmpeg commands; existing validated renderer is reused.
- Results are independent downloadable files, not new dashboard projects. Analysis is silence/activity based; music/noise can be misclassified as speech. No viral-success guarantee.
- A cover frame removed by edits explicitly falls back to the first output frame.

## Validation
- Tests in `backend/tests/test_publishing.py` include isolated API validation, cross-project clip-ID rejection, safe attachment download, real four-ratio FFmpeg output/ZIP and a real 30s clip with source-time trim.
- Final validation: `backend/.venv/Scripts/python.exe -m pytest -q` — 22 passed (one Starlette/httpx deprecation warning); frontend production build including TypeScript passed; targeted ESLint and `git diff --check` passed.
- No manual/browser interaction test performed yet.
