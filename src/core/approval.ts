import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { CollaborationOrigin } from "./collaboration.js";

export const DEFAULT_APPROVAL_TIMEOUT_SECONDS = 300;

export const ApprovalRequestSchema = z.object({
  operation: z.string().trim().min(1).max(120),
  detail: z.string().trim().min(1).max(2_000),
  impact: z.string().trim().min(1).max(500),
  rollback: z.string().trim().min(1).max(500),
  timeoutSeconds: z.number().int().min(60).max(3_600).optional(),
});

export type ApprovalRequest = z.infer<typeof ApprovalRequestSchema>;

export interface ApprovalFlow {
  token: string;
  taskId: string;
  botId: string;
  sessionId: string;
  ownerOpenId: string;
  ownerUnionId?: string;
  collaboration?: CollaborationOrigin;
  originalMessageId: string;
  cardMessageId?: string;
  replyInThread: boolean;
  request: ApprovalRequest;
  status: "pending" | "approved" | "rejected" | "expired";
  expiresAt: string;
  decidedAt?: string;
}

export interface CreateApprovalFlowOptions {
  taskId: string;
  botId: string;
  sessionId: string;
  ownerOpenId: string;
  ownerUnionId?: string;
  collaboration?: CollaborationOrigin;
  originalMessageId: string;
  cardMessageId?: string;
  replyInThread: boolean;
  request: ApprovalRequest;
}

export function findApprovalRequest(
  toolCalls: Array<{ toolName: string; input: unknown }> | undefined,
): ApprovalRequest | undefined {
  for (let index = (toolCalls?.length ?? 0) - 1; index >= 0; index -= 1) {
    const call = toolCalls?.[index];
    if (call?.toolName !== "request_approval") continue;
    const parsed = ApprovalRequestSchema.safeParse(call.input);
    if (parsed.success) return parsed.data;
  }
  return undefined;
}

export function formatApprovalDecision(flow: ApprovalFlow): string {
  const decision =
    flow.status === "approved"
      ? "审批已通过"
      : flow.status === "rejected"
        ? "审批已拒绝"
        : "审批超时未处理，已自动拒绝";
  return [
    `你的高危操作审批有了结果：${decision}。`,
    `操作：${flow.request.operation}`,
    `详情：${flow.request.detail}`,
    flow.status === "approved"
      ? "请继续执行已批准的操作并完成修复；完成后给出最终结论。"
      : "不要执行该操作。停止相关动作，把当前进展和阻塞原因汇报给用户。",
  ].join("\n\n");
}

export class ApprovalFlowStore {
  private readonly flows = new Map<string, ApprovalFlow>();

  constructor(initialFlows: ApprovalFlow[] = []) {
    for (const flow of initialFlows) {
      this.flows.set(flow.token, flow);
    }
  }

  create(options: CreateApprovalFlowOptions): ApprovalFlow {
    for (const flow of this.flows.values()) {
      if (flow.taskId === options.taskId && flow.botId === options.botId && flow.status === "pending") {
        flow.status = "expired";
        flow.decidedAt = new Date().toISOString();
      }
    }
    const timeoutSeconds = options.request.timeoutSeconds ?? DEFAULT_APPROVAL_TIMEOUT_SECONDS;
    const flow: ApprovalFlow = {
      token: randomUUID().replaceAll("-", ""),
      ...options,
      status: "pending",
      expiresAt: new Date(Date.now() + timeoutSeconds * 1_000).toISOString(),
    };
    this.flows.set(flow.token, flow);
    return flow;
  }

  get(token: string): ApprovalFlow | undefined {
    return this.flows.get(token);
  }

  resolve(token: string, decision: "approved" | "rejected"): ApprovalFlow | undefined {
    const flow = this.flows.get(token);
    if (!flow || flow.status !== "pending") return undefined;
    flow.status = decision;
    flow.decidedAt = new Date().toISOString();
    return flow;
  }

  expire(token: string): ApprovalFlow | undefined {
    const flow = this.flows.get(token);
    if (!flow || flow.status !== "pending") return undefined;
    flow.status = "expired";
    flow.decidedAt = new Date().toISOString();
    return flow;
  }

  protected snapshot(): ApprovalFlow[] {
    return structuredClone([...this.flows.values()]);
  }

  protected restore(flows: ApprovalFlow[]): void {
    this.flows.clear();
    for (const flow of flows) {
      this.flows.set(flow.token, flow);
    }
  }
}
