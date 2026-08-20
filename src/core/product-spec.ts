import { randomUUID } from "node:crypto";
import { z } from "zod";

const WorkspaceDocumentPathSchema = z
  .string()
  .trim()
  .min(1)
  .max(240)
  .refine((value) => !value.startsWith("/") && !value.split(/[\\/]/).includes(".."), "文档路径必须位于当前工作目录内");

export const ProductSpecRequestSchema = z.object({
  title: z.string().trim().min(1).max(80),
  summary: z.string().trim().min(1).max(500),
  specPath: WorkspaceDocumentPathSchema,
  ticketsPath: WorkspaceDocumentPathSchema,
});

export type ProductSpecRequest = z.infer<typeof ProductSpecRequestSchema>;

export interface ProductSpecFlow {
  token: string;
  taskId: string;
  botId: string;
  ownerOpenId: string;
  ownerUnionId?: string;
  request: ProductSpecRequest;
  status: "pending" | "approved" | "expired";
  approvedAt?: string;
}

export interface CreateProductSpecFlowOptions {
  taskId: string;
  botId: string;
  ownerOpenId: string;
  ownerUnionId?: string;
  request: ProductSpecRequest;
}

export function findProductSpecRequest(
  toolCalls: Array<{ toolName: string; input: unknown }> | undefined,
): ProductSpecRequest | undefined {
  for (let index = (toolCalls?.length ?? 0) - 1; index >= 0; index -= 1) {
    const call = toolCalls?.[index];
    if (call?.toolName !== "request_spec_approval") continue;
    const parsed = ProductSpecRequestSchema.safeParse(call.input);
    if (parsed.success) return parsed.data;
  }
  return undefined;
}

export function isProductSpecOwner(
  flow: Pick<ProductSpecFlow, "ownerOpenId" | "ownerUnionId">,
  operator: { operatorOpenId: string; operatorUnionId?: string },
): boolean {
  if (flow.ownerUnionId && operator.operatorUnionId) {
    return flow.ownerUnionId === operator.operatorUnionId;
  }
  return flow.ownerOpenId === operator.operatorOpenId;
}

export class ProductSpecFlowStore {
  private readonly flows = new Map<string, ProductSpecFlow>();

  create(options: CreateProductSpecFlowOptions): ProductSpecFlow {
    for (const flow of this.flows.values()) {
      if (flow.taskId === options.taskId && flow.botId === options.botId && flow.status === "pending") {
        flow.status = "expired";
      }
    }
    const flow: ProductSpecFlow = {
      token: randomUUID().replaceAll("-", ""),
      ...options,
      status: "pending",
    };
    this.flows.set(flow.token, flow);
    return flow;
  }

  get(token: string): ProductSpecFlow | undefined {
    return this.flows.get(token);
  }

  approve(token: string): ProductSpecFlow | undefined {
    const flow = this.flows.get(token);
    if (!flow || flow.status !== "pending") return undefined;
    flow.status = "approved";
    flow.approvedAt = new Date().toISOString();
    return flow;
  }
}
