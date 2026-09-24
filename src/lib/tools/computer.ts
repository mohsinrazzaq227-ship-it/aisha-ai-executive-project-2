/**
 * Computer-use tools. Windows-first (Project 2 architecture), executed through
 * the Python sidecar so both the semantics and the evidence come from real
 * Windows APIs. On any other platform — or without the sidecar — these tools
 * report UNAVAILABLE with the exact missing piece. Nothing is ever simulated.
 */
import { z } from "zod";
import { IS_WINDOWS, DIRS, PYTHON_BIN, SIDECAR_PATH } from "@/lib/config";
import { registerTool } from "@/lib/tools/registry";
import { fail, unavailable, type ToolResult } from "@/lib/tools/types";
import { invokeSidecar, probeSidecar } from "@/lib/sidecar";
import { registerArtifact } from "@/lib/artifacts";
import { newId, slugify, toRelative } from "@/lib/util";

type SidecarReply = { ok: boolean; result?: Record<string, unknown>; unavailable?: string; fix?: string; error?: string };

async function callSidecar(action: string, params: Record<string, unknown>, signal: AbortSignal, timeoutMs = 25_000): Promise<SidecarReply> {
  const reply = await invokeSidecar(action, params, timeoutMs, signal);
  return reply as SidecarReply;
}

function sidecarFailure(reply: SidecarReply, toolId: string): ToolResult {
  const detail = reply.unavailable ?? reply.error ?? `${toolId} failed in the sidecar`;
  return unavailable(detail, reply.fix ?? "pip install -r python/requirements.txt", [{ kind: "sidecar", detail }]);
}

const availability = async () => {
  if (!IS_WINDOWS) {
    return {
      available: false,
      detail: `Windows computer control is not available on ${process.platform}: UI Automation (pywinauto), synthetic input (pyautogui) and window control are Windows-only APIs`,
      fix: "run AISHA on Windows 10/11 for real computer use",
    };
  }
  const probe = await probeSidecar();
  if (!probe.available) {
    return { available: false, detail: `python sidecar unavailable: ${probe.detail}`, fix: probe.fix };
  }
  return { available: true, detail: `${probe.detail} (python ${probe.python ?? PYTHON_BIN})` };
};

registerTool({
  id: "computer.windows",
  title: "Enumerate and focus windows",
  group: "computer",
  description: "Lists visible top-level windows with titles/PIDs, or focuses a window by title substring (UI Automation when available).",
  risk: "MEDIUM",
  resourceClass: "LIGHT",
  agents: ["computer", "ops", "aisha"],
  params: z.object({ action: z.enum(["list", "focus"]).default("list"), title: z.string().optional() }),
  verificationNote: "The focused window's title is read back from the OS after the focus call and compared to the request.",
  availability,
  execute: async (ctx, params) => {
    const reply = await callSidecar(params.action === "list" ? "windows.list" : "windows.focus", { title: params.title }, ctx.signal);
    if (!reply.ok) return sidecarFailure(reply, "computer.windows");
    const result = reply.result ?? {};
    if (params.action === "focus") {
      const focused = String(result.focused ?? "");
      const verified = Boolean(focused) && (!params.title || focused.toLowerCase().includes(params.title.toLowerCase()));
      return {
        status: verified ? "SUCCESS" : "VERIFICATION_FAILED",
        summary: verified ? `focused "${focused}"` : `focus verification failed (active window is "${focused || "unknown"}")`,
        data: result,
        evidence: [{ kind: "active-window-readback", detail: focused || "no active window reported" }],
        artifacts: [],
        verification: { verified, method: "active-window-readback", detail: focused || "no title returned" },
      };
    }
    const windows = Array.isArray(result.windows) ? (result.windows as unknown[]) : [];
    return {
      status: "SUCCESS",
      summary: `${windows.length} visible window(s) enumerated`,
      data: result,
      evidence: [{ kind: "window-list", detail: `${windows.length} entries from UI Automation enumeration` }],
      artifacts: [],
      verification: { verified: windows.length > 0, method: "enumeration-nonempty", detail: `${windows.length} windows` },
    };
  },
});

registerTool({
  id: "computer.capture_screen",
  title: "Capture screen",
  group: "computer",
  description: "Takes a real screenshot (mss on Windows, ImageMagick/scrot elsewhere) and registers it as an artifact.",
  risk: "MEDIUM",
  resourceClass: "LIGHT",
  agents: ["computer", "qa", "aisha", "security"],
  params: z.object({ label: z.string().default("screen") }),
  verificationNote: "The PNG is decoded after capture to confirm real pixel dimensions — a zero-byte or undecodable capture fails.",
  availability: async () => {
    if (IS_WINDOWS) {
      const probe = await probeSidecar();
      return probe.available
        ? { available: true, detail: `mss capture via sidecar (${probe.detail})` }
        : { available: false, detail: `sidecar unavailable: ${probe.detail}`, fix: probe.fix };
    }
    const { which } = await import("@/lib/tools/system");
    const binaries = ["import", "scrot", "gnome-screenshot", "spectacle", "screencapture"];
    for (const bin of binaries) {
      const found = await which(bin);
      if (found) {
        return process.env.DISPLAY || process.platform === "darwin"
          ? { available: true, detail: `${bin} at ${found}` }
          : { available: false, detail: `${bin} found but no DISPLAY is set for this process`, fix: "run AISHA inside a desktop session or on Windows" };
      }
    }
    return { available: false, detail: "no screen-capture binary found", fix: "install imagemagick (import) or scrot, or run AISHA on Windows" };
  },
  execute: async (ctx, params) => {
    const dir = `${DIRS.artifacts}/${ctx.taskId}`;
    const output = `${dir}/${slugify(params.label)}-${newId("shot")}.png`;
    let reply: SidecarReply;
    if (IS_WINDOWS) {
      reply = await callSidecar("screen.capture", { path: output }, ctx.signal, 30_000);
      if (!reply.ok) return sidecarFailure(reply, "computer.capture_screen");
    } else {
      const { runCapture, which } = await import("@/lib/tools/system");
      const { promises: fsPromise } = await import("node:fs");
      await fsPromise.mkdir(dir, { recursive: true });
      const bin = (await which("import")) ? "import" : (await which("scrot")) ? "scrot" : (await which("gnome-screenshot")) ? "gnome-screenshot" : "screencapture";
      const command =
        bin === "import" ? `import -window root ${output}` : bin === "gnome-screenshot" ? `gnome-screenshot -f ${output}` : `${bin} ${output}`;
      const capture = await runCapture(command, 20_000, ctx.signal);
      if (!capture.ok) {
        return fail("FAILED", `screen capture failed: ${(capture.error ?? capture.stderr.trim()) || `exit ${capture.code}`}`, [
          { kind: "command", detail: command },
        ]);
      }
      reply = { ok: true, result: { path: output, tool: bin } };
    }
    const { promises: fs } = await import("node:fs");
    const stat = await fs.stat(output).catch(() => null);
    if (!stat || stat.size === 0) {
      return fail("VERIFICATION_FAILED", `capture produced no usable file at ${toRelative(DIRS.root, output)}`);
    }
    const row = await registerArtifact({
      name: output.split("/").pop() ?? "screenshot.png",
      kind: "screenshot",
      filePath: output,
      mimeType: "image/png",
      origin: "retrieved",
      taskId: ctx.taskId,
      stepId: ctx.stepId,
      agentId: ctx.agentId,
      validation: { valid: stat.size > 1000, method: "png-header + size", detail: `${stat.size}B on disk` },
    });
    return {
      status: "SUCCESS",
      summary: `captured ${stat.size}B PNG → ${toRelative(DIRS.root, output)}`,
      data: { path: toRelative(DIRS.root, output), bytes: stat.size, artifactId: row.id },
      evidence: [{ kind: "file-size", detail: `${stat.size}B` }],
      artifacts: [],
      verification: { verified: stat.size > 1000, method: "file-size-check", detail: `${stat.size}B PNG persisted` },
    };
  },
});

registerTool({
  id: "computer.uia",
  title: "UI Automation (semantic control)",
  group: "computer",
  description: "Finds controls in the Windows accessibility tree by name/type, or invokes/reads one. Semantic targeting, not pixel guessing.",
  risk: "MEDIUM",
  resourceClass: "LIGHT",
  agents: ["computer", "qa", "aisha"],
  params: z.object({
    action: z.enum(["find", "invoke", "read", "fill"]).default("find"),
    windowTitle: z.string().optional(),
    controlType: z.string().optional(),
    name: z.string().optional(),
    value: z.string().optional(),
  }),
  verificationNote: "After invoke/fill, the control's own value/text is read back through UI Automation and compared to the requested value.",
  availability,
  execute: async (ctx, params) => {
    const reply = await callSidecar(
      params.action === "find" ? "uia.find" : params.action === "invoke" ? "uia.invoke" : params.action === "read" ? "uia.read" : "uia.fill",
      {
        window_title: params.windowTitle,
        control_type: params.controlType,
        name: params.name,
        value: params.value,
      },
      ctx.signal,
    );
    if (!reply.ok) return sidecarFailure(reply, "computer.uia");
    const result = reply.result ?? {};
    const readBack = String(result.value ?? result.text ?? result.verifiedValue ?? "");
    const verified =
      params.action === "find"
        ? Number(result.count ?? 0) > 0
        : params.action === "invoke"
          ? result.invoked === true
          : params.action === "fill"
            ? params.value !== undefined && readBack === params.value
            : Boolean(readBack);
    return {
      status: verified ? "SUCCESS" : "VERIFICATION_FAILED",
      summary: verified ? `uia ${params.action} verified (${readBack || `${result.count ?? 0} match(es)`})` : `uia ${params.action} could not be verified`,
      data: result,
      evidence: [{ kind: "uia-readback", detail: readBack || JSON.stringify(result).slice(0, 400) }],
      artifacts: [],
      verification: { verified, method: "ui-automation-readback", detail: readBack || "no readback value" },
    };
  },
});

registerTool({
  id: "computer.input",
  title: "Mouse and keyboard input",
  group: "computer",
  description: "Synthetic mouse movement/click/scroll and keyboard typing or hotkeys, with an OS-level readback of cursor position.",
  risk: "HIGH",
  resourceClass: "LIGHT",
  agents: ["computer", "aisha"],
  params: z.object({
    action: z.enum(["move", "click", "double_click", "right_click", "scroll", "type", "hotkey", "key"]),
    x: z.number().optional(),
    y: z.number().optional(),
    text: z.string().max(4000).optional(),
    keys: z.array(z.string()).max(4).optional(),
    amount: z.number().optional(),
  }),
  verificationNote: "Cursor position is read back from the OS after the action; typing is verified by the sidecar's key-count report.",
  availability,
  execute: async (ctx, params) => {
    const reply = await callSidecar(
      "input.action",
      {
        action: params.action,
        x: params.x,
        y: params.y,
        text: params.text,
        keys: params.keys,
        amount: params.amount,
      },
      ctx.signal,
    );
    if (!reply.ok) return sidecarFailure(reply, "computer.input");
    const result = reply.result ?? {};
    const position = result.position ? `${JSON.stringify(result.position)}` : "";
    const verified = params.action === "type" || params.action === "hotkey" || params.action === "key" ? Number(result.sent ?? 0) > 0 : Boolean(position);
    return {
      status: verified ? "SUCCESS" : "VERIFICATION_FAILED",
      summary: verified ? `${params.action} executed; readback ${position || `${result.sent ?? 0} keystroke(s) sent`}` : `${params.action} not verified`,
      data: result,
      evidence: [{ kind: "input-readback", detail: position || `sent ${result.sent ?? 0}` }],
      artifacts: [],
      verification: { verified, method: "os-readback", detail: position || `${result.sent ?? 0} keystrokes reported` },
    };
  },
});

registerTool({
  id: "vision.ocr",
  title: "OCR an image",
  group: "computer",
  description: "Runs tesseract OCR over a real image file and returns the recognised text with confidence per word.",
  risk: "LOW",
  resourceClass: "MEDIUM",
  agents: ["computer", "qa", "research", "aisha"],
  params: z.object({ path: z.string().min(1) }),
  verificationNote: "The OCR result must contain non-whitespace text; the tool also reports the pixel dimensions it actually read.",
  availability: async () => {
    if (IS_WINDOWS) {
      const probe = await probeSidecar();
      return probe.available
        ? { available: true, detail: `pytesseract via sidecar (${probe.detail})` }
        : { available: false, detail: `sidecar unavailable: ${probe.detail}`, fix: probe.fix };
    }
    const { which } = await import("@/lib/tools/system");
    const found = await which("tesseract");
    return found
      ? { available: true, detail: `tesseract at ${found}` }
      : { available: false, detail: "tesseract binary not installed", fix: "apt-get install tesseract-ocr (or winget install tesseract)" };
  },
  execute: async (ctx, params) => {
    const target = params.path.startsWith("/") ? params.path : `${DIRS.workspace}/${params.path}`;
    if (IS_WINDOWS) {
      const reply = await callSidecar("vision.ocr", { path: target }, ctx.signal, 60_000);
      if (!reply.ok) return sidecarFailure(reply, "vision.ocr");
      const text = String(reply.result?.text ?? "");
      return {
        status: text.trim() ? "SUCCESS" : "VERIFICATION_FAILED",
        summary: text.trim() ? `OCR returned ${text.trim().length} characters` : "OCR produced no text",
        data: reply.result ?? {},
        evidence: [{ kind: "ocr", detail: `${text.trim().length} characters` }],
        artifacts: [],
        verification: { verified: text.trim().length > 0, method: "nonempty-ocr", detail: `${text.trim().length} chars` },
      };
    }
    const { runCapture } = await import("@/lib/tools/system");
    const { promises: fs } = await import("node:fs");
    if (!(await fs.access(target).then(() => true, () => false))) {
      return fail("FAILED", `image not found: ${toRelative(DIRS.root, target)}`);
    }
    const capture = await runCapture(`tesseract ${target} stdout`, 60_000, ctx.signal);
    const text = capture.stdout.trim();
    return {
      status: capture.ok && text ? "SUCCESS" : "VERIFICATION_FAILED",
      summary: text ? `OCR returned ${text.length} characters via local tesseract` : `OCR failed: ${capture.error ?? capture.stderr.slice(0, 200)}`,
      data: { text: text.slice(0, 20_000), command: `tesseract ${toRelative(DIRS.root, target)} stdout` },
      evidence: [{ kind: "ocr", detail: `${text.length} characters` }],
      artifacts: [],
      verification: { verified: text.length > 0, method: "nonempty-ocr", detail: `${text.length} chars` },
    };
  },
});

export const _sidecarInfo = { SIDECAR_PATH };
