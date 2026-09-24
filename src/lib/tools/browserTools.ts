import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { logEvent } from "@/lib/logging";
import { ensureDir, humanSize } from "@/lib/workspace";
import { fail, ok, type ArtifactSpec, type ToolContext, type ToolResult } from "@/lib/tools/types";

const require_ = createRequire(`${process.cwd()}/package.json`);

/**
 * Browser automation agent.
 *
 * The engine is optional and probed for real: if Playwright (or its browser
 * binaries) is missing, `browser.probe` reports NOT_CONFIGURED with the exact
 * install command and every browser.* tool refuses — the research agent then
 * uses the labelled HTTP extraction path instead. No page is ever fabricated.
 */

type PlaywrightPage = {
  goto: (url: string, options?: Record<string, unknown>) => Promise<{ status: () => number } | null>;
  title: () => Promise<string>;
  url: () => string;
  content: () => Promise<string>;
  textContent: (selector: string) => Promise<string | null>;
  screenshot: (options?: Record<string, unknown>) => Promise<Uint8Array>;
  click: (selector: string, options?: Record<string, unknown>) => Promise<void>;
  fill: (selector: string, value: string) => Promise<void>;
  selectOption: (selector: string, value: string) => Promise<unknown>;
  setContent: (html: string) => Promise<void>;
  keyboard: { press: (key: string) => Promise<void>; type: (text: string, options?: Record<string, unknown>) => Promise<void> };
  mouse: { wheel: (dx: number, dy: number) => Promise<void> };
  evaluate: <T>(fn: () => T) => Promise<T>;
  waitForTimeout: (ms: number) => Promise<void>;
  waitForSelector: (selector: string, options?: Record<string, unknown>) => Promise<unknown>;
};

type PlaywrightContext = { newPage: () => Promise<PlaywrightPage>; close: () => Promise<void> };
type PlaywrightBrowser = { newContext: (options?: Record<string, unknown>) => Promise<PlaywrightContext>; close: () => Promise<void> };

function playwright(): { chromium: { launch: (options?: Record<string, unknown>) => Promise<PlaywrightBrowser> } } | null {
  try {
    return require_("playwright") as { chromium: { launch: (options?: Record<string, unknown>) => Promise<PlaywrightBrowser> } };
  } catch {
    return null;
  }
}

const VIEWPORT = { width: 1440, height: 900 };

async function withPage<T>(ctx: ToolContext, fn: (page: PlaywrightPage, context: PlaywrightContext) => Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: string; diagnostics?: Record<string, unknown> }> {
  const engine = playwright();
  if (!engine) {
    return {
      ok: false,
      error:
        "The browser automation engine (Playwright) is not installed, so no browser was launched and no page was read. Install with: npm install playwright && npx playwright install chromium",
      diagnostics: { installPath: "npm install playwright && npx playwright install chromium" },
    };
  }
  let browser: PlaywrightBrowser | null = null;
  try {
    browser = await engine.chromium.launch({ headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
    if (ctx.signal.aborted) throw new Error("cancelled before navigation");
    const context = await browser.newContext({ viewport: VIEWPORT, userAgent: "AI-Executive/1.0 (local desktop agent)" });
    const page = await context.newPage();
    const value = await fn(page, context);
    await context.close();
    return { ok: true, value };
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  } finally {
    if (browser) {
      try {
        await browser.close();
      } catch {
        /* already closed */
      }
    }
  }
}

const browserProbe: (ctx: ToolContext) => Promise<ToolResult> = async () => {
  const engine = playwright();
  if (!engine) {
    return fail(
      "The browser automation engine is not installed in this environment. Interactive pages and JavaScript-rendered content cannot be driven; the HTTP research path remains available and is labelled per task. Nothing was simulated.",
      "BROWSER_ENGINE_NOT_CONFIGURED",
      { installPath: "npm install playwright && npx playwright install chromium", probed: "require.resolve('playwright')" },
    );
  }
  const attempt = await withPage({ signal: new AbortController().signal } as ToolContext, async (page) => {
    await page.setContent("<html><head><title>AISHA BROWSER PROBE</title></head><body><h1 id='probe'>engine verified</h1></body></html>");
    const title = await page.title();
    const text = await page.textContent("#probe");
    return { title, text };
  });
  if (!attempt.ok) {
    return fail(`Playwright is installed but the launch probe failed: ${attempt.error}`, "BROWSER_LAUNCH_FAILED", attempt.diagnostics ?? {});
  }
  return {
    ok: true,
    summary: `Browser engine verified: launched a real browser, rendered a page and read the DOM back (title="${attempt.value.title}", #probe="${attempt.value.text}").`,
    agentMessage: "The browser engine is genuinely working — I launched it and read a page back.",
    output: { engine: "playwright-chromium", title: attempt.value.title, text: attempt.value.text, viewport: VIEWPORT },
  };
};

const browserNavigate = async (ctx: ToolContext): Promise<ToolResult> => {
  const url = String(ctx.input.url);
  if (!/^https?:\/\//i.test(url)) return fail(`Refusing to open "${url}": only absolute http(s) URLs are allowed.`, "INVALID_URL");
  const timeoutMs = Number(ctx.input.timeoutMs ?? 45000);
  const attempt = await withPage(ctx, async (page) => {
    const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: timeoutMs });
    await page.waitForTimeout(600);
    const title = await page.title();
    const status = response?.status() ?? null;
    const html = await page.content();
    const text = (await page.textContent("body")) ?? "";
    return { title, status, htmlLength: html.length, text: text.replace(/\s+/g, " ").trim(), finalUrl: page.url() };
  });
  if (!attempt.ok) return fail(`Navigation failed for ${url}: ${attempt.error}`, "NAVIGATION_FAILED", attempt.diagnostics ?? { url });
  const value = attempt.value;
  return {
    ok: true,
    summary: `Navigated to ${value.finalUrl} (HTTP ${value.status ?? "n/a"}), title "${value.title}", ${value.htmlLength} bytes of DOM, ${value.text.length} chars of visible text.`,
    agentMessage: `Page loaded: "${value.title}". ${value.text.length} characters of visible text were read from the real DOM.`,
    output: {
      engine: "playwright-chromium",
      requestedUrl: url,
      finalUrl: value.finalUrl,
      status: value.status,
      title: value.title,
      visibleText: value.text.slice(0, 20000),
      visibleChars: value.text.length,
      domBytes: value.htmlLength,
    },
  };
};

const browserExtract = async (ctx: ToolContext): Promise<ToolResult> => {
  const url = String(ctx.input.url ?? "");
  const selector = ctx.input.selector ? String(ctx.input.selector) : null;
  const attempt = await withPage(ctx, async (page) => {
    if (url) {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
      await page.waitForTimeout(500);
    }
    const structure = await page.evaluate(() => {
      const doc = (globalThis as unknown as { document: Document }).document;
      const collection = (nodes: ArrayLike<Element>) => Array.from(nodes);
      return {
        title: doc.title,
        headings: collection(doc.querySelectorAll("h1,h2,h3")).slice(0, 40).map((node) => ({ tag: node.tagName, text: (node.textContent ?? "").trim().slice(0, 200) })),
        links: collection(doc.querySelectorAll("a[href]")).slice(0, 120).map((node) => ({ text: (node.textContent ?? "").trim().slice(0, 120), href: (node as HTMLAnchorElement).href })),
        buttons: collection(doc.querySelectorAll("button,[role=button],input[type=submit]")).slice(0, 40).map((node) => ({ text: (node.textContent ?? (node as HTMLInputElement).value ?? "").trim().slice(0, 80), id: node.id, name: (node as HTMLInputElement).name ?? "" })),
        inputs: collection(doc.querySelectorAll("input,select,textarea")).slice(0, 40).map((node) => ({ type: (node as HTMLInputElement).type ?? node.tagName, id: node.id, name: (node as HTMLInputElement).name ?? "", placeholder: (node as HTMLInputElement).placeholder ?? "" })),
        forms: collection(doc.querySelectorAll("form")).length,
        text: (doc.body?.innerText ?? "").replace(/\s+/g, " ").trim().slice(0, 30000),
      };
    });
    const selected = selector ? await page.textContent(selector) : null;
    return { ...structure, selected, url: page.url() };
  });
  if (!attempt.ok) return fail(`Page extraction failed: ${attempt.error}`, "EXTRACTION_FAILED", attempt.diagnostics ?? {});
  const value = attempt.value;
  const artifactDir = ensureDir(path.join(ctx.runDir, "browser"));
  const jsonPath = path.join(artifactDir, `page_structure_${Date.now()}.json`);
  fs.writeFileSync(jsonPath, JSON.stringify(value, null, 2), "utf8");
  return {
    ok: true,
    summary: `Extracted structured page data from ${value.url}: ${value.headings.length} headings, ${value.links.length} links, ${value.buttons.length} buttons, ${value.inputs.length} inputs, ${value.forms} form(s)${selector ? `, selector "${selector}" -> ${value.selected?.slice(0, 80) ?? "(no match)"}` : ""}.`,
    agentMessage: `I read the page structure from the live DOM: ${value.headings.length} headings, ${value.links.length} links and ${value.buttons.length} interactive buttons.`,
    output: { ...value, engine: "playwright-dom", structurePath: jsonPath },
    artifacts: [{ kind: "browser-structure", name: path.basename(jsonPath), absPath: jsonPath, mime: "application/json", meta: { links: value.links.length, headings: value.headings.length }, validated: true }],
  };
};

const browserInteract = async (ctx: ToolContext): Promise<ToolResult> => {
  const url = String(ctx.input.url ?? "");
  const action = String(ctx.input.action ?? "click");
  const selector = String(ctx.input.selector ?? "");
  if (!selector) return fail("Interactive browser actions require an explicit selector — blind coordinate clicking is not used when the DOM is available.", "MISSING_SELECTOR");
  const attempt = await withPage(ctx, async (page) => {
    if (url) {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
      await page.waitForTimeout(400);
    }
    const before = { url: page.url(), title: await page.title() };
    if (action === "click") {
      await page.waitForSelector(selector, { timeout: 15000 });
      await page.click(selector, { timeout: 15000 });
    } else if (action === "type") {
      await page.fill(selector, String(ctx.input.text ?? ""));
    } else if (action === "select") {
      await page.selectOption(selector, String(ctx.input.value ?? ""));
    } else if (action === "press") {
      await page.keyboard.press(String(ctx.input.key ?? "Enter"));
    } else if (action === "scroll") {
      await page.mouse.wheel(0, Number(ctx.input.delta ?? 800));
    } else {
      throw new Error(`Unsupported browser action "${action}"`);
    }
    await page.waitForTimeout(700);
    const after = { url: page.url(), title: await page.title(), bodyText: ((await page.textContent("body")) ?? "").replace(/\s+/g, " ").slice(0, 4000) };
    return { before, after, action };
  });
  if (!attempt.ok) return fail(`Browser interaction ("${action}" on ${selector}) failed: ${attempt.error}`, "INTERACTION_FAILED", attempt.diagnostics ?? {});
  const { before, after } = attempt.value;
  const changed = before.url !== after.url || before.title !== after.title;
  return {
    ok: true,
    summary: `Performed ${action} on "${selector}" through the DOM. Page state ${changed ? "changed" : "unchanged"}: url ${before.url} -> ${after.url}, title "${before.title}" -> "${after.title}".`,
    agentMessage: `${action} completed through semantic DOM interaction (no coordinate guessing). ${changed ? "The page state changed." : "The page state did not visibly change."}`,
    output: { engine: "playwright-dom", action, selector, before, after, stateChanged: changed },
  };
};

const browserScreenshot = async (ctx: ToolContext): Promise<ToolResult> => {
  const url = String(ctx.input.url ?? "");
  const dir = ensureDir(path.join(ctx.runDir, "browser"));
  const file = path.join(dir, `page_${Date.now()}.png`);
  const attempt = await withPage(ctx, async (page) => {
    if (url) {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
      await page.waitForTimeout(600);
    }
    const buffer = await page.screenshot({ fullPage: Boolean(ctx.input.fullPage) });
    fs.writeFileSync(file, buffer);
    return { title: await page.title(), finalUrl: page.url(), bytes: buffer.byteLength };
  });
  if (!attempt.ok) return fail(`Browser screenshot failed: ${attempt.error}`, "SCREENSHOT_FAILED", attempt.diagnostics ?? {});
  const artifacts: ArtifactSpec[] = [{ kind: "screenshot", name: path.basename(file), absPath: file, mime: "image/png", meta: { url: attempt.value.finalUrl, title: attempt.value.title, bytes: attempt.value.bytes }, validated: attempt.value.bytes > 1000 }];
  await logEvent("browser", `Browser screenshot of ${attempt.value.finalUrl} (${humanSize(attempt.value.bytes)})`, { taskId: ctx.taskId, agentId: ctx.agentId });
  return {
    ok: true,
    summary: `Captured a ${humanSize(attempt.value.bytes)} PNG of "${attempt.value.title}" (${attempt.value.finalUrl}).`,
    agentMessage: "Screenshot captured from the rendered page.",
    output: { engine: "playwright-chromium", path: file, bytes: attempt.value.bytes, url: attempt.value.finalUrl, title: attempt.value.title },
    artifacts,
  };
};

const browserVerify = async (ctx: ToolContext): Promise<ToolResult> => {
  const url = String(ctx.input.url ?? "");
  const expected = String(ctx.input.expectedText ?? "");
  if (expected.length < 2) return fail("browser.verify requires expectedText.", "MISSING_EXPECTATION");
  const attempt = await withPage(ctx, async (page) => {
    if (url) {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
      await page.waitForTimeout(400);
    }
    const text = ((await page.textContent("body")) ?? "").replace(/\s+/g, " ");
    const index = text.toLowerCase().indexOf(expected.toLowerCase());
    return { found: index >= 0, url: page.url(), title: await page.title(), context: index >= 0 ? text.slice(Math.max(0, index - 180), index + 320) : text.slice(0, 400) };
  });
  if (!attempt.ok) return fail(`Verification navigation failed: ${attempt.error}`, "VERIFICATION_FAILED", attempt.diagnostics ?? {});
  return {
    ok: attempt.value.found,
    summary: attempt.value.found
      ? `VERIFIED: ${attempt.value.url} really contains "${expected}". Context: …${attempt.value.context}…`
      : `NOT VERIFIED: "${expected}" was not found in the rendered page at ${attempt.value.url}. Beginning of the page: ${attempt.value.context.slice(0, 200)}`,
    error: attempt.value.found ? undefined : `"${expected}" not present in the page`,
    agentMessage: attempt.value.found ? `Confirmed on the live page: "${expected}" is present.` : `I could not find "${expected}" on that page, so I am reporting a negative result rather than guessing.`,
    output: { engine: "playwright-dom", verified: attempt.value.found, url: attempt.value.url, title: attempt.value.title, context: attempt.value.context },
  };
};

export const BROWSER_TOOLS = {
  "browser.probe": browserProbe,
  "browser.navigate": browserNavigate,
  "browser.extract": browserExtract,
  "browser.interact": browserInteract,
  "browser.screenshot": browserScreenshot,
  "browser.verify": browserVerify,
} satisfies Record<string, (ctx: ToolContext) => Promise<ToolResult>>;
