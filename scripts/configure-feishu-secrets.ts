// Pass values through stdin, never command arguments, logs, or a disk export.
import { spawn } from "node:child_process";
import { loadFeishuConfig } from "../src/feishu";
const repo = process.argv[2];
if (!repo || !/^[\w-]+\/[\w.-]+$/.test(repo)) throw new Error("Pass owner/repository");
const config = loadFeishuConfig(process.env, "data/state.json");
if (!config) throw new Error("FEISHU_CONFIG_REQUIRED");
const values = { FEISHU_APP_ID: config.appId, FEISHU_APP_SECRET: config.appSecret,
  FEISHU_RECEIVE_ID: config.receiveId, FEISHU_RECEIVE_ID_TYPE: config.receiveIdType };
for (const [name, value] of Object.entries(values)) {
  const status = await new Promise<number | null>((resolve) => {
    const child = spawn("gh", ["secret", "set", name, "--repo", repo], { stdio: ["pipe", "ignore", "ignore"], windowsHide: true });
    child.on("error", () => resolve(-1)); child.on("close", resolve);
    child.stdin.on("error", () => {}); child.stdin.end(value);
  });
  if (status !== 0) { console.error(`Secret upload failed: ${name}; check gh authentication/permissions`); process.exit(1); }
  console.log(`Configured ${name}`);
}
