// Streamable HTTP MCP server, one instance per request. Stateless: no
// session id, JSON responses rather than SSE. The caller has already
// turned the bearer token into an McpContext.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import type { ZodRawShapeCompat } from '@modelcontextprotocol/sdk/server/zod-compat.js';
import { MCP_TOOLS, runTool, type McpContext } from './tools';

export const MCP_SERVER_INFO = { name: 'compendium', version: '1.0.0' } as const;

export function createMcpServer(ctx: McpContext): McpServer {
  const server = new McpServer(MCP_SERVER_INFO, {
    instructions:
      'Access to one Compendium world (a tabletop RPG campaign vault). Reading never changes anything. ' +
      'Start with list_campaigns or search_notes, then read_note for full text. ' +
      'Notes you cannot see are reported as not found. ' +
      'To wrap up a Session, call wrap_up_context then submit_wrap_up: that stores a proposal for a Player to review and writes no notes.',
  });
  for (const tool of MCP_TOOLS) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        // The SDK ships its own zod 4 and types its shapes against it;
        // the app is on zod 3. At runtime the SDK's zod-compat layer
        // duck-types a v3 schema (`safeParse`, `.shape`), which the
        // route test exercises end to end, so only the types need
        // bridging here.
        inputSchema: tool.input as unknown as ZodRawShapeCompat,
        annotations: { readOnlyHint: tool.readOnly ?? true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      },
      async (args: unknown) => {
        const result = runTool(tool.name, ctx, args);
        return { content: [{ type: 'text' as const, text: result.text }], isError: result.isError };
      },
    );
  }
  return server;
}

export async function handleMcpRequest(req: Request, ctx: McpContext): Promise<Response> {
  const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true });
  const server = createMcpServer(ctx);
  await server.connect(transport);
  try {
    return await transport.handleRequest(req);
  } finally {
    void server.close().catch(() => {});
  }
}
