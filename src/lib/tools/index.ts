import { COMPUTER_TOOLS } from "@/lib/tools/computerTools";
import { BROWSER_TOOLS } from "@/lib/tools/browserTools";
import { EXTENDED_TOOLS } from "@/lib/tools/extendedTools";
import { FS_TOOLS } from "@/lib/tools/fsTools";
import { KNOWLEDGE_TOOLS } from "@/lib/tools/knowledgeTools";
import { MEDIA_TOOLS } from "@/lib/tools/mediaTools";
import { SYSTEM_TOOLS } from "@/lib/tools/systemTools";
import { TOOLS } from "@/lib/tools/registry";
import type { ToolHandler } from "@/lib/tools/types";

const handlers: Record<string, ToolHandler> = {
  ...FS_TOOLS,
  ...COMPUTER_TOOLS,
  ...BROWSER_TOOLS,
  ...EXTENDED_TOOLS,
  ...KNOWLEDGE_TOOLS,
  ...MEDIA_TOOLS,
  ...SYSTEM_TOOLS,
};

export const ALL_TOOLS = handlers;

export function missingHandlers(): string[] {
  return Object.keys(TOOLS).filter((id) => !handlers[id]);
}

export function getHandler(toolId: string): ToolHandler | undefined {
  return handlers[toolId];
}

export { TOOLS, getTool } from "@/lib/tools/registry";
