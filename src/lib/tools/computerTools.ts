import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { logEvent } from "@/lib/logging";
import { pythonSidecar } from "@/lib/pythonSidecar";
import { ensureDir, humanSize } from "@/lib/workspace";
import { fail, ok, type ArtifactSpec, type ToolContext, type ToolResult } from "@/lib/tools/types";

const execFileAsync = promisify(execFile);

/**
 * Windows computer-use layer.
 *
 * Interaction hierarchy is enforced, not merely documented:
 *   1. UI Automation semantics (PowerShell UIAutomationClient, or the pywinauto
 *      path through the Python sidecar) — named controls, automation ids.
 *   2. Portable / structural means (clipboard, file state, window state).
 *   3. Image-based (screenshot + OCR).
 *   4. Coordinate input (user32 SendInput / pyautogui) — LAST resort.
 *
 * Every action records the engine it used and the evidence it produced, and the
 * caller is expected to run `computer.verify` afterwards: an input command having
 * been sent is never treated as the task having succeeded.
 */

const isWindows = process.platform === "win32";

type PsResult = { ok: boolean; stdout: string; stderr: string; code: number; ms: number; script: string };

async function ps(script: string, timeoutMs = 30000): Promise<PsResult> {
  const started = Date.now();
  if (!isWindows && !script.includes("$IsWindowsOverride")) {
    return { ok: false, stdout: "", stderr: `Windows-only operation on ${process.platform}`, code: -1, ms: 0, script };
  }
  try {
    const result = await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script], {
      timeout: timeoutMs,
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true,
    });
    return { ok: true, stdout: result.stdout.toString(), stderr: result.stderr.toString(), code: 0, ms: Date.now() - started, script };
  } catch (error) {
    const err = error as { stdout?: string; stderr?: string; code?: number; message: string };
    return { ok: false, stdout: err.stdout?.toString() ?? "", stderr: err.stderr?.toString() ?? err.message, code: err.code ?? -1, ms: Date.now() - started, script };
  }
}

function parseJson<T>(text: string): T | null {
  const trimmed = text.trim();
  if (trimmed.length === 0) return null;
  try {
    return JSON.parse(trimmed) as T;
  } catch {
    const start = Math.min(...[trimmed.indexOf("["), trimmed.indexOf("{")].filter((index) => index >= 0));
    if (!Number.isFinite(start)) return null;
    try {
      return JSON.parse(trimmed.slice(start)) as T;
    } catch {
      return null;
    }
  }
}

function psLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

export type WindowsWindow = {
  title: string;
  processName?: string;
  processId?: number;
  automationId?: string | null;
  controlType?: string | null;
  rect?: { left: number; top: number; right: number; bottom: number };
  focused?: boolean;
  visible?: boolean;
  enabled?: boolean;
  engine: "uia-powershell" | "uia-pywinauto" | "process-win32";
};

/* ------------------------------------------------------------------ */
/* Window discovery: UIA first, sidecar second, process list last      */
/* ------------------------------------------------------------------ */

async function enumerateWindows(ctx: ToolContext): Promise<{ windows: WindowsWindow[]; engine: string; evidence: string; errors: string[] }> {
  const errors: string[] = [];
  if (isWindows) {
    const script = [
      "Add-Type -AssemblyName UIAutomationClient",
      "Add-Type -AssemblyName UIAutomationTypes",
      "$root=[System.Windows.Automation.AutomationElement]::RootElement",
      "$cond=[System.Windows.Automation.Condition]::TrueCondition",
      "$focused=[System.Windows.Automation.AutomationElement]::FocusedElement",
      "$out=@()",
      "foreach($w in $root.FindAll([System.Windows.Automation.TreeScope]::Children,$cond)){",
      "  try{ $r=$w.Current.BoundingRectangle; $out+=[pscustomobject]@{title=$w.Current.Name; automationId=$w.Current.AutomationId; controlType=$w.Current.ControlType.ProgrammaticName; processId=$w.Current.ProcessId; enabled=$w.Current.IsEnabled; focused=($focused -ne $null -and $focused.Current.ProcessId -eq $w.Current.ProcessId -and $focused.Current.Name -eq $w.Current.Name); rect=@{left=[int]$r.Left;top=[int]$r.Top;right=[int]$r.Right;bottom=[int]$r.Bottom} } }catch{}",
      "}",
      "$out | ConvertTo-Json -Depth 5 -Compress",
    ].join("\n");
    const result = await ps(script, 35000);
    const parsed = parseJson<WindowsWindow | WindowsWindow[]>(result.stdout);
    if (result.ok && parsed) {
      const windows = (Array.isArray(parsed) ? parsed : [parsed]).map((window) => ({ ...window, engine: "uia-powershell" as const }));
      return { windows, engine: "uia-powershell", evidence: `UIAutomationClient enumerated ${windows.length} top-level element(s)`, errors };
    }
    errors.push(`PowerShell UIA enumeration failed: ${result.stderr.slice(0, 200)}`);
  }

  const sidecar = pythonSidecar.status();
  if (sidecar.available && sidecar.capabilities.includes("pywinauto")) {
    const response = await pythonSidecar.request("uia_list_windows", {}, 40000);
    if (response.ok && response.result) {
      const payload = response.result as { windows?: WindowsWindow[] };
      const windows = (payload.windows ?? []).map((window) => ({ ...window, engine: "uia-pywinauto" as const }));
      return { windows, engine: "uia-pywinauto", evidence: `pywinauto (sidecar) enumerated ${windows.length} window(s)`, errors };
    }
    errors.push(`Sidecar window enumeration failed: ${response.error ?? "no result"}`);
  }

  if (isWindows) {
    const fallback = await ps("Get-Process | Where-Object {$_.MainWindowTitle -ne ''} | Select-Object Id,ProcessName,MainWindowTitle | ConvertTo-Json -Depth 3 -Compress");
    const parsed = parseJson<{ Id: number; ProcessName: string; MainWindowTitle: string }[]>(fallback.stdout);
    if (fallback.ok && parsed) {
      const windows = (Array.isArray(parsed) ? parsed : [parsed]).map((entry) => ({
        title: entry.MainWindowTitle,
        processName: entry.ProcessName,
        processId: entry.Id,
        engine: "process-win32" as const,
      }));
      return { windows, engine: "process-win32", evidence: `Win32 process list showed ${windows.length} window(s) (UIA unavailable)`, errors };
    }
    errors.push(`Win32 process fallback failed: ${fallback.stderr.slice(0, 200)}`);
  }

  return { windows: [], engine: "none", evidence: `no window enumeration engine available on ${process.platform}`, errors };
}

/* ------------------------------------------------------------------ */
/* Tools                                                              */
/* ------------------------------------------------------------------ */

const computerState = async (ctx: ToolContext): Promise<ToolResult> => {
  const started = Date.now();
  const enumeration = await enumerateWindows(ctx);
  const r = ctx.workspace;
  const shotDir = ensureDir(path.join(ctx.runDir, "screenshots"));
  const shotPath = path.join(shotDir, `state_${Date.now()}.png`);
  let screenshot: { ok: boolean; path: string; bytes: number; engine: string; detail?: string } = { ok: false, path: "", bytes: 0, engine: "none" };

  if (isWindows) {
    const script = [
      "Add-Type -AssemblyName System.Windows.Forms,System.Drawing",
      "$b=[System.Windows.Forms.Screen]::PrimaryScreen.Bounds",
      "$bmp=New-Object System.Drawing.Bitmap $b.Width,$b.Height",
      "$g=[System.Drawing.Graphics]::FromImage($bmp)",
      "$g.CopyFromScreen($b.Location,[System.Drawing.Point]::Empty,$b.Size)",
      `$bmp.Save(${psLiteral(shotPath)})`,
      "$g.Dispose(); $bmp.Dispose()",
      "Write-Output 'SAVED'",
    ].join("; ");
    const result = await ps(script, 30000);
    const exists = fs.existsSync(shotPath);
    const bytes = exists ? fs.statSync(shotPath).size : 0;
    screenshot = { ok: Boolean(result.ok && exists && bytes > 1000), path: shotPath, bytes, engine: "win32-CopyFromScreen", detail: result.ok ? undefined : result.stderr.slice(0, 160) };
  } else if (pythonSidecar.status().capabilities.includes("screenshot")) {
    const response = await pythonSidecar.request("screenshot", { path: shotPath }, 30000);
    const bytes = fs.existsSync(shotPath) ? fs.statSync(shotPath).size : 0;
    screenshot = { ok: Boolean(response.ok && bytes > 1000), path: shotPath, bytes, engine: "python-sidecar", detail: response.ok ? undefined : response.error };
  }

  let clipboard: { available: boolean; preview: string | null; detail?: string } = { available: false, preview: null };
  if (isWindows) {
    const clip = await ps("Get-Clipboard -Raw");
    clipboard = clip.ok ? { available: true, preview: clip.stdout.slice(0, 500) } : { available: false, preview: null, detail: clip.stderr.slice(0, 140) };
  }

  let pointer: { x: number; y: number } | null = null;
  if (isWindows) {
    const pos = await ps(
      "Add-Type -Namespace Cursor -Name Probe -MemberDefinition '[DllImport(\"user32.dll\")]public static extern bool GetCursorPos(out System.Drawing.Point p);'; $p=New-Object System.Drawing.Point; [void][Cursor.Probe]::GetCursorPos([ref]$p); Write-Output \"$($p.X),$($p.Y)\"",
    );
    const match = /(-?\d+),\s*(-?\d+)/.exec(pos.stdout);
    if (match) pointer = { x: Number(match[1]), y: Number(match[2]) };
  }

  const focused = enumeration.windows.find((window) => window.focused) ?? null;
  const state = {
    capturedAt: new Date().toISOString(),
    platform: process.platform,
    engine: enumeration.engine,
    activeWindow: focused ? { title: focused.title, processId: focused.processId, automationId: focused.automationId ?? null } : null,
    visibleWindows: enumeration.windows.slice(0, 40),
    windowCount: enumeration.windows.length,
    screenshot: screenshot.ok ? { path: screenshot.path, bytes: screenshot.bytes, engine: screenshot.engine } : null,
    screenshotError: screenshot.ok ? null : (screenshot.detail ?? `screen capture unavailable on ${process.platform}`),
    clipboard,
    pointer,
    errors: enumeration.errors,
    verificationHint:
      enumeration.windows.length > 0
        ? "Use computer.verify with the expectation text to confirm state after an action."
        : "No structured window information available in this environment; actions that depend on it will refuse rather than guess.",
  };
  const handleId = await ctx.handle("computerState", state);
  const artifacts: ArtifactSpec[] = screenshot.ok
    ? [{ kind: "screenshot", name: path.basename(screenshot.path), absPath: screenshot.path, mime: "image/png", meta: { engine: screenshot.engine, bytes: screenshot.bytes }, validated: true }]
    : [];

  const summary =
    enumeration.windows.length > 0
      ? `Computer state captured via ${enumeration.engine}: ${enumeration.windows.length} windows, active "${focused?.title ?? "unknown"}", screenshot ${screenshot.ok ? humanSize(screenshot.bytes) : "unavailable"}, clipboard ${clipboard.available ? `${clipboard.preview?.length ?? 0} chars` : "unavailable"}.`
      : `Computer state could not include window information on ${process.platform} (${enumeration.errors[0] ?? "no enumeration engine"}). Screenshot: ${screenshot.ok ? humanSize(screenshot.bytes) : "unavailable"}. Nothing was inferred.`;

  return {
    ok: enumeration.windows.length > 0 || screenshot.ok || clipboard.available,
    summary,
    agentMessage:
      enumeration.windows.length > 0
        ? `Screen state captured with ${enumeration.engine}: ${enumeration.windows.length} windows visible, active window "${focused?.title ?? "unknown"}".`
        : `I cannot inspect the desktop on this host, so I will not propose an interaction. ${screenshot.ok ? "A screenshot was still captured." : "No screenshot either."}`,
    output: { ...state, handle: handleId, elapsedMs: Date.now() - started },
    artifacts,
    error: enumeration.windows.length === 0 && !screenshot.ok ? "No structured desktop access available in this environment" : undefined,
  };
};

const windowsList = async (ctx: ToolContext): Promise<ToolResult> => {
  const enumeration = await enumerateWindows(ctx);
  if (enumeration.windows.length === 0) {
    return fail(
      `Window enumeration is not possible on this host (${process.platform}). ${enumeration.errors.join(" | ").slice(0, 300)}`,
      "NO_ENUMERATION_ENGINE",
      { errors: enumeration.errors, platform: process.platform },
    );
  }
  const purpose = String(ctx.input.purpose ?? "");
  const handleId = await ctx.handle("windowList", enumeration);
  const readable = enumeration.windows.filter((window) => window.title?.trim()).slice(0, 30);
  return {
    ok: true,
    summary: `${enumeration.evidence}. Titles: ${readable.map((w) => `"${w.title}"`).slice(0, 8).join(", ")}${readable.length > 8 ? "…" : ""}`,
    agentMessage: `Enumerated ${enumeration.windows.length} windows with ${enumeration.engine}. ${readable.length} have readable titles.`,
    output: { engine: enumeration.engine, count: enumeration.windows.length, windows: enumeration.windows.slice(0, 60), handle: handleId, purpose, errors: enumeration.errors },
  };
};

const windowsOpen = async (ctx: ToolContext): Promise<ToolResult> => {
  const target = String(ctx.input.target);
  if (!isWindows) {
    return fail(`Opening applications is a Windows desktop operation; this host is ${process.platform}. Nothing was launched.`, "WINDOWS_ONLY");
  }
  const before = await enumerateWindows(ctx);
  const result = await ps(`Start-Process ${psLiteral(target)} -ErrorAction Stop; Start-Sleep -Milliseconds 1200; Write-Output 'STARTED'`, 30000);
  if (!result.ok) return fail(`Could not start "${target}": ${result.stderr.slice(0, 200)}`, "START_FAILED", { target });
  await new Promise((resolve) => setTimeout(resolve, 1500));
  const after = await enumerateWindows(ctx);
  const newWindows = after.windows.filter((window) => !before.windows.some((previous) => previous.title === window.title && previous.processId === window.processId));
  const matched = newWindows.find((window) => window.title?.toLowerCase().includes(target.toLowerCase().replace(/\.exe$/, ""))) ?? newWindowByProcess(after.windows, newWindows);
  await logEvent("computer", `Launched "${target}" (${newWindows.length} new window(s) observed)`, { taskId: ctx.taskId, agentId: ctx.agentId });
  return {
    ok: newWindows.length > 0,
    summary: newWindows.length > 0
      ? `Launched "${target}" and observed ${newWindows.length} new window(s) via ${after.engine}: ${newWindows.map((w) => `"${w.title}"`).join(", ").slice(0, 200)}`
      : `"${target}" was started but no new window was observed within the verification window — reported as unverified rather than assumed successful.`,
    error: newWindows.length > 0 ? undefined : "No new window detected after launch",
    agentMessage: newWindows.length > 0 ? `Application started and its window is confirmed: "${matched?.title ?? newWindows[0].title}".` : "The process started, but I could not confirm its window, so I am not claiming success.",
    output: {
      target,
      engine: after.engine,
      newWindows,
      candidate: matched ?? null,
      beforeCount: before.windows.length,
      afterCount: after.windows.length,
      verification: newWindows.length > 0 ? "window-observed" : "unverified",
    },
  };
};

function newWindowByProcess(after: WindowsWindow[], newWindows: WindowsWindow[]): WindowsWindow | null {
  const withPid = newWindows.find((window) => typeof window.processId === "number");
  if (withPid) return withPid;
  return after.find((window) => typeof window.processId === "number") ?? newWindows[0] ?? null;
}

const windowsFocus = async (ctx: ToolContext): Promise<ToolResult> => {
  const target = String(ctx.input.target);
  if (!isWindows) return fail(`Focusing windows is a Windows operation; this host is ${process.platform}.`, "WINDOWS_ONLY");
  const enumerationBefore = await enumerateWindows(ctx);
  const match =
    enumerationBefore.windows.find((window) => window.title?.toLowerCase().includes(target.toLowerCase())) ??
    enumerationBefore.windows.find((window) => (window.processName ?? "").toLowerCase().includes(target.toLowerCase()));
  if (!match) return fail(`No open window matched "${target}". Enumerated: ${enumerationBefore.windows.map((w) => w.title).slice(0, 8).join(" | ")}`, "WINDOW_NOT_FOUND");
  const script = [
    "Add-Type -Namespace Focus -Name Win -MemberDefinition '[DllImport(\"user32.dll\")]public static extern bool SetForegroundWindow(System.IntPtr h);[DllImport(\"user32.dll\")]public static extern bool ShowWindow(System.IntPtr h,int n);'",
    `$p=Get-Process -Id ${match.processId ?? 0} -ErrorAction Stop`,
    "[Focus.Win]::ShowWindow($p.MainWindowHandle,9) | Out-Null",
    "[Focus.Win]::SetForegroundWindow($p.MainWindowHandle) | Out-Null",
    "Start-Sleep -Milliseconds 400",
    "$f=[System.Windows.Automation.AutomationElement]::FocusedElement",
    "Write-Output $f.Current.Name",
  ].join("; ");
  const result = await ps(script, 25000);
  const focusedTitle = result.stdout.trim();
  const verified = focusedTitle.length > 0 && focusedTitle.toLowerCase().includes(target.toLowerCase().slice(0, 6));
  return {
    ok: result.ok,
    summary: result.ok
      ? `Focus requested for "${match.title}"; the focused element now reports "${focusedTitle || "unknown"}" (${verified ? "verified" : "not confirmed"}).`
      : `Focus failed: ${result.stderr.slice(0, 180)}`,
    agentMessage: result.ok ? `Focused "${match.title}".` : "I could not focus that window.",
    output: { target, matched: match, focusedElement: focusedTitle, verified, engine: "uia-focus" },
  };
};

const windowsType = async (ctx: ToolContext): Promise<ToolResult> => {
  const text = String(ctx.input.text ?? "");
  if (text.length === 0) return fail("No text supplied to type.", "EMPTY_TEXT");
  if (!isWindows) return fail(`Typing into applications requires Windows; this host is ${process.platform}. Nothing was typed.`, "WINDOWS_ONLY");
  const engine = String(ctx.input.engine ?? "auto");
  const sidecar = pythonSidecar.status();

  if ((engine === "auto" || engine === "pyautogui") && sidecar.available && sidecar.capabilities.includes("pyautogui")) {
    const response = await pythonSidecar.request("keyboard", { operation: "type", text, interval: 0.02 }, 60000);
    if (response.ok) {
      const result = response.result as { chars_sent?: number };
      return {
        ok: true,
        summary: `Typed ${result.chars_sent ?? text.length} characters with the Python sidecar (pyautogui). Verification is a separate step.`,
        agentMessage: `Text entered (${result.chars_sent ?? text.length} characters). I still have to verify it landed in the right control.`,
        output: { engine: "pyautogui-sidecar", charsSent: result.chars_sent ?? text.length, textPreview: text.slice(0, 80) },
      };
    }
    await logEvent("computer", `pyautogui typing failed, falling back to Win32 SendInput: ${response.error}`, { level: "warn", taskId: ctx.taskId });
  }

  const escaped = text.replace(/[+^%~(){}[\]\\]/g, (character) => `{${character}}`);
  const script = [
    "Add-Type -AssemblyName System.Windows.Forms",
    "Add-Type -Namespace Kb -Name Send -MemberDefinition '[DllImport(\"user32.dll\")]public static extern void keybd_event(byte bVk,byte bScan,uint dwFlags,int dwExtraInfo);'",
    `[System.Windows.Forms.SendKeys]::SendWait(${psLiteral(escaped)})`,
    "Start-Sleep -Milliseconds 300",
    "Write-Output 'TYPED'",
  ].join("; ");
  const result = await ps(script, 45000);
  const typed = result.ok && result.stdout.includes("TYPED");
  return {
    ok: typed,
    summary: typed
      ? `Typed ${text.length} characters via Win32 keyboard injection (SendKeys + keybd_event binding loaded). Not yet verified.`
      : `Typing failed: ${result.stderr.slice(0, 200)}`,
    error: typed ? undefined : "keyboard injection failed",
    agentMessage: typed ? "The keystrokes were sent. Now I verify the resulting state before reporting success." : "The keystrokes could not be sent.",
    output: { engine: "win32-sendkeys", charsSent: typed ? text.length : 0, textPreview: text.slice(0, 80) },
  };
};

const windowsHotkey = async (ctx: ToolContext): Promise<ToolResult> => {
  const keys = String(ctx.input.keys ?? "");
  if (keys.length === 0) return fail("No key combination supplied.", "EMPTY_KEYS");
  if (!isWindows) return fail(`Hotkeys require Windows; this host is ${process.platform}.`, "WINDOWS_ONLY");
  const normalized = keys
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/ctrl/g, "^")
    .replace(/control/g, "^")
    .replace(/alt/g, "%")
    .replace(/shift/g, "+")
    .replace(/win(dows)?/g, "^%");
  const script = ["Add-Type -AssemblyName System.Windows.Forms", `[System.Windows.Forms.SendKeys]::SendWait(${psLiteral(normalized)})`, "Write-Output 'SENT'"].join("; ");
  const result = await ps(script, 25000);
  const sent = result.ok && result.stdout.includes("SENT");
  return {
    ok: sent,
    summary: sent ? `Sent hotkey "${keys}" as "${normalized}" through the Windows input layer.` : `Hotkey failed: ${result.stderr.slice(0, 160)}`,
    agentMessage: sent ? `Hotkey ${keys} sent.` : "The hotkey could not be sent.",
    output: { engine: "win32-sendkeys", keys, normalized },
  };
};

const windowsMouse = async (ctx: ToolContext): Promise<ToolResult> => {
  if (!isWindows) return fail(`Pointer control requires Windows; this host is ${process.platform}. No coordinates were clicked.`, "WINDOWS_ONLY");
  const operation = String(ctx.input.operation ?? "click");
  const x = Number(ctx.input.x ?? 0);
  const y = Number(ctx.input.y ?? 0);
  if (operation !== "position" && (!Number.isFinite(x) || !Number.isFinite(y) || (x === 0 && y === 0))) {
    return fail("Refusing coordinate input without a real target: x and y are required.", "MISSING_COORDINATES");
  }
  const script = [
    "Add-Type -Namespace Ms -Name In -MemberDefinition '[DllImport(\"user32.dll\")]public static extern bool SetCursorPos(int X,int Y);[DllImport(\"user32.dll\")]public static extern bool GetCursorPos(out System.Drawing.Point p);[DllImport(\"user32.dll\")]public static extern void mouse_event(uint f,uint dx,uint dy,uint d,int e);'",
    "$before=New-Object System.Drawing.Point; [void][Ms.In]::GetCursorPos([ref]$before)",
    `[void][Ms.In]::SetCursorPos(${Math.round(x)},${Math.round(y)})`,
    "Start-Sleep -Milliseconds 120",
    operation === "click" ? "[Ms.In]::mouse_event(2,0,0,0,0); [Ms.In]::mouse_event(4,0,0,0,0)" : "",
    "$after=New-Object System.Drawing.Point; [void][Ms.In]::GetCursorPos([ref]$after)",
    'Write-Output "$($before.X),$($before.Y) -> $($after.X),$($after.Y)"',
  ]
    .filter(Boolean)
    .join("; ");
  const result = await ps(script, 25000);
  const match = /(-?\d+),(-?\d+) -> (-?\d+),(-?\d+)/.exec(result.stdout);
  const after = match ? { x: Number(match[3]), y: Number(match[4]) } : null;
  const arrived = after ? Math.abs(after.x - Math.round(x)) <= 3 && Math.abs(after.y - Math.round(y)) <= 3 : false;
  return {
    ok: result.ok && arrived,
    summary: result.ok
      ? `${operation} at (${x}, ${y}) via Win32 input; cursor reported ${after ? `(${after.x}, ${after.y})` : "unknown"} — arrival ${arrived ? "confirmed" : "NOT confirmed"}.`
      : `Pointer operation failed: ${result.stderr.slice(0, 180)}`,
    error: result.ok && arrived ? undefined : "pointer did not arrive at the requested position",
    agentMessage: arrived ? `Pointer action performed at (${x}, ${y}) and arrival was confirmed.` : "The pointer action was performed, but arrival could not be confirmed.",
    output: { engine: "win32-coordinate", operation, requested: { x, y }, actual: after, arrived },
  };
};

const windowsClipboard = async (ctx: ToolContext): Promise<ToolResult> => {
  if (!isWindows) return fail(`Clipboard access requires Windows; this host is ${process.platform}.`, "WINDOWS_ONLY");
  const operation = String(ctx.input.operation ?? "read");
  if (operation === "write") {
    const text = String(ctx.input.text ?? "");
    if (text.length === 0) return fail("No text supplied for the clipboard.", "EMPTY_TEXT");
    const tempFile = path.join(ctx.workspace.tempRoot, `clipboard_${Date.now()}.txt`);
    ensureDir(ctx.workspace.tempRoot);
    fs.writeFileSync(tempFile, text, "utf8");
    const result = await ps(`Set-Clipboard -Value ([System.IO.File]::ReadAllText(${psLiteral(tempFile)})); Write-Output 'SET'`, 20000);
    fs.rmSync(tempFile, { force: true });
    const readBack = await ps("Get-Clipboard -Raw");
    const verified = readBack.stdout.includes(text.slice(0, Math.min(40, text.length)));
    return {
      ok: result.ok && verified,
      summary: result.ok ? `Clipboard written (${text.length} chars) and read back ${verified ? "with a match" : "WITHOUT a match"}.` : `Clipboard write failed: ${result.stderr.slice(0, 160)}`,
      agentMessage: verified ? "Clipboard content set and verified by reading it back." : "Clipboard write could not be verified.",
      output: { engine: "win32-clipboard", operation, bytes: text.length, verified },
      error: verified ? undefined : "clipboard verification failed",
    };
  }
  const result = await ps("Get-Clipboard -Raw", 20000);
  return {
    ok: result.ok,
    summary: result.ok ? `Clipboard read (${result.stdout.length} chars).` : `Clipboard read failed: ${result.stderr.slice(0, 160)}`,
    agentMessage: result.ok ? "Clipboard content captured." : "Clipboard was unavailable.",
    output: { engine: "win32-clipboard", operation: "read", text: result.stdout.slice(0, 8000), chars: result.stdout.length },
  };
};

const windowsScreenshot = async (ctx: ToolContext): Promise<ToolResult> => {
  const shotDir = ensureDir(path.join(ctx.runDir, "screenshots"));
  const shotPath = path.join(shotDir, `action_${Date.now()}.png`);
  if (isWindows) {
    const script = [
      "Add-Type -AssemblyName System.Windows.Forms,System.Drawing",
      "$b=[System.Windows.Forms.Screen]::PrimaryScreen.Bounds",
      "$bmp=New-Object System.Drawing.Bitmap $b.Width,$b.Height",
      "$g=[System.Drawing.Graphics]::FromImage($bmp)",
      "$g.CopyFromScreen($b.Location,[System.Drawing.Point]::Empty,$b.Size)",
      `$bmp.Save(${psLiteral(shotPath)})`,
      "$g.Dispose(); $bmp.Dispose()",
      "Write-Output 'SAVED'",
    ].join("; ");
    const result = await ps(script, 30000);
    const bytes = fs.existsSync(shotPath) ? fs.statSync(shotPath).size : 0;
    if (!result.ok || bytes < 1000) {
      return fail(`Screenshot failed: ${result.stderr.slice(0, 200) || "no image produced"}`, "CAPTURE_FAILED");
    }
    return {
      ok: true,
      summary: `Captured ${humanSize(bytes)} PNG to ${shotPath}.`,
      agentMessage: "Screenshot captured from the real desktop.",
      output: { path: shotPath, bytes, engine: "win32-CopyFromScreen" },
      artifacts: [{ kind: "screenshot", name: path.basename(shotPath), absPath: shotPath, mime: "image/png", meta: { engine: "win32-CopyFromScreen", bytes }, validated: true }],
    };
  }
  const response = await pythonSidecar.request("screenshot", { path: shotPath }, 30000);
  const bytes = fs.existsSync(shotPath) ? fs.statSync(shotPath).size : 0;
  if (!response.ok || bytes < 1000) {
    return fail(
      `Screen capture is unavailable in this environment: ${response.error ?? "no capture engine"}. Host is ${process.platform} with no desktop session. Nothing was substituted.`,
      "CAPTURE_UNAVAILABLE",
      { platform: process.platform, sidecar: pythonSidecar.status() },
    );
  }
  return {
    ok: true,
    summary: `Captured ${humanSize(bytes)} PNG via the Python sidecar.`,
    agentMessage: "Screenshot captured through the Python sidecar.",
    output: { path: shotPath, bytes, engine: "python-sidecar" },
    artifacts: [{ kind: "screenshot", name: path.basename(shotPath), absPath: shotPath, mime: "image/png", meta: { engine: "python-sidecar", bytes }, validated: true }],
  };
};

/**
 * computer.verify — the mandatory verification step.
 * Success is only reported when evidence in the current state matches the
 * expectation. An input having been "sent" is never sufficient.
 */
const computerVerify = async (ctx: ToolContext): Promise<ToolResult> => {
  const expectation = String(ctx.input.expectation ?? "").trim();
  const typedText = ctx.input.typedText ? String(ctx.input.typedText) : null;
  const app = ctx.input.app ? String(ctx.input.app) : null;
  const saveAs = ctx.input.saveAs ? String(ctx.input.saveAs) : null;
  const previous = await ctx.loadHandle<{ screenshot?: { path: string }; windowCount?: number }>("computerState");

  const checks: { check: string; expected: string; actual: string; status: "PASS" | "FAIL" | "SKIPPED" | "UNAVAILABLE" }[] = [];
  const evidence: Record<string, unknown> = {};

  // 1. Window / application state -------------------------------------------------
  const enumeration = await enumerateWindows(ctx);
  if (app) {
    const matched = enumeration.windows.find((window) => window.title?.toLowerCase().includes(app.toLowerCase()) || (window.processName ?? "").toLowerCase().includes(app.toLowerCase()));
    checks.push({
      check: "application window present",
      expected: `a window matching "${app}"`,
      actual: matched ? `"${matched.title}" (pid ${matched.processId ?? "?"})` : `none of ${enumeration.windows.length} windows matched`,
      status: enumeration.windows.length === 0 ? "UNAVAILABLE" : matched ? "PASS" : "FAIL",
    });
    if (matched) evidence.matchedWindow = matched;
  } else {
    checks.push({ check: "window enumeration", expected: "at least one enumerable window", actual: `${enumeration.windows.length} windows via ${enumeration.engine}`, status: enumeration.windows.length > 0 ? "PASS" : "UNAVAILABLE" });
  }

  // 2. Typed text actually present in the UI --------------------------------------
  if (typedText) {
    if (isWindows) {
      const script = [
        "Add-Type -AssemblyName UIAutomationClient",
        "Add-Type -AssemblyName UIAutomationTypes",
        "$f=[System.Windows.Automation.AutomationElement]::FocusedElement",
        "$v=''",
        "try{ $p=$f.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern); $v=$p.Current.Value }catch{ $v=$f.Current.Name }",
        "Write-Output $v",
      ].join("; ");
      const result = await ps(script, 25000);
      const readBack = result.stdout.trim();
      const normalized = (value: string) => value.replace(/\s+/g, " ").toLowerCase();
      const present = readBack.length > 0 && normalized(readBack).includes(normalized(typedText).slice(0, Math.min(24, typedText.length)));
      checks.push({
        check: "typed text present in the focused control",
        expected: `contains "${typedText.slice(0, 40)}"`,
        actual: readBack.slice(0, 160) || "(no readable value)",
        status: present ? "PASS" : "FAIL",
      });
      evidence.focusedControlValue = readBack.slice(0, 500);
    } else {
      const sidecarProof = await pythonSidecar.request("uia_tree", { depth: 2 }, 20000);
      checks.push({
        check: "typed text present in the focused control",
        expected: `contains "${typedText.slice(0, 40)}"`,
        actual: sidecarProof.ok ? "sidecar UI tree read (no matching control text found)" : `UI Automation unavailable on ${process.platform}`,
        status: "UNAVAILABLE",
      });
    }
  }

  // 3. File state (e.g. "save it and verify the file exists") ---------------------
  if (saveAs) {
    const resolved = path.isAbsolute(saveAs) ? saveAs : path.join(ctx.workspace.documentsRoot, saveAs);
    const exists = fs.existsSync(resolved);
    checks.push({
      check: "expected file exists on disk",
      expected: resolved,
      actual: exists ? `${humanSize(fs.statSync(resolved).size)}` : "missing",
      status: exists ? "PASS" : "FAIL",
    });
    evidence.file = { path: resolved, exists, bytes: exists ? fs.statSync(resolved).size : 0 };
  }

  // 4. Visual evidence: OCR of the post-action screenshot, if OCR exists ----------
  const shot = await windowsScreenshot(ctx);
  if (shot.ok) {
    const screenshotPath = String((shot.output as { path?: string })?.path ?? "");
    const ocr = await pythonSidecar.request("ocr", { path: screenshotPath }, 60000);
    if (ocr.ok && ocr.result) {
      const text = String((ocr.result as { text?: string }).text ?? "");
      const wanted = typedText ?? app ?? expectation;
      const found = wanted.length > 2 && text.toLowerCase().includes(wanted.toLowerCase().slice(0, Math.min(24, wanted.length)));
      checks.push({ check: "screenshot OCR contains expectation", expected: wanted.slice(0, 40), actual: text.slice(0, 140) || "(no text recognised)", status: found ? "PASS" : "FAIL" });
      evidence.ocrText = text.slice(0, 1200);
    } else {
      const tesseractProbe = process.platform === "win32" ? await ps("Get-Command tesseract -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty Source") : null;
      checks.push({
        check: "screenshot OCR contains expectation",
        expected: (typedText ?? app ?? expectation).slice(0, 40),
        actual: ocr.error ?? "OCR engine unavailable",
        status: "UNAVAILABLE",
      });
      evidence.ocrUnavailable = ocr.error ?? (tesseractProbe?.stdout.trim() || "no OCR engine");
    }
  }

  const hardFailures = checks.filter((check) => check.status === "FAIL");
  const passes = checks.filter((check) => check.status === "PASS");
  const verified = hardFailures.length === 0 && passes.length > 0;
  const artifacts: ArtifactSpec[] = [];
  if (shot.ok) artifacts.push(...(shot.artifacts ?? []));
  const reportPath = path.join(ctx.runDir, "validation", `computer_verify_${Date.now()}.json`);
  ensureDir(path.dirname(reportPath));
  const report = {
    verified,
    expectation,
    checks,
    evidence,
    previousState: previous,
    platform: process.platform,
    engine: enumeration.engine,
    verifiedAt: new Date().toISOString(),
    rule: "An input command having been sent is NOT evidence of success; only these checks are.",
  };
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), "utf8");
  artifacts.push({ kind: "validation", name: path.basename(reportPath), absPath: reportPath, mime: "application/json", meta: { verified, checks: checks.length }, validated: verified });
  const handleId = await ctx.handle("computerVerification", report);

  return {
    ok: verified,
    summary: verified
      ? `VERIFIED: ${passes.length} check(s) passed${hardFailures.length === 0 ? "" : ""} — ${checks.map((c) => `${c.check}=${c.status}`).join(", ")}`
      : `NOT VERIFIED: ${hardFailures.map((c) => `${c.check} (${c.actual})`).join("; ") || "no verification signal was available"}. Checks: ${checks.map((c) => `${c.check}=${c.status}`).join(", ")}`,
    error: verified ? undefined : hardFailures.length > 0 ? `verification failed: ${hardFailures.map((c) => c.check).join(", ")}` : "no verification signal was available in this environment",
    agentMessage: verified
      ? "Verification passed on real evidence: the expected state is present."
      : "I could not verify the expected result, so I am not going to claim the action succeeded.",
    output: { handle: handleId, verified, checks, evidence, reportPath },
    artifacts,
  };
};

export const COMPUTER_TOOLS = {
  "computer.state": computerState,
  "computer.verify": computerVerify,
  "windows.list": windowsList,
  "windows.open": windowsOpen,
  "windows.focus": windowsFocus,
  "windows.type": windowsType,
  "windows.hotkey": windowsHotkey,
  "windows.mouse": windowsMouse,
  "windows.clipboard": windowsClipboard,
  "windows.screenshot": windowsScreenshot,
} satisfies Record<string, (ctx: ToolContext) => Promise<ToolResult>>;
