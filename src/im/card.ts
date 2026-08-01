export type CardJson = Record<string, unknown>;
export type TaskStatus = "running" | "success" | "failed";

export interface TaskCardOptions {
  title: string;
  status: TaskStatus;
  progress: number;
  detail: string;
  activities?: string[];
}

const STATUS_STYLE = {
  running: { template: "blue", label: "运行中" },
  success: { template: "green", label: "已完成" },
  failed: { template: "red", label: "执行失败" },
} as const;

type UpdateCard = (card: CardJson) => Promise<void>;

function clampProgress(progress: number): number {
  return Math.min(100, Math.max(0, Math.round(progress)));
}

function buildProgressBar(progress: number): string {
  const filled = Math.round(progress / 10);
  return `${"█".repeat(filled)}${"░".repeat(10 - filled)}`;
}

export function buildTaskCard(options: TaskCardOptions): CardJson {
  const progress = clampProgress(options.progress);
  const style = STATUS_STYLE[options.status];
  const activities = options.activities ?? [];
  const activityText = activities.length ? `\n\n**最近进展**\n${activities.map((item) => `- ${item}`).join("\n")}` : "";

  return {
    schema: "2.0",
    config: {
      update_multi: true,
      summary: { content: `${options.title}：${style.label}` },
    },
    header: {
      template: style.template,
      title: { tag: "plain_text", content: options.title },
    },
    body: {
      direction: "vertical",
      elements: [
        {
          tag: "markdown",
          content: [
            `**状态：** ${style.label}`,
            `**进度：** ${buildProgressBar(progress)} ${progress}%`,
            `**当前：** ${options.detail}${activityText}`,
          ].join("\n\n"),
        },
        {
          tag: "button",
          text: {
            tag: "plain_text",
            content: options.status === "running" ? "任务执行中" : style.label,
          },
          type: options.status === "success" ? "primary" : "default",
          disabled: true,
        },
      ],
    },
  };
}

export class ThrottledCardUpdater {
  private pendingCard: CardJson | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private updateChain: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(
    private readonly updateCard: UpdateCard,
    private readonly intervalMs = 2_000,
  ) {}

  push(card: CardJson): void {
    if (this.closed) throw new Error("卡片更新器已经结束");
    this.pendingCard = card;
    this.schedule();
  }

  async finish(finalCard: CardJson): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.pendingCard = undefined;
    await this.updateChain;
    await this.updateCard(finalCard);
  }

  async cancel(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.pendingCard = undefined;
    await this.updateChain;
  }

  private schedule(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.flushPending();
    }, this.intervalMs);
  }
  private flushPending(): void {
    const card = this.pendingCard;
    this.pendingCard = undefined;
    if (!card || this.closed) return;

    this.updateChain = this.updateChain
      .then(() => this.updateCard(card))
      .finally(() => {
        if (this.pendingCard && !this.closed) this.schedule();
      });
  }
}
