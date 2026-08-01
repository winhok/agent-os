import "dotenv/config";
import { startBot } from "./im/lark.js";
import { join } from "node:path";
import { resolveMentions, extractResourceKeys } from "./im/message-parser.js";

const appId = process.env.BOT_A_APP_ID;
const appSecret = process.env.BOT_A_APP_SECRET;

if (!appId || !appSecret) {
  console.error("缺少 BOT_A_APP_ID / BOT_A_APP_SECRET，请检查 .env");
  process.exit(1);
}

console.log("Agent OS 启动，正在建立飞书长连接…");

startBot({
  appId,
  appSecret,
  onMessage: async (msg, bot) => {
    const resolved = resolveMentions(msg.text, msg.mentions);
    console.log(`[收到] chat=${msg.chatId} threadId=${msg.threadId} rootId=${msg.rootId} sender=${msg.senderOpenId}`);
    console.log(`  原文: ${msg.text}`);
    console.log(`  还原: ${resolved}`);
    console.log(`  mentions: ${msg.mentions.map((m) => `${m.key}=${m.name}(${m.openId})`).join(", ") || "(无)"}`);

    const resources = extractResourceKeys(msg.messageType, msg.rawContent);
    for (const res of resources) {
      try {
        const savePath = await bot.downloadResource(
          msg.messageId,
          res.key,
          res.type,
          join("data", "downloads"),
          res.fileName,
        );
        console.log(`  [下载] ${res.type} → ${savePath}`);
      } catch (e) {
        console.error(`  [下载失败] ${res.key}:`, (e as Error).message);
      }
    }

    const hasThread = !!msg.threadId || !!msg.rootId;

    const replyId = await bot.reply(msg.messageId, `收到：${resolved}`, hasThread);
    console.log(`[已回] message_id=${replyId} inThread=${hasThread}`);
  },
});
