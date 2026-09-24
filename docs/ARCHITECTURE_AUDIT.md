# Architecture audit — Project 1 vs Project 2 vs final AISHA

Read-only audit performed before any code was written, using the GitHub trees of both
repositories (`svgaisha-ai-executive-project-1`, 206 files; `aisha-ai-executive-project-2`,
410 files) and their `package.json`, `config/*.json`, `.env.example`, `desktop/*.cjs`,
`python/worker/aisha_worker.py` and `migrations/*.sql`.

Both projects are Next.js + Drizzle + PostgreSQL applications; neither ships a compiled
Electron dependency in `package.json` — Electron is a host wrapper (`desktop/main.cjs`)
that starts the local service and loads it with a hardened preload bridge.

## Decision matrix

| Capability | Project 1 | Project 2 | Final decision | Implementation source |
| --- | --- | --- | --- | --- |
| Supervisor | yes (single orchestration file) | yes (stronger lifecycle + approvals) | keep one supervisor, strengthen verification/retry | Project 2, extended |
| Agents | 16 specialists with identity/station/voice | fewer, thinner | keep the rich registry, make it the single registry | Project 1 concept, Project 2 discipline |
| Task DAG | sequential steps | `plan_steps` with `depends_on`, `parallel`, `resource_class`, `attempts` | DAG with real parallel branches + deferral | Project 2 |
| Approvals | modal UX | action hash + expiry + audit + token | keep Project 2 enforcement, add Project 1 UX | Project 2 + Project 1 UX |
| Electron | wrapper | wrapper with permission/allowlist hardening | keep hardened host, document install as optional | Project 2 |
| Windows control | limited conceptual | Python sidecar with pywinauto/pyautogui/mss | keep sidecar protocol; tools report UNAVAILABLE off-Windows | Project 2 |
| UI Automation | mentions | real worker actions (`uia.find/read/invoke/fill`) | exposed as `computer.uia` with read-back verification | Project 2 |
| Mouse / Keyboard | no | `pyautogui` actions | `computer.input` with OS read-back | Project 2 |
| Browser | HTTP fetch engine | Playwright dependency declared | real Playwright + launch-verified capability probe | Project 2, strengthened |
| Vision | no | mss capture + pytesseract OCR | `computer.capture_screen` + `vision.ocr` | Project 2 |
| OCR | no | pytesseract | real sidecar/tesseract call, MISSING when absent | Project 2 |
| Voice STT | API route (client side) | faster-whisper sidecar + browser fallback | local engine first, browser API labelled CLIENT_SIDE | Project 2 |
| Voice TTS | API route (client side) | piper/kokoro HTTP | TTS_URL engine, browser fallback labelled CLIENT_SIDE | Project 2 |
| Ollama | lib/llm.ts | lib/llm.ts + provider status | single client, live model discovery, deterministic fallback named in the task row | Project 2 |
| Email | stub | imapflow/nodemailer declared, HIGH risk | real IMAP/SMTP, UNAVAILABLE without credentials, approval-gated send | Project 2 |
| Documents | text render | unpdf/mammoth/opentype/sharp | TXT/MD/JSON/CSV/PDF/DOCX/XLSX with structural re-parse | Project 2 packages, new composition step |
| Media generation | deterministic text/vector renderer | ffmpeg-static + textrender | provider abstraction: deterministic PNG/ffmpeg vs configured AI API, always labelled | both, corrected labelling |
| FFmpeg | declared | ffmpeg-static + ffprobe validation | render + ffprobe stream/duration validation | Project 2 |
| 3D office | yes (concept-rich) | minimal | keep it, drive it from the single event stream with server-computed geometry | Project 1 concept, new server projection |
| Artifact system | present | present with manifest/validation | one table, hash + origin + validation + producer | Project 2 |
| Audit logs | file logs | DB audit + security log | DB audit log + structured event stream | Project 2 |
| Security | deny-list | deny-list + allowlist + approval hashing | keep and extend (Windows-path detection on foreign hosts) | Project 2 |
| Diagnostics | doctor (partly assumed) | doctor with probe vocabulary | doctor that never assumes Windows implies capability | Project 2 vocabulary, stricter probes |
| Resource management | mentions | config in app.json | live governor with LIGHT/MEDIUM/HEAVY/EXCLUSIVE admission + deferral reasons | Project 2 concept, implemented |
| Startup | Start-Agent.bat | Start-Agent.bat | one `Start-AISHA.bat` that validates, migrates, probes, builds, starts | both |
| Testing | run-checks.mjs | run-checks.mjs | runtime acceptance suite executing the real system, persisted to `test_runs` | both, expanded |

## Rejections (deliberate)

* **No second supervisor, agent list, tool registry, database, event bus, media pipeline,
  browser layer or security layer** from either project was copied wholesale.
* Project 1's weaker runtime pieces (thin tool metadata, no approval hashing) were not
  adopted; its *concepts* (agent identity, stations, handoffs, approval UX, office) were.
* Project 2's assumptions that Windows availability implies capability availability were
  replaced with live probes that also attempt execution (browser launch, ffmpeg render,
  sidecar import checks).
* No mock success path, no placeholder provider, no "TODO" behaviour was carried over.

## Environment limitation discovered during the audit

The reference projects targeted Windows 10/11 with Python sidecar packages installed.
This implementation environment is Linux without root, so Windows-only capabilities
(UI Automation, synthetic input, window control), OCR (tesseract binary) and Playwright
(Chromium is downloaded but cannot load `libnspr4.so`/`libnss3.so`) cannot be executed
here. AISHA implements them fully and reports each as UNAVAILABLE with the exact probe
reason and fix command — never as a pass. See `docs/VERIFICATION.md`.
