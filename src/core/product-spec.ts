import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { CollaborationOrigin } from "./collaboration.js";

const WorkspaceDocumentPathSchema = z
  .string()
  .trim()
  .min(1)
  .max(240)
  .refine((value) => !value.startsWith("/") && !value.split(/[\\/]/).includes(".."), "文档路径必须位于当前工作目录内");

const ProductSpecBaseSchema = z.object({
  title: z.string().trim().min(1).max(80),
  summary: z.string().trim().min(1).max(500),
});

const LarkDocumentUrlSchema = z
  .url()
  .refine((value) => /\/docx\//.test(new URL(value).pathname), "documentUrl 必须是飞书 Docx 文档链接");

export const LocalProductSpecRequestSchema = ProductSpecBaseSchema.extend({
  deliveryMode: z.literal("local"),
  specPath: WorkspaceDocumentPathSchema,
  ticketsPath: WorkspaceDocumentPathSchema,
}).strict();

export const LarkProductSpecRequestSchema = ProductSpecBaseSchema.extend({
  deliveryMode: z.literal("lark-doc"),
  documentUrl: LarkDocumentUrlSchema,
}).strict();

export const ProductSpecRequestSchema = z.discriminatedUnion("deliveryMode", [
  LocalProductSpecRequestSchema,
  LarkProductSpecRequestSchema,
]);

export type ProductSpecRequest = z.infer<typeof ProductSpecRequestSchema>;
export type LocalProductSpecRequest = z.infer<typeof LocalProductSpecRequestSchema>;

export interface ProductSpecFlow {
  token: string;
  taskId: string;
  botId: string;
  sessionId: string;
  ownerOpenId: string;
  ownerUnionId?: string;
  collaboration?: CollaborationOrigin;
  request: ProductSpecRequest;
  status: "pending" | "approved" | "expired";
  approvedAt?: string;
}

export interface CreateProductSpecFlowOptions {
  taskId: string;
  botId: string;
  sessionId: string;
  ownerOpenId: string;
  ownerUnionId?: string;
  collaboration?: CollaborationOrigin;
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

  constructor(initialFlows: ProductSpecFlow[] = []) {
    for (const flow of initialFlows) {
      this.flows.set(flow.token, flow);
    }
  }

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

  findPendingByDocument(botId: string, fileToken: string): ProductSpecFlow | undefined {
    for (const flow of this.flows.values()) {
      if (
        flow.botId === botId &&
        flow.status === "pending" &&
        flow.request.deliveryMode === "lark-doc" &&
        documentToken(flow.request.documentUrl) === fileToken
      )
        return flow;
    }
    return undefined;
  }

  approve(token: string): ProductSpecFlow | undefined {
    const flow = this.flows.get(token);
    if (!flow || flow.status !== "pending") return undefined;
    flow.status = "approved";
    flow.approvedAt = new Date().toISOString();
    return flow;
  }

  protected snapshot(): ProductSpecFlow[] {
    return structuredClone([...this.flows.values()]);
  }

  protected restore(flows: ProductSpecFlow[]): void {
    this.flows.clear();
    for (const flow of flows) {
      this.flows.set(flow.token, flow);
    }
  }
}

function documentToken(documentUrl: string): string | undefined {
  const match = /^\/docx\/([A-Za-z0-9_-]+)\/?$/.exec(new URL(documentUrl).pathname);
  return match?.[1];
}
