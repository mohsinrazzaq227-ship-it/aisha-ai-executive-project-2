# AISHA — local-first AI Executive

One coherent system: a **Master Supervisor**, **16 specialist agents**, **39 real tools**,
a **single authoritative event stream**, **human-in-the-loop approvals**, **verified
artifacts**, and a **3D office** that shows what is actually happening.

AISHA is built as: **runtime/engineering from the canonical Project 2 foundation**, plus
**product/experience concepts from Project 1** (richer agent identity, stations, walking
handoffs, approval UX, office, media director). There is exactly one supervisor, one tool
registry, one database, one event stream, one security layer. See
[`docs/ARCHITECTURE_AUDIT.md`](docs/ARCHITECTURE_AUDIT.md).

> **No fake capability detection. No mock success. No unverified claims.**
> Anything AISHA cannot do on a given machine is reported as `UNAVAILABLE` with the real
> probe reason and the exact fix command. See [`docs/VERIFICATION.md`](docs/VERIFICATION.md).

---

## 1. Quick start

```bash
# 1. environment
cp .env.example .env         # set DATABASE_URL; everything else is optional

# 2. schema (safe, repeatable; also applied by the migration runner on boot)
npx drizzle-kit push

# 3. run
npm install
npm run build && npm run start       # http://127.0.0.1:3000
```

Windows one-command path: **`Start-AISHA.bat`** — validates Node, installs dependencies,
applies migrations, probes Ollama and the Python sidecar, builds, starts, opens the UI.

Health: `GET /api/health` · Doctor: `GET /api/system` · Suite: `POST /api/tests {"confirm":"run-acceptance-suite"}`

Optional Electron desktop host (hardened: `contextIsolation`, `sandbox`, no
`nodeIntegration`, allow-listed preload bridge):

```bash
npm install --save-dev electron
npx electron desktop/main.cjs
```

## 2. Architecture

```
AISHA UI (chat · tasks · approvals · events · 3D office · capabilities · verification)
        │  HTTP + SSE (one event stream)
        ▼
Master Supervisor  ──► plan / risk-classify / delegate / observe / verify / recover / report
        ▼
Task DAG engine    ──► parallel independent branches, dependency waits, retries, cancellation
        ▼
16 specialist agents (research, browser, computer, files, documents, email, code, data,
                      media director, image, video, voice, QA, security, ops, supervisor)
        ▼
Tool registry (39 tools: risk class · resource class · allowed agents · verification contract)
        ▼
system · fs · docs · data · web · email · media · voice · computer/vision · qa · security
        ▼
Playwright · ffmpeg/ffprobe · pdf-lib/docx/exceljs · imapflow/nodemailer · Python sidecar
(pywinauto / pyautogui / mss / pytesseract / faster-whisper) · PostgreSQL (Drizzle)
```

## 3. Mandatory action lifecycle

Every step runs `PLAN → RISK CLASSIFY → APPROVAL (if required) → EXECUTE → OBSERVE →
VERIFY → COMMIT → ARTIFACT/STATE → REPORT`. The supervisor does not trust a tool's own
status: a `SUCCESS` with no evidence becomes `VERIFICATION_FAILED`, and every registered
artifact is re-read from disk and re-checked before a step can be reported successful.

Statuses: `SUCCESS · FAILED · TIMEOUT · CANCELLED · BLOCKED · WAITING_APPROVAL · UNAVAILABLE · VERIFICATION_FAILED`.

## 4. Commands to try in the console

| Ask | What actually happens |
| --- | --- |
| `research the local AI market and prepare an executive report as PDF` | 2 parallel research branches (Wikipedia REST + OpenAlex, re-fetched for verification) → `report.write` (MD+PDF reparsed) → `doc.generate` (PDF reparsed) → 5 artifacts with hashes |
| `run host diagnostics and check the process list` | host/resources in parallel; the shell step stops at the approval gate, and a denial leaves it `BLOCKED` with evidence |
| `create a 3-scene deterministic video with captions` | brief → PNG scene cards (IHDR-decoded) → ffmpeg MP4 validated by ffprobe (resolution + duration), SRT cues |
| `analyse workspace/datasets/sample.csv and summarise the price column` | real CSV parse, per-column statistics, independent recount, Markdown analysis artifact |
| `browse https://example.com` | Playwright navigation + DOM facts + PNG screenshot — or `UNAVAILABLE` with the Chromium launch reason |
| `send an email to "you@example.com" saying the report is ready` | draft artifact (safe) + a HIGH-risk send step that cannot execute without your approval; requires `SMTP_URL` |

## 5. Agents

16 agents with identity, role, personality, capabilities, permitted tools, risk ceiling,
office station and voice profile (`GET /api/agents`). The supervisor selects only the
agents a task needs — no task is pushed through every specialist.

States emitted to the office and the event log: `IDLE · THINKING · PLANNING · WORKING ·
RESEARCHING · WAITING · REQUESTING_APPROVAL · HANDING_OFF · RECEIVING · VERIFYING ·
SUCCESS · FAILED`.

## 6. 3D office (`/office`)

Not decorative. `/api/agents` returns each agent's **persisted** state, station, position
and walk window (`startedAt` + geometry-derived `durationMs`); the client interpolates
server truth instead of inventing animation. A successful step triggers a real handoff:
`agent.walk.started` → `handoff.started` → `handoff.completed` → return. Approval requests
walk the requesting agent to the Security Gate. All of it comes from the same rows the task
engine writes.

## 7. Security and approvals (`/security`)

* Hard deny-list: drive format/partition, raw device write, recursive system deletion,
  security disabling, account/privilege escalation, registry persistence, credential
  extraction, remote script execution, backup destruction.
* Path confinement: protected system roots and the workspace boundary are enforced on
  every read/write/delete — including Windows paths judged as Windows paths when AISHA
  runs on another host.
* Approvals: HIGH/CRITICAL tools require a granted approval whose **action hash matches the
  exact current parameters**; tokens expire (15 min default) and mismatches are refused and
  audited. Denial or expiry leaves the step `BLOCKED` — never silently executed.
* Audit log: every validator/approval decision is persisted (`/api/security` UI, `/api/system?section=audit`).

## 8. Capabilities and honesty rules

`GET /api/system` returns the live doctor: Node, PostgreSQL, workspace round-trip, Ollama
+ model discovery, ffmpeg/ffprobe, Playwright (which **launches a browser** to prove it),
Python sidecar + per-package import checks, PowerShell, screen capture, STT/TTS engines,
email credentials, AI media providers, environment, resources, tool registry, Electron.

Statuses: `AVAILABLE · AVAILABLE_BUT_OPTIONAL · MISCONFIGURED · MISSING · FAILED · DISABLED · UNAVAILABLE`.
A downloaded Chromium that cannot load its OS libraries is reported `MISCONFIGURED` with the
loader error — never `AVAILABLE`.

## 9. Voice, email, media, documents

* **Voice** — `GET /api/voice` reports engines honestly: local `WHISPER_URL`/`TTS_URL` or
  the sidecar's `faster-whisper`; browser `SpeechRecognition`/`SpeechSynthesis` are exposed
  as `CLIENT_SIDE` fallbacks and are described as such. Recorded audio is written to
  `uploads/voice/` before transcription, so an empty transcript cannot be invented.
* **Email** — real IMAP listing (`imapflow`), draft artifacts, and SMTP send that returns
  the server's own accepted/messageId response. Without credentials the tools report
  `UNAVAILABLE` with the missing env var.
* **Media** — provider abstraction: deterministic PNG composer (native encoder, IHDR
  verified), ffmpeg renderer (ffprobe-validated), SRT captions, and AI image/video only when
  `AISHA_IMAGE_API_URL`/`AISHA_VIDEO_API_URL` are configured. Origin is recorded per
  artifact (`deterministic` vs `ai-generated`).
* **Documents** — TXT/MD/JSON/CSV/PDF/DOCX/XLSX generation with structural re-parse, plus
  extraction from PDF (`unpdf`), DOCX (`mammoth`) and XLSX (`exceljs`).

## 10. Resources

Target machine class: i7-1195G7, 16 GB RAM, Intel Iris Xe, no CUDA, Windows 11.
The governor samples CPU, load/core, free RAM, disk and active steps; steps carry
`LIGHT · MEDIUM · HEAVY · EXCLUSIVE` classes; HEAVY/EXCLUSIVE work is admitted or
**deferred with a reason shown in the task graph** (`step.deferred` event) instead of
thrashing the machine.

## 11. Configuration

Everything is environment-driven (`.env.example` documents every key): database, Ollama,
sidecar/python, speech, media binaries, browser, email, AI media providers, approval
secret, workspace, resource floors. `config/app.json` holds autonomy/concurrency/upload
policy, `config/providers.json` declares provider status vocabulary.

## 12. Testing and verification

```bash
npm run typecheck                                    # TypeScript
npm run lint                                         # ESLint
curl -X POST localhost:3000/api/tests -H 'content-type: application/json' \
     -d '{"confirm":"run-acceptance-suite"}'         # 39 runtime checks
node scripts/run-verification.mjs http://127.0.0.1:3000   # writes docs/VERIFICATION.md
```

The suite executes the real system: database round-trip, registry integrity, planner DAG,
file write/read/hash/copy/archive, protected-path refusal, approval required/hash-mismatch/
granted, document generation per format, artifact hash re-read, CSV analysis, host
diagnostics, process listing, forbidden-command blocking, audit writes, the full task
lifecycle (plan → parallel execution → approval requested → denied → `BLOCKED` → cancel),
verified cancellation, restart recovery, office geometry/event coverage, media renders,
browser automation, vision, voice, email gates, Ollama discovery.

## 13. Limitations (as measured, not guessed)

From the last run on this machine (Linux, no root, no Ollama, no sidecar packages):

* **Browser automation** — implemented and probe-verified, but Chromium cannot start here
  (`libnspr4.so`/`libnss3.so` missing). Fix: `npx playwright install-deps chromium` (root) or run on a desktop host.
* **Windows computer use / UI Automation / synthetic input** — implemented through the
  sidecar; Windows-only APIs, so `UNAVAILABLE` off-Windows (this host).
* **Screen capture** — no `DISPLAY` in this server context; the binary is present, capture fails with a real error.
* **OCR** — the `tesseract` binary is not installed here; the tool reports `MISSING` with the install command.
* **Email** — no IMAP/SMTP credentials configured; tools report `UNAVAILABLE`/`MISCONFIGURED`.
* **Ollama** — not running here; every task therefore states `engine: DETERMINISTIC`, and the UI names the engine that planned it.
* **AI image/video providers** — not configured; deterministic renderers are used and labelled as such.

Each of these becomes `AVAILABLE` automatically once the dependency exists — the probe is
live, never cached as a claim.
