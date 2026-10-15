// A clearly labelled synthetic event exercises the real adapter, then API readback.
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { FeishuNotifier, loadFeishuConfig } from "../src/feishu";
import { extractEvents } from "../src/events";
import type { XPost } from "../src/types";

if (!process.argv.includes("--live")) throw new Error("Use --live to send one labelled simulation");
const config = loadFeishuConfig(process.env, "outputs/live-smoke/state.json");
if (!config) throw new Error("FEISHU_CONFIG_REQUIRED");
if (process.env.FEISHU_SMOKE_LEDGER_PATH) config.ledgerPath = process.env.FEISHU_SMOKE_LEDGER_PATH;
const post: XPost = { id: "0", text: "We will do a global reset of Codex usage within two hours.",
  createdAt: new Date().toISOString(), url: "https://x.com/thsottiaux/status/0", media: [] };
let sends = 0;
const fetcher: typeof fetch = async (url, init) => {
  if (String(url).includes("im/v1/messages?")) {
    sends++;
    const body = JSON.parse(init!.body as string);
    const content = JSON.parse(body.content);
    content.text = "🧪 通知器模拟测试：以下内容与链接均为测试样例，不是实际重置公告。\n\n" + content.text;
    body.content = JSON.stringify(content);
    return fetch(url, { ...init, body: JSON.stringify(body) });
  }
  return fetch(url, init);
};
try {
  const item = { key: "smoke-v1", post, events: extractEvents(post), targets: [], delivered: [] };
  await new FeishuNotifier(config, fetcher).send(item);
  await new FeishuNotifier(config, fetcher).send(item);
  const ledger = JSON.parse(await readFile(config.ledgerPath, "utf8"));
  const receipt = (Object.values(ledger) as { messageId: string }[])[0]?.messageId;
  const auth = await fetch("https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ app_id: config.appId, app_secret: config.appSecret }), signal: AbortSignal.timeout(15000) });
  const token = await auth.json();
  if (!auth.ok || token.code !== 0 || !token.tenant_access_token || !receipt) throw new Error();
  const response = await fetch(`https://open.feishu.cn/open-apis/im/v1/messages/${encodeURIComponent(receipt)}`, {
    headers: { Authorization: `Bearer ${token.tenant_access_token}` }, signal: AbortSignal.timeout(15000) });
  const result = await response.json();
  const contents = JSON.stringify(result.data?.items?.map((entry: any) => entry.body?.content));
  if (!response.ok || result.code !== 0 || !contents?.includes("通知器模拟测试")) throw new Error();
  const evidence = { testedAt: new Date().toISOString(), apiReadback: true, messagePostRequests: sends, repeatSuppressed: sends <= 1, receipt };
  await mkdir("outputs", { recursive: true });
  await writeFile("outputs/live-smoke-result.json", JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify({ apiReadback: true, messagePostRequests: sends, repeatSuppressed: sends <= 1 }));
} catch { console.error("FEISHU_LIVE_SMOKE_FAILED_SEE_SANITIZED_ADAPTER_LOG"); process.exitCode = 1; }
