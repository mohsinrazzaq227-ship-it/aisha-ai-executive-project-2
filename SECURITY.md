# AISHA — security model

Enforcement lives in code (`src/lib/security.ts`, `src/lib/tools/registry.ts`,
`src/lib/supervisor.ts`), not in the interface. The UI cannot widen a policy.

## 1. Trust boundaries

| Boundary | Control |
| --- | --- |
| Browser → server | Only the local HTTP API. No secrets in responses; credentials are never echoed (URL userinfo is redacted in logs and events). |
| Electron renderer → main | `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`, allow-listed preload channels, navigation/window-open blocked, only microphone permission granted. |
| Supervisor → tools | The registry is the only execution path: schema validation, live availability, approval gate, timeout, cancellation, audit and tool-run persistence. |
| Tools → OS | Path confinement, command deny-list, workspace sandbox, explicit approval for destructive/credential/permission operations. |

## 2. Command validation

Hard-blocked (never executed, always audited):

* `format`, `diskpart`, `mkfs*`, raw `dd of=/dev/...` write
* recursive deletion of system roots (`rm -rf /`, `Remove-Item -Recurse -Force C:\Windows`)
* security disabling (`Disable-WindowsDefender`, real-time monitoring off)
* account creation/privilege escalation (`net user /add`, `net localgroup administrators /add`)
* registry tampering (`reg add/delete`, `Set-ItemProperty HKLM...`)
* persistence (`schtasks /create`, `HKCU\...\Run`)
* ownership/ACL changes (`takeown`, `icacls /grant`, `Set-Acl`)
* credential extraction (`mimikatz`, LSASS access/dumps)
* boot/backup destruction (`bcdedit`, `vssadmin delete shadows`)
* remote script execution (`Invoke-Expression`, `DownloadString | iex`)

Everything else is risk-classified; sensitive patterns (delete, shutdown, force-push,
network egress) become `HIGH`, which means **approval required**. An optional explicit
allowlist (`AISHA_ALLOWED_COMMANDS`) can narrow the accepted program set; widening it is a
deliberate user decision and is audited.

## 3. Path confinement

Every path is resolved and checked before use:

* protected roots (`config/app.json` + `AISHA_PROTECTED_PATHS`) are refused for read, write and delete
* filesystem roots are refused
* deletion outside the AISHA workspace/sandbox is refused; inside the workspace it is `HIGH` (approval)
* Windows-style paths (`C:\Windows\...`) are judged as Windows paths even when AISHA runs on
  another host, so a path can never "escape" protection by being resolved on Linux

## 4. Approvals (human-in-the-loop)

* Risk classes: `LOW` execute directly · `MEDIUM` scoped/validated · `HIGH` approval required
  · `CRITICAL` refused unless policy is deliberately widened.
* Every approval carries: exact action, parameters, target, risk, reason, expiry (15 min
  default), `action_hash` and a random token.
* `action_hash = sha256(action ‖ target ‖ canonical(params) ‖ install-secret)`. The registry
  recomputes it at execution time; **any parameter change invalidates the approval**.
* A mismatched token, an expired window or a denial leaves the step `BLOCKED`. The task
  continues with the remaining independent branches and reports the block.
* Decisions are written to `audit_logs` with actor, decision and note.

## 5. Audit and evidence

* `audit_logs` — every validator/approval decision (ALLOWED / BLOCKED / PENDING / GRANTED / DENIED).
* `events` — the single authoritative stream (task, step, tool, approval, verification,
  artifact, walk, handoff, security, resource).
* `tool_runs` — every tool attempt with risk, status, duration, sanitised parameters and result.
* `artifacts` — path, byte size, sha256, origin and the method that validated the file.

Secrets are redacted before they reach logs or events (`redactSecrets`), and tool-run
parameters are sanitised (`password`, `token`, `secret`, `apiKey` ⇒ `***`, long content truncated).

## 6. Credentials

No credential ships in the repository. `.env.example` documents every key; `.env` is
git-ignored by convention. Approval signing uses `AISHA_APPROVAL_SECRET` when set, otherwise
a path-derived value so approvals cannot be forged across installations.

## 7. Reporting a problem

Bring the evidence: `taskId`, `stepId`, approval id, the relevant `events` rows and the
`tool_runs` row. AISHA's audit data is designed to make a claim falsifiable.
