import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ClarificationRequestSchema } from "../core/clarification.js";
import { CLARIFICATION_TOOL_NAME } from "../cli/app-tools.js";

const server = new McpServer({
  name: "agent-os",
  version: "1.0.0",
});

server.registerTool(
  CLARIFICATION_TOOL_NAME,
  {
    title: "向用户提问",
    description: [
      "当产品需求仍有会实质影响方案的歧义时，调用此工具提交结构化问题。",
      "一次最多提交 5 个问题，每题提供 2 到 4 个清晰选项。",
      "提交后不要自行补全用户答案，本轮回复可以简短收束。",
    ].join(""),
    inputSchema: ClarificationRequestSchema,
  },
  async ({ questions }) => ({
    content: [
      {
        type: "text",
        text: `已把 ${questions.length} 个结构化问题交给 Agent OS。`,
      },
    ],
  }),
);

await server.connect(new StdioServerTransport());
