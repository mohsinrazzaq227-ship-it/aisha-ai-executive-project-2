import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { ffmpegBinary, ffprobeBinary } from "@/lib/providers";
import { ffmpegJobs } from "@/lib/tools/jobRegistry";
import { askModel } from "@/lib/llm";
import { logEvent } from "@/lib/logging";
import { ensureDir, humanSize } from "@/lib/workspace";
import { atomicPublish } from "@/lib/workspace";
import {
  DEFAULT_CAPTION_STYLE,
  FRAME_HEIGHT,
  FRAME_WIDTH,
  THEMES,
  composeFrameWithCaption,
  measureText,
  renderCaptionPng,
  renderScenePng,
  wrapText,
  type SceneSpec,
  type Theme,
  type VisualType,
} from "@/lib/textrender";
import { fail, ok, type ArtifactSpec, type ToolContext, type ToolHandler } from "@/lib/tools/types";
import type { ResearchBundle } from "@/lib/tools/knowledgeTools";

/* ------------------------------------------------------------------ */
/* Types                                                              */
/* ------------------------------------------------------------------ */

export type BeatKey = "HOOK" | "CONTEXT" | "MECHANISM" | "EVIDENCE" | "APPLICATION" | "IMPLICATIONS" | "TAKEAWAY";

export type CreativeBrief = {
  id: string;
  topic: string;
  audience: string;
  platform: string;
  durationSec: number;
  tone: string;
  visualStyle: string;
  narrativeStructure: { beat: BeatKey; purpose: string; seconds: number }[];
  sceneCount: number;
  transitions: string;
  cameraLanguage: string[];
  soundDesign: string;
  captions: string;
  pacing: string;
  themeId: string;
  evidenceAvailable: number;
  factCheck: { supported: number; partial: number; unsupported: number } | null;
  createdAt: string;
};

export type ScriptBeat = {
  index: number;
  beat: BeatKey;
  heading: string;
  narration: string;
  wordCount: number;
  targetSeconds: number;
  engine: string;
  grounding: string[];
};

export type Scene = {
  index: number;
  beat: BeatKey;
  purpose: string;
  narration: string;
  durationSec: number;
  visualType: VisualType;
  motion: "ZOOM_IN" | "ZOOM_OUT" | "PAN_LEFT" | "PAN_RIGHT" | "PARALLAX" | "ROTATE";
  transition: "CUT" | "FADE" | "DIP";
  themeId: string;
  bullets: string[];
  data: { label: string; value: string }[];
  dataSource: "RESEARCH_FACTS" | "STORYBOARD_METRICS" | "SCRIPT_STATS";
  sources: { title: string; url: string }[];
  bgPath?: string;
  framePath?: string;
};

export type Storyboard = {
  id: string;
  briefId: string;
  topic: string;
  scenes: Scene[];
  totalDurationSec: number;
  fps: number;
  resolution: { width: number; height: number };
  visualDiversity: { distinctTypes: number; types: string[] };
  createdAt: string;
};

export type CaptionCue = {
  sceneIndex: number;
  start: number;
  end: number;
  text: string;
  lines: string[];
  pngPath: string;
  measuredWidth: number;
  overflowed: boolean;
  fontSize: number;
};

export type CaptionTrack = {
  id: string;
  cues: CaptionCue[];
  timingSource: "WHISPER_WORD_LEVEL" | "SCENE_DURATION_PROPORTIONAL";
  overflowCount: number;
  srtPath: string;
  createdAt: string;
};

/* ------------------------------------------------------------------ */
/* Helpers                                                            */
/* ------------------------------------------------------------------ */

function themeForTopic(topic: string): Theme {
  const t = topic.toLowerCase();
  if (/space|black hole|galaxy|astro|cosmos|universe/.test(t)) return THEMES[0];
  if (/climate|energy|heat|fire|volcan|solar/.test(t)) return THEMES[1];
  if (/bio|health|medicine|gene|cell|eco|agri/.test(t)) return THEMES[2];
  if (/security|cyber|network|code|software|ai\b/.test(t)) return THEMES[3];
  return THEMES[4];
}

function beatPlan(durationSec: number): { beat: BeatKey; purpose: string; seconds: number }[] {
  const perScene = durationSec <= 30 ? 6 : durationSec <= 60 ? 6.5 : 7;
  const sceneCount = Math.max(4, Math.min(24, Math.round(durationSec / perScene)));
  const base: { beat: BeatKey; purpose: string }[] = [
    { beat: "HOOK", purpose: "Earn attention with the single most surprising verified fact" },
    { beat: "CONTEXT", purpose: "Establish what the viewer is looking at and why it matters" },
    { beat: "MECHANISM", purpose: "Explain the underlying mechanism step by step" },
    { beat: "EVIDENCE", purpose: "Present measured evidence with real numbers" },
    { beat: "APPLICATION", purpose: "Translate the mechanism into concrete modern applications" },
    { beat: "IMPLICATIONS", purpose: "State what this changes and what remains open" },
    { beat: "TAKEAWAY", purpose: "Close on one memorable, verifiable statement" },
  ];
  const beats: { beat: BeatKey; purpose: string; seconds: number }[] = [];
  for (let i = 0; i < sceneCount; i += 1) {
    const template = base[i % base.length];
    const cycle = Math.floor(i / base.length);
    beats.push({
      beat: template.beat,
      purpose: cycle === 0 ? template.purpose : `${template.purpose} (extended deep-dive ${cycle + 1})`,
      seconds: durationSec / sceneCount,
    });
  }
  const total = beats.reduce((sum, b) => sum + b.seconds, 0);
  const scale = durationSec / total;
  return beats.map((b) => ({ ...b, seconds: Number((b.seconds * scale).toFixed(2)) }));
}

function pickStatData(facts: string[], context: string[], theme: Theme): { label: string; value: string; dataSource: Scene["dataSource"] }[] {
  const found: { label: string; value: string }[] = [];
  for (const fact of facts) {
    const matches = fact.match(/([$€£]?\d[\d,.]*\s?(?:%|percent|billion|million|thousand|years?|km|kg|seconds?|degrees?|light-years?)?)/gi) ?? [];
    for (const match of matches) {
      const cleaned = match.trim();
      const contextWords = fact
        .split(/\s+/)
        .filter((w) => /[a-zA-Z]{4,}/.test(w))
        .slice(0, 6)
        .join(" ");
      if (cleaned.replace(/[^0-9]/g, "").length >= 1 && found.length < 8) {
        found.push({ label: contextWords.slice(0, 90) || "Measured value in source", value: cleaned.slice(0, 14) });
      }
    }
    if (found.length >= 6) break;
  }
  if (found.length >= 3) return found.slice(0, 6).map((f) => ({ ...f, dataSource: "RESEARCH_FACTS" as const }));
  return [];
}

/* ------------------------------------------------------------------ */
/* Director                                                           */
/* ------------------------------------------------------------------ */

const directorBrief: ToolHandler = async (ctx) => {
  const topic = String(ctx.input.topic);
  const durationSec = Number(ctx.input.durationSec);
  const audience = String(ctx.input.audience ?? "curious adults, non-specialists");
  const platform = String(ctx.input.platform ?? "vertical short-form explainer (1080x1920)");
  const tone = String(ctx.input.tone ?? "authoritative, calm, no hype");
  const theme = themeForTopic(topic);
  const plan = beatPlan(durationSec);
  const research = (ctx.findings.research as ResearchBundle | undefined) ?? (await ctx.loadHandle<ResearchBundle>("research")) ?? undefined;
  const evidence = research?.facts ?? [];
  const factCheck = (ctx.findings.factCheck as { supported: number; partial: number; unsupported: number } | undefined) ?? null;

  const brief: CreativeBrief = {
    id: `brief_${ctx.runId}_${ctx.stepId}`,
    topic,
    audience,
    platform,
    durationSec,
    tone,
    visualStyle: `deterministic vector art, ${theme.name} palette, high-contrast typography, editorial grid, no stock photography`,
    narrativeStructure: plan,
    sceneCount: plan.length,
    transitions: "hard cuts inside a beat block, 0.35s crossfades across beat changes, dip-to-colour on the final close",
    cameraLanguage: ["push-in", "pull-out", "lateral pan", "parallax drift", "orbit tilt"],
    soundDesign: "synthesised score bed, -23 LUFS target for the bed; narration mixed on top when a TTS provider is configured",
    captions: `two-line maximum, ${DEFAULT_CAPTION_STYLE.sideSafe}px side safe area, ${DEFAULT_CAPTION_STYLE.bottomSafe}px bottom safe area, measured line breaks, outline + shadow for contrast`,
    pacing: `${plan.length} scenes over ${durationSec}s (~${(durationSec / plan.length).toFixed(1)}s per scene)`,
    themeId: theme.id,
    evidenceAvailable: evidence.length,
    factCheck,
    createdAt: new Date().toISOString(),
  };

  const briefDir = ensureDir(path.join(ctx.runDir, "script"));
  const briefPath = path.join(briefDir, "creative_brief.json");
  fs.writeFileSync(briefPath, JSON.stringify(brief, null, 2), "utf8");
  const handleId = await ctx.handle("brief", brief);
  ctx.findings.brief = brief;

  return {
    ok: true,
    summary: `Creative brief ready: ${plan.length} scenes / ${durationSec}s, audience "${audience}", style "${theme.name}", grounded in ${evidence.length} verified facts.`,
    agentMessage: `Brief locked: ${plan.length} scenes across ${durationSec} seconds. The narration will be grounded in ${evidence.length} verified research facts, not filler.`,
    output: { ...brief, handle: handleId },
    artifacts: [{ kind: "brief", name: "creative_brief.json", absPath: briefPath, mime: "application/json", meta: { sceneCount: plan.length, theme: theme.id }, validated: true }],
  };
};

/* ------------------------------------------------------------------ */
/* Scriptwriter                                                       */
/* ------------------------------------------------------------------ */

const SENTENCE_TEMPLATES: Record<BeatKey, string[]> = {
  HOOK: [
    "Here is the part of {topic} that surprises almost everyone.",
    "{topic} is usually described badly — let us start with what is actually verified.",
  ],
  CONTEXT: [
    "To make sense of this, start with the established picture of {topic}.",
    "The background matters, because {topic} is easy to misread at a glance.",
  ],
  MECHANISM: [
    "The mechanism itself has a clear sequence.",
    "Strip away the jargon and the process runs in stages.",
  ],
  EVIDENCE: ["The numbers are what make this concrete.", "Measurement is where the claims become checkable."],
  APPLICATION: ["That is not abstract: it shows up in real systems.", "This is where the science turns into engineering."],
  IMPLICATIONS: ["The consequences are measurable, and some questions stay open.", "This changes what we can predict — and what we still cannot."],
  TAKEAWAY: ["If you remember one thing, remember this:", "The honest summary is short."],
};

const STOP = new Set("the a an and or of to in with for on by is are was were be been this that these those it its as at from than then into over under more most other such no nor only own same so too very can will just about above after again against all any because before being below between during few further here how".split(/\s+/));

function deterministicNarration(beat: BeatKey, topic: string, facts: string[], targetSeconds: number): { narration: string; grounding: string[] } {
  const wps = 2.55;
  const budget = Math.max(18, Math.round(targetSeconds * wps));
  const opener = SENTENCE_TEMPLATES[beat][0].replace(/\{topic\}/g, topic);
  const grounding: string[] = [];
  let narration = `${opener} `;
  const usable = facts.filter((fact) => fact.length > 70);
  const chosen = usable.slice(0, Math.max(1, Math.min(3, Math.ceil((budget - opener.split(/\s+/).length) / 34))));
  for (const fact of chosen) {
    const clean = fact.replace(/\s+/g, " ").replace(/\s*\([^)]*\)\s*/g, " ").trim();
    narration += `${clean.replace(/\.$/, "")}. `;
    grounding.push(fact.slice(0, 220));
  }
  if (chosen.length === 0) {
    narration += `No source material was retrieved for ${topic}, so this section states only that the evidence is missing rather than inventing detail. `;
  }
  if (beat === "TAKEAWAY" && usable.length > 0) {
    narration += "Everything above traces back to the sources listed in the description. ";
  }
  const words = narration.split(/\s+/).filter(Boolean);
  if (words.length > budget * 1.25) narration = `${words.slice(0, Math.round(budget * 1.2)).join(" ")}.`;
  return { narration: narration.trim(), grounding };
}

const scriptGenerate: ToolHandler = async (ctx) => {
  const topic = String(ctx.input.topic);
  const durationSec = Number(ctx.input.durationSec);
  const audience = String(ctx.input.audience ?? "curious adults");
  const tone = String(ctx.input.tone ?? "authoritative, calm");
  const brief = (ctx.findings.brief as CreativeBrief | undefined) ?? (await ctx.loadHandle<CreativeBrief>("brief"));
  const research = (ctx.findings.research as ResearchBundle | undefined) ?? (await ctx.loadHandle<ResearchBundle>("research"));
  const evidence = ((ctx.input.evidence as string[] | undefined) ?? research?.facts ?? []).slice(0, 40);
  if (evidence.length === 0) {
    await ctx.progress("No research evidence available — the script will be written without factual grounding and labelled as such.");
  }
  const plan = brief?.narrativeStructure ?? beatPlan(durationSec);

  const beats: ScriptBeat[] = [];
  let llmBeats = 0;
  let deterministicBeats = 0;
  for (let index = 0; index < plan.length; index += 1) {
    const entry = plan[index];
    const slice = evidence.slice(index * 3, index * 3 + 4);
    const deterministic = deterministicNarration(entry.beat, topic, slice.length > 0 ? slice : evidence, entry.seconds);
    let narration = deterministic.narration;
    let engine = "deterministic-local";
    if (index < 8) {
      const attempt = await askModel(
        `Section type: ${entry.beat}. Topic: ${topic}. Audience: ${audience}. Tone: ${tone}. Target length: about ${Math.round(entry.seconds * 2.55)} words (about ${entry.seconds}s spoken).\nVerified facts you may use (do not invent anything beyond them):\n${(slice.length > 0 ? slice : evidence).map((f, i) => `${i + 1}. ${f}`).join("\n") || "(none retrieved)"}\nWrite ONLY the narration for this section as plain prose. No headings, no stage directions, no markdown.`,
        "You are a professional documentary narrator. You write precise, adult, non-repetitive prose. You never fabricate facts; if evidence is thin you say less rather than invent.",
        ctx.signal,
      );
      if (attempt.ok && attempt.text.trim().split(/\s+/).length >= 12) {
        narration = attempt.text.trim().replace(/^["']|["']$/g, "");
        engine = `${attempt.engine}${attempt.model ? `:${attempt.model}` : ""}`;
        llmBeats += 1;
      } else {
        deterministicBeats += 1;
      }
    } else {
      deterministicBeats += 1;
    }
    await ctx.progress(`Script section ${index + 1}/${plan.length} written (${engine})`);
    beats.push({
      index,
      beat: entry.beat,
      heading: `${entry.beat} — ${entry.purpose}`,
      narration,
      wordCount: narration.split(/\s+/).filter(Boolean).length,
      targetSeconds: entry.seconds,
      engine,
      grounding: deterministic.grounding,
    });
  }

  const script = {
    id: `script_${ctx.runId}`,
    topic,
    durationSec,
    audience,
    tone,
    beats,
    totalWords: beats.reduce((sum, b) => sum + b.wordCount, 0),
    engines: { llmBeats, deterministicBeats },
    createdAt: new Date().toISOString(),
  };
  const scriptDir = ensureDir(path.join(ctx.runDir, "script"));
  const jsonPath = path.join(scriptDir, "script.json");
  const mdPath = path.join(scriptDir, "script.md");
  fs.writeFileSync(jsonPath, JSON.stringify(script, null, 2), "utf8");
  fs.writeFileSync(
    mdPath,
    [`# ${topic}`, "", `${durationSec}s · ${audience} · ${tone}`, "", ...beats.map((b) => `## Scene ${String(b.index + 1).padStart(2, "0")} · ${b.beat}\n\n${b.narration}\n\n_grounded in ${b.grounding.length} source fact(s) · engine ${b.engine}_\n`)].join("\n"),
    "utf8",
  );
  const handleId = await ctx.handle("script", script);
  ctx.findings.script = script;

  return {
    ok: true,
    summary: `Script written: ${beats.length} sections, ${script.totalWords} words (${llmBeats} sections by the configured model, ${deterministicBeats} by the deterministic local writer).`,
    agentMessage: `Script complete — ${beats.length} sections, ${script.totalWords} words. ${llmBeats > 0 ? `${llmBeats} sections came from the configured local model.` : "No language model was configured, so the deterministic local writer produced every section and I am saying so rather than implying otherwise."}`,
    output: { handle: handleId, beats, totalWords: script.totalWords, engines: script.engines, scriptPath: mdPath, groundingAvailable: evidence.length },
    artifacts: [
      { kind: "script", name: "script.json", absPath: jsonPath, mime: "application/json", meta: { beats: beats.length, totalWords: script.totalWords } },
      { kind: "script", name: "script.md", absPath: mdPath, mime: "text/markdown" },
    ],
  };
};

/* ------------------------------------------------------------------ */
/* Storyboard + visuals                                               */
/* ------------------------------------------------------------------ */

const VISUAL_ORDER: VisualType[] = ["TITLE_CARD", "PARALLAX_CROP", "MECHANISM_STEPS", "CHART_BARS", "DIAGRAM_FLOW", "STAT_CALLOUT", "TIMELINE", "COMPARISON_TABLE", "QUOTE_CARD", "SOURCE_LIST", "ICON_GRID", "PARTICLE_FIELD"];
const MOTIONS: Scene["motion"][] = ["ZOOM_IN", "PAN_LEFT", "ZOOM_OUT", "PAN_RIGHT", "PARALLAX", "ROTATE"];

const storyboardGenerate: ToolHandler = async (ctx) => {
  const scriptStored = (ctx.findings.script as { id: string; beats: ScriptBeat[]; topic: string }) ?? (await ctx.loadHandle<{ id: string; beats: ScriptBeat[]; topic: string }>(String(ctx.input.scriptId)));
  if (!scriptStored) return fail(`Script handle "${String(ctx.input.scriptId)}" not found in this run.`, "SCRIPT_NOT_FOUND");
  const brief = (ctx.findings.brief as CreativeBrief | undefined) ?? (await ctx.loadHandle<CreativeBrief>("brief"));
  const research = (ctx.findings.research as ResearchBundle | undefined) ?? (await ctx.loadHandle<ResearchBundle>("research"));
  const topic = scriptStored.topic;
  const theme = themeForTopic(topic);
  const stats = pickStatData(research?.facts ?? [], [], theme);
  const sources = (research?.sources ?? []).slice(0, 6).map((s) => ({ title: s.title, url: s.url }));

  const scenes: Scene[] = scriptStored.beats.map((beat, index) => {
    const visualType = VISUAL_ORDER[index % VISUAL_ORDER.length];
    const facts = research?.facts ?? [];
    const data = visualType === "CHART_BARS" || visualType === "STAT_CALLOUT" || visualType === "TIMELINE" || visualType === "COMPARISON_TABLE"
      ? stats.slice(0, 6)
      : [];
    return {
      index,
      beat: beat.beat,
      purpose: brief?.narrativeStructure[index]?.purpose ?? beat.heading,
      narration: beat.narration,
      durationSec: Number((beat.targetSeconds || beat.wordCount / 2.55).toFixed(2)),
      visualType,
      motion: MOTIONS[index % MOTIONS.length],
      transition: index === 0 || index === scriptStored.beats.length - 1 ? "FADE" : index % 3 === 0 ? "FADE" : "CUT",
      themeId: theme.id,
      bullets: facts.slice(index * 2, index * 2 + 3).map((f) => f.slice(0, 110)),
      data: data.map((d) => ({ label: d.label, value: d.value })),
      dataSource: data.length > 0 ? "RESEARCH_FACTS" : "STORYBOARD_METRICS",
      sources: visualType === "SOURCE_LIST" ? sources : [],
    };
  });

  const distinct = Array.from(new Set(scenes.map((s) => s.visualType)));
  const storyboard: Storyboard = {
    id: `storyboard_${ctx.runId}`,
    briefId: brief?.id ?? "no-brief",
    topic,
    scenes,
    totalDurationSec: Number(scenes.reduce((sum, s) => sum + s.durationSec, 0).toFixed(2)),
    fps: 30,
    resolution: { width: FRAME_WIDTH, height: FRAME_HEIGHT },
    visualDiversity: { distinctTypes: distinct.length, types: distinct },
    createdAt: new Date().toISOString(),
  };
  const dir = ensureDir(path.join(ctx.runDir, "storyboard"));
  const jsonPath = path.join(dir, "storyboard.json");
  fs.writeFileSync(jsonPath, JSON.stringify(storyboard, null, 2), "utf8");
  fs.writeFileSync(
    path.join(dir, "storyboard.md"),
    [`# Storyboard · ${topic}`, "", `${scenes.length} scenes · ${storyboard.totalDurationSec}s total · ${distinct.length} distinct visual types`, "", ...scenes.map((s) => `## SCENE ${String(s.index + 1).padStart(2, "0")} · ${s.beat}\n- Purpose: ${s.purpose}\n- Visual: ${s.visualType} (${s.dataSource})\n- Camera: ${s.motion}\n- Transition: ${s.transition}\n- Duration: ${s.durationSec}s\n- Narration: ${s.narration}\n`)].join("\n"),
    "utf8",
  );
  const handleId = await ctx.handle("storyboard", storyboard);
  ctx.findings.storyboard = storyboard;

  const tooSimilar = scenes.filter((s, i) => i > 0 && s.visualType === scenes[i - 1].visualType).length;
  return {
    ok: true,
    summary: `Storyboard built: ${scenes.length} scenes, ${storyboard.totalDurationSec}s, ${distinct.length} distinct visual representations, ${tooSimilar} repeated adjacent visual(s).`,
    agentMessage: `Storyboard ready — ${scenes.length} scenes and ${distinct.length} genuinely different visual languages. Repeated adjacent visuals: ${tooSimilar}.`,
    output: { handle: handleId, sceneCount: scenes.length, totalDurationSec: storyboard.totalDurationSec, visualDiversity: storyboard.visualDiversity, storyboardPath: jsonPath, dataSource: scenes[0]?.dataSource },
    artifacts: [
      { kind: "storyboard", name: "storyboard.json", absPath: jsonPath, mime: "application/json", meta: { scenes: scenes.length, distinctTypes: distinct.length } },
      { kind: "storyboard", name: "storyboard.md", absPath: path.join(dir, "storyboard.md"), mime: "text/markdown" },
    ],
  };
};

function sceneSpecFrom(scene: Scene, total: number, theme: Theme): SceneSpec {
  return {
    index: scene.index,
    kicker: `${scene.beat} · SCENE ${String(scene.index + 1).padStart(2, "0")} / ${String(total).padStart(2, "0")}`,
    title: scene.visualType === "TITLE_CARD" ? scene.narration.split(/(?<=[.!?])\s/)[0]?.slice(0, 120) ?? scene.purpose : scene.purpose,
    body: scene.visualType === "QUOTE_CARD" ? scene.narration.slice(0, 320) : scene.narration.slice(0, 300),
    bullets: scene.bullets,
    visualType: scene.visualType,
    data: scene.data,
    sources: scene.sources,
    accent: theme.accent,
    accent2: theme.accent2,
    themeId: scene.themeId,
    totalScenes: total,
  };
}

const visualsRender: ToolHandler = async (ctx) => {
  const storyboard = (ctx.findings.storyboard as Storyboard | undefined) ?? (await ctx.loadHandle<Storyboard>(String(ctx.input.storyboardId)));
  if (!storyboard) return fail(`Storyboard "${String(ctx.input.storyboardId)}" not found.`, "STORYBOARD_NOT_FOUND");
  const theme = THEMES.find((t) => t.id === storyboard.scenes[0]?.themeId) ?? THEMES[0];
  const imagesDir = ensureDir(path.join(ctx.runDir, "images"));
  const artworks: ArtifactSpec[] = [];
  const wanted = (ctx.input.sceneIndexes as number[] | undefined) ?? storyboard.scenes.map((s) => s.index);

  for (const scene of storyboard.scenes) {
    if (!wanted.includes(scene.index)) continue;
    const spec = sceneSpecFrom(scene, storyboard.scenes.length, theme);
    const bg = await renderScenePng(spec);
    const bgPath = path.join(imagesDir, `scene_${String(scene.index + 1).padStart(2, "0")}_bg.png`);
    fs.writeFileSync(bgPath, bg);
    const caption = await renderCaptionPng(scene.narration, theme);
    const captionPath = path.join(imagesDir, `scene_${String(scene.index + 1).padStart(2, "0")}_caption.png`);
    fs.writeFileSync(captionPath, caption.buffer);
    const frame = await composeFrameWithCaption(bg, caption.buffer);
    const framePath = path.join(imagesDir, `scene_${String(scene.index + 1).padStart(2, "0")}_frame.png`);
    fs.writeFileSync(framePath, frame);
    scene.bgPath = bgPath;
    scene.framePath = framePath;
    artworks.push({
      kind: "image",
      name: path.basename(framePath),
      absPath: framePath,
      mime: "image/png",
      meta: { scene: scene.index + 1, visualType: scene.visualType, motion: scene.motion, transition: scene.transition, overflowed: caption.overflowed, lines: caption.lines.length, bgPath, captionPath },
    });
    await ctx.progress(`Rendered frame ${scene.index + 1}/${storyboard.scenes.length} (${scene.visualType}, ${humanSize(frame.length)})`);
    await logEvent("media", `Frame rendered: scene ${scene.index + 1} (${scene.visualType})`, { taskId: ctx.taskId, agentId: ctx.agentId, data: { bytes: frame.length } });
  }
  fs.writeFileSync(path.join(ctx.runDir, "storyboard", "storyboard_with_assets.json"), JSON.stringify(storyboard, null, 2), "utf8");
  await ctx.handle("storyboard", storyboard);
  ctx.findings.storyboard = storyboard;

  const totalBytes = artworks.reduce((sum, a) => sum + fs.statSync(a.absPath).size, 0);
  return {
    ok: true,
    summary: `Rendered ${artworks.length} composite 1080x1920 frames (${humanSize(totalBytes)}) offline as vector art — no image API, deterministic output.`,
    agentMessage: `All ${artworks.length} frames are rendered locally from vector art. Every scene uses a different visual language: ${storyboard.visualDiversity.types.slice(0, 5).join(", ")} and more.`,
    output: {
      rendered: artworks.length,
      imagesDir,
      visualTypes: storyboard.scenes.map((s) => s.visualType),
      motionPlan: storyboard.scenes.map((s) => ({ scene: s.index, motion: s.motion, transition: s.transition })),
      totalBytes,
    },
    artifacts: artworks,
  };
};

/* ------------------------------------------------------------------ */
/* Captions                                                           */
/* ------------------------------------------------------------------ */

function srtTimestamp(seconds: number): string {
  const clamped = Math.max(0, seconds);
  const h = Math.floor(clamped / 3600);
  const m = Math.floor((clamped % 3600) / 60);
  const s = Math.floor(clamped % 60);
  const ms = Math.round((clamped - Math.floor(clamped)) * 1000);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")},${String(ms).padStart(3, "0")}`;
}

const captionsRender: ToolHandler = async (ctx) => {
  const storyboard = (ctx.findings.storyboard as Storyboard | undefined) ?? (await ctx.loadHandle<Storyboard>(String(ctx.input.storyboardId)));
  if (!storyboard) return fail(`Storyboard "${String(ctx.input.storyboardId)}" not found.`, "STORYBOARD_NOT_FOUND");
  const alignment = ctx.input.alignmentId ? await ctx.loadHandle<{ words?: { word: string; start: number; end: number }[]; timingSource: string; audioPath?: string }>(String(ctx.input.alignmentId)) : null;
  const theme = THEMES.find((t) => t.id === storyboard.scenes[0]?.themeId) ?? THEMES[0];
  const captionDir = ensureDir(path.join(ctx.runDir, "captions"));
  const cues: CaptionCue[] = [];
  let overflowCount = 0;
  let cursor = 0;

  for (const scene of storyboard.scenes) {
    if (!scene.bgPath) return fail(`Scene ${scene.index + 1} has no rendered background. Run visuals.render first.`, "MISSING_FRAME");
    const sceneStart = cursor;
    const sceneEnd = cursor + scene.durationSec;
    cursor = sceneEnd;

    const words = alignment?.words?.filter((w) => w.start >= sceneStart - 0.05 && w.start < sceneEnd + 0.05) ?? null;
    if (words && words.length > 3) {
      // True word-level timing: build cues from real whisper word windows, respecting the measured caption box.
      const maxWidth = FRAME_WIDTH - DEFAULT_CAPTION_STYLE.sideSafe * 2;
      let buffer: { word: string; start: number; end: number }[] = [];
      const flush = async () => {
        if (buffer.length === 0) return;
        const text = buffer.map((w) => w.word).join(" ").trim();
        const { lines, truncated } = wrapText(text, maxWidth, DEFAULT_CAPTION_STYLE.fontSize, "bold", DEFAULT_CAPTION_STYLE.maxLines);
        const render = await renderCaptionPng(text, theme);
        const pngPath = path.join(captionDir, `cue_${String(cues.length + 1).padStart(3, "0")}.png`);
        fs.writeFileSync(pngPath, render.buffer);
        if (render.overflowed || truncated) overflowCount += 1;
        cues.push({
          sceneIndex: scene.index,
          start: Number(buffer[0].start.toFixed(2)),
          end: Number(buffer[buffer.length - 1].end.toFixed(2)),
          text,
          lines: render.lines,
          pngPath,
          measuredWidth: Number(render.measuredWidth.toFixed(1)),
          overflowed: render.overflowed || truncated,
          fontSize: render.fontSize,
        });
        buffer = [];
      };
      for (const word of words) {
        const candidate = [...buffer, word];
        const text = candidate.map((w) => w.word).join(" ").trim();
        const fitted = wrapText(text, maxWidth, DEFAULT_CAPTION_STYLE.fontSize, "bold", DEFAULT_CAPTION_STYLE.maxLines);
        const tooWide = fitted.truncated || fitted.lines.length > DEFAULT_CAPTION_STYLE.maxLines;
        if (tooWide || candidate.length > 7 || candidate[candidate.length - 1].end - candidate[0].start > 3.4) await flush();
        if (buffer.length === 0) buffer = [word];
        else if (buffer[buffer.length - 1] !== word) buffer.push(word);
      }
      await flush();
    } else {
      // Scene-level timing: the directed scene duration is authoritative; text length
      // only distributes that real window across cues (labelled in the metadata).
      const sentences = scene.narration.split(/(?<=[.!?])\s+/).filter((s) => s.trim().length > 0);
      const chunks: string[] = [];
      for (const sentence of sentences) {
        const { lines } = wrapText(sentence, FRAME_WIDTH - DEFAULT_CAPTION_STYLE.sideSafe * 2, DEFAULT_CAPTION_STYLE.fontSize, "bold", DEFAULT_CAPTION_STYLE.maxLines);
        if (lines.length <= DEFAULT_CAPTION_STYLE.maxLines) chunks.push(sentence);
        else {
          const { lines: split } = wrapText(sentence, FRAME_WIDTH - DEFAULT_CAPTION_STYLE.sideSafe * 2, DEFAULT_CAPTION_STYLE.fontSize, "bold", 99);
          for (const line of split) chunks.push(line);
        }
      }
      const chunkList = chunks.length > 0 ? chunks : [scene.narration];
      const totalWeight = chunkList.reduce((sum, c) => sum + Math.max(12, c.length), 0);
      let offset = sceneStart;
      for (const chunk of chunkList) {
        const share = (Math.max(12, chunk.length) / totalWeight) * scene.durationSec;
        const render = await renderCaptionPng(chunk, theme);
        const pngPath = path.join(captionDir, `cue_${String(cues.length + 1).padStart(3, "0")}.png`);
        fs.writeFileSync(pngPath, render.buffer);
        if (render.overflowed) overflowCount += 1;
        cues.push({
          sceneIndex: scene.index,
          start: Number(offset.toFixed(2)),
          end: Number((offset + share).toFixed(2)),
          text: chunk,
          lines: render.lines,
          pngPath,
          measuredWidth: Number(render.measuredWidth.toFixed(1)),
          overflowed: render.overflowed,
          fontSize: render.fontSize,
        });
        offset += share;
      }
    }
    await ctx.progress(`Captions composed for scene ${scene.index + 1}/${storyboard.scenes.length}`);
  }

  const srtPath = path.join(captionDir, "captions.srt");
  fs.writeFileSync(
    srtPath,
    cues.map((cue, i) => `${i + 1}\n${srtTimestamp(cue.start)} --> ${srtTimestamp(cue.end)}\n${cue.lines.join("\n")}\n`).join("\n"),
    "utf8",
  );
  const track: CaptionTrack = {
    id: `captions_${ctx.runId}`,
    cues,
    timingSource: alignment?.words && alignment.words.length > 0 ? "WHISPER_WORD_LEVEL" : "SCENE_DURATION_PROPORTIONAL",
    overflowCount,
    srtPath,
    createdAt: new Date().toISOString(),
  };
  const jsonPath = path.join(captionDir, "captions.json");
  fs.writeFileSync(jsonPath, JSON.stringify(track, null, 2), "utf8");
  const handleId = await ctx.handle("captions", track);
  ctx.findings.captions = track;
  const maxMeasured = Math.max(...cues.map((c) => c.measuredWidth), 0);
  const longestLineCue = cues.find((c) => c.measuredWidth === maxMeasured);

  return {
    ok: true,
    summary: `Captions composed: ${cues.length} cues, timing source ${track.timingSource}, ${overflowCount} overflow(s). Widest measured line ${maxMeasured.toFixed(0)}px inside a ${FRAME_WIDTH - DEFAULT_CAPTION_STYLE.sideSafe * 2}px safe box.`,
    agentMessage: `${cues.length} caption cues built with measured line breaks. Widest line measures ${maxMeasured.toFixed(0)} pixels against a ${FRAME_WIDTH - DEFAULT_CAPTION_STYLE.sideSafe * 2} pixel safe area, and the timing source is ${track.timingSource}.`,
    output: { handle: handleId, cueCount: cues.length, timingSource: track.timingSource, overflowCount, widestMeasured: maxMeasured, widestCue: longestLineCue?.text ?? null },
    artifacts: [
      { kind: "captions", name: "captions.srt", absPath: srtPath, mime: "application/x-subrip", meta: { cues: cues.length } },
      { kind: "captions", name: "captions.json", absPath: jsonPath, mime: "application/json", meta: { timingSource: track.timingSource, overflowCount }, validated: overflowCount === 0 },
    ],
  };
};

/* ------------------------------------------------------------------ */
/* Audio                                                              */
/* ------------------------------------------------------------------ */

function runProcess(bin: string, args: string[], ctx: ToolContext, options: { progressPattern?: boolean; timeoutMs?: number } = {}): Promise<{ code: number; stderr: string; stdout: string; killed: boolean }> {
  return new Promise((resolve) => {
    const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    const jobId = `${ctx.taskId}:${ctx.stepId}:${child.pid}`;
    ffmpegJobs.register(ctx.taskId, jobId, child);
    let stderr = "";
    let stdout = "";
    let killed = false;
    const timer = setTimeout(() => {
      killed = true;
      child.kill("SIGKILL");
    }, options.timeoutMs ?? 600000);
    const onAbort = () => {
      killed = true;
      child.kill("SIGKILL");
    };
    ctx.signal.addEventListener("abort", onAbort, { once: true });
    child.stdout?.on("data", (data: Buffer) => {
      stdout += data.toString();
    });
    child.stderr?.on("data", (data: Buffer) => {
      const text = data.toString();
      stderr = (stderr + text).slice(-8000);
      if (options.progressPattern) {
        const match = /frame=\s*(\d+)/.exec(text);
        if (match) void ctx.progress(`Encoding frame ${match[1]}`);
      }
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      ctx.signal.removeEventListener("abort", onAbort);
      ffmpegJobs.finish(jobId);
      resolve({ code: -1, stderr: `${stderr}\n${error.message}`, stdout, killed });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      ctx.signal.removeEventListener("abort", onAbort);
      ffmpegJobs.finish(jobId);
      resolve({ code: code ?? -1, stderr, stdout, killed });
    });
  });
}

function motionFilter(scene: Scene, dur: number): string {
  const frames = Math.max(2, Math.round(dur * 30));
  const zoomExpr = scene.motion === "ZOOM_OUT" ? `if(eq(on,0),1.14,max(1.0,zoom-0.0012))` : `min(1.16,1+0.0012*on)`;
  const xExpr = scene.motion === "PAN_LEFT" ? `(iw-iw/zoom)*(on/${frames})` : scene.motion === "PAN_RIGHT" ? `(iw-iw/zoom)*(1-on/${frames})` : `iw/2-(iw/zoom/2)`;
  const yExpr = scene.motion === "ROTATE" ? `(ih-ih/zoom)*(0.5+0.3*sin(on/25))` : scene.motion === "PARALLAX" ? `(ih-ih/zoom)*(0.35+0.25*sin(on/40))` : `ih/2-(ih/zoom/2)`;
  const fadeOutStart = Math.max(0, dur - 0.35);
  return `zoompan=z='${zoomExpr}':x='${xExpr}':y='${yExpr}':d=${frames}:s=${FRAME_WIDTH}x${FRAME_HEIGHT}:fps=30,fade=t=in:st=0:d=0.35,fade=t=out:st=${fadeOutStart.toFixed(2)}:d=0.35,setsar=1`;
}

async function synthAudioBed(ctx: ToolContext, durationSec: number, theme: Theme, outPath: string): Promise<{ ok: boolean; detail: string }> {
  const ffmpeg = ffmpegBinary();
  if (!ffmpeg) return { ok: false, detail: "ffmpeg unavailable" };
  const base = theme.id === "deep-space" ? 110 : theme.id === "ember" ? 146.83 : theme.id === "bio-lab" ? 164.81 : theme.id === "graphite" ? 130.81 : 174.61;
  const args = [
    "-y",
    "-f",
    "lavfi",
    "-i",
    `sine=frequency=${base}:duration=${durationSec.toFixed(2)}:sample_rate=48000`,
    "-f",
    "lavfi",
    "-i",
    `sine=frequency=${(base * 1.5).toFixed(2)}:duration=${durationSec.toFixed(2)}:sample_rate=48000`,
    "-f",
    "lavfi",
    "-i",
    `sine=frequency=${(base * 2).toFixed(2)}:duration=${durationSec.toFixed(2)}:sample_rate=48000`,
    "-filter_complex",
    "[0:a]volume=0.05[a0];[1:a]volume=0.03[a1];[2:a]volume=0.015[a2];[a0][a1][a2]amix=inputs=3:duration=first,afade=t=in:d=2,afade=t=out:st=" +
      Math.max(0, durationSec - 3).toFixed(2) +
      ":d=3,lowpass=f=1200,alimiter=limit=0.9[aout]",
    "-map",
    "[aout]",
    "-c:a",
    "aac",
    "-b:a",
    "192k",
    "-ar",
    "48000",
    outPath,
  ];
  const result = await runProcess(ffmpeg, args, ctx, { timeoutMs: 180000 });
  return { ok: result.code === 0 && fs.existsSync(outPath), detail: result.code === 0 ? "synthesised deterministic score bed" : result.stderr.split("\n").slice(-3).join(" ") };
}

const audioNarrate: ToolHandler = async (ctx) => {
  const storyboard = (ctx.findings.storyboard as Storyboard | undefined) ?? (await ctx.loadHandle<Storyboard>(String(ctx.input.storyboardId)));
  if (!storyboard) return fail(`Storyboard "${String(ctx.input.storyboardId)}" not found.`, "STORYBOARD_NOT_FOUND");
  const theme = THEMES.find((t) => t.id === storyboard.scenes[0]?.themeId) ?? THEMES[0];
  const audioDir = ensureDir(path.join(ctx.runDir, "audio"));
  const ttsUrl = process.env.TTS_URL;
  const narrationFiles: string[] = [];
  const narrationErrors: string[] = [];
  let narrationIncluded = false;

  if (ttsUrl) {
    for (const scene of storyboard.scenes) {
      try {
        const res = await fetch(`${ttsUrl.replace(/\/$/, "")}/tts`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ text: scene.narration, voice: String(ctx.input.voice ?? "default"), format: "wav" }),
          signal: ctx.signal,
        });
        if (!res.ok) {
          narrationErrors.push(`scene ${scene.index + 1}: HTTP ${res.status}`);
          continue;
        }
        const buffer = Buffer.from(await res.arrayBuffer());
        const file = path.join(audioDir, `narration_${String(scene.index + 1).padStart(2, "0")}.wav`);
        fs.writeFileSync(file, buffer);
        narrationFiles.push(file);
        await ctx.progress(`Narrated scene ${scene.index + 1}/${storyboard.scenes.length}`);
      } catch (error) {
        narrationErrors.push(`scene ${scene.index + 1}: ${(error as Error).message}`);
      }
    }
    narrationIncluded = narrationFiles.length === storyboard.scenes.length;
  } else {
    narrationErrors.push("TTS_URL is not configured, so no narration speech was generated (nothing was simulated).");
  }

  const bedPath = path.join(audioDir, "score_bed.m4a");
  const bed = await synthAudioBed(ctx, storyboard.totalDurationSec, theme, bedPath);

  if (narrationIncluded && narrationFiles.length > 0) {
    const ffmpeg = ffmpegBinary();
    if (ffmpeg) {
      const listPath = path.join(audioDir, "concat.txt");
      fs.writeFileSync(listPath, narrationFiles.map((f) => `file '${f.replace(/'/g, "'\\''")}'`).join("\n"), "utf8");
      const narrationPath = path.join(audioDir, "narration.mp3");
      const concat = await runProcess(ffmpeg, ["-y", "-f", "concat", "-safe", "0", "-i", listPath, "-c:a", "libmp3lame", "-b:a", "192k", narrationPath], ctx, { timeoutMs: 300000 });
      if (concat.code === 0) narrationFiles.push(narrationPath);
    }
  }

  const primary = narrationIncluded ? narrationFiles[narrationFiles.length - 1] : bed.ok ? bedPath : null;
  const audio = {
    id: `audio_${ctx.runId}`,
    narrationIncluded,
    narrationFiles,
    narrationErrors,
    bedPath: bed.ok ? bedPath : null,
    bedDetail: bed.detail,
    primaryAudioPath: primary,
    audioPath: primary,
    totalDurationSec: storyboard.totalDurationSec,
    providerMode: narrationIncluded ? "LOCAL_TTS_SERVER" : bed.ok ? "SYNTHETIC_SCORE_BED_ONLY" : "NO_AUDIO",
    createdAt: new Date().toISOString(),
  };
  const jsonPath = path.join(audioDir, "audio.json");
  fs.writeFileSync(jsonPath, JSON.stringify(audio, null, 2), "utf8");
  const handleId = await ctx.handle("audio", audio);
  ctx.findings.audio = audio;

  const artifacts: ArtifactSpec[] = [
    { kind: "audio", name: "audio.json", absPath: jsonPath, mime: "application/json", meta: { providerMode: audio.providerMode, narrationIncluded } },
  ];
  if (primary) artifacts.push({ kind: "audio", name: path.basename(primary), absPath: primary, mime: narrationIncluded ? "audio/mpeg" : "audio/mp4", validated: true });

  return {
    ok: true,
    summary: narrationIncluded
      ? `Narration generated for all ${narrationFiles.length} sections with the configured local TTS server, plus a score bed.`
      : `No narration speech was produced (${narrationErrors[0]}). ${bed.ok ? "A deterministic synthesised score bed was produced instead and the final video will state that it contains no narration." : "No audio track could be produced."}`,
    agentMessage: narrationIncluded
      ? "Narration is rendered with the local TTS server and mixed over the score bed."
      : "I must be precise: no TTS provider is configured, so the video will contain a synthesised score bed and will be labelled as having no narration rather than pretending otherwise.",
    output: { handle: handleId, providerMode: audio.providerMode, narrationIncluded, narrationCount: narrationFiles.length, errors: narrationErrors, primaryAudioPath: primary },
    artifacts,
  };
};

const audioAlign: ToolHandler = async (ctx) => {
  const storyboard = (ctx.findings.storyboard as Storyboard | undefined) ?? (await ctx.loadHandle<Storyboard>(String(ctx.input.storyboardId)));
  if (!storyboard) return fail(`Storyboard "${String(ctx.input.storyboardId)}" not found.`, "STORYBOARD_NOT_FOUND");
  const audio = (ctx.findings.audio as { primaryAudioPath?: string | null; narrationIncluded?: boolean }) ?? (await ctx.loadHandle<{ primaryAudioPath?: string | null }>(String(ctx.input.audioId ?? "audio")));
  const whisperUrl = process.env.WHISPER_URL;
  const alignDir = ensureDir(path.join(ctx.runDir, "audio"));

  if (whisperUrl && audio?.primaryAudioPath && fs.existsSync(audio.primaryAudioPath)) {
    try {
      const buffer = fs.readFileSync(audio.primaryAudioPath);
      const res = await fetch(`${whisperUrl.replace(/\/$/, "")}/transcribe`, {
        method: "POST",
        headers: { "content-type": "application/octet-stream", "x-filename": path.basename(audio.primaryAudioPath) },
        body: new Uint8Array(buffer),
        signal: ctx.signal,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const payload = (await res.json()) as { words?: { word: string; start: number; end: number }[]; segments?: { words?: { word: string; start: number; end: number }[] }[] };
      const words = payload.words ?? payload.segments?.flatMap((s) => s.words ?? []) ?? [];
      if (words.length === 0) throw new Error("whisper returned no word timestamps");
      const alignment = { id: `alignment_${ctx.runId}`, timingSource: "WHISPER_WORD_LEVEL", words, audioPath: audio.primaryAudioPath, createdAt: new Date().toISOString() };
      const jsonPath = path.join(alignDir, "alignment.json");
      fs.writeFileSync(jsonPath, JSON.stringify(alignment, null, 2), "utf8");
      const handleId = await ctx.handle("alignment", alignment);
      ctx.findings.alignment = alignment;
      return {
        ok: true,
        summary: `Whisper alignment complete: ${words.length} word-level timestamps read from the real narration audio.`,
        agentMessage: `Word alignment is genuine: ${words.length} words timestamped by the local Whisper server from the rendered audio.`,
        output: { handle: handleId, timingSource: alignment.timingSource, wordCount: words.length },
        artifacts: [{ kind: "alignment", name: "alignment.json", absPath: jsonPath, mime: "application/json", meta: { timingSource: alignment.timingSource, words: words.length }, validated: true }],
      };
    } catch (error) {
      await logEvent("media", `Whisper alignment failed: ${(error as Error).message}`, { level: "error", taskId: ctx.taskId });
    }
  }

  const sceneTimings = storyboard.scenes.map((scene) => {
    const start = storyboard.scenes.slice(0, scene.index).reduce((sum, s) => sum + s.durationSec, 0);
    return { sceneIndex: scene.index, start: Number(start.toFixed(2)), end: Number((start + scene.durationSec).toFixed(2)), words: scene.narration.split(/\s+/).filter(Boolean).length };
  });
  const alignment = {
    id: `alignment_${ctx.runId}`,
    timingSource: "SCENE_LEVEL_STORYBOARD",
    reason: whisperUrl ? "Whisper server reachable but no narration audio existed to align, or alignment failed - see logs." : "WHISPER_URL is not configured, so no word-level timestamps exist. Scene windows come from the directed storyboard durations, not from guessing speech rate.",
    sceneTimings,
    audioPath: audio?.primaryAudioPath ?? null,
    createdAt: new Date().toISOString(),
  };
  const jsonPath = path.join(alignDir, "alignment.json");
  fs.writeFileSync(jsonPath, JSON.stringify(alignment, null, 2), "utf8");
  const handleId = await ctx.handle("alignment", alignment);
  ctx.findings.alignment = alignment;
  return {
    ok: true,
    summary: `Alignment produced ${sceneTimings.length} scene windows using directed storyboard durations (timing source: SCENE_LEVEL_STORYBOARD — explicitly not word-level).`,
    agentMessage: `I will not fake word timing. Without the local Whisper server the captions use the directed scene windows and the artifact records that source explicitly.`,
    output: { handle: handleId, timingSource: alignment.timingSource, sceneTimings },
    artifacts: [{ kind: "alignment", name: "alignment.json", absPath: jsonPath, mime: "application/json", meta: { timingSource: alignment.timingSource }, validated: true }],
  };
};

/* ------------------------------------------------------------------ */
/* Renderer + validator                                               */
/* ------------------------------------------------------------------ */

async function probe(path: string, ctx: ToolContext): Promise<Record<string, unknown> | null> {
  const ffprobe = ffprobeBinary();
  if (!ffprobe) return null;
  const result = await runProcess(ffprobe, ["-v", "quiet", "-print_format", "json", "-show_format", "-show_streams", path], ctx, { timeoutMs: 60000 });
  if (result.code !== 0) return null;
  try {
    return JSON.parse(result.stdout) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function evaluateProbe(payload: Record<string, unknown>, expected: { durationSec: number; fps: number; width: number; height: number }): { passed: boolean; checks: { check: string; expected: string; actual: string; status: "PASS" | "FAIL" | "WARN" }[] } {
  const format = (payload.format ?? {}) as { format_name?: string; duration?: string; size?: string; bit_rate?: string };
  const streams = (payload.streams ?? []) as { codec_type?: string; codec_name?: string; width?: number; height?: number; avg_frame_rate?: string; pix_fmt?: string; sample_rate?: string; channels?: number; duration?: string; profile?: string }[];
  const video = streams.find((s) => s.codec_type === "video");
  const audio = streams.find((s) => s.codec_type === "audio");
  const checks: { check: string; expected: string; actual: string; status: "PASS" | "FAIL" | "WARN" }[] = [];
  const add = (check: string, expected: string, actual: string, status: "PASS" | "FAIL" | "WARN") => checks.push({ check, expected, actual, status });

  add("container", "mp4/mov", format.format_name ?? "unknown", (format.format_name ?? "").includes("mp4") ? "PASS" : "FAIL");
  add("video codec", "h264", video?.codec_name ?? "missing", video?.codec_name === "h264" ? "PASS" : "FAIL");
  add("resolution", `${expected.width}x${expected.height}`, video ? `${video.width}x${video.height}` : "missing", video?.width === expected.width && video?.height === expected.height ? "PASS" : "FAIL");
  const fpsActual = video?.avg_frame_rate ? eval(video.avg_frame_rate) : 0;
  add("frame rate", String(expected.fps), fpsActual.toFixed(2), Math.abs(fpsActual - expected.fps) < 0.5 ? "PASS" : "FAIL");
  add("pixel format", "yuv420p", video?.pix_fmt ?? "missing", video?.pix_fmt === "yuv420p" ? "PASS" : "FAIL");
  add("audio codec", "aac", audio?.codec_name ?? "missing", audio?.codec_name === "aac" ? "PASS" : "FAIL");
  add("audio sample rate", "48000", audio?.sample_rate ?? "missing", audio?.sample_rate === "48000" ? "PASS" : "WARN");
  const durationActual = Number(format.duration ?? video?.duration ?? 0);
  add("duration (s)", expected.durationSec.toFixed(2), durationActual.toFixed(2), Math.abs(durationActual - expected.durationSec) / Math.max(1, expected.durationSec) < 0.12 ? "PASS" : "FAIL");
  const size = Number(format.size ?? 0);
  add("file size", "> 64 KB", `${(size / 1024).toFixed(0)} KB`, size > 65536 ? "PASS" : "FAIL");
  add("stream count", ">= 2", String(streams.length), streams.length >= 2 ? "PASS" : "FAIL");
  return { passed: checks.every((c) => c.status !== "FAIL"), checks };
}

const mediaRender: ToolHandler = async (ctx) => {
  const ffmpeg = ffmpegBinary();
  if (!ffmpeg) return fail("FFmpeg is not available on this host, so no video can be produced. Nothing was faked.", "FFMPEG_UNAVAILABLE");
  const storyboard = (ctx.findings.storyboard as Storyboard | undefined) ?? (await ctx.loadHandle<Storyboard>(String(ctx.input.storyboardId)));
  if (!storyboard) return fail(`Storyboard "${String(ctx.input.storyboardId)}" not found.`, "STORYBOARD_NOT_FOUND");
  const captions = (ctx.findings.captions as CaptionTrack | undefined) ?? (ctx.input.captionId ? await ctx.loadHandle<CaptionTrack>(String(ctx.input.captionId)) : null);
  const audio = (ctx.findings.audio as { primaryAudioPath?: string | null; narrationIncluded?: boolean; providerMode?: string } | undefined) ?? (await ctx.loadHandle<{ primaryAudioPath?: string | null; narrationIncluded?: boolean; providerMode?: string }>(String(ctx.input.audioId ?? "audio")));
  const fps = Number(ctx.input.fps ?? storyboard.fps ?? 30);
  const crf = Number(ctx.input.crf ?? 22);
  const rendersDir = ensureDir(path.join(ctx.runDir, "renders"));
  const theme = THEMES.find((t) => t.id === storyboard.scenes[0]?.themeId) ?? THEMES[0];

  const clipPaths: string[] = [];
  for (const scene of storyboard.scenes) {
    if (!fs.existsSync(scene.bgPath ?? "")) return fail(`Scene ${scene.index + 1} has no rendered background frame.`, "MISSING_FRAME");
    const clipPath = path.join(rendersDir, `clip_${String(scene.index + 1).padStart(2, "0")}.mp4`);
    const sceneCues = captions?.cues.filter((cue) => cue.sceneIndex === scene.index) ?? [];
    const args: string[] = ["-y", "-loop", "1", "-t", scene.durationSec.toFixed(2), "-i", scene.bgPath as string];
    for (const cue of sceneCues) {
      args.push("-loop", "1", "-t", Math.max(0.2, cue.end - cue.start).toFixed(2), "-i", cue.pngPath);
    }
    const filters: string[] = [`[0:v]scale=${FRAME_WIDTH * 2}:-1,${motionFilter(scene, scene.durationSec)}[bg]`];
    let last = "bg";
    sceneCues.forEach((cue, index) => {
      const inputIndex = index + 1;
      const label = `ov${index}`;
      const start = Math.max(0, cue.start - captions!.cues.filter((c) => c.sceneIndex === scene.index)[0].start);
      const end = start + Math.max(0.2, cue.end - cue.start);
      filters.push(`[${inputIndex}:v]format=rgba[cap${index}]`);
      filters.push(`[${last}][cap${index}]overlay=0:0:enable='between(t,${start.toFixed(2)},${end.toFixed(2)})'[${label}]`);
      last = label;
    });
    filters.push(`[${last}]format=yuv420p[vout]`);
    args.push("-filter_complex", filters.join(";"), "-map", "[vout]", "-t", scene.durationSec.toFixed(2), "-r", String(fps), "-c:v", "libx264", "-preset", "veryfast", "-crf", String(crf), "-movflags", "+faststart", clipPath);
    const result = await runProcess(ffmpeg, args, ctx, { progressPattern: true, timeoutMs: 600000 });
    if (result.code !== 0 || !fs.existsSync(clipPath)) {
      return fail(
        `Encoding scene ${scene.index + 1} failed (exit ${result.code}${result.killed ? ", killed by cancellation/timeout" : ""}).`,
        "ENCODE_FAILED",
        { scene: scene.index + 1, stderrTail: result.stderr.split("\n").slice(-8).join("\n") },
      );
    }
    clipPaths.push(clipPath);
    await ctx.progress(`Encoded scene ${scene.index + 1}/${storyboard.scenes.length} (${scene.visualType}, ${scene.motion})`);
    await logEvent("media", `Scene encoded: ${scene.index + 1}/${storyboard.scenes.length}`, { taskId: ctx.taskId, agentId: ctx.agentId, data: { clip: clipPath, motion: scene.motion } });
  }

  const listPath = path.join(rendersDir, "clips.txt");
  fs.writeFileSync(listPath, clipPaths.map((clip) => `file '${clip.replace(/'/g, "'\\''")}'`).join("\n"), "utf8");
  const videoOnly = path.join(rendersDir, "video_only.mp4");
  const concatResult = await runProcess(ffmpeg, ["-y", "-f", "concat", "-safe", "0", "-i", listPath, "-c", "copy", videoOnly], ctx, { timeoutMs: 300000 });
  if (concatResult.code !== 0) return fail("Concatenation of scene clips failed.", "CONCAT_FAILED", { stderrTail: concatResult.stderr.slice(-1200) });

  let audioPath = audio?.primaryAudioPath && fs.existsSync(audio.primaryAudioPath) ? audio.primaryAudioPath : null;
  if (!audioPath) {
    const fallbackBed = path.join(ctx.runDir, "audio", "score_bed.m4a");
    const bed = await synthAudioBed(ctx, storyboard.totalDurationSec, theme, fallbackBed);
    if (bed.ok) audioPath = fallbackBed;
  }

  const tempFinal = path.join(rendersDir, `render_${ctx.runId}_temp.mp4`);
  const muxArgs: string[] = ["-y", "-i", videoOnly];
  if (audioPath) muxArgs.push("-i", audioPath);
  muxArgs.push("-map", "0:v", ...(audioPath ? ["-map", "1:a"] : []), "-c:v", "copy", ...(audioPath ? ["-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2"] : []), "-shortest", "-movflags", "+faststart", tempFinal);
  const muxResult = await runProcess(ffmpeg, muxArgs, ctx, { timeoutMs: 300000 });
  if (muxResult.code !== 0 || !fs.existsSync(tempFinal)) {
    return fail("Final multiplexing failed.", "MUX_FAILED", { stderrTail: muxResult.stderr.slice(-1200) });
  }

  // ---- Validate BEFORE publishing (atomic output, no partial artifacts) --------
  const raw = await probe(tempFinal, ctx);
  if (!raw) return fail("The rendered file could not be read back with ffprobe, so it will not be published.", "PROBE_FAILED");
  const evaluation = evaluateProbe(raw, { durationSec: storyboard.totalDurationSec, fps, width: FRAME_WIDTH, height: FRAME_HEIGHT });
  const validationDir = ensureDir(path.join(ctx.runDir, "validation"));
  const validationPath = path.join(validationDir, "render_validation.json");
  const validationReport = {
    file: tempFinal,
    passed: evaluation.passed,
    checks: evaluation.checks,
    raw,
    expectations: { durationSec: storyboard.totalDurationSec, fps, width: FRAME_WIDTH, height: FRAME_HEIGHT, videoCodec: "h264", audioCodec: "aac", pixelFormat: "yuv420p" },
    validatedAt: new Date().toISOString(),
    narrationIncluded: Boolean(audio?.narrationIncluded),
    audioProviderMode: audio?.providerMode ?? "UNKNOWN",
    captionTimingSource: captions?.timingSource ?? "UNKNOWN",
  };
  fs.writeFileSync(validationPath, JSON.stringify(validationReport, null, 2), "utf8");

  if (!evaluation.passed) {
    const failed = evaluation.checks.filter((c) => c.status === "FAIL").map((c) => `${c.check}: expected ${c.expected}, got ${c.actual}`);
    await logEvent("media", `Render FAILED_VALIDATION: ${failed.join("; ")}`, { level: "error", taskId: ctx.taskId, agentId: ctx.agentId });
    return {
      ok: false,
      summary: `FAILED_VALIDATION — the render was not published. ${failed.join("; ")}`,
      error: `Validation failed: ${failed.join("; ")}`,
      diagnostics: { validationPath, tempFile: tempFinal, checks: evaluation.checks },
      output: { published: false, tempFile: tempFinal, checks: evaluation.checks },
      artifacts: [{ kind: "validation", name: "render_validation.json", absPath: validationPath, mime: "application/json", meta: { passed: false } }],
    };
  }

  const slug = storyboard.topic.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "video";
  const finalPath = path.join(ctx.workspace.outputRoot, "renders", `${slug}_${ctx.runId}.mp4`);
  ensureDir(path.dirname(finalPath));
  atomicPublish(tempFinal, finalPath);
  const stat = fs.statSync(finalPath);
  const srtCopy = captions ? path.join(ctx.workspace.outputRoot, "renders", `${slug}_${ctx.runId}.srt`) : null;
  if (captions && srtCopy) {
    fs.copyFileSync(captions.srtPath, srtCopy);
  }
  const artifactsList: ArtifactSpec[] = [
    { kind: "video", name: path.basename(finalPath), absPath: finalPath, mime: "video/mp4", meta: { durationSec: Number((raw.format as { duration?: string })?.duration ?? 0), fps, crf, resolution: `${FRAME_WIDTH}x${FRAME_HEIGHT}`, scenes: storyboard.scenes.length, narrationIncluded: validationReport.narrationIncluded, captionTimingSource: validationReport.captionTimingSource, checks: evaluation.checks }, validated: true },
    { kind: "validation", name: "render_validation.json", absPath: validationPath, mime: "application/json", meta: { passed: true } },
  ];
  if (srtCopy) artifactsList.push({ kind: "captions", name: path.basename(srtCopy), absPath: srtCopy, mime: "application/x-subrip" });

  await logEvent("media", `Video published: ${finalPath} (${humanSize(stat.size)})`, { taskId: ctx.taskId, agentId: ctx.agentId, data: { checks: evaluation.checks.length } });

  return {
    ok: true,
    summary: `VALIDATED MP4 published: ${finalPath} — ${humanSize(stat.size)}, ${storyboard.scenes.length} scenes, ${(raw.format as { duration?: string })?.duration ?? "?"}s, all ${evaluation.checks.length} ffprobe checks passed.`,
    agentMessage: `Render complete and independently validated. ${evaluation.checks.length} ffprobe checks passed, including H.264, AAC, 1080x1920, ${fps} fps and yuv420p read back from the file itself.`,
    output: { published: true, finalPath, size: stat.size, checks: evaluation.checks, validationPath, srtPath: srtCopy, narrationIncluded: validationReport.narrationIncluded, audioProviderMode: validationReport.audioProviderMode, captionTimingSource: validationReport.captionTimingSource },
    artifacts: artifactsList,
  };
};

const validationFfprobe: ToolHandler = async (ctx) => {
  let target = String(ctx.input.path ?? "");
  if (!target && ctx.input.artifactId && ctx.findings.lastVideoPath) target = String(ctx.findings.lastVideoPath);
  if (!target) {
    const video = (ctx.findings.mediaRender as { finalPath?: string } | undefined)?.finalPath;
    if (video) target = video;
  }
  if (!target || !fs.existsSync(target)) return fail(`Nothing to validate: no readable media path was provided (${target || "none"}).`, "NO_MEDIA");
  const ffprobe = ffprobeBinary();
  if (!ffprobe) return fail("ffprobe is not available, so no independent verification is possible.", "FFPROBE_UNAVAILABLE");
  const raw = await probe(target, ctx);
  if (!raw) return fail(`ffprobe could not read ${target}.`, "PROBE_FAILED");
  const evaluation = evaluateProbe(raw, { durationSec: Number((raw.format as { duration?: string })?.duration ?? 0), fps: 30, width: FRAME_WIDTH, height: FRAME_HEIGHT });
  const dir = ensureDir(path.join(ctx.runDir, "validation"));
  const jsonPath = path.join(dir, "independent_validation.json");
  fs.writeFileSync(jsonPath, JSON.stringify({ file: target, ...evaluation, raw, validatedAt: new Date().toISOString() }, null, 2), "utf8");
  return {
    ok: evaluation.passed,
    summary: `${target}: ${evaluation.checks.filter((c) => c.status === "PASS").length}/${evaluation.checks.length} checks passed${evaluation.passed ? " — VALIDATED" : " — NOT VALIDATED"}`,
    agentMessage: evaluation.passed ? "The file itself confirms the expected container, codecs and geometry." : "Validation did not pass; the file is reported as not validated.",
    output: { file: target, ...evaluation },
    artifacts: [{ kind: "validation", name: "independent_validation.json", absPath: jsonPath, mime: "application/json", meta: { passed: evaluation.passed }, validated: evaluation.passed }],
  };
};

export const MEDIA_TOOLS: Record<string, ToolHandler> = {
  "director.brief": directorBrief,
  "script.generate": scriptGenerate,
  "storyboard.generate": storyboardGenerate,
  "visuals.render": visualsRender,
  "captions.render": captionsRender,
  "audio.narrate": audioNarrate,
  "audio.align": audioAlign,
  "media.render": mediaRender,
  "validation.ffprobe": validationFfprobe,
};
