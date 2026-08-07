import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import {
  AnalyzeTaskInputSchema,
  AnalyzeTaskOutputSchema,
  BuildContextPackInputSchema,
  BuildContextPackOutputSchema,
  EstimateTokensInputSchema,
  EstimateTokensOutputSchema,
  ExpandContextInputSchema,
  ExpandContextOutputSchema,
  HealthInputSchema,
  HealthOutputSchema,
  RecordRunInputSchema,
  RecordRunOutputSchema,
  SummarizeTargetsInputSchema,
  SummarizeTargetsOutputSchema,
} from "./schemas";
import { createToolHandlers, type ToolHandlerOptions } from "./tools";

export interface McpServerOptions extends ToolHandlerOptions {
  readonly name?: string;
}

export function createAgentTokenOptimizerMcpServer(
  options: McpServerOptions = {},
): McpServer {
  const server = new McpServer({
    name: options.name ?? "agent-token-optimizer",
    version: options.packageVersion ?? "0.1.0",
  });

  registerAgentTokenOptimizerTools(server, options);

  return server;
}

export function registerAgentTokenOptimizerTools(
  server: McpServer,
  options: ToolHandlerOptions = {},
): void {
  const handlers = createToolHandlers(options);

  server.registerTool(
    "analyze_task",
    {
      title: "Analyze Task",
      description:
        "Classify task complexity and recommend whether to skip optimization, rank lightly, or build a context pack.",
      inputSchema: AnalyzeTaskInputSchema,
      outputSchema: AnalyzeTaskOutputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    handlers.analyzeTask,
  );

  server.registerTool(
    "build_context_pack",
    {
      title: "Build Context Pack",
      description:
        "Discover the workspace, rank relevant files for a task, and return a budgeted context pack with structural summaries, focused snippets, and expansion rules.",
      inputSchema: BuildContextPackInputSchema,
      outputSchema: BuildContextPackOutputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    handlers.buildContextPack,
  );

  server.registerTool(
    "estimate_tokens",
    {
      title: "Estimate Tokens",
      description:
        "Estimate approximate token usage for raw text or an Agent Token Optimizer context pack.",
      inputSchema: EstimateTokensInputSchema,
      outputSchema: EstimateTokensOutputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    handlers.estimateTokens,
  );

  server.registerTool(
    "expand_context",
    {
      title: "Expand Context",
      description:
        "Return the next bounded page of compact fallback candidates from a previously built context pack.",
      inputSchema: ExpandContextInputSchema,
      outputSchema: ExpandContextOutputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    handlers.expandContext,
  );

  server.registerTool(
    "summarize_targets",
    {
      title: "Summarize Targets",
      description:
        "Return compact structural outlines for selected workspace files or directories with secret redaction and workspace-bound path validation.",
      inputSchema: SummarizeTargetsInputSchema,
      outputSchema: SummarizeTargetsOutputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    handlers.summarizeTargets,
  );

  server.registerTool(
    "record_run",
    {
      title: "Record Run",
      description:
        "Validate and optionally persist task outcome, token, latency, validation metadata, content-free workflow signals, and a shared-run token ledger for reports.",
      inputSchema: RecordRunInputSchema,
      outputSchema: RecordRunOutputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    handlers.recordRun,
  );

  server.registerTool(
    "health",
    {
      title: "Health",
      description:
        "Return MCP server diagnostics, optional workspace readability, optional local cache health, and process-local aggregate observability counters.",
      inputSchema: HealthInputSchema,
      outputSchema: HealthOutputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    handlers.health,
  );
}

export async function runStdioServer(options: McpServerOptions = {}): Promise<void> {
  const server = createAgentTokenOptimizerMcpServer(options);
  const transport = new StdioServerTransport();

  await server.connect(transport);
}
