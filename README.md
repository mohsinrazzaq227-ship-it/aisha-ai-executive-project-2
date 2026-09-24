# AI-EXECUTIVE

**A free / local-first autonomous agent operating environment.**
A Master Supervisor agent plans your request, classifies its risk, asks for your approval before anything consequential, coordinates specialist agents that operate real tools on your machine, and shows the whole thing as a live 3D office whose agent movement is driven by real backend state.

> The 3D world is not decoration. It is the visual interface of the agent system: every walk, handoff, speech bubble, error state and payload in the office comes from the same authoritative event stream that drives the task panel and the audit log.

---

## 1. What it is

AI-EXECUTIVE is a small local AI operating system, not a chatbot:

- **Master Supervisor (AISHA)** — receives your request, builds a structured plan, classifies every step as LOW / MEDIUM / HIGH risk, delegates, verifies, reports.
- **16 registered specialist agents** — research, browser, computer control, vision, files, documents, email, voice, script, visual, audio, video director, renderer, validation, asset management.
- **Real tools** — network research with genuine URLs, document extraction (PDF/DOCX/XLSX/CSV/TXT), filesystem work, shell execution behind a validator + approval, offline vector frame rendering, FFmpeg video production with FFprobe validation, diagnostics.
- **Human-in-the-loop by construction** — MEDIUM and HIGH risk actions stop the whole task and wait for you, with the exact parameters shown, hashed, and re-verified at execution time.
- **Multitasking** — several tasks run at once, each with its own run directory, artifact manifest and agent locks so two tasks never corrupt each other's state.
- **Cancellation that actually cancels** — pausing takes effect at a step boundary; cancelling aborts in-flight HTTP requests and kills real FFmpeg/shell processes on the host.

---

## 2. Install (Windows 10/11 x64)

1. Install **Node.js 20+** (https://nodejs.org) and **PostgreSQL 14+** (or point `DATABASE_URL` at any reachable PostgreSQL).
2. Extract `AI_EXECUTIVE_DESKTOP_AGENT.zip` anywhere (no fixed install path is required — all paths resolve at runtime).
3. Copy `.env.example` to `.env` and set `DATABASE_URL`. Everything else is optional.
4. Double-click **`Start-Agent.bat`**. It verifies Node, creates `.env`, installs dependencies with your explicit consent, applies the database schema, prints an environment summary and starts the app at `http://127.0.0.1:3000`.

Manual equivalent:

```bash
npm install
npx drizzle-kit push      # creates tables
npm run build && npm run start
```

### Optional: run inside Electron (desktop shell)

```bash
npm install electron --save-dev
npx electron desktop/main.cjs
```

`desktop/main.cjs` uses `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`, a preload channel allowlist, navigation blocking and a permission handler that grants only the microphone. If you prefer the browser runtime, every feature still works there — the desktop shell is packaging, not a different system.

---

## 3. First launch

1. Open `http://127.0.0.1:3000`.
2. Switch the right panel to **System** and press **Run diagnostics** (the AI-EXECUTIVE Doctor). It reports PASS / WARNING / FAIL / NOT_CONFIGURED / CLIENT_SIDE for: OS, CPU/RAM, Node, npm, Python, FFmpeg, FFprobe, fonts, Ollama, cloud opt-in, Whisper, TTS, research sources, Playwright, OCR, Windows control, email, database, filesystem permissions, ports, network reachability, desktop host layer and 3D renderer — each with an actionable explanation.
3. Talk to AISHA in the chat panel, or press and hold **CTRL + SPACE** and speak.
4. Watch the 3D office: the Master plans, an agent walks to a station, works, carries a payload back, hands it over, and reports.

---

## 4. Free / local-first: what is local and what is optional

| Capability | Local & free | Optional external service |
|---|---|---|
| Planning, risk classification, task state, approvals, audit | ✅ deterministic local planner (no API key needed) | Ollama (`OLLAMA_URL`) for richer prose; cloud LLM only if you set `AI_EXECUTIVE_ENABLE_CLOUD_LLM=true` **and** provide a key |
| Research with real citations | — | ✅ free public APIs: Wikipedia REST, OpenAlex, Hacker News Algolia (no keys) |
| Document extraction | ✅ PDF/DOCX/XLSX/CSV/TXT engines bundled | — |
| Frames, captions, MP4 render, validation | ✅ Sharp + OpenType vectors + bundled FFmpeg/FFprobe | — |
| Speech-to-text | ✅ browser/OS engine in the UI | faster-whisper server (`WHISPER_URL`) for local word-accurate transcripts |
| Text-to-speech | ✅ OS speech synthesis with real interruption | local Piper/Kokoro server (`TTS_URL`) to burn narration into MP4 |
| Email | ✅ drafts written as real `.eml` files | IMAP/SMTP/Gmail/Graph credentials for inbox and sending |
| Windows desktop control | ✅ on Windows (PowerShell-backed) | — |

**No silent fallbacks.** Every provider carries an explicit status (`AVAILABLE`, `UNAVAILABLE`, `DISABLED`, `ERROR`, `CLIENT_SIDE`, `OPTIONAL_UNTESTED`) and the UI shows which engine actually answered. If nothing is configured, the system says so instead of pretending.

---

## 5. The approval system

Every action is classified:

- **LOW** — read a file, list a directory, research public sources, analyse an upload, run diagnostics.
- **MEDIUM** — create/modify a file, write a report, render frames, run FFmpeg, access an inbox, create a draft.
- **HIGH** — delete anything, execute a shell command, send email, change system settings, desktop control.

Before a MEDIUM/HIGH action the task stops and a modal shows: agent, action, risk class, the **exact** parameters/command, target, reason, expiry countdown and the SHA-256 hash of the action. You can `Approve once`, `Approve for session`, `Modify` (which voids the approval and re-asks for the edited action) or `Deny`.

At execution time the supervisor recomputes the hash and verifies the signed approval token. **If anything changed, the token is invalid and you are asked again.** Denials are recorded, the task fails honestly, and nothing is executed.

---

## 6. Voice

- **Push-to-talk:** hold `CTRL + SPACE`.
- **Hands-free:** enable it and the app uses a live RMS voice-activity detector, 950 ms silence detection and chunked recording.
- **Interruption is real:** while AISHA is speaking, your voice cancels speech synthesis immediately and switches to listening.
- **States are visible:** `LISTENING`, `PROCESSING`, `SPEAKING`, `IDLE`, `MICROPHONE ERROR`, `NO SPEECH DETECTED`. If no speech is detected the app says so and never invents a transcript.
- Device selection, live input-level meter, permission diagnostics and a text fallback are always available.

---

## 7. Video generation (real, not a slideshow)

Pipeline: research → fact check → creative brief → script → storyboard → vector frames → audio → alignment → captions → FFmpeg render → FFprobe validation → atomic publish.

- The **Director** decides how many scenes the topic genuinely needs (never "two images for a 90 s video") and sets camera language, transitions, pacing and sound design.
- **Visual diversity** is enforced: title cards, parallax prose, mechanism rings, bar charts built from numbers found in the research, process flows, stat callouts, timelines, comparison tables, quote cards, source lists, icon grids and particle fields — different representations, not the same zoom six times.
- **Frames are rendered offline** with Sharp + real font glyph outlines (deterministic vector art, no image API, no cost), and captions are laid out using **measured glyph advances** so text never overflows its safe area.
- **Motion** (push-in, pull-out, lateral pan, parallax, orbit) is deterministic and reproducible from the scene spec.
- **Output:** MP4, H.264, AAC 192 kbit/s, 1080×1920, fps from config, `yuv420p`, `+faststart`, CRF from config.
- **Validation:** FFprobe reads the produced file and every claim is checked (container, codecs, resolution, frame rate, pixel format, audio sample rate, stream count, duration tolerance, file size). A failed check yields `FAILED_VALIDATION`, nothing is published, and diagnostics are kept. Publishing is atomic: temp render → validate → rename.

Honest limits: without `TTS_URL` no narration speech is generated — the video then contains a **synthesised score bed** and its artifact metadata says `providerMode: SYNTHETIC_SCORE_BED_ONLY`. Without `WHISPER_URL` there are no word-level timestamps; captions then use the **directed scene windows** and record `timingSource: SCENE_DURATION_PROPORTIONAL`. Both facts are written into the artifact metadata and the validation report, never hidden.

---

## 8. Where your files live

```
runs/<run_id>/     request.json, plan.json, approvals.json, events.json, manifest.json (sha256 per artifact)
                   research/ script/ storyboard/ images/ audio/ captions/ renders/ validation/ logs/ handles/
uploads/           your uploaded originals (never overwritten, hashed)
output/renders/    validated MP4 + SRT
data/documents/    reports written for you (new files only, unique names)
logs/              supervisor.log agents.log voice.log browser.log computer.log media.log security.log errors.log (rotated)
```

Every artifact is linked to its task, step, agent and manifest entry, and can be opened or downloaded from the task panel.

---

## 9. Security model

- Path normalisation and traversal prevention; every path is resolved inside an allowed scope (`workspace`, `documents`, `uploads`).
- Command validator: deny-list (filesystem destruction, drive formatting, power control, remote-script piping, encoded payloads, persistence, account/ownership changes) plus an optional allowlist in `config/app.json`.
- Per-tool timeouts, cancellation, approval tokens, audit log (`security_log` table + `logs/security.log`), secret redaction in logs and event payloads.
- `config/app.json` can widen scope (add allowlisted programs, disable realistic walking) — that is an explicit, logged user decision.
- Secrets never belong in this app: credentials are read from environment/OS stores and are never surfaced to prompts, logs, screenshots or the frontend. Email passwords must be supplied through environment variables or your OS credential store.

---

## 10. Troubleshooting & Doctor

| Symptom | What the system tells you |
|---|---|
| No narration in the MP4 | Provider panel shows `tts.server = DISABLED`; the artifact says `SYNTHETIC_SCORE_BED_ONLY`. Configure `TTS_URL`. |
| Captions say `SCENE_DURATION_PROPORTIONAL` | `WHISPER_URL` is not configured, so word-level timestamps do not exist. Nothing was guessed. |
| Research returns fewer sources | Per-engine status is reported (e.g. `wikipedia: OK, openalex: ERROR (timeout)`); failed engines are listed instead of silent gaps. |
| An agent reports ERROR in 3D | The task panel shows the exact tool, error and diagnostics, with **Retry failed steps**, **Change approach** (rephrase and resend) or **Cancel**. |
| Email features unavailable | `NOT_CONFIGURED` — the Email Agent explains which variables and optional packages are required. |
| Shell command refused | The validator blocked it and the reason is shown; widen `allowedCommands` only if you intend to. |
| Nothing happens when I speak | `MICROPHONE ERROR` or `NO SPEECH DETECTED` is displayed with the reason (permission, silence, engine missing). Text input always works. |
| 3D stutters | Switch the office to **Low power** in the left panel: agent logic is unchanged, only geometry/effects reduce. |

Run the Doctor any time from **System → Run diagnostics**; it re-checks binaries, providers, permissions, ports and network reachability.

---

## 11. Known limitations (stated plainly)

- The Windows-only desktop tools (window enumeration/focus, screenshots, clipboard) are **not available** on non-Windows hosts; the Computer Agent refuses and explains rather than simulating.
- Playwright DOM navigation is optional; without it the Browser Agent uses the HTTP extraction engine, which is reported per task.
- OCR requires a system Tesseract installation.
- Email requires IMAP/SMTP credentials plus the optional `imapflow`/`nodemailer` packages to be installed.
- The deterministic local planner is rule-based by design (auditable, no API cost). A local LLM (Ollama) greatly improves prose quality; a cloud model is available only with explicit opt-in.
- Python helpers (pywinauto/pynput OCR automation) are documented but not shipped as code, precisely so that nothing pretends to work (see `python/README.md`).

---

## 12. Project layout

```
src/app/          routes: dashboard + /api/{chat,tasks,approvals,uploads,artifacts,events,system,voice,health}
src/lib/          supervisor, planner, approvals, event bus, providers, doctor, nav graph, frame renderer
src/lib/tools/    registry (schema/risk/validators) + handlers (fs, knowledge, media, system)
src/components/   dashboard, 3D office, approvals, uploads, chat + voice
desktop/          Electron main/preload with the hardened security model
config/           app.json, providers.json
Start-Agent.bat   one-click launcher with consent prompts
```

## 13. License

MIT. Everything the app depends on is free/open source; every external capability is optional and switchable off.


## 14. Final verification (regenerated on demand)

The acceptance harness is resumable and everything it reports is read back from the running
system — no claim in it is asserted by hand:

```bash
node tests/run-checks.mjs submit   # submits the 11 acceptance scenarios
node tests/run-checks.mjs drive    # decides pending approvals, exercises real cancellation
node tests/run-checks.mjs report   # evaluates every scenario -> /tmp/ai-executive-report.json
node tests/run-checks.mjs matrix   # capabilities + acceptance -> CAPABILITY_MATRIX.md
node scripts/migrate.mjs --status  # explicit, versioned schema state (never auto-applied)
```

`CAPABILITY_MATRIX.md` is machine generated: one row per capability with the evidence its probe
produced, the full tool registry (risk / approval / host / timeout / path scope), and the
per-scenario acceptance results. A capability is only `AVAILABLE` after a probe executed real work,
and a scenario is only `PASS` when the artifacts, files and ffprobe output were actually read back.


## 15. Open items from the last acceptance run (honest status)

| Item | State | Detail |
|---|---|---|
| `TEST 1 · report artifact` | **NOT VERIFIED (open)** | The research and verification nodes completed and returned 8 live sources with 17–19 citable facts, but the `report.write` node was observed stuck in `RUNNING` with no error under concurrent task load. Diagnosis: connection-pool starvation (pg `Pool` default `max: 10` with no acquire timeout) — a step could wait forever instead of failing. Mitigation applied: pool bounded to 24 connections plus a 10 s acquire timeout and a 120 s statement timeout, so the same condition now surfaces as an explicit error. Re-verification of this scenario is pending; it is **not** reported as passing. |
| `TEST 7 · render` | **PASS with a caveat** | A validated 7.2 MB MP4 was produced (`output/renders/45-black-holes_*.mp4`, H.264/AAC, 1080x1920, 30 fps, yuv420p, every ffprobe check PASS). The earlier attempt correctly refused to publish with `FAILED_VALIDATION` because the synthesised audio bed was malformed; that defect was fixed (three separate `lavfi` sine inputs) and the next run produced real audio. |
| `TEST 10 · impossible path` | **FAIL (known behaviour)** | The planner normalises path hints, so an invented path such as `/definitely/not/a/real/path` resolves to the Documents root and the listing succeeds instead of failing. The resolved absolute path is printed in the step output, so the substitution is visible, but the intent is not honoured. Fix direction: reject unresolved absolute paths instead of falling back to Documents. |
| Windows UIA / input / screenshots / browser automation / OCR | **NOT VERIFIED here (implemented, host-gated)** | All of it is implemented and probed for real, but this verification host is Linux and has no Playwright/Tesseract installed, so the probes correctly return `UNAVAILABLE`/`NOT_CONFIGURED`. Run the harness on Windows 10/11 after `npm install playwright && npx playwright install chromium` to verify them. |
| Electron desktop shell | **NOT VERIFIED** | `desktop/main.cjs` + `desktop/preload.cjs` implement the hardened host (contextIsolation, sandbox, channel allowlist, navigation blocking, microphone-only permissions) and the capability probe detects the runtime, but Electron is not installed in this environment. |
