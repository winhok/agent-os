export interface Mention {
  key: string; // '@_user_1'
  name: string; // 显示名，如 'MyBot'
  openId: string; // 'ou_xxx'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseMentions(raw: unknown): Mention[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((mention: unknown) => {
    if (!isRecord(mention) || typeof mention.key !== "string" || !mention.key) return [];
    const id = isRecord(mention.id) ? mention.id : undefined;
    return [
      {
        key: mention.key,
        name: typeof mention.name === "string" ? mention.name : "",
        openId: typeof id?.open_id === "string" ? id.open_id : "",
      },
    ];
  });
}

export function resolveMentions(text: string, mentions: Mention[]): string {
  let resolved = text;
  for (const m of mentions) {
    resolved = resolved.replaceAll(m.key, `@${m.name}`);
  }
  return resolved.trim();
}

export function extractResourceKeys(
  messageType: string,
  content: string,
): { type: "image" | "file"; key: string; fileName?: string }[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return [];
  }
  if (!isRecord(parsed)) return [];
  const resources: { type: "image" | "file"; key: string; fileName?: string }[] = [];

  if (messageType === "image" && typeof parsed.image_key === "string" && parsed.image_key) {
    resources.push({ type: "image", key: parsed.image_key });
  }
  if (messageType === "file" && typeof parsed.file_key === "string" && parsed.file_key) {
    resources.push({
      type: "file",
      key: parsed.file_key,
      ...(typeof parsed.file_name === "string" ? { fileName: parsed.file_name } : {}),
    });
  }
  if (messageType === "post") {
    const paragraphs: unknown[] = Array.isArray(parsed.content) ? parsed.content : [];
    const elements: unknown[] = paragraphs.flatMap((paragraph) => (Array.isArray(paragraph) ? paragraph : []));
    for (const el of elements) {
      if (isRecord(el) && el.tag === "img" && typeof el.image_key === "string" && el.image_key) {
        resources.push({ type: "image", key: el.image_key });
      }
    }
  }

  return resources;
}
