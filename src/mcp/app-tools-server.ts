import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ClarificationRequestSchema } from "../core/clarification.js";
import { ProductSpecRequestSchema } from "../core/product-spec.js";
import { DispatchTaskRequestSchema } from "../core/collaboration.js";
import { CLARIFICATION_TOOL_NAME, PRODUCT_SPEC_TOOL_NAME, DISPATCH_TASK_TOOL_NAME } from "../cli/app-tools.js";

const server = new McpServer({
  name: "agent-os",
  version: "1.0.0",
});

server.registerTool(
  CLARIFICATION_TOOL_NAME,
  {
    title: "向用户提问",
    description: [
      "当产品需求仍有会实质影响方案的歧义时，调用此工具向用户展示飞书问题卡片。",
      "一次最多提交 5 个问题，每题提供 2 到 4 个清晰选项。",
      "提交后不要自行补全用户答案，本轮回复可以简短收束。",
    ].join(""),
    inputSchema: ClarificationRequestSchema,
  },
  async ({ questions }) => ({
    content: [
      {
        type: "text",
        text: `已把 ${questions.length} 个问题交给 Agent OS，请等待用户回答。`,
      },
    ],
  }),
);

server.registerTool(
  PRODUCT_SPEC_TOOL_NAME,
  {
    title: "提交产品文档",
    description: [
      "产品方案已经生成后，调用此工具提交唯一的待确认产物。",
      "deliveryMode=local 时提交 specPath 与 ticketsPath，并确保文件真实存在。",
      "deliveryMode=lark-doc 时只提交 documentUrl，且必须使用 lark-doc 创建或更新成功结果中的 document.url；该文档必须同时包含产品说明与「实现任务（Tickets）」章节。",
      "同一份方案不要同时维护本地 Markdown 和飞书云文档，避免两个来源互相覆盖。",
      "summary 只写便于快速了解方案的摘要，完整内容保留在所选产物中。",
      "提交前必须完成需求澄清，确保这份方案已经可以确认。",
      "调用后停止工作，不要实现代码或委派团队成员。",
    ].join(""),
    inputSchema: ProductSpecRequestSchema,
  },
  async () => ({
    content: [
      {
        type: "text",
        text: "唯一的产品方案产物已交给 Agent OS，等待用户查看。",
      },
    ],
  }),
);

server.registerTool(
  DISPATCH_TASK_TOOL_NAME,
  {
    title: "把任务交给团队成员",
    description: [
      "把任务确定性地交给一名已注册的长期团队成员。",
      "只有 CEO 助理可以在运行时调用；产品经理和开发者调用会被拒绝。",
      "targetBotId 必须是团队名单中的成员 id，不能填写自己。",
      "objective 写协作目标，instruction 写交给对方的完整要求，expectedOutput 写期望产出。",
      "调用后停止工作，等待对方完成并把结果交回。",
    ].join(""),
    inputSchema: DispatchTaskRequestSchema,
  },
  async () => ({
    content: [
      {
        type: "text",
        text: "派发请求已交给 Agent OS，等待协作任务送达目标成员。",
      },
    ],
  }),
);

await server.connect(new StdioServerTransport());
