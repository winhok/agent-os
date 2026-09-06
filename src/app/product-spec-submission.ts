import type { ProductDeliveryMode } from "../core/bot-registry.js";
import { findProductSpecRequest, type ProductSpecRequest } from "../core/product-spec.js";
import type { CliRunResult } from "../cli/types.js";

export interface ProductSpecSubmission {
  result: CliRunResult;
  request?: ProductSpecRequest;
}

export async function ensureProductSpecSubmission(options: {
  result: CliRunResult;
  required: boolean;
  defaultDeliveryMode: ProductDeliveryMode;
  retry: (prompt: string, sessionId: string | undefined) => Promise<CliRunResult>;
}): Promise<ProductSpecSubmission> {
  const existing = findProductSpecRequest(options.result.toolCalls);
  if (existing || !options.required) return { result: options.result, request: existing };

  const retried = await options.retry(
    [
      "CEO 本次派发要求交付待审批产品方案，但尚未收到有效的 request_spec_approval 调用。",
      "检查当前产物：已经存在时复用原文件或文档 URL；尚未创建或内容不完整时，完成本次要求的唯一产物，不要重复创建。",
      `沿用当前任务已确定的交付方式；没有明确覆盖时使用 ${options.defaultDeliveryMode}。`,
      "完成后实际调用 request_spec_approval，提交对应产物字段，然后结束本轮。普通回复不能代替提交。",
      "缺少权限、凭证或其他必要条件时，明确报告阻塞和缺失产物，不声称交付完成。",
    ].join("\n\n"),
    options.result.sessionId,
  );
  const recovered = findProductSpecRequest(retried.toolCalls);
  if (!recovered) {
    throw new Error("待审批方案交付未完成：一次补交后仍未收到有效的 request_spec_approval，请检查产物及工具执行条件。");
  }
  return { result: retried, request: recovered };
}
