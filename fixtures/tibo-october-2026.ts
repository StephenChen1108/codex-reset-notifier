import type { XPost } from "../src/types";

// Public original posts verified through FxEmbed on 2026-10-15.
// Parents and quotes are actual source metadata, never inferred from timestamps.
const rows: [string, string, string, string?, string?][] = [
  ["2106845241357824205", "2026-10-04T20:33:43Z", "Over the next 28 days, each day we’ll either ship one thing that is a clear improvement and relevant for most codex/work users or ship a full reset. Let the improvements begin."],
  ["2107676072871600470", "2026-10-07T03:35:09Z", "We shipped four things that were deemed good to great and some math proofs, but the vote is clear and the community demands a reset. I did calibrate it and it *seems* that the game is rigged in reset's favor, but such are the rules at the moment.\n\nTherefore ... the reset has been processed. Enjoy!"],
  ["2107913674593644711", "2026-10-07T19:19:17Z", "Day 3/\n\nThe big one is GPT-6 in Chat, but today is also a little celebration day with a new high of 40M active users across Codex and ChatGPT Work.\n\nLoading a banked reset in everyone's paid accounts. See you again tomorrow!"],
  ["2109045220411351517", "2026-10-10T22:15:39Z", "Day 6/ Reset"],
  ["2109045392684032299", "2026-10-10T22:16:20Z", "Global reset by EOD. May the tokens do good things for you.", "2109045220411351517"],
  ["2109132167112782291", "2026-10-11T04:01:09Z", "Put the reset in the bag. All propagated.", undefined, "2109045392684032299"],
  ["2109812216212099456", "2026-10-13T01:03:25Z", "Day 8/ Reset"],
  ["2109812360596865224", "2026-10-13T01:03:59Z", "Global reset landing by EOD PST time. Enjoy", "2109812216212099456"],
  ["2109873287853707513", "2026-10-13T05:06:06Z", "What would you like with your side of reset? It's done.", undefined, "2109812360596865224"],
  ["2110595484180214059", "2026-10-15T04:55:51Z", "The reports of my reset button being lost are greatly exaggerated\n\nDay 10/ Reset"],
  ["2110595554036400151", "2026-10-15T04:56:07Z", "Landing within the next 2 hours", "2110595484180214059"],
  ["2110618732666257557", "2026-10-15T06:28:13Z", "Done and dusted", undefined, "2110595554036400151"],
  ["2110151780478927344", "2026-10-13T23:32:43Z", "Day 9/\n\nWe've rolled out optimizations to how we store state on disk for the chatgpt &amp; codex desktop app that should reduce the amount stored on disk by 60%. Small ship but we've heard enough feedback about power users running out of disk space."],
  ["2109090080497508356", "2026-10-11T01:13:54Z", "The day we reach perfection it will be resets from there onwards", undefined, "2109045220411351517"],
];
export const posts: XPost[] = rows.map(([id, createdAt, text, replyToId, quotedPostId]) => ({
  id, createdAt, text, replyToId, quotedPostId, authorUsername: "thsottiaux",
  url: `https://x.com/thsottiaux/status/${id}`, media: [],
}));
