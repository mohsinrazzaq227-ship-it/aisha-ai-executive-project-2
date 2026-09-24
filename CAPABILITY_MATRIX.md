# AISHA — capability matrix

Statuses come from live probes (`GET /api/system`, `/api/doctor` behaviour) and from the
runtime acceptance suite (`POST /api/tests`). Vocabulary:
`AVAILABLE · AVAILABLE_BUT_OPTIONAL · MISCONFIGURED · MISSING · FAILED · DISABLED · UNAVAILABLE`.

"Windows target" describes the intended deployment (Win 11, i7-1195G7, 16 GB, no CUDA,
Ollama installed, `pip install -r python/requirements.txt`). "This measurement host" is the
environment in which the suite below was executed (Linux, no root, no Ollama, no sidecar
packages, no email credentials).

| Area | Capability | Implementation | Windows target | This measurement host |
| --- | --- | --- | --- | --- |
| Core | Node runtime | yes | AVAILABLE | AVAILABLE (v22) |
| Core | PostgreSQL + Drizzle, 14 tables | yes | AVAILABLE | AVAILABLE (PostgreSQL 15.16) |
| Core | Versioned migration runner (checksummed, transactional) | yes | AVAILABLE | AVAILABLE |
| Core | Workspace read/write round-trip | yes | AVAILABLE | AVAILABLE |
| Core | Tool registry (39 tools, risk + verification contracts) | yes | AVAILABLE | AVAILABLE |
| Core | Resource governor (LIGHT/MEDIUM/HEAVY/EXCLUSIVE + deferral) | yes | AVAILABLE | AVAILABLE |
| Supervisor | Deterministic planner (composite multi-branch DAG) | yes | AVAILABLE | AVAILABLE |
| Supervisor | Ollama planner (strict JSON, validated against registry) | yes | AVAILABLE with models | UNAVAILABLE (Ollama not running) |
| Supervisor | Parallel branches, dependency gates, retry, cancellation with verified teardown | yes | AVAILABLE | AVAILABLE |
| Supervisor | Restart recovery of stale tasks | yes | AVAILABLE | AVAILABLE |
| Agents | 16 specialists, single registry, station + risk ceiling | yes | AVAILABLE | AVAILABLE |
| Approvals | Risk classes, action hash, token, expiry, deny/expire handling | yes | AVAILABLE | AVAILABLE |
| Security | Deny-list, path confinement, Windows-path detection on foreign hosts, audit log | yes | AVAILABLE | AVAILABLE |
| Files | read/write/copy/move/list/mkdir/hash/zip archive/approval-gated delete | yes | AVAILABLE | AVAILABLE |
| Documents | TXT/MD/JSON/CSV/PDF/DOCX/XLSX/HTML generation with structural re-parse | yes | AVAILABLE | AVAILABLE |
| Documents | Extraction: PDF (unpdf), DOCX (mammoth), XLSX (exceljs) | yes | AVAILABLE | AVAILABLE |
| Data | CSV/JSON analysis with independent recount | yes | AVAILABLE | AVAILABLE |
| Research | Wikipedia REST + OpenAlex retrieval, per-engine failure reporting, artifact dossier | yes | AVAILABLE with network | AVAILABLE |
| Browser | Playwright navigation, DOM facts, screenshots, verification | yes | AVAILABLE after `npx playwright install chromium` | UNAVAILABLE — Chromium downloaded but cannot start: `libnspr4.so`/`libnss3.so` missing (no root to install) |
| Browser | Form fill + submit with post-action confirmation assertion | yes | AVAILABLE | UNAVAILABLE (same Chromium limitation) |
| Computer | Window enumeration + focus (UI Automation) | yes (pywinauto) | AVAILABLE after pip install | UNAVAILABLE — Windows-only API |
| Computer | Semantic UI Automation find/invoke/fill with read-back | yes (pywinauto) | AVAILABLE after pip install | UNAVAILABLE — Windows-only API |
| Computer | Mouse/keyboard input with OS read-back | yes (pyautogui) | AVAILABLE after pip install | UNAVAILABLE — Windows-only API |
| Computer | PowerShell execution path (validated, approval-gated) | yes | AVAILABLE | UNAVAILABLE — host is Linux; `system.shell` uses `/bin/sh` there |
| Vision | Screen capture (mss / import / scrot) | yes | AVAILABLE after pip install | UNAVAILABLE — no `DISPLAY` in this server context |
| Vision | OCR (pytesseract / tesseract) | yes | AVAILABLE after install | UNAVAILABLE — tesseract binary not installed |
| Voice | STT local engine (faster-whisper via sidecar or WHISPER_URL) | yes | AVAILABLE after pip install / service | UNAVAILABLE — no engine configured |
| Voice | TTS local engine (TTS_URL: piper/kokoro) | yes | AVAILABLE after service | UNAVAILABLE — no engine configured |
| Voice | Browser SpeechRecognition / SpeechSynthesis | yes, labelled `CLIENT_SIDE` | CLIENT_SIDE | CLIENT_SIDE |
| Email | IMAP inbox/read/search (imapflow) | yes | AVAILABLE with credentials | UNAVAILABLE — `IMAP_URL` unset |
| Email | SMTP send (nodemailer) behind mandatory approval | yes | AVAILABLE with credentials | UNAVAILABLE — `SMTP_URL` unset |
| Media | Deterministic PNG composer (native encoder, IHDR decoded) | yes | AVAILABLE | AVAILABLE |
| Media | ffmpeg render + ffprobe validation | yes (ffmpeg-static) | AVAILABLE | AVAILABLE |
| Media | SRT captions, storyboard, creative brief with provider decision | yes | AVAILABLE | AVAILABLE |
| Media | AI image generation | provider adapter | AVAILABLE when configured | DISABLED — no provider configured |
| Media | AI video generation | provider adapter | AVAILABLE when configured | DISABLED — no provider configured |
| 3D office | Server-projected state, geometry-derived walks, real handoffs | yes | AVAILABLE | AVAILABLE |
| Events | Single authoritative stream consumed by UI, tasks and office | yes | AVAILABLE | AVAILABLE |
| Artifacts | sha256, byte size, origin, validation method, producer traceability | yes | AVAILABLE | AVAILABLE |
| Diagnostics | Doctor with per-capability probes and evidence | yes | AVAILABLE | AVAILABLE |
| Desktop | Electron host (hardened) | yes, `desktop/` | AVAILABLE after `npm i -D electron` | MISSING — electron package not installed (documented, optional) |
| Startup | `Start-AISHA.bat` (validate → migrate → probe → build → start) | yes | AVAILABLE | n/a (Linux host) |
| Testing | Runtime acceptance suite, 39 checks, persisted history | yes | AVAILABLE | AVAILABLE (32 PASS / 0 FAIL / 7 UNAVAILABLE) |

## How to re-measure

```bash
curl -s localhost:3000/api/system | jq '.doctor.capabilities[] | {label, status, detail, fix}'
curl -s -X POST localhost:3000/api/tests -H 'content-type: application/json' \
     -d '{"confirm":"run-acceptance-suite"}' | jq '{passed, failed, total, results}'
node scripts/run-verification.mjs http://127.0.0.1:3000   # regenerates docs/VERIFICATION.md
```

Nothing in this table is aspirational: each row maps to code that runs, and to a probe that
will report the true state on your machine.
