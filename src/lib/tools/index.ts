/**
 * Tool bootstrap. Importing this module registers the complete tool surface
 * exactly once (duplicate ids throw in the registry).
 */
import "@/lib/tools/system";
import "@/lib/tools/fs";
import "@/lib/tools/docs";
import "@/lib/tools/web";
import "@/lib/tools/computer";
import "@/lib/tools/media";
import "@/lib/tools/voice";
import "@/lib/tools/email";
import "@/lib/tools/qa";

export { listTools, getTool, runTool, toolsForAgent, requiresApproval } from "@/lib/tools/registry";
export type { ToolDefinition, ToolResult, ToolContext } from "@/lib/tools/types";
