import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import {
  ApprovalRequestSchema,
  ApprovalFlowStore,
  type ApprovalFlow,
  type CreateApprovalFlowOptions,
} from "./approval.js";

const ApprovalFlowSchema = z.object({
  token: z.string().min(1),
  taskId: z.string().min(1),
  botId: z.string().min(1),
  sessionId: z.string().min(1),
  ownerOpenId: z.string().min(1),
  ownerUnionId: z.string().min(1).optional(),
  collaboration: z
    .object({
      taskId: z.string().min(1),
      fromBotId: z.string().min(1),
      reportToBotId: z.string().min(1),
      round: z.number().int().positive(),
      maxRounds: z.number().int().positive(),
    })
    .optional(),
  originalMessageId: z.string().min(1),
  cardMessageId: z.string().min(1).optional(),
  replyInThread: z.boolean(),
  request: ApprovalRequestSchema,
  status: z.enum(["pending", "approved", "rejected", "expired"]),
  expiresAt: z.string().min(1),
  decidedAt: z.string().optional(),
});

export class JsonApprovalFlowStore extends ApprovalFlowStore {
  constructor(private readonly filePath: string) {
    super(loadFlows(filePath));
  }

  override create(options: CreateApprovalFlowOptions): ApprovalFlow {
    return this.mutate(() => super.create(options));
  }

  override resolve(token: string, decision: "approved" | "rejected"): ApprovalFlow | undefined {
    return this.mutate(() => super.resolve(token, decision));
  }

  override expire(token: string): ApprovalFlow | undefined {
    return this.mutate(() => super.expire(token));
  }

  private mutate<T>(operation: () => T): T {
    const previous = this.snapshot();
    try {
      const result = operation();
      this.persist();
      return result;
    } catch (error) {
      this.restore(previous);
      throw error;
    }
  }

  private persist(): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.tmp`;
    writeFileSync(temporaryPath, `${JSON.stringify(this.snapshot(), null, 2)}\n`, "utf8");
    renameSync(temporaryPath, this.filePath);
  }
}

function loadFlows(filePath: string): ApprovalFlow[] {
  let content: string;
  try {
    content = readFileSync(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const rows: unknown = JSON.parse(content);
  if (!Array.isArray(rows)) {
    throw new Error(`审批状态文件格式错误: ${filePath}`);
  }
  return rows.flatMap((row) => {
    const result = ApprovalFlowSchema.safeParse(row);
    return result.success ? [result.data] : [];
  });
}
