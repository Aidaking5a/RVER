import type { ChatCompletionTool } from "groq-sdk/resources/chat/completions";
import { calculate } from "./calculator.js";
import { getTime } from "./time.js";
import { getWeather } from "./weather.js";
import { searchWeb } from "./search.js";
import { extractPages } from "./extract.js";
import {
  listProjectFiles,
  readProjectFile,
  proposeProjectEdit,
} from "./code.js";
import { runProjectCheck } from "./exec.js";
import { Fault, type Store } from "../store.js";

type Property = {
  type: string;
  description?: string;
  enum?: string[];
  items?: { type: string };
};
const text = (description: string): Property => ({
  type: "string",
  description,
});
const number = (description: string): Property => ({
  type: "number",
  description,
});
type FunctionTool = ChatCompletionTool & {
  function: NonNullable<ChatCompletionTool["function"]>;
};
function tool(
  name: string,
  description: string,
  properties: Record<string, Property> = {},
  required = Object.keys(properties),
): FunctionTool {
  return {
    type: "function",
    function: {
      name,
      description,
      parameters: {
        type: "object",
        properties,
        required,
        additionalProperties: false,
      },
    },
  };
}
const definitions = [
  tool("calculate", "Calculate two finite numbers.", {
    a: number("First number"),
    b: number("Second number"),
    operation: {
      type: "string",
      enum: ["add", "subtract", "multiply", "divide"],
    },
  }),
  tool("get_time", "Get the current date, time, and timezone."),
  tool("get_weather", "Get current weather for a city.", {
    city: text("City name"),
  }),
  tool(
    "search_web",
    "Search the web for current information and source URLs.",
    { query: text("Search query") },
  ),
  tool("extract_pages", "Read up to two public HTTP(S) source pages.", {
    urls: { type: "array", items: { type: "string" } },
  }),
  tool(
    "list_project_files",
    "List project files without hidden folders or dependencies.",
  ),
  tool(
    "read_project_file",
    "Read a complete source line window and full-file hash. Request more ranges as needed.",
    {
      path: text("Relative file path"),
      start_line: number("First line, default 1"),
      limit: number("Number of lines, default 60, at most 120"),
    },
    ["path"],
  ),
  tool(
    "propose_project_edit",
    "Stage an exact replacement for user review. Does not write the file.",
    {
      path: text("Relative file path"),
      old_text: text("Exact text occurring once"),
      new_text: text("Replacement text"),
      hash: text("Full-file hash from read_project_file"),
    },
  ),
  tool(
    "run_project_check",
    "Run the fixed TypeScript check; report its actual result.",
    { check: { type: "string", enum: ["typescript_build"] } },
  ),
  tool(
    "recall_conversations",
    "Search your operator’s recent stored conversations for relevant context.",
    { query: text("Specific phrase to find") },
  ),
  tool(
    "ask_user",
    "Ask a necessary clarification and pause the current task.",
    { question: text("A concise, complete question") },
  ),
];
export type ToolContext = {
  store: Store;
  root: string;
  ownerId: string;
  sessionId: string;
  mode: "inspect" | "edit";
  signal: AbortSignal;
};
export function availableTools(mode: ToolContext["mode"]) {
  return definitions.filter(
    (t) => mode === "edit" || t.function.name !== "propose_project_edit",
  );
}

export async function executeTool(
  name: string,
  raw: string,
  ctx: ToolContext,
): Promise<unknown> {
  ctx.signal.throwIfAborted();
  const definition = availableTools(ctx.mode).find(
    (t) => t.function.name === name,
  );
  if (!definition)
    throw new Fault("This tool is not permitted in the current mode");
  const args: unknown = JSON.parse(raw);
  if (!args || typeof args !== "object" || Array.isArray(args))
    throw new Fault("Tool arguments must be an object");
  const data = args as Record<string, unknown>;
  const schema = definition.function.parameters as {
    properties: Record<string, Property>;
    required: string[];
  };
  for (const key of schema.required)
    if (!(key in data)) throw new Fault(`Missing tool argument: ${key}`);
  for (const [key, value] of Object.entries(data)) {
    const property = schema.properties[key];
    if (
      !property ||
      (property.type === "array"
        ? !Array.isArray(value) || value.some((v) => typeof v !== "string")
        : typeof value !== property.type)
    )
      throw new Fault(`Invalid tool argument: ${key}`);
    if (
      typeof value === "string" &&
      (value.length > 12000 || (!value.trim() && key !== "new_text"))
    )
      throw new Fault(`Invalid text argument: ${key}`);
    if (typeof value === "number" && !Number.isFinite(value))
      throw new Fault("Numbers must be finite");
    if (property.enum && !property.enum.includes(value as string))
      throw new Fault(`Invalid ${key}`);
  }
  const str = (key: string) => data[key] as string;
  switch (name) {
    case "calculate": {
      if (str("operation") === "divide" && data.b === 0)
        throw new Fault("Cannot divide by zero");
      const result = calculate(
        data.a as number,
        data.b as number,
        str("operation"),
      );
      if (typeof result !== "number" || !Number.isFinite(result))
        throw new Fault("Calculation result is not finite");
      return result;
    }
    case "get_time":
      return getTime();
    case "get_weather":
      return getWeather(str("city"), ctx.signal);
    case "search_web":
      return searchWeb(str("query"), ctx.signal);
    case "extract_pages":
      return extractPages(data.urls as string[], ctx.signal);
    case "list_project_files":
      return listProjectFiles(ctx.root);
    case "read_project_file":
      return readProjectFile(
        ctx.root,
        str("path"),
        data.start_line as number | undefined,
        data.limit as number | undefined,
      );
    case "propose_project_edit":
      return proposeProjectEdit(
        ctx.store,
        ctx.root,
        ctx.ownerId,
        ctx.sessionId,
        {
          path: str("path"),
          old_text: str("old_text"),
          new_text: str("new_text"),
          hash: str("hash"),
        },
      );
    case "run_project_check":
      return runProjectCheck(str("check"), ctx.root, ctx.signal);
    case "recall_conversations":
      return ctx.store.search(ctx.ownerId, str("query"));
    case "ask_user":
      return { question: str("question") };
    default:
      throw new Fault("Unknown tool");
  }
}
