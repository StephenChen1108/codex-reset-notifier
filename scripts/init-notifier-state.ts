import { emptyState, writeState } from "../src/state";
import { buildPublicStatus, writePublicFeed, writePublicStatus } from "../src/public-status";
import { mkdir, writeFile } from "node:fs/promises";
const dir = process.argv[2];
if (!dir) throw new Error("Pass a NEW empty state directory");
await mkdir(dir, { recursive: true });
// Exclusive creation prevents accidental reset of existing cursors or receipts.
await writeFile(`${dir}/state.json`, "", { flag: "wx" });
const state = emptyState("thsottiaux", "reset");
await writeState(`${dir}/state.json`, state);
const status = buildPublicStatus(state, "fxembed", new Date().toISOString());
await writePublicStatus(`${dir}/status.json`, status);
await writePublicFeed(`${dir}/feed.xml`, status);
await writeFile(`${dir}/feishu-deliveries.json`, "{}\n", { flag: "wx" });
console.log("Created empty independent runtime state; first run will bootstrap silently.");
