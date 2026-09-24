# AISHA — verification report

Generated: 2026-09-24T02:30:41.256Z
Base URL: http://127.0.0.1:3000
Health: ok (database=ok, migrations=ok, supervisor=ok, tools=ok)

## Runtime acceptance summary

- PASS: 32
- FAIL: 0
- UNAVAILABLE (probed, absent on this host, reason recorded): 7
- total checks: 39 in 9902 ms

## Per-area result

| Area | PASS | FAIL | UNAVAILABLE |
| --- | --- | --- | --- |
| CORE | 7 | 0 | 0 |
| SUPERVISOR | 4 | 0 | 0 |
| FILES | 2 | 0 | 0 |
| SECURITY | 4 | 0 | 0 |
| APPROVAL | 3 | 0 | 0 |
| DOCUMENTS | 2 | 0 | 0 |
| DATA | 1 | 0 | 0 |
| RECOVERY | 1 | 0 | 0 |
| 3D | 3 | 0 | 0 |
| MEDIA | 3 | 0 | 0 |
| BROWSER | 0 | 0 | 2 |
| VISION | 0 | 0 | 3 |
| VOICE | 1 | 0 | 0 |
| EMAIL | 1 | 0 | 1 |
| OLLAMA | 0 | 0 | 1 |

## Every check

| Area | Check | Status | ms | Evidence / reason |
| --- | --- | --- | --- | --- |
| CORE | Database round-trip | PASS | 4 | events 804 → 805 |
| CORE | Tool registry integrity | PASS | 0 | 39 unique tools; every tool declares availability + verification note |
| CORE | Agent registry seeded (16) | PASS | 1 | 16 agent state rows for 16 definitions |
| CORE | Resource governor | PASS | 1 | NORMAL: 3379MB free of 3940MB, 4 cores — within configured limits |
| CORE | Runtime configuration | PASS | 0 | maxConcurrentSteps=4, approval TTL=15min |
| SUPERVISOR | Intent classification | PASS | 1 | all 5 intents classified as expected |
| SUPERVISOR | Deterministic planner builds a runnable DAG | PASS | 1 | 5 steps, 4 parallel roots, all tool ids real, graph acyclic, research→report→email linked |
| FILES | Write + read + hash | PASS | 19 | write/read SUCCESS, sha256 f373a267ec04… verified twice |
| FILES | Copy + zip archive | PASS | 18 | copy verified by hash, archive registered as artifact |
| SECURITY | Protected system path refused | PASS | 1 | both protected roots refused (path is inside a protected system location (C:\Windows) / path is inside a protected system location (/etc)) |
| APPROVAL | HIGH-risk tool blocked without approval | PASS | 4 | fs.delete BLOCKED by the approval gate; file untouched |
| APPROVAL | Approval token hash mismatch rejected | PASS | 2 | mismatched action hash rejected (fs.delete approval token does not match the current parameters (hash mismatch)) |
| APPROVAL | Granted approval executes and verifies | PASS | 7 | delete executed with a matched hash and post-condition check |
| DOCUMENTS | PDF/DOCX/XLSX/CSV/JSON/MD generation | PASS | 184 | 7 formats generated and re-parsed: pdf, docx, xlsx, csv, json, md, txt |
| DOCUMENTS | Artifacts hash-verified on disk | PASS | 3 | 5 artifact(s) re-read from disk with matching sha256 |
| DATA | CSV analysis with independent recount | PASS | 9 | price sum 361 matches 120+98+143 |
| CORE | Host diagnostics | PASS | 19 | linux · Intel(R) Xeon(R) Processor @ 2.60GHz |
| CORE | Process inventory | PASS | 19 | listed 6 process row(s) |
| SECURITY | Forbidden commands blocked | PASS | 1 | all 5 destructive patterns refused by the validator |
| SECURITY | Audit log written for scan decisions | PASS | 8 | audit_logs 13 → 14 |
| SECURITY | Shell requires approval before execution | PASS | 5 | shell refused without approval; 6 blocked attempt(s) recorded in tool_runs, 0 ever executed |
| SUPERVISOR | Create → plan → execute → approval → deny → cancel | PASS | 3146 | task WAITING_APPROVAL; 3 parallel roots; denial → BLOCKED observed; 2 verified steps; cancel=(cancellation verified) |
| SUPERVISOR | Cancellation verified in persisted state | PASS | 6274 | abort observed, no step left RUNNING, evidence persisted: {"aborted":true,"verifiedAt":"2026-09-24T02:30:38.571Z","stillRunning":[],"runningBefore":[{"tool":"research.search","stepId":"s_642ff6df61a54f1da8ae"},{"tool":"research.search","s |
| RECOVERY | Restart recovery reconciles stale state | PASS | 29 | 2 stale task(s) reconciled; step marked CANCELLED; task.recovery event emitted |
| 3D | Office geometry and walk timing are derived, not faked | PASS | 0 | distance-based walk: 5419ms (realistic) vs 1144ms (cinematic) from (-9,-2) → (0,-7) |
| 3D | 3D office is driven by the same event stream | PASS | 4 | 14 event topics observed in the single authoritative stream |
| 3D | Agent states map to real task activity | PASS | 2 | 16 agents carry office positions; 823 agent-attributed events |
| MEDIA | Deterministic PNG scene composition | PASS | 23 | PNG composed, IHDR-decoded and registered (1 artifact) |
| MEDIA | ffmpeg render validated by ffprobe | PASS | 87 | MP4 rendered and ffprobe-verified (640x360) |
| MEDIA | SRT caption generation | PASS | 9 | 2 caption cue(s) written to selftest-captions.srt |
| BROWSER | Playwright navigation + DOM + screenshot | UNAVAILABLE | 0 | chromium is downloaded but cannot start: missing OS libraries (libnspr4.so) — the browser binary exists, execution does not. Loader said: /home/user/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome: error while loading shared libraries: libnspr4.so: cannot open shared object file: No such fi |
| BROWSER | Form fill requires post-action confirmation | UNAVAILABLE | 0 | chromium is downloaded but cannot start: missing OS libraries (libnspr4.so) — the browser binary exists, execution does not. Loader said: /home/user/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome: error while loading shared libraries: libnspr4.so: cannot open shared object file: No such fi |
| VISION | Screen capture on this host | UNAVAILABLE | 6 | import found but no DISPLAY is set for this process — fix: run AISHA inside a desktop session or on Windows |
| VISION | Windows UI Automation | UNAVAILABLE | 0 | Windows computer control is not available on linux: UI Automation (pywinauto), synthetic input (pyautogui) and window control are Windows-only APIs |
| VISION | OCR over a real image | UNAVAILABLE | 5 | tesseract binary not installed — fix: apt-get install tesseract-ocr (or winget install tesseract) |
| VOICE | Voice pipeline truthfulness | PASS | 3 | STT: python sidecar (faster-whisper missing) (MISSING) · TTS: none configured (UNAVAILABLE) · browser fallback documented as CLIENT_SIDE; transcribe returned UNAVAILABLE |
| EMAIL | IMAP/SMTP connectors | UNAVAILABLE | 1 | IMAP_URL not configured — fix: set IMAP_URL=imaps://user:password@host:993 in .env |
| EMAIL | Sending email is impossible without approval | PASS | 4 | email.send no SMTP transport configured, so nothing could be transmitted; 0 message(s) ever sent by this tool |
| OLLAMA | Local model discovery | UNAVAILABLE | 1 | unreachable: TypeError: fetch failed — models found: 0; deterministic planner in use |

## Capability verdicts from /api/doctor (live probes)

| Capability | Status | Detail | Fix |
| --- | --- | --- | --- |
| Node.js runtime | AVAILABLE | v22.22.1 on linux-x64 | — |
| PostgreSQL database | AVAILABLE | PostgreSQL reachable; 14 public tables (probe 10ms) | — |
| Workspace (read/write) | AVAILABLE | write+read+delete verified in /app/workspace | — |
| Ollama local LLM | UNAVAILABLE | unreachable: TypeError: fetch failed (deterministic planner will be used instead) | start ollama (ollama serve) or set OLLAMA_URL |
| ffmpeg + ffprobe | AVAILABLE | /app/node_modules/ffmpeg-static/ffmpeg · /app/node_modules/ffprobe-static/bin/linux/x64/ffprobe | — |
| Playwright + Chromium | MISCONFIGURED | chromium is downloaded but cannot start: missing OS libraries (libnspr4.so) — the browser binary exists, execution does not. Loader said: /home/user/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome: error while l | install the browser OS dependencies: npx playwright install-deps chromium (requires root/sudo) |
| Python sidecar | AVAILABLE_BUT_OPTIONAL | sidecar online on Linux 6.1.158 (host is linux: Windows-only actions remain unavailable) | — |
| Windows UI Automation (pywinauto) | MISSING | not importable in the sidecar interpreter | pip install -r python/requirements.txt |
| Synthetic mouse/keyboard (pyautogui) | MISSING | not importable in the sidecar interpreter | pip install -r python/requirements.txt |
| Screen capture (mss) | MISSING | not importable in the sidecar interpreter | pip install -r python/requirements.txt |
| OCR (pytesseract + tesseract) | MISSING | not importable in the sidecar interpreter | pip install -r python/requirements.txt |
| Speech-to-text (faster-whisper) | MISSING | not importable in the sidecar interpreter | pip install -r python/requirements.txt |
| PowerShell execution | UNAVAILABLE | host is linux; system.shell uses /bin/sh and refuses Windows-only syntax | — |
| Screen capture on this host | MISCONFIGURED | /usr/bin/import found; DISPLAY is NOT set for this process, so capture will fail with a real error | install imagemagick or run a desktop session |
| Speech-to-text engine | MISSING | faster_whisper is not importable in the sidecar interpreter | pip install faster-whisper |
| Text-to-speech engine | UNAVAILABLE | no TTS_URL configured | run piper/kokoro behind an HTTP endpoint and set TTS_URL |
| IMAP + SMTP email | MISCONFIGURED | no email credentials configured (tools report UNAVAILABLE, nothing is faked) | set IMAP_URL and SMTP_URL in .env |
| AI image/video providers | DISABLED | AI image provider not configured; AI video provider not configured. Deterministic PNG/ffmpeg rendering is always labelled deterministic. | set AISHA_IMAGE_API_URL/AISHA_VIDEO_API_URL + keys to enable AI generation |
| Electron desktop shell | MISSING | electron is not installed (the web runtime is fully functional without it) | npm install --save-dev electron  (then: npx electron desktop/main.cjs) |
| Environment variables | AVAILABLE | DATABASE_URL=set · OLLAMA_URL=unset · WHISPER_URL=unset · TTS_URL=unset · IMAP_URL=unset · SMTP_URL=unset · AISHA_APPROVAL_SECRET=unset | — |
| Resource headroom | AVAILABLE | cpu 37% · free 3380MB of 3940MB · load/core 0.36 · disk free 17077MB — within configured limits | — |
| Tool registry | AVAILABLE | 39 tool(s) registered across 11 group(s) | — |

> Deterministic renders are never reported as AI generation. UNAVAILABLE entries are host limitations, not passes.
