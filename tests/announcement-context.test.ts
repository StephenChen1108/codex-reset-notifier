import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { posts } from "../fixtures/tibo-october-2026";
import { announcementEvents, collectContext } from "../src/announcement-context";
import { officialEvents, FeishuNotifier, renderFeishu } from "../src/feishu";
import { loadConfig } from "../src/config";
import { runMonitor } from "../src/monitor";
import { emptyState, writeState } from "../src/state";
import { FxEmbedClient } from "../src/fxembed-client";
import { XClient } from "../src/x-client";
import type { XPost } from "../src/types";

const cache = Object.fromEntries(posts.map(p => [p.id, p]));
const byId = (id: string) => cache[id];
const day10 = posts.slice(9, 12);
const events = (post: XPost, context = cache) => officialEvents(post, announcementEvents(post, context, "America/Los_Angeles"));
const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(p => rm(p, { recursive: true, force: true }))); });
async function setup() {
  const dir = await mkdtemp(join(tmpdir(), "announcement-context-")); dirs.push(dir);
  const config = loadConfig({ STATE_PATH: join(dir, "state.json"), INCLUDE_MENTIONS: "false",
    FEISHU_APP_ID: "cli_test", FEISHU_APP_SECRET: "test-secret", FEISHU_RECEIVE_ID: "test-recipient" });
  return { dir, config };
}

describe("verified October announcement replay", () => {
  it.each([
    ["2107676072871600470", "completed", "2107676072871600470"],
    ["2109045220411351517", "scheduled", "2109045220411351517"],
    ["2109045392684032299", "scheduled", "2109045220411351517"],
    ["2109132167112782291", "completed", "2109045220411351517"],
    ["2109812216212099456", "scheduled", "2109812216212099456"],
    ["2109812360596865224", "scheduled", "2109812216212099456"],
    ["2109873287853707513", "completed", "2109812216212099456"],
    ["2110595484180214059", "scheduled", "2110595484180214059"],
    ["2110595554036400151", "scheduled", "2110595484180214059"],
    ["2110618732666257557", "completed", "2110595484180214059"],
  ])("recognizes source %s as %s with stable root", (id, status, rootPostId) => {
    expect(events(byId(id))).toEqual(expect.arrayContaining([expect.objectContaining({ type: "reset", status, rootPostId })]));
  });
  it("recognizes Loading a banked reset as a grant, separately from automatic resets", () => {
    expect(events(posts[2])).toEqual(expect.arrayContaining([expect.objectContaining({ type: "bank_credit" })]));
  });
  it("anchors the two-hour window to the timing reply and preserves source links", () => {
    const e = events(day10[0])[0];
    expect(e.time).toMatchObject({ kind: "window", start: "2026-10-15T04:56:07.000Z", end: "2026-10-15T06:56:07.000Z" });
    const text = renderFeishu(day10[0], e);
    expect(text).toContain(day10[1].url);
    const complete = events(day10[2])[0];
    expect(complete.time).toMatchObject({ kind: "observed", start: day10[2].createdAt });
    expect(complete.sources!.map(p => p.id)).toEqual(day10.map(p => p.id));
  });
  it("does not fabricate a timestamp for EOD PST", () => {
    expect(events(posts[7])[0].time).toMatchObject({ kind: "unknown", start: null });
    expect(events(posts[7])[0].time.note).toContain("PST");
  });
  it.each([posts[0], posts[12], posts[13]])("does not turn campaign/feature/discussion $id into a reset", p => {
    expect(events(p)).toEqual([]);
  });
  it("rejects disconnected completion/timing, foreign roots, hypothetical or negative replies", () => {
    for (const p of day10.slice(1)) expect(events(p, {})).toEqual([]);
    const other = { ...day10[0], url: `https://x.com/other/status/${day10[0].id}`, authorUsername: "other" };
    expect(events(day10[1], { [other.id]: other })).toEqual([]);
    for (const text of ["It's not done.", "Maybe it's done.", "Done?", "Landing in two hours?", "We hope it is done."])
      expect(events({ ...day10[2], text })).toEqual([]);
    expect(events({ ...day10[0], text: "Day 10/ Reset password" })).toEqual([]);
    expect(events({ ...day10[0], createdAt: "2027-01-01T00:00:00Z" })).toEqual([]);
  });
  it("does not let another author's embedded quote or cycles supply context", async () => {
    const foreign = { ...day10[0], url: `https://x.com/other/status/${day10[0].id}` };
    const p = { ...day10[2], quotedPostId: foreign.id, quotedPost: foreign };
    const source = { resolveUserId: async () => "42", getPosts: async () => ({ posts: [], newestId: null }) };
    const c = await collectContext({}, [p], source, "thsottiaux", "42");
    expect(events(p, c)).toEqual([]);
    expect(events({ ...day10[2], quotedPostId: day10[2].id }, { [day10[2].id]: { ...day10[2], quotedPostId: day10[2].id } })).toEqual([]);
  });
});

describe("durable context and notification delivery", () => {
  it("announces, enriches, then completes across three independent monitor runs without duplicate preview", async () => {
    const { config } = await setup();
    await writeState(config.statePath, { ...emptyState("thsottiaux", "reset"), sinceId: "1", contextVersion: 1 });
    const send = vi.fn();
    const source = { resolveUserId: async () => "42", getPosts: vi.fn() };
    const targets = [{ id: "mock", channel: "mock", send }];
    for (const p of day10) {
      source.getPosts.mockResolvedValue({ posts: [p], newestId: p.id });
      await runMonitor(config, { source, targets });
    }
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[0][0].events[0].status).toBe("announced");
    expect(send.mock.calls[1][0].events[0]).toMatchObject({ status: "completed", rootPostId: day10[0].id });
    expect(send.mock.calls[1][0].events[0].sources).toHaveLength(3);
    await runMonitor(config, { source, targets });
    expect(send).toHaveBeenCalledTimes(2);
  });
  it("hydrates a missing ancestor from its ID and does not advance on lookup failure", async () => {
    const { config } = await setup();
    await writeState(config.statePath, { ...emptyState("thsottiaux", "reset"), sinceId: day10[1].id });
    const getPost = vi.fn().mockImplementation(async id => byId(id));
    const source = { resolveUserId: async () => "42", getPost,
      getPosts: async () => ({ posts: [day10[2]], newestId: day10[2].id }) };
    const send = vi.fn();
    await runMonitor(config, { source, targets: [{ id: "mock", channel: "mock", send }] });
    expect(getPost).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[0][0].events[0].status).toBe("completed");
    await writeState(config.statePath, { ...emptyState("thsottiaux", "reset"), sinceId: day10[1].id });
    getPost.mockRejectedValue(new Error("source offline"));
    await expect(runMonitor(config, { source, targets: [{ id: "mock", channel: "mock", send }] })).rejects.toThrow("cursor not advanced");
    expect(JSON.parse(await readFile(config.statePath, "utf8")).sinceId).toBe(day10[1].id);
  });
  it("migrates existing cursor silently, then recognizes a genuinely new completion", async () => {
    const { config } = await setup();
    await writeState(config.statePath, { ...emptyState("thsottiaux", "reset"), sinceId: day10[1].id, eventParserVersion: 5 });
    const source = { resolveUserId: async () => "42", getPosts: vi.fn().mockResolvedValue({ posts: [], newestId: null, contextPosts: day10.slice(0, 2) }) };
    const send = vi.fn(); const targets = [{ id: "mock", channel: "mock", send }];
    const state = await runMonitor(config, { source, targets });
    expect(state.sinceId).toBe(day10[1].id); expect(send).not.toHaveBeenCalled();
    source.getPosts.mockResolvedValue({ posts: [day10[2]], newestId: day10[2].id });
    await runMonitor(config, { source, targets }); expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0].events[0].status).toBe("completed");
  });
  it("bootstraps historical thread silently and keeps pending deliveries through parser migration", async () => {
    const { config } = await setup(); const send = vi.fn();
    const source = { resolveUserId: async () => "42", getPosts: async () => ({ posts: day10, newestId: day10[2].id }) };
    const targets = [{ id: "mock", channel: "mock", send }];
    const state = await runMonitor(config, { source, targets }); expect(send).not.toHaveBeenCalled();
    state.eventParserVersion = 5;
    state.outbox = [{ key: "already-pending", post: day10[2], events: events(day10[2]), targets: ["mock"], delivered: [] }];
    await writeState(config.statePath, state);
    const migrated = await runMonitor(config, { source, targets }); expect(send).toHaveBeenCalledTimes(1);
    expect(migrated.matches.find(m => m.id === day10[2].id)?.events[0].status).toBe("completed");
  });
  it("does not regress a completed thread to another preview after a completion-only bootstrap", async () => {
    const { config } = await setup(); const send = vi.fn();
    const source = { resolveUserId: async () => "42", getPosts: vi.fn().mockResolvedValue({
      posts: [day10[2]], contextPosts: day10, newestId: day10[2].id }) };
    const targets = [{ id: "mock", channel: "mock", send }];
    await runMonitor(config, { source, targets });
    const delayed = { ...day10[1], id: "2110618732666257560", createdAt: "2026-10-15T06:30:00Z",
      url: "https://x.com/thsottiaux/status/2110618732666257560" };
    source.getPosts.mockResolvedValue({ posts: [delayed], newestId: delayed.id });
    await runMonitor(config, { source, targets }); expect(send).not.toHaveBeenCalled();
  });
  it("replays all five real rounds end-to-end into mock Feishu; same roots do not resend across adapter restarts", async () => {
    const { config } = await setup();
    await writeState(config.statePath, { ...emptyState("thsottiaux", "reset"), sinceId: "1", contextVersion: 1 });
    const bodies: any[] = [];
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (url, init) => {
      if (String(url).includes("auth/")) return Response.json({ code: 0, tenant_access_token: "mock-token" });
      bodies.push(JSON.parse(init!.body as string));
      return Response.json({ code: 0, data: { message_id: `om_${bodies.length}` } });
    });
    const source = { resolveUserId: async () => "42", getPosts: async () => ({ posts, newestId: day10[2].id }) };
    const run = () => runMonitor(config, { source, targets: [new FeishuNotifier(config.feishu!, fetcher)] });
    await run(); await run();
    // Day 2 completed + Day 3 banked + three (preview, completed) threads.
    expect(bodies).toHaveLength(8);
    expect(new Set(bodies.map(b => b.uuid)).size).toBe(8);
    const texts = bodies.map(b => JSON.parse(b.content).text);
    expect(texts.filter(t => t.includes("全局重置预告"))).toHaveLength(3);
    expect(texts.filter(t => t.includes("全局重置完成公告"))).toHaveLength(4);
    expect(texts.filter(t => t.includes("储备券发放公告"))).toHaveLength(1);
    const root = events(day10[0])[0];
    await new FeishuNotifier(config.feishu!, fetcher).send({ key: "different-post-version", post: day10[1], events: [root], targets: [], delivered: [] });
    expect(bodies).toHaveLength(8);
    expect(JSON.parse(await readFile(config.statePath, "utf8")).outbox).toEqual([]);
  });
});

describe("source metadata normalization", () => {
  it("keeps actual FxEmbed reply/quote relations and safely resolves a single post", async () => {
    const raw = (p: XPost): any => ({ id: p.id, type: "status", text: p.text, created_at: p.createdAt,
      author: { id: "42", screen_name: "thsottiaux" }, media: {},
      replying_to: p.replyToId ? { status: p.replyToId, screen_name: "thsottiaux" } : null,
      ...(p.quotedPostId ? { quote: raw(byId(p.quotedPostId)) } : {}) });
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async url => String(url).includes("/statuses")
      ? Response.json({ code: 200, results: day10.map(raw), cursor: { bottom: null } })
      : Response.json({ code: 200, tweet: { ...raw(day10[1]), replying_to: "thsottiaux", replying_to_status: day10[0].id } }));
    const client = new FxEmbedClient(fetcher);
    const result = await client.getPosts({ userId: "42", username: "thsottiaux", bootstrap: true });
    expect(result.posts[1].replyToId).toBe(day10[0].id);
    expect(result.posts[2].quotedPost?.replyToId).toBe(day10[0].id);
    expect((await client.getPost(day10[1].id, "thsottiaux", "42")).replyToId).toBe(day10[0].id);
    await expect(client.getPost(day10[1].id, "thsottiaux", "99")).rejects.toThrow("author mismatch");
  });
  it("keeps official X API references and rejects a foreign ancestor", async () => {
    const raw = (p: XPost) => ({ id: p.id, text: p.text, created_at: p.createdAt, author_id: "42",
      referenced_tweets: p.replyToId ? [{ type: "replied_to", id: p.replyToId }] : p.quotedPostId ? [{ type: "quoted", id: p.quotedPostId }] : [] });
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async url => String(url).includes("/users/")
      ? Response.json({ data: [raw(day10[2])], includes: { tweets: day10.slice(0, 2).map(raw) } })
      : Response.json({ data: raw(day10[1]), includes: { tweets: [raw(day10[0])] } }));
    const client = new XClient("mock-token", fetcher);
    const result = await client.getPosts({ userId: "42", username: "thsottiaux" });
    expect(result.posts[0].quotedPost?.replyToId).toBe(day10[0].id);
    expect((await client.getPost(day10[1].id, "thsottiaux", "42")).replyToId).toBe(day10[0].id);
    await expect(client.getPost(day10[1].id, "thsottiaux", "99")).rejects.toThrow("author mismatch");
  });
});
