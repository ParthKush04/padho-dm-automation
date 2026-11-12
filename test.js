// Padho DM test script
// ---------------------
// This small script checks four things, one at a time:
//   1. node test.js media                  -> shows your recent posts and their IDs
//   2. node test.js comments <MEDIA_ID>    -> shows the comments on one post
//   3. node test.js reply <COMMENT_ID>     -> sends ONE private DM to the person who wrote that comment
//   4. node test.js public <COMMENT_ID>    -> posts a public reply under that comment ("Check your DMs")
//
// Before running, create a file named ".env" in this same folder with these lines:
//   IG_TOKEN=your_access_token_here
//   IG_ID=17841411754236458
//   DM_TEXT=Hi! Thanks for commenting. This is a test message from Padho.
//
// Needs Node.js 18 or newer. No packages to install.

const fs = require("fs");
const path = require("path");

// Read the .env file (simple reader, so no extra package is needed)
function loadEnv() {
  const envPath = path.join(__dirname, ".env");
  if (!fs.existsSync(envPath)) return;
  const lines = fs.readFileSync(envPath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (!(key in process.env)) process.env[key] = value;
  }
}
loadEnv();

const TOKEN = process.env.IG_TOKEN;
const IG_ID = process.env.IG_ID;
const DM_TEXT =
  process.env.DM_TEXT ||
  "Hi! Thanks for commenting. This is a test message from Padho.";
const BASE = "https://graph.facebook.com/v27.0";

if (!TOKEN || !IG_ID) {
  console.log("Missing IG_TOKEN or IG_ID. Please create the .env file first.");
  process.exit(1);
}

// One helper for every API call. The token goes in a header, never in the output.
async function api(method, pathname, query, body) {
  const url = new URL(BASE + pathname);
  for (const [k, v] of Object.entries(query || {})) url.searchParams.set(k, v);

  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) {
    const e = data.error || {};
    console.log("\nThe API returned an error:");
    console.log("  message :", e.message || "(none)");
    console.log("  type    :", e.type || "(none)");
    console.log("  code    :", e.code ?? "(none)");
    console.log("  subcode :", e.error_subcode ?? "(none)");
    console.log("\nCopy the lines above and share them. They do not contain your token.");
    process.exit(1);
  }
  return data;
}

async function showMedia() {
  const data = await api("GET", `/${IG_ID}/media`, {
    fields: "id,media_type,caption,comments_count,permalink",
    limit: "10",
  });
  console.log("\nYour recent posts:\n");
  for (const m of data.data || []) {
    const caption = (m.caption || "").replace(/\s+/g, " ").slice(0, 50);
    console.log(`MEDIA_ID: ${m.id}`);
    console.log(`  type: ${m.media_type} | comments: ${m.comments_count}`);
    console.log(`  caption: ${caption}`);
    console.log(`  link: ${m.permalink}\n`);
  }
  console.log("Next: node test.js comments <MEDIA_ID>");
}

async function showComments(mediaId) {
  const data = await api("GET", `/${mediaId}/comments`, {
    fields: "id,text,username,timestamp",
    limit: "50",
  });
  const list = data.data || [];
  console.log(`\nFound ${list.length} comment(s) on this post:\n`);
  for (const c of list) {
    console.log(`COMMENT_ID: ${c.id}`);
    console.log(`  from: ${c.username || "(username not shown)"}`);
    console.log(`  text: ${c.text}`);
    console.log(`  time: ${c.timestamp}\n`);
  }
  console.log("Next: node test.js reply <COMMENT_ID>");
}

async function sendReply(commentId) {
  const data = await api("POST", `/${IG_ID}/messages`, null, {
    recipient: { comment_id: commentId },
    message: { text: DM_TEXT },
  });
  console.log("\nDM sent successfully.");
  console.log("  message_id:", data.message_id || "(not returned)");
  console.log("\nAsk the commenter to check their inbox AND their message Requests folder.");
}

// A few different public replies, so they do not all look copy-pasted.
// One is picked at random each time. Change the wording to match your style.
const PUBLIC_REPLIES = [
  "Sent! Check your DMs 📩",
  "Done, please check your inbox (or message requests) 🙌",
  "Just sent it to you in DM ✅",
  "Check your DMs, it's there now 👀",
  "Shared with you in DM. Look in message requests if you don't see it 📥",
];

async function sendPublicReply(commentId) {
  const text = PUBLIC_REPLIES[Math.floor(Math.random() * PUBLIC_REPLIES.length)];
  const data = await api("POST", `/${commentId}/replies`, null, { message: text });
  console.log("\nPublic reply posted under the comment.");
  console.log("  text    :", text);
  console.log("  reply_id:", data.id || "(not returned)");
}

async function main() {
  const [command, id] = process.argv.slice(2);
  if (command === "media") return showMedia();
  if (command === "comments" && id) return showComments(id);
  if (command === "reply" && id) return sendReply(id);
  if (command === "public" && id) return sendPublicReply(id);

  console.log("How to use:");
  console.log("  node test.js media");
  console.log("  node test.js comments <MEDIA_ID>");
  console.log("  node test.js reply <COMMENT_ID>     (private DM)");
  console.log("  node test.js public <COMMENT_ID>    (public reply under the comment)");
}

main().catch((err) => {
  console.log("Something went wrong:", err.message);
  process.exit(1);
});