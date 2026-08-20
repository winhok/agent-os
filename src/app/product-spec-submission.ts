import type { ProductDeliveryMode } from "../core/bot-registry.js";
import { findProductSpecRequest, type ProductSpecRequest } from "../core/product-spec.js";
import type { CliRunResult } from "../cli/types.js";

export interface ProductSpecSubmission {
  result: CliRunResult;
  request: ProductSpecRequest;
}

export async function ensureProductSpecSubmission(options: {
  result: CliRunResult;
  defaultDeliveryMode: ProductDeliveryMode;
  retry: (prompt: string, sessionId: string | undefined) => Promise<CliRunResult>;
}): Promise<ProductSpecSubmission> {
  const existing = findProductSpecRequest(options.result.toolCalls);
  if (existing) return { result: options.result, request: existing };

  const retried = await options.retry(missingSubmissionPrompt(options.defaultDeliveryMode), options.result.sessionId);
  const recovered = findProductSpecRequest(retried.toolCalls);
  if (!recovered) {
    throw new Error("产品方案已经整理完成，但产品经理没有调用 request_spec_approval");
  }
  return { result: retried, request: recovered };
}

function missingSubmissionPrompt(defaultDeliveryMode: ProductDeliveryMode): string {
  return [
    "上一轮已经完成产品方案整理，但没有完成 Agent OS 的结构化提交。",
    "不要重新创建文档，也不要继续解释。请沿用上一轮已经生成的唯一产物，立即调用 request_spec_approval。",
    `没有明确覆盖时，deliveryMode 使用 ${defaultDeliveryMode}。`,
    "必须实际调用工具；不能只在普通回复中写出 deliveryMode、documentUrl、specPath 或 ticketsPath。",
    "工具调用成功后立即结束本轮。",
  ].join("\n\n");
}
