import * as Lark from "@larksuiteoapi/node-sdk";
import { mkdir } from "node:fs/promises";
import { extname, join } from "node:path";
import { parseMentions, type Mention } from "./message-parser.js";
import type { CardJson } from "./card.js";

export interface IncomingMessage {
  messageId: string;
  chatId: string;
  chatType: string;
  messageType: string;
  text: string;
  rootId: string;
  threadId: string;
  senderType: string;
  senderOpenId: string;
  mentions: Mention[];
  rawContent: string;
}

export interface BotOptions {
  appId: string;
  appSecret: string;
  onMessage: (msg: IncomingMessage, bot: Bot) => Promise<void>;
  onCardAction?: (action: CardAction) => Promise<CardActionResponse | undefined>;
}

export interface BotIdentity {
  openId: string;
  name: string;
}

export interface CardAction {
  operatorOpenId: string;
  messageId: string;
  value: Record<string, unknown>;
}

export interface CardActionResponse {
  toast?: { type: "success" | "info" | "warning" | "error"; content: string };
  card?: { type: "raw"; data: CardJson };
}

export function parseCardAction(data: any): CardAction {
  const value = data?.action?.value;
  return {
    operatorOpenId: data?.operator?.open_id ?? data?.operator_id?.open_id ?? "",
    messageId: data?.context?.open_message_id ?? data?.open_message_id ?? "",
    value: isRecord(value) ? value : {},
  };
}

export interface Bot {
  client: Lark.Client;
  getIdentity: () => Promise<BotIdentity>;
  reply: (messageId: string, text: string, replyInThread?: boolean) => Promise<string | undefined>;
  replyCard: (messageId: string, card: CardJson, replyInThread?: boolean) => Promise<string | undefined>;
  replyMention: (
    messageId: string,
    target: BotIdentity,
    text: string,
    replyInThread?: boolean,
  ) => Promise<string | undefined>;
  updateCard: (messageId: string, card: CardJson) => Promise<void>;
  downloadResource: (
    messageId: string,
    fileKey: string,
    type: "image" | "file",
    saveDir: string,
    fileName?: string,
  ) => Promise<string>;
}

export function buildMentionPostContent(target: BotIdentity, text: string): Record<string, unknown> {
  return {
    zh_cn: {
      title: "",
      content: [
        [
          {
            tag: "at",
            user_id: target.openId,
            ...(target.name ? { user_name: target.name } : {}),
          },
          { tag: "text", text: ` ${text}` },
        ],
      ],
    },
  };
}

async function fetchBotIdentity(client: Lark.Client): Promise<BotIdentity> {
  const response = await client.request({
    url: "/open-apis/bot/v3/info",
    method: "GET",
  });
  const bot = (response as { bot?: { open_id?: string; app_name?: string } }).bot;
  if (!bot?.open_id) throw new Error("飞书没有返回 bot open_id");
  return { openId: bot.open_id, name: bot.app_name?.trim() || "Bot" };
}

const CONTENT_TYPE_EXTENSIONS: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/bmp": "bmp",
  "image/x-icon": "ico",
};

function getHeader(headers: any, name: string): string {
  const value =
    typeof headers?.get === "function" ? headers.get(name) : (headers?.[name] ?? headers?.[name.toLowerCase()]);
  return Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
}

function resourceExtension(type: "image" | "file", fileName: string | undefined, contentType: string): string {
  const original = fileName ? extname(fileName).slice(1).toLowerCase() : "";
  if (/^[a-z0-9]{1,10}$/.test(original)) return original;

  const mime = contentType.split(";", 1)[0].trim().toLowerCase();
  return CONTENT_TYPE_EXTENSIONS[mime] ?? (type === "image" ? "img" : "bin");
}

interface PostElement {
  tag?: string;
  text?: string;
  user_id?: string;
}

function renderPostElement(element: PostElement): string {
  if (element.tag === "at") return element.user_id ?? "";
  if (element.tag === "br") return "\n";
  if (["text", "a", "code", "code_block", "md"].includes(element.tag ?? "")) {
    return element.text ?? "";
  }
  return "";
}

export function extractMessageText(messageType: string, content: string): string {
  const parsed = JSON.parse(content);
  if (messageType === "text") {
    return parsed.text ?? "";
  }
  if (messageType === "post") {
    const paragraphs: PostElement[][] = parsed.content ?? [];
    return paragraphs
      .map((paragraph) => paragraph.map(renderPostElement).join(""))
      .filter(Boolean)
      .join("\n")
      .trim();
  }
  return "";
}

export function startBot(opts: BotOptions): Bot {
  const { appId, appSecret, onMessage, onCardAction } = opts;

  const client = new Lark.Client({ appId, appSecret });

  const bot: Bot = {
    client,
    getIdentity() {
      return fetchBotIdentity(client);
    },

    async reply(messageId, text, replyInThread = false) {
      const res = await client.im.v1.message.reply({
        path: { message_id: messageId },
        data: {
          msg_type: "text",
          content: JSON.stringify({ text }),
          ...(replyInThread ? { reply_in_thread: true } : {}),
        },
      });
      return res.data?.message_id;
    },

    async replyCard(messageId, card, replyInThread = false) {
      const res = await client.im.v1.message.reply({
        path: { message_id: messageId },
        data: {
          msg_type: "interactive",
          content: JSON.stringify(card),
          ...(replyInThread ? { reply_in_thread: true } : {}),
        },
      });
      return res.data?.message_id;
    },

    async replyMention(messageId, target, text, replyInThread = false) {
      const res = await client.im.v1.message.reply({
        path: { message_id: messageId },
        data: {
          msg_type: "post",
          content: JSON.stringify(buildMentionPostContent(target, text)),
          ...(replyInThread ? { reply_in_thread: true } : {}),
        },
      });
      return res.data?.message_id;
    },

    async updateCard(messageId, card) {
      await client.im.v1.message.patch({
        path: { message_id: messageId },
        data: { content: JSON.stringify(card) },
      });
    },

    async downloadResource(messageId, fileKey, type, saveDir, fileName) {
      const res = await client.im.v1.messageResource.get({
        path: { message_id: messageId, file_key: fileKey },
        params: { type },
      });
      const contentType = getHeader(res.headers, "content-type");
      const extension = resourceExtension(type, fileName, contentType);
      const savePath = join(saveDir, `${fileKey}.${extension}`);
      await mkdir(saveDir, { recursive: true });
      await res.writeFile(savePath);
      return savePath;
    },
  };

  const dispatcher = new Lark.EventDispatcher({}).register({
    "card.action.trigger": async (data: any) => {
      if (!onCardAction) return undefined;
      return onCardAction(parseCardAction(data));
    },
    "im.message.receive_v1": async (data) => {
      const m = data.message;
      const msg: IncomingMessage = {
        messageId: m.message_id,
        chatId: m.chat_id,
        chatType: m.chat_type,
        messageType: m.message_type,
        text: extractMessageText(m.message_type, m.content),
        rootId: m.root_id ?? "",
        threadId: m.thread_id ?? "",
        senderType: data.sender.sender_type ?? "",
        senderOpenId: data.sender.sender_id?.open_id ?? "",
        mentions: parseMentions(m.mentions),
        rawContent: m.content,
      };
      await onMessage(msg, bot);
    },
  });

  const wsClient = new Lark.WSClient({ appId, appSecret });
  wsClient.start({ eventDispatcher: dispatcher });

  return bot;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
