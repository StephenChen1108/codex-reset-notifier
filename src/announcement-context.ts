import { extractEvents, parseEventTime, type ResetEvent } from "./events";
import type { PostSource } from "./post-source";
import type { XPost } from "./types";

export const CONTEXT_VERSION = 1;
export const isTiboPost = (post: XPost) => /^\d+$/.test(post.id) &&
  post.url.toLowerCase() === `https://x.com/thsottiaux/status/${post.id}` &&
  (!post.authorUsername || post.authorUsername.toLowerCase() === "thsottiaux");
// The 28-day campaign is documented by Tibo's Oct 4 announcement, not a prediction.
const inCampaign = (post: XPost) => Boolean(post.createdAt &&
  Date.parse(post.createdAt) >= Date.parse("2026-10-04T20:33:43Z") &&
  Date.parse(post.createdAt) < Date.parse("2026-11-01T20:33:43Z"));
const dayReset = (post: XPost) => inCampaign(post) &&
  /(?:^|\n)\s*Day\s+(?:[1-9]|1\d|2[0-8])\s*\/\s*Reset[.!]?\s*(?:\n|$)/i.test(post.text);
const globalScope = /\b(?:global|everyone|everybody|all\s+(?:codex\s+)?(?:paid|users|subscriptions|usage|limits|quotas|accounts|reset)|reset\s+all)\b/i;
const completion = (text: string) => (text.match(/[^.!?\n]+[.!?\n]?/g) ?? [])
  .map(s => s.trim()).find(s => !s.endsWith("?") &&
    !/\b(?:not|never|isn't|wasn't|won't|maybe|might|could|if|hope|wish|waiting|pending)\b/i.test(s) &&
    /^(?:(?:it['’]s|it is|it has|the reset (?:has been|is)|reset (?:is|has been))\s+)?(?:done(?: and dusted)?|all propagated|processed|completed|finished|propagated)[.!]?$/i.test(s));
const timing = (text: string) => /^(?:global\s+)?(?:reset\s+(?:landing|lands?|by|within|in)|landing\b|lands?\b)/i.test(text.trim()) &&
  !/\?|\b(?:not|never|won't|might|maybe|could|if|hope)\b/i.test(text);

function rootEvents(post: XPost, timezone?: string): ResetEvent[] {
  if (!isTiboPost(post)) return [];
  if (dayReset(post)) return [{ type: "reset", status: "announced",
    evidence: post.text.match(/Day\s+\d+\s*\/\s*Reset/i)![0],
    time: { kind: "unknown", start: null, end: null, evidence: post.text, note: "重置公告尚未说明生效时间" } }];
  return extractEvents(post, timezone).filter(e => e.type === "reset" && e.status !== "uncertain" &&
    (globalScope.test(e.evidence) || (inCampaign(post) && e.status === "completed" && Boolean(completion(e.evidence)))));
}

export async function collectContext(previous: Record<string, XPost>, posts: XPost[],
  source: PostSource, username: string, userId: string): Promise<Record<string, XPost>> {
  const cache = { ...previous };
  const add = (post: XPost, depth = 0) => {
    if (!isTiboPost(post)) return;
    const { quotedPost, ...plain } = post;
    cache[post.id] = plain;
    if (quotedPost && depth < 4) add(quotedPost, depth + 1);
  };
  posts.forEach(p => add(p));
  let requests = 0;
  const visit = async (post: XPost, depth: number, path: Set<string>): Promise<void> => {
    if (depth >= 4 || path.has(post.id)) return;
    const nextPath = new Set([...path, post.id]);
    for (const id of [post.replyToId, post.quotedPostId]) {
      if (!id || !/^\d+$/.test(id) || nextPath.has(id)) continue;
      if (!cache[id] && source.getPost) {
        if (++requests > 20) throw new Error("Announcement context lookup limit reached; cursor not advanced");
        add(await source.getPost(id, username, userId));
      }
      if (cache[id]) await visit(cache[id], depth + 1, nextPath);
    }
  };
  for (const post of posts) {
    if (isTiboPost(post) && (/\breset\b/i.test(post.text) || timing(post.text) || completion(post.text)))
      await visit(post, 0, new Set());
  }
  // Keep enough context for the campaign, independently of the 20-row public list.
  const ordered = Object.values(cache).sort((a, b) => BigInt(a.id) < BigInt(b.id) ? -1 : 1);
  return Object.fromEntries(ordered.slice(-2000).map(post => [post.id, post]));
}

export function announcementEvents(post: XPost, cache: Record<string, XPost>, timezone?: string): ResetEvent[] {
  if (!isTiboPost(post)) return extractEvents(post, timezone);
  const findRoot = (current: XPost, depth: number, visited: Set<string>): XPost[] | null => {
    if (depth > 4 || visited.has(current.id) || !isTiboPost(current)) return null;
    const next = new Set([...visited, current.id]);
    if (dayReset(current)) return [current];
    for (const id of [current.replyToId, current.quotedPostId]) {
      const ancestor = id ? cache[id] : undefined;
      if (!ancestor || !ancestor.createdAt || !current.createdAt || Date.parse(ancestor.createdAt) > Date.parse(current.createdAt)) continue;
      const path = findRoot(ancestor, depth + 1, next);
      if (path) return [...path, current];
    }
    return rootEvents(current, timezone).length ? [current] : null;
  };
  const path = findRoot(post, 0, new Set());
  if (!path) return extractEvents(post, timezone);
  const bankEvents = extractEvents(post, timezone).filter(e => e.type === "bank_credit" || e.type === "bank_expiry");
  // A bank grant quoting a previous reset is a separate benefit, not that reset's lifecycle.
  if (bankEvents.length && !rootEvents(post, timezone).length) return bankEvents;
  const root = path[0];
  const sources = path.map(({ quotedPost, ...plain }) => plain);
  const done = completion(post.text);
  if (done) return [{ type: "reset", status: "completed", rootPostId: root.id, sources,
    evidence: done, time: { kind: "observed", start: post.createdAt, end: null, evidence: done,
      note: "使用完成公告发布时间；不代表账户实际到账时刻" } }];
  if (root.id !== post.id && !timing(post.text))
    return extractEvents(post, timezone).filter(e => e.type === "mention");
  const events = rootEvents(root, timezone);
  const timePost = timing(post.text) ? post : Object.values(cache)
    .filter(p => p.replyToId === root.id && isTiboPost(p) && timing(p.text) && p.createdAt && root.createdAt &&
      Date.parse(p.createdAt) >= Date.parse(root.createdAt))
    .sort((a, b) => Date.parse(a.createdAt!) - Date.parse(b.createdAt!))[0];
  return [...events.map(event => ({ ...event, rootPostId: root.id,
    ...(timePost && event.status !== "completed" ? { status: "scheduled" as const,
      time: parseEventTime(timePost.text, timePost.createdAt, timezone) } : {}),
    sources: timePost && !sources.some(s => s.id === timePost.id) ? [...sources, timePost] : sources })), ...bankEvents];
}

export function announcementKey(event: ResetEvent): string | undefined {
  return event.rootPostId ? `${event.rootPostId}:${event.type}:${event.status === "completed" ? "completed" : "preview"}` : undefined;
}
