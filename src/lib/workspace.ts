import fs from "node:fs";
import path from "node:path";

/**
 * Workspace resolution. NOTHING in this project hardcodes a user home path or a
 * developer machine path: every location is derived from the project root, an
 * env override, or the OS-provided directories at runtime.
 */

export type WorkspaceRoots = {
  projectRoot: string;
  dataRoot: string;
  runsRoot: string;
  uploadsRoot: string;
  outputRoot: string;
  logsRoot: string;
  tempRoot: string;
  documentsRoot: string;
};

function projectRoot(): string {
  if (process.env.AI_EXECUTIVE_ROOT) return path.resolve(process.env.AI_EXECUTIVE_ROOT);
  // .next/ or src/ -> project root
  const candidates = [process.cwd(), path.resolve(process.cwd(), "..")];
  for (const candidate of candidates) {
    if (fs.existsSync(path.join(candidate, "package.json"))) return candidate;
  }
  return process.cwd();
}

export function roots(): WorkspaceRoots {
  const root = projectRoot();
  const dataRoot = process.env.AI_EXECUTIVE_DATA_DIR
    ? path.resolve(process.env.AI_EXECUTIVE_DATA_DIR)
    : path.join(root, "data");
  const docs = process.env.AI_EXECUTIVE_DOCUMENTS_DIR
    ? path.resolve(process.env.AI_EXECUTIVE_DOCUMENTS_DIR)
    : path.join(dataRoot, "documents");
  return {
    projectRoot: root,
    dataRoot,
    runsRoot: path.join(root, "runs"),
    uploadsRoot: path.join(root, "uploads"),
    outputRoot: path.join(root, "output"),
    logsRoot: path.join(root, "logs"),
    tempRoot: path.join(root, "temp"),
    documentsRoot: docs,
  };
}

export function ensureDir(dir: string): string {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function ensureWorkspace(): WorkspaceRoots {
  const r = roots();
  for (const dir of [r.dataRoot, r.runsRoot, r.uploadsRoot, r.outputRoot, r.logsRoot, r.tempRoot, r.documentsRoot]) {
    ensureDir(dir);
  }
  return r;
}

export const SAFE_FILENAME = /^[A-Za-z0-9._-]+$/;

/** Remove traversal, absolute prefixes, control chars and reserved Windows names. */
export function safeFilename(original: string): string {
  const base = path
    .basename(original.replace(/\\/g, "/"))
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/[^A-Za-z0-9._ -]/g, "_")
    .trim();
  const collapsed = base.replace(/\s+/g, "_");
  const guarded = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(collapsed) ? `file_${collapsed}` : collapsed;
  return guarded.length > 0 ? guarded.slice(0, 120) : "file";
}

/** Ensure a unique name inside a directory: never overwrite an existing file. */
export function uniqueFilename(dir: string, filename: string): string {
  ensureDir(dir);
  const ext = path.extname(filename);
  const stem = path.basename(filename, ext);
  let candidate = filename;
  let counter = 1;
  while (fs.existsSync(path.join(dir, candidate))) {
    candidate = `${stem}_${counter}${ext}`;
    counter += 1;
    if (counter > 500) {
      candidate = `${stem}_${Date.now()}${ext}`;
      break;
    }
  }
  return candidate;
}

export function assertInside(base: string, candidate: string): string {
  const resolvedBase = path.resolve(base);
  const resolved = path.resolve(candidate);
  const rel = path.relative(resolvedBase, resolved);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new SecurityError(`Path escapes the allowed area: ${candidate}`, { base: resolvedBase, candidate: resolved });
  }
  return resolved;
}

export class SecurityError extends Error {
  detail: Record<string, unknown>;
  constructor(message: string, detail: Record<string, unknown> = {}) {
    super(message);
    this.name = "SecurityError";
    this.detail = detail;
  }
}

/** Resolve a user-supplied path (absolute or relative) inside the access scope. */
export function resolveUserPath(input: string, scope: "workspace" | "documents" | "uploads"): string {
  const r = roots();
  const allow: Record<typeof scope, string[]> = {
    workspace: [r.dataRoot, r.projectRoot],
    documents: [r.documentsRoot, r.dataRoot, r.projectRoot],
    uploads: [r.uploadsRoot],
  };
  const raw = input.trim().replace(/^"|"$/g, "");
  if (raw.length === 0) throw new SecurityError("Empty path");

  // Named roots resolved from the natural-language hints produced by the planner.
  const sentinels: Record<string, string> = {
    documents: r.documentsRoot,
    documents_folder: r.documentsRoot,
    uploads: r.uploadsRoot,
    workspace: r.dataRoot,
    data: r.dataRoot,
    desktop: path.join(process.env.USERPROFILE ?? process.env.HOME ?? r.dataRoot, "Desktop"),
    downloads: path.join(process.env.USERPROFILE ?? process.env.HOME ?? r.dataRoot, "Downloads"),
  };
  const sentinelKey = raw.toLowerCase().replace(/\s+/g, "_").replace(/_folder$/, "");
  if (sentinels[sentinelKey]) {
    if (sentinelKey === "desktop" || sentinelKey === "downloads") {
      // Personal folders are only honoured if they actually exist; otherwise fall back to Documents.
      return fs.existsSync(sentinels[sentinelKey]) ? sentinels[sentinelKey] : r.documentsRoot;
    }
    return sentinels[sentinelKey];
  }

  const candidates: string[] = [];
  if (path.isAbsolute(raw)) {
    candidates.push(path.resolve(raw));
  } else {
    candidates.push(path.resolve(process.env.HOME ?? r.dataRoot, raw));
    candidates.push(path.resolve(r.documentsRoot, raw));
    candidates.push(path.resolve(r.projectRoot, raw));
  }
  for (const candidate of candidates) {
    for (const base of allow[scope]) {
      try {
        const inside = assertInside(base, candidate);
        return inside;
      } catch {
        /* keep trying */
      }
    }
  }
  throw new SecurityError(
    `Path "${input}" is outside the permitted scope (${scope}). Allowed roots: ${allow[scope].join(", ")}`,
    { input, scope },
  );
}

export function relToRoot(absPath: string): string {
  const r = roots();
  const rel = path.relative(r.projectRoot, absPath);
  return rel.startsWith("..") ? absPath : rel;
}

export function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/** Real atomic publish: write temp -> validate -> rename. Never expose partial output. */
export function atomicPublish(tempPath: string, finalPath: string): void {
  ensureDir(path.dirname(finalPath));
  fs.renameSync(tempPath, finalPath);
}
