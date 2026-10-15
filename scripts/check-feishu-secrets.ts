import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { loadFeishuConfig } from "../src/feishu";
const config = loadFeishuConfig(process.env, "data/state.json");
if (!config) throw new Error("FEISHU_CONFIG_REQUIRED");
const files = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], { encoding: "utf8" }).split("\0").filter(Boolean);
for (const file of new Set(files)) {
  const body = readFileSync(file, "utf8");
  if ([config.appId, config.appSecret, config.receiveId].some((value) => body.includes(value)))
    throw new Error("FEISHU_CONFIG_VALUE_FOUND_IN_PUBLISHABLE_FILES");
}
console.log(`No live Feishu config values found in ${new Set(files).size} publishable files.`);
