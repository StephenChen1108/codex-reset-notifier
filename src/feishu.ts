import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { setTimeout } from "node:timers/promises";
import { DateTime } from "luxon";
import { formatTime, type ResetEvent } from "./events";
import type { NotificationTarget } from "./notifications";
import type { PendingNotification, XPost } from "./types";

export type FeishuConfig = {
  appId: string;
  appSecret: string;
  receiveId: string;
  receiveIdType: string;
  ledgerPath: string;
};
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const base = "https://open.feishu.cn/open-apis";

/** Explicit local opt-in reads two files only; never imports or runs Soar. */
export function loadFeishuConfig(env: NodeJS.ProcessEnv, statePath: string): FeishuConfig | undefined {
  let values = { ...env };
  if (env.SOAR_FEISHU_READONLY === "true") {
    try {
      const text = readFileSync("D:/Apps/Soar/secrets/feishu.env", "utf8");
      const secrets: Record<string, string> = {};
      for (const line of text.split(/\r?\n/)) {
        if (line.trim().startsWith("#")) continue;
        const match = line.match(/^\s*([^=:]+?)\s*[=:]\s*(.*?)\s*$/);
        if (match) secrets[match[1]] = match[2].replace(/^"|"$/g, "");
      }
      const recipient = JSON.parse(readFileSync("D:/Apps/Soar/config/feishu_recipient.json", "utf8"));
      values = { ...values,
        FEISHU_APP_ID: secrets.SOAR_FEISHU_APP_ID || secrets["App ID"],
        FEISHU_APP_SECRET: secrets.SOAR_FEISHU_APP_SECRET || secrets["App Secret"],
        FEISHU_RECEIVE_ID: recipient.receive_id,
        FEISHU_RECEIVE_ID_TYPE: recipient.receive_id_type,
      };
    } catch { throw new Error("FEISHU_LOCAL_CONFIG_UNAVAILABLE"); }
  }
  const parts = [values.FEISHU_APP_ID, values.FEISHU_APP_SECRET, values.FEISHU_RECEIVE_ID];
  if (!parts.some(Boolean)) {
    if (env.FEISHU_REQUIRED === "true") throw new Error("FEISHU_CONFIG_REQUIRED");
    return undefined;
  }
  const receiveIdType = values.FEISHU_RECEIVE_ID_TYPE || "open_id";
  if (!parts.every((v) => typeof v === "string" && v.trim()) ||
      !values.FEISHU_APP_ID!.startsWith("cli_") ||
      !["open_id", "user_id", "union_id"].includes(receiveIdType))
    throw new Error("FEISHU_CONFIG_INCOMPLETE");
  return { appId: values.FEISHU_APP_ID!, appSecret: values.FEISHU_APP_SECRET!,
    receiveId: values.FEISHU_RECEIVE_ID!, receiveIdType,
    ledgerPath: `${dirname(statePath)}/feishu-deliveries.json` };
}

/** Apply notification policy without changing upstream detection or projections. */
export function officialEvents(post: XPost, events: ResetEvent[]): ResetEvent[] {
  if (!new RegExp(`^https://x\\.com/thsottiaux/status/${post.id}$`, "i").test(post.url) ||
      !/^\d+$/.test(post.id)) return [];
  return events.filter((event) => {
    if (event.type === "mention" || event.status === "uncertain") return false;
    const evidence = event.evidence;
    if (/\b(?:my|mine|personally|automatically|daily|weekly|every\s+\d|password|router|database|factory)\b|\b(?:5|five)[ -]hour\b/i.test(evidence)) return false;
    if (event.type === "reset")
      return /\b(?:global|everyone|everybody|all\s+(?:paid|users|subscriptions|usage|limits|quotas|accounts|reset)|reset\s+all)\b/i.test(evidence);
    if (event.type === "bank_credit")
      return /\b(?:credit(?:ed)?|grant(?:ed)?|add(?:ed|ing)?|giv(?:e|en|ing)|issu(?:e|ed|ing)|roll(?:ing)?\s+out)\b/i.test(evidence);
    return /\b(?:expir\w*|valid|available|usable|for|over)\b/i.test(evidence);
  });
}

export function renderFeishu(post: XPost, event: ResetEvent): string {
  const preview = event.type === "reset" && event.status !== "completed";
  const title = event.type === "reset"
    ? preview ? "🚨 Codex 全局重置预告" : "✅ Codex 全局重置完成公告"
    : event.type === "bank_credit" ? "🎟️ Banked Reset 储备券发放公告" : "⏳ Banked Reset 有效期公告";
  const publication = post.createdAt ? DateTime.fromISO(post.createdAt).setZone("Asia/Shanghai") : null;
  return [title, "", event.type === "reset"
    ? preview ? "Tibo 宣布将进行全局额度重置。" : "Tibo 宣布全局重置已完成；不代表你的个人账号已到账，请以账号页面为准。"
    : "Tibo 发布了 Banked Reset 公告，请核对适用范围与条件。",
    `发布时间：${publication?.isValid ? publication.toFormat("yyyy-MM-dd HH:mm") + "（北京时间）" : "未提供"}`,
    formatTime(event.time, "Asia/Shanghai"),
    ...(preview ? ["", "💡 建议暂缓使用 Banked Reset。"] : []),
    "", `原文依据：${event.evidence.slice(0, 1800)}`,
    "", `🔗 原始公告：${post.url}`].join("\n");
}

type Delivery = { status: "uncertain" | "pending" | "sent"; firstAttemptAt: string; messageId?: string };
type Ledger = Record<string, Delivery>;
class DeliveryError extends Error {
  constructor(message: string, readonly uncertain = false) { super(message); }
}

export class FeishuNotifier implements NotificationTarget {
  readonly channel = "feishu";
  readonly id: string;
  constructor(private readonly config: FeishuConfig,
    private readonly fetcher: typeof fetch = fetch,
    private readonly now: () => Date = () => new Date(),
    private readonly pause: (ms: number) => Promise<unknown> = setTimeout) {
    this.id = `feishu:${hash(`${config.appId}:${config.receiveIdType}:${config.receiveId}`).slice(0, 24)}`;
  }

  private async readLedger(): Promise<Ledger> {
    try {
      const data = JSON.parse(await readFile(this.config.ledgerPath, "utf8"));
      if (!data || Array.isArray(data) || typeof data !== "object" ||
          Object.values(data).some((v: any) => !v || !["sent", "pending", "uncertain"].includes(v.status) || !Number.isFinite(Date.parse(v.firstAttemptAt))))
        throw new Error();
      return data;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw new Error("FEISHU_LEDGER_INVALID_RESTORE_BACKUP");
    }
  }
  private async save(ledger: Ledger): Promise<void> {
    await mkdir(dirname(this.config.ledgerPath), { recursive: true });
    await writeFile(`${this.config.ledgerPath}.tmp`, JSON.stringify(ledger, null, 2) + "\n", { mode: 0o600 });
    await rename(`${this.config.ledgerPath}.tmp`, this.config.ledgerPath);
  }
  private async request(path: string, body: unknown, token?: string): Promise<any> {
    let response: Response;
    try {
      response = await this.fetcher(`${base}/${path}`, { method: "POST",
        headers: { "Content-Type": "application/json; charset=utf-8", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify(body), signal: AbortSignal.timeout(15_000), redirect: "error" });
    } catch { throw new DeliveryError("FEISHU_REQUEST_FAILED", Boolean(token)); }
    if (!response.ok) throw new DeliveryError(`FEISHU_HTTP_${response.status}`, Boolean(token) && response.status >= 500);
    let result;
    try { result = await response.json(); }
    catch { throw new DeliveryError("FEISHU_INVALID_JSON", Boolean(token)); }
    if (!result || typeof result.code !== "number") throw new DeliveryError("FEISHU_INVALID_REPLY", Boolean(token));
    if (result.code !== 0) throw new DeliveryError(`FEISHU_REJECTED_${result.code}`);
    return result;
  }

  async send(item: PendingNotification): Promise<void> {
    const ledger = await this.readLedger();
    const events = officialEvents(item.post, item.events).sort((a, b) => Number(b.type === "reset" && b.status !== "completed") - Number(a.type === "reset" && a.status !== "completed"));
    for (const event of events) {
      // Stable across edits/parser upgrades; allow a later completion of the same post.
      const phase = event.type === "reset" ? event.status === "completed" ? "completed" : "preview"
        : event.type === "bank_expiry" ? JSON.stringify([event.time, event.evidence]) : "grant";
      const key = hash(`${this.id}:${item.post.canonicalId ?? item.post.id}:${event.type}:${phase}`);
      if (ledger[key]?.status === "sent") continue;
      for (let attempt = 0; attempt < 3; attempt++) {
        const previous = ledger[key];
        // Feishu UUID deduplication lasts one hour; use a conservative 55 minutes.
        if (previous?.status === "uncertain" && this.now().getTime() - Date.parse(previous.firstAttemptAt) >= 55 * 60_000) {
          console.error("FEISHU_UNCERTAIN_RECONCILE_BEFORE_RETRY");
          throw new Error("FEISHU_UNCERTAIN_RECONCILE_BEFORE_RETRY");
        }
        try {
          const auth = await this.request("auth/v3/tenant_access_token/internal", { app_id: this.config.appId, app_secret: this.config.appSecret });
          if (typeof auth.tenant_access_token !== "string" || !auth.tenant_access_token) throw new DeliveryError("FEISHU_TOKEN_MISSING");
          ledger[key] = { status: "uncertain", firstAttemptAt: previous?.status === "uncertain" ? previous.firstAttemptAt : this.now().toISOString() };
          await this.save(ledger);
          const reply = await this.request(`im/v1/messages?receive_id_type=${this.config.receiveIdType}`, {
            receive_id: this.config.receiveId, msg_type: "text", uuid: key.slice(0, 32),
            content: JSON.stringify({ text: renderFeishu(item.post, event) }),
          }, auth.tenant_access_token);
          const messageId = reply.data?.message_id;
          if (typeof messageId !== "string" || !messageId) throw new DeliveryError("FEISHU_RECEIPT_MISSING", true);
          ledger[key] = { ...ledger[key], status: "sent", messageId };
          await this.save(ledger);
          console.log("feishu delivered", key.slice(0, 12));
          break;
        } catch (error) {
          // Never erase a prior uncertain attempt following an authentication error.
          if (error instanceof DeliveryError && !error.uncertain && previous?.status !== "uncertain") {
            ledger[key] = { status: "pending", firstAttemptAt: this.now().toISOString() };
            await this.save(ledger);
          }
          if (!(error instanceof DeliveryError)) throw error;
          console.error(error.message);
          if (attempt === 2) throw error;
          await this.pause(1000 * 2 ** attempt);
        }
      }
    }
  }
}
