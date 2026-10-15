// Isolated rehearsal against public production state; never loads delivery secrets.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { loadConfig } from "../src/config";
import { runMonitor } from "../src/monitor";
import { posts } from "../fixtures/tibo-october-2026";
import { announcementEvents, announcementKey } from "../src/announcement-context";
import { officialEvents, renderFeishu } from "../src/feishu";

const root = "outputs/context-release";
await mkdir(root, { recursive: true });
const originalText = execFileSync("git", ["show", "origin/monitor-state:state.json"], { encoding: "utf8" });
const original = JSON.parse(originalText);
const receipts = execFileSync("git", ["show", "origin/monitor-state:feishu-deliveries.json"], { encoding: "utf8" });
await writeFile(`${root}/state-before.json`, originalText);
await writeFile(`${root}/state.json`, originalText);
await writeFile(`${root}/receipts-before.json`, receipts);
const config = loadConfig({ STATE_PATH: `${root}/state.json`, INCLUDE_MENTIONS: "false" });
let oldPostsEnqueued = 0;
const deliveries: string[] = [];
const target = { id: "migration-mock", channel: "mock", send: async (item: any) => {
  if (original.sinceId && BigInt(item.post.id) <= BigInt(original.sinceId)) oldPostsEnqueued++;
  deliveries.push(item.post.id);
} };
if (original.outbox?.length) throw new Error("Production has pending deliveries; inspect before migration rehearsal");
const migrated = await runMonitor(config, { targets: [target] });
if (oldPostsEnqueued || (original.sinceId && BigInt(migrated.sinceId!) < BigInt(original.sinceId)))
  throw new Error("Migration replayed historical data or rewound the cursor");
const context = Object.fromEntries(posts.map(p => [p.id, p]));
const seen = new Set<string>();
const replay = posts.flatMap(post => officialEvents(post, announcementEvents(post, context, "America/Los_Angeles"))
  .filter(event => {
    const key = announcementKey(event) ?? `${post.id}:${event.type}`;
    if (seen.has(key)) return false;
    seen.add(key); return true;
  }).map(event => ({ id: post.id, rootPostId: event.rootPostId ?? post.id, type: event.type,
    status: event.status, text: renderFeishu(post, event) })));
if (replay.length !== 8) throw new Error("Real fixture replay did not produce the expected eight stage notifications");
await writeFile(`${root}/real-replay.json`, JSON.stringify(replay, null, 2));
const result = { verifiedAt: new Date().toISOString(), originalSinceId: original.sinceId,
  migratedSinceId: migrated.sinceId, contextPosts: Object.keys(migrated.contextPosts ?? {}).length,
  contextVersion: migrated.contextVersion, oldPostsEnqueued, newEventsMocked: deliveries,
  receiptsArchiveSha256: createHash("sha256").update(receipts).digest("hex"),
  replay: { rounds: 5, previews: replay.filter(r => r.type === "reset" && r.status !== "completed").length,
    completions: replay.filter(r => r.type === "reset" && r.status === "completed").length,
    bankGrants: replay.filter(r => r.type === "bank_credit").length },
  productionStateNotWritten: true, realMessagesSent: 0 };
await writeFile(`${root}/result.json`, JSON.stringify(result, null, 2));
console.log(JSON.stringify(result));
