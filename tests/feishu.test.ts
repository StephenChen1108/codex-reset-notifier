import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FeishuNotifier, loadFeishuConfig, officialEvents, renderFeishu } from "../src/feishu";
import { extractEvents } from "../src/events";
import { loadConfig, validateConfig } from "../src/config";
import { createTargets } from "../src/notifications";
import { runMonitor } from "../src/monitor";
import { emptyState, writeState } from "../src/state";
import type { PendingNotification, XPost } from "../src/types";

const dirs: string[] = [];
const post = (text: string, id = "2"): XPost => ({ id, text, createdAt: "2026-10-15T01:00:00Z", url: `https://x.com/thsottiaux/status/${id}`, media: [] });
const item = (text = "We will do a global reset of Codex usage within two hours."): PendingNotification => {
  const p = post(text);
  return { key: "version", post: p, events: extractEvents(p), targets: [], delivered: [] };
};
async function setup() {
  const dir = await mkdtemp(join(tmpdir(), "feishu-")); dirs.push(dir);
  const config = loadConfig({ FEISHU_APP_ID: "cli_test", FEISHU_APP_SECRET: "secret-value", FEISHU_RECEIVE_ID: "recipient-private", STATE_PATH: join(dir, "state.json") });
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async (url) => String(url).includes("auth/")
    ? Response.json({ code: 0, tenant_access_token: "secret-token" })
    : Response.json({ code: 0, data: { message_id: "om_test" } }));
  const now = vi.fn(() => new Date("2026-10-15T01:01:00Z"));
  const notifier = new FeishuNotifier(config.feishu!, fetcher, now, async () => {});
  return { dir, config, fetcher, now, notifier };
}
afterEach(async () => { await Promise.all(dirs.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

describe("Feishu notification policy", () => {
  it.each([
    "Maybe we will reset Codex limits for everyone in two hours.",
    "We will not reset Codex limits for everyone.",
    "Can we get a global reset?", "Reset your password now.",
    "My Codex limits have reset.", "Codex limits reset automatically every five hours.",
    "Your Codex limits will reset in two hours.", "The database will reset for everyone.",
    "You can use your banked reset credit now.",
  ])("does not push ordinary or uncertain text: %s", (text) => {
    const p = post(text); expect(officialEvents(p, extractEvents(p))).toEqual([]);
  });
  it.each([
    ["We will do a global reset of Codex usage within two hours.", "reset", "scheduled"],
    ["We will do a global reset of Codex usage.", "reset", "announced"],
    ["All reset for everyone. Enjoy Codex.", "reset", "completed"],
    ["Reset all propagated.", "reset", "completed"],
    ["We are adding a banked reset credit for everyone now.", "bank_credit", "scheduled"],
    ["Banked reset credits expire tomorrow.", "bank_expiry", "scheduled"],
  ])("accepts explicit announcements: %s", (text, type, status) => {
    const p = post(text); expect(officialEvents(p, extractEvents(p, "America/Los_Angeles"))).toEqual(expect.arrayContaining([expect.objectContaining({ type, status })]));
  });
  it("rejects another author and formats publication separately from completion", () => {
    const i = item("All reset for everyone.");
    expect(officialEvents({ ...i.post, url: "https://x.com/other/status/2" }, i.events)).toEqual([]);
    const rendered = renderFeishu(i.post, i.events[0]);
    expect(rendered).toContain("2026-10-15 09:00");
    expect(rendered).toContain("不代表你的个人账号已到账");
    expect(rendered).toContain("公告发布时刻");
    expect(rendered).toContain(i.post.url);
    const preview = item(); expect(renderFeishu(preview.post, preview.events[0])).toContain("暂缓使用 Banked Reset");
  });
  it("rejects partial secrets and registers a standalone channel", async () => {
    expect(() => loadFeishuConfig({ FEISHU_APP_ID: "cli_test" }, "state.json")).toThrow("INCOMPLETE");
    expect(() => loadFeishuConfig({ FEISHU_REQUIRED: "true" }, "state.json")).toThrow("REQUIRED");
    const { config } = await setup(); expect(validateConfig(config)).toEqual([]);
    expect(createTargets(config)[0].channel).toBe("feishu");
  });
});

describe("Feishu transport and durable delivery", () => {
  it("checks business success and receipt; deduplicates edits across restarts", async () => {
    const { config, notifier, fetcher } = await setup();
    const i = item(); await notifier.send(i);
    await new FeishuNotifier(config.feishu!, fetcher).send({ ...i, key: "edited-version" });
    expect(fetcher).toHaveBeenCalledTimes(2);
    const body = JSON.parse(fetcher.mock.calls[1][1]!.body as string);
    expect(body.uuid).toHaveLength(32); expect(body.msg_type).toBe("text");
    const ledger = await readFile(config.feishu!.ledgerPath, "utf8");
    expect(ledger).toContain("om_test"); expect(ledger).not.toMatch(/secret|recipient-private/);
    expect(notifier.id).not.toContain("recipient");
    await notifier.send(item("All reset for everyone.")); // separate lifecycle phase
    expect(fetcher).toHaveBeenCalledTimes(4);
  });
  it("retries HTTP 200 business rejection and does not mark it delivered", async () => {
    const { notifier, fetcher, config } = await setup();
    fetcher.mockImplementation(async (url) => String(url).includes("auth/")
      ? Response.json({ code: 0, tenant_access_token: "token" })
      : Response.json({ code: 999, msg: "secret-private" }));
    await expect(notifier.send(item())).rejects.toThrow("FEISHU_REJECTED_999");
    expect(fetcher).toHaveBeenCalledTimes(6);
    expect(await readFile(config.feishu!.ledgerPath, "utf8")).not.toContain('"sent"');
  });
  it("reuses UUID on timeout and holds uncertain delivery beyond 55 minutes", async () => {
    const { config, notifier, fetcher, now } = await setup();
    fetcher.mockImplementation(async (url) => {
      if (String(url).includes("auth/")) return Response.json({ code: 0, tenant_access_token: "token" });
      throw new Error("secret in network error");
    });
    await expect(notifier.send(item())).rejects.toThrow("FEISHU_REQUEST_FAILED");
    const ids = fetcher.mock.calls.filter(([url]) => String(url).includes("im/v1")).map(([, init]) => JSON.parse(init!.body as string).uuid);
    expect(new Set(ids).size).toBe(1);
    now.mockReturnValue(new Date("2026-10-15T02:01:00Z"));
    const calls = fetcher.mock.calls.length;
    await expect(notifier.send(item())).rejects.toThrow("RECONCILE");
    expect(fetcher).toHaveBeenCalledTimes(calls);
    expect(await readFile(config.feishu!.ledgerPath, "utf8")).toContain("uncertain");
  });
  it("requires a receipt even with code zero", async () => {
    const { notifier, fetcher } = await setup();
    fetcher.mockImplementation(async (url) => String(url).includes("auth/")
      ? Response.json({ code: 0, tenant_access_token: "token" }) : Response.json({ code: 0, data: {} }));
    await expect(notifier.send(item())).rejects.toThrow("RECEIPT_MISSING");
  });
  it("handles HTTP throttling and malformed/auth failures without secret output", async () => {
    const { notifier, fetcher } = await setup();
    fetcher.mockImplementation(async () => Response.json({ code: 1, msg: "secret" }));
    await expect(notifier.send(item())).rejects.toThrow("REJECTED_1");
    fetcher.mockImplementation(async () => new Response("secret", { status: 429 }));
    await expect(notifier.send(item())).rejects.toThrow("HTTP_429");
    fetcher.mockImplementation(async () => new Response("secret"));
    await expect(notifier.send(item())).rejects.toThrow("INVALID_JSON");
  });
  it("simulated end-to-end monitor checkpoints failure then retries without source or duplicate send", async () => {
    const { config, fetcher } = await setup();
    await writeState(config.statePath, { ...emptyState("thsottiaux", "reset"), sinceId: "1" });
    const source = { resolveUserId: async () => "42", getPosts: vi.fn().mockResolvedValue({ posts: [item().post, post("My limits have reset.", "3")], newestId: "3" }) };
    fetcher.mockImplementation(async () => Response.json({ code: 999 }));
    const targets = createTargets(config, fetcher);
    await expect(runMonitor(config, { source, targets })).rejects.toThrow("delivery failed");
    expect(JSON.parse(await readFile(config.statePath, "utf8")).outbox).toHaveLength(1);
    source.getPosts.mockResolvedValue({ posts: [], newestId: null });
    fetcher.mockImplementation(async (url) => String(url).includes("auth/") ? Response.json({ code: 0, tenant_access_token: "token" }) : Response.json({ code: 0, data: { message_id: "om_e2e" } }));
    await runMonitor(config, { source, targets });
    const calls = fetcher.mock.calls.length;
    await runMonitor(config, { source, targets }); expect(fetcher).toHaveBeenCalledTimes(calls);
    expect(JSON.parse(await readFile(config.statePath, "utf8")).outbox).toEqual([]);
  });
  it("first deployment is silent even with historical global announcements", async () => {
    const { config, fetcher } = await setup();
    const source = { resolveUserId: async () => "42", getPosts: async () => ({ posts: [item().post], newestId: "2" }) };
    await runMonitor(config, { source, targets: createTargets(config, fetcher) });
    expect(fetcher).not.toHaveBeenCalled();
  });
});
