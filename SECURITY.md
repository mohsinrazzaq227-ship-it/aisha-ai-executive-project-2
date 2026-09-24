# AISHA AI-EXECUTIVE — security model

## 1. Authority model
* There is exactly **one authority**: the Master Supervisor (`src/lib/supervisor.ts`).
  Specialist agents cannot invoke a tool, spawn a process or write a file on their own;
  every action is a node in a supervisor-owned task graph.
* Privileged work never bypasses the approval layer. The gate is evaluated from the
  database (`approvals`), not from a UI flag, so a modified renderer cannot self-approve.

## 2. Risk classification (registry-enforced)
Every tool declares its own risk in `src/lib/tools/registry.ts`:
`LOW` (read/research/diagnostics), `MEDIUM` (write a file, render frames, navigate, create
a draft, send input), `HIGH` (delete, shell execution, send email, external communication).
`requiresApproval` is part of the tool definition; the planner can never weaken it.

## 3. Approval tokens
Granting an approval writes a record containing the **SHA-256 hash of the exact action**
(tool id + parameters + task + step + agent) and a signed token
(`sha256(approvalId:parametersHash:APPROVAL_SECRET)`). At execution time the supervisor
re-computes the hash and verifies the token:
* hash mismatch → `TOKEN INVALID`, the old approval is voided and approval is requested again;
* token mismatch → invalidated, re-approval required;
* expiry (15 min default) → `EXPIRED`;
* `MODIFY` replaces parameters and voids the approval.
Decision scope is `ONCE` or `SESSION`; every decision is written to `logs/security.log`,
the `security_log` table and the live event stream.

## 4. Shell execution
`shell.preview` validates without executing. `shell.execute` re-validates at execution time
(defence in depth) against:
* a deny-list: filesystem-root deletion, drive formatting, disk/partition tools, power control,
  remote-script piping (`curl … | sh`), encoded command payloads, persistence (`schtasks /create`,
  `reg delete`), security-control tampering, account/privilege changes, ownership changes, fork bombs;
* an optional allowlist (`allowedCommands` in `config/app.json`, empty by default = deny-list only).
Execution runs with a hard timeout, is cancellable, captures stdout/stderr/exit code/duration,
records affected paths and writes an audit JSON per execution. The SSH-like rule applies:
**the exact command shown to the user is the exact command executed.**

## 5. Filesystem
* All paths resolve through `resolveUserPath` against allowed scopes (`workspace`, `documents`, `uploads`);
  `assertInside` rejects traversal and absolute escapes (`SecurityError`).
* Writes always produce a **new unique filename** — nothing is overwritten silently.
* Deletion requires HIGH-risk approval *plus* the literal confirmation string `DELETE`.
* Uploaded originals are stored under `uploads/` with a SHA-256, are never mutated, and derived
  artifacts are separate files. Temporary writes use `*.partial` + atomic rename.

## 6. Desktop control (Windows)
UI Automation is attempted first (PowerShell `UIAutomationClient`, or the pywinauto path in the
optional Python sidecar), then structural means, then OCR, and only then coordinates. Every action
records the engine used and returns evidence; `computer.verify` is the step that decides success.

## 7. Process and electron safety
* Renderer: `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`, a preload channel
  allowlist, navigation/window-open blocking, and a permission handler that grants the microphone only.
* Long-running children (FFmpeg, shell, Python sidecar) are tracked in a registry so cancellation
  kills the real OS process; the Python sidecar has a crash-loop guard (max 5 restarts/minute).
* Renderer never receives filesystem or process APIs; all privileged work happens server-side.

## 8. Secrets
Credentials live in the environment / OS store only. Tokens are redacted in file logs
(`logs/*.log`) and event payloads; screenshots are never taken of credential prompts by default;
approval dialogs display parameters with secret-looking keys masked.

## 9. Audit trail
`events`, `security_log`, `system_log`, `approvals`, `artifacts`, plus per-run
`runs/<run_id>/{request,plan,approvals,events,manifest}.json`. The manifest carries a SHA-256 per
artifact. `logs/` rotate at 2 MB. Nothing important happens without a durable record.

## 10. Known limitations (not hidden)
* Windows-only capabilities report `UNAVAILABLE` off-Windows and refuse; nothing is emulated.
* The renderer's `localStorage`-free settings panel can widen the shell allowlist: that is an
  explicit, logged privilege decision, not an implicit one.
* Natural-language path hints are normalised (e.g. "my documents folder" → Documents root). An
  impossible path can therefore resolve to Documents rather than failing; the step output always
  shows the resolved absolute path so the difference is visible.
* Email sending stays disabled until SMTP creds and the optional drivers exist; drafts are real
  `.eml` files either way.
