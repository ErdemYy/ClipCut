# ClipCut project guidance

- Read `.ai/TASK_STATE.md` for the latest implementation status and known limits.
- Use the local Graphify graph before architecture/impact searches:
  `graphify query "<question>" --budget 1500`.
- Verify relevant source and tests before editing; graph relationships are navigation aids, not proof.
- Refresh after code changes with `./graphify.bat` (or `./graphify.ps1` when PowerShell policy permits); outputs stay local in ignored `graphify-out/`.
- The graph covers source code and project documentation. Runtime storage, stock media and decorative assets are excluded.
- Follow additional `frontend/AGENTS.md` guidance for frontend work.
- Do not invoke paid AI/TTS services to validate changes; use mock mode and local FFmpeg tests.
