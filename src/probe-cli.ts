import { createInterface } from "node:readline";

const t0 = Date.now();
const stamp = () => `[${((Date.now() - t0) / 1000).toFixed(1)}s]`;

const rl = createInterface({ input: process.stdin });

rl.on("line", (line) => {
  let ev: any;
  try {
    ev = JSON.parse(line);
  } catch (e) {
    return;
  }

  switch (ev.type) {
    // claude code event stream
    case "system":
      if (ev.subtype === "init") console.log(`${stamp()} 会话开始 session_id=${ev.session_id} model=${ev.model}`);
      break;
    case "assistant":
      for (const block of ev.message?.content ?? []) {
        if (block.type === "text" && block.text) console.log(`${stamp()} 模型说: ${block.text}`);
        if (block.type === "tool_use") console.log(`${stamp()} 调用工具: ${block.name}`);
      }
      break;
    case "result":
      console.log(`${stamp()} 完成 turns=${ev.num_turns} 耗时=${ev.duration_ms}ms 成本=$${ev.total_cost_usd}`);
      console.log(`${stamp()} 最终回答: ${ev.result}`);
      break;

    // codex event stream
    case "thread.started":
      console.log(`${stamp()} 会话开始 thread_id=${ev.thread_id}`);
      break;
    case "item.completed":
      if (ev.item?.type === "agent_message") console.log(`${stamp()} 模型说: ${ev.item.text}`);
      if (ev.item?.type === "command_execution") console.log(`${stamp()} 执行命令: ${ev.item.command}`);
      break;
    case "turn.completed":
      console.log(`${stamp()} 完成 tokens=${JSON.stringify(ev.usage)}`);
      break;
  }
});
