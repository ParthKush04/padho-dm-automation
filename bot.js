// Padho DM bot (version 3: "link" keyword gets the DM, everything else gets the result reply)
// ------------------------------------------------------------------------------------------
// What it does, again and again:
//   1. Looks at your recent posts and reels.
//   2. Finds new comments.
//   3. Decides what each comment is (this is the "keyword" mode, the default):
//        - It contains your keyword (link, LINK, Link... any letter case)  -> LINK REQUEST
//              -> sends a private DM with your link, then posts "Check your DMs".
//        - Anything else (numbers, words, emojis)                           -> NORMAL COMMENT
//              -> posts a public reply like "Results will be out soon, it will be pinned". No DM.
//   4. Remembers every comment it has handled in state.json, so nobody gets two replies.
//   5. Rotates between your different reply texts and never uses the same one twice in a row.
//
// How to run:
//   node bot.js           -> keeps running and checks every minute
//   node bot.js --once    -> checks one time and stops
//
// Files it needs in the same folder:
//   .env        -> your token and settings (see env-example.txt)
//   rules.json  -> your reply texts, DM texts and per-post choices
//
// Needs Node.js 18 or newer.
//
// Running it online (for example on Render):
//   - If PORT is set, it opens a tiny status web page, so the host sees a web service.
//   - If MONGODB_URI is set, it keeps its memory in MongoDB instead of only in state.json,
//     so the memory survives when the server restarts. This needs "npm install" once.

const fs = require("fs");
const path = require("path");
const http = require("http");

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

function loadEnv() {
  const envPath = path.join(__dirname, ".env");
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
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

function num(name, fallback) {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}
function bool(name, fallback) {
  const v = (process.env[name] || "").toLowerCase();
  if (v === "true" || v === "1" || v === "yes") return true;
  if (v === "false" || v === "0" || v === "no") return false;
  return fallback;
}

const TOKEN = process.env.IG_TOKEN;
const IG_ID = process.env.IG_ID;
const BASE = process.env.GRAPH_BASE || "https://graph.facebook.com/v27.0";

const POLL_SECONDS = num("POLL_SECONDS", 60); // how often to check for new comments
// How many posts to watch. Default: all of them (up to 1000). Set MEDIA_LIMIT=10 to watch only the newest 10.
const MAX_MEDIA = 1000;
const MEDIA_LIMIT = (() => {
  const raw = String(process.env.MEDIA_LIMIT || "").trim().toLowerCase();
  if (!raw || raw === "all") return MAX_MEDIA;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), MAX_MEDIA) : MAX_MEDIA;
})();
const FULL_SCAN_EVERY = num("FULL_SCAN_EVERY", 30); // every Nth check, re-read the newest comments of every post
const DELAY_SECONDS = num("DELAY_SECONDS", 5); // wait between two people
const MAX_DMS_PER_HOUR = num("MAX_DMS_PER_HOUR", 200); // safety cap on DMs (Meta's own limit is 750)
const MAX_REPLIES_PER_HOUR = num("MAX_REPLIES_PER_HOUR", 300); // safety cap on public replies
const MAX_PAGES = num("MAX_PAGES", 40); // comment pages to read per post (50 comments each)
const DRY_RUN = bool("DRY_RUN", false); // true = only print what it would do, send nothing
const RUN_ONCE = process.argv.includes("--once");

const MONGODB_URI = (process.env.MONGODB_URI || "").trim(); // optional: keep the memory in MongoDB
const MONGODB_DB = (process.env.MONGODB_DB || "padho_bot").trim();
const STATE_ID = DRY_RUN ? "state-dryrun" : "state";

const RULES_FILE = path.join(__dirname, "rules.json");
const STATE_FILE = path.join(__dirname, DRY_RUN ? "state.dryrun.json" : "state.json");

const REPLY_WINDOW_MS = 6.5 * 24 * 60 * 60 * 1000; // Instagram allows 7 days for DMs; we stop a little early
const KEEP_RECORDS_MS = 30 * 24 * 60 * 60 * 1000; // forget handled comments after 30 days
const RATE_LIMIT_PAUSE_MS = 15 * 60 * 1000; // rest for 15 minutes if Instagram says "slow down"
const HOUR_MS = 60 * 60 * 1000;
const MAX_TRIES = 2;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function log(...parts) {
  const time = new Date().toLocaleString("en-IN", { hour12: false });
  console.log(`[${time}]`, ...parts);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Picks one text at random, but never the same one that was used last time for this kind of reply.
function pickFresh(state, kind, list) {
  if (list.length === 1) return list[0];
  const last = state.lastPick[kind];
  let index = Math.floor(Math.random() * list.length);
  if (list[index] === last) index = (index + 1 + Math.floor(Math.random() * (list.length - 1))) % list.length;
  state.lastPick[kind] = list[index];
  return list[index];
}
const short = (text, n) => String(text || "").replace(/\s+/g, " ").slice(0, n);

class FatalError extends Error {}

// ---------------------------------------------------------------------------
// Rules (rules.json)
// ---------------------------------------------------------------------------

// keyword: keyword -> DM + reply, every other comment -> result reply   (default)
// auto   : number -> result reply, no number -> link flow
// quiz   : number -> result reply, everything else -> nothing
// link   : link flow only, everything else -> nothing
// off    : ignore the post
const MODES = ["keyword", "auto", "quiz", "link", "off"];

function textList(value) {
  const list = Array.isArray(value) ? value : value === undefined || value === null ? [] : [value];
  return list.filter((t) => typeof t === "string" && t.trim());
}

// Matches the keyword as a whole word, in any letter case. Works for Hindi and other scripts too.
function makeMatcher(keyword) {
  const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, "iu");
}

function loadRules() {
  if (!fs.existsSync(RULES_FILE)) {
    throw new FatalError("rules.json is missing. Put it in the same folder as bot.js.");
  }
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(RULES_FILE, "utf8"));
  } catch (e) {
    throw new FatalError("rules.json has a mistake in it (not valid JSON): " + e.message);
  }
  if (Array.isArray(raw.rules)) {
    throw new FatalError("rules.json is in the old format. Please use the new rules.json that came with this bot.js.");
  }

  const defaultMode = raw.defaultMode || "keyword";
  if (!MODES.includes(defaultMode)) {
    throw new FatalError(`rules.json: defaultMode must be one of ${MODES.join(", ")}.`);
  }

  const quiz = { replies: textList(raw.quiz && raw.quiz.replies) };

  const linkRaw = raw.link || {};
  const trigger = linkRaw.trigger || "any";
  if (!["any", "keywords"].includes(trigger)) {
    throw new FatalError('rules.json: link.trigger must be "any" or "keywords".');
  }
  const keywords = textList(linkRaw.keywords).map((k) => k.trim().toLowerCase());
  const dmStyle = linkRaw.dmStyle || "text";
  if (!["text", "button"].includes(dmStyle)) {
    throw new FatalError('rules.json: link.dmStyle must be "text" or "button".');
  }
  const buttonText = typeof linkRaw.buttonText === "string" && linkRaw.buttonText.trim() ? linkRaw.buttonText.trim() : "Open link";
  if ([...buttonText].length > 20) {
    throw new FatalError("rules.json: link.buttonText can be at most 20 characters (Instagram's limit).");
  }
  const link = {
    trigger,
    keywords,
    matchers: keywords.map(makeMatcher),
    url: typeof linkRaw.url === "string" ? linkRaw.url.trim() : "",
    dm: textList(linkRaw.dm),
    publicReplies: textList(linkRaw.publicReplies),
    dmStyle,
    buttonText,
  };
  if (trigger === "keywords" && !keywords.length) {
    throw new FatalError('rules.json: link.trigger is "keywords" but link.keywords is empty.');
  }

  const posts = {};
  for (const [mediaId, p] of Object.entries(raw.posts || {})) {
    if (!/^\d+$/.test(mediaId)) continue; // skips the example entry and anything that is not a real ID
    const mode = (p && p.mode) || defaultMode;
    if (!MODES.includes(mode)) {
      throw new FatalError(`rules.json: post ${mediaId} has mode "${mode}". Use one of ${MODES.join(", ")}.`);
    }
    posts[mediaId] = {
      mode,
      url: typeof p.url === "string" ? p.url.trim() : "",
      dm: textList(p.dm),
      publicReplies: textList(p.publicReplies),
      quizReplies: textList(p.quizReplies),
    };
  }

  const modesInUse = new Set([defaultMode, ...Object.values(posts).map((p) => p.mode)]);
  const usesQuiz = modesInUse.has("keyword") || modesInUse.has("auto") || modesInUse.has("quiz");
  const usesLink = modesInUse.has("keyword") || modesInUse.has("auto") || modesInUse.has("link");
  if (modesInUse.has("keyword") && !keywords.length) {
    throw new FatalError('rules.json: link.keywords is empty. Add your keyword, for example ["link"].');
  }
  if (usesQuiz && !quiz.replies.length) {
    throw new FatalError("rules.json: quiz.replies needs at least one reply text.");
  }
  if (usesLink && !link.dm.length) {
    throw new FatalError("rules.json: link.dm needs at least one DM text.");
  }
  if (usesLink) {
    // Every DM text that says {link} needs a real link to put there.
    const places = [{ where: "link", url: link.url, dm: link.dm }];
    for (const [mediaId, p] of Object.entries(posts)) {
      if (p.mode === "keyword" || p.mode === "auto" || p.mode === "link") {
        places.push({ where: `post ${mediaId}`, url: p.url || link.url, dm: p.dm.length ? p.dm : link.dm });
      }
    }
    for (const place of places) {
      const usesPlaceholder = place.dm.some((t) => t.includes("{link}"));
      if (usesPlaceholder && !place.url) {
        throw new FatalError(`rules.json: the DM text for ${place.where} uses {link} but no "url" is set.`);
      }
      const stillExample = /example\.com/i.test(place.url) || place.dm.some((t) => /example\.com/i.test(t));
      if (stillExample && !DRY_RUN) {
        throw new FatalError(
          `rules.json: ${place.where} still has the example link (example.com). ` +
            'Put your real link in "url" before going live, or set DRY_RUN=true to only try it out.'
        );
      }
    }
  }

  return { defaultMode, quiz, link, posts };
}

// Any digit counts as "has a number": 0-9 and also digits of other scripts like Hindi (०-९).
const hasNumber = (text) => /\p{Nd}/u.test(text || "");

// Decides what to do with one comment. Returns "quiz", "link" or null (do nothing).
function decide(config, text, mediaId) {
  if (!text || !text.trim()) return null; // GIF or sticker comments have no text
  const post = config.posts[mediaId];
  const mode = post ? post.mode : config.defaultMode;
  if (mode === "off") return null;

  const hasKeyword = () => config.link.matchers.some((m) => m.test(text));
  const wantsLink = () => config.link.trigger === "any" || hasKeyword();

  // keyword mode: the keyword always wins, even if the comment also has a number
  if (mode === "keyword") return hasKeyword() ? "link" : "quiz";
  if (mode === "quiz") return hasNumber(text) ? "quiz" : null;
  if (mode === "link") return wantsLink() ? "link" : null;
  // auto: a number means a quiz answer, anything else is a link request
  if (hasNumber(text)) return "quiz";
  return wantsLink() ? "link" : null;
}

// Texts to use for one comment. A post's own texts win over the general ones.
function textsFor(config, action, mediaId) {
  const post = config.posts[mediaId] || { url: "", dm: [], publicReplies: [], quizReplies: [] };
  if (action === "quiz") {
    return { url: "", dm: [], pub: post.quizReplies.length ? post.quizReplies : config.quiz.replies };
  }
  return {
    url: post.url || config.link.url,
    dm: post.dm.length ? post.dm : config.link.dm,
    pub: post.publicReplies.length ? post.publicReplies : config.link.publicReplies,
  };
}

// ---------------------------------------------------------------------------
// Memory (state.json)
// ---------------------------------------------------------------------------

const EMPTY_STATE = () => ({
  started: false,
  watchAll: false,
  comments: {},
  sent: [],
  sentPub: [],
  mediaCounts: {},
  pauseUntil: 0,
  cycles: 0,
  lastPick: {},
});

let mongoCollection = null;
let mongoWasDown = false;

async function connectMongo() {
  if (mongoCollection) return mongoCollection;
  let MongoClient;
  try {
    ({ MongoClient } = require("mongodb"));
  } catch (e) {
    throw new FatalError('MONGODB_URI is set but the "mongodb" package is not installed. Run: npm install');
  }
  try {
    const client = new MongoClient(MONGODB_URI, { serverSelectionTimeoutMS: 15000 });
    await client.connect();
    mongoCollection = client.db(MONGODB_DB).collection("bot_state");
    return mongoCollection;
  } catch (e) {
    // Do not start without the memory: that could mean replying to people twice.
    throw new FatalError("Could not connect to MongoDB: " + e.message);
  }
}

function readLocalState() {
  if (!fs.existsSync(STATE_FILE)) return null;
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch (e) {
    // Never start fresh silently: that could message people a second time.
    throw new FatalError(
      `${path.basename(STATE_FILE)} could not be read (${e.message}). ` +
        "Fix or remove the file yourself, then start again."
    );
  }
}

async function loadState() {
  if (MONGODB_URI) {
    const col = await connectMongo();
    let doc;
    try {
      doc = await col.findOne({ _id: STATE_ID });
    } catch (e) {
      throw new FatalError("Could not read the memory from MongoDB: " + e.message);
    }
    if (doc) {
      try {
        log("Memory loaded from MongoDB.");
        return { ...EMPTY_STATE(), ...JSON.parse(doc.json) };
      } catch (e) {
        throw new FatalError("The memory saved in MongoDB is damaged: " + e.message);
      }
    }
    const local = readLocalState();
    if (local) log(`MongoDB has no memory yet. Starting from ${path.basename(STATE_FILE)} and copying it there.`);
    else log("MongoDB has no memory yet. Starting fresh.");
    return { ...EMPTY_STATE(), ...(local || {}) };
  }
  return { ...EMPTY_STATE(), ...(readLocalState() || {}) };
}

// Saves the memory. Returns true when it is safely stored, false when the database could not be reached.
async function saveState(state) {
  const json = JSON.stringify(state, null, 1);
  try {
    const tmp = STATE_FILE + ".tmp";
    fs.writeFileSync(tmp, json);
    fs.renameSync(tmp, STATE_FILE);
  } catch (e) {
    if (!MONGODB_URI) throw e; // without a database the file is the only memory
  }
  if (!MONGODB_URI) return true;
  try {
    const col = await connectMongo();
    await col.replaceOne({ _id: STATE_ID }, { _id: STATE_ID, json, updatedAt: new Date() }, { upsert: true });
    if (mongoWasDown) log("MongoDB is reachable again.");
    mongoWasDown = false;
    return true;
  } catch (e) {
    if (!mongoWasDown) log("Could not save the memory to MongoDB:", e.message);
    mongoWasDown = true;
    return false;
  }
}

function tidyState(state) {
  const now = Date.now();
  state.sent = state.sent.filter((t) => now - t < HOUR_MS);
  state.sentPub = state.sentPub.filter((t) => now - t < HOUR_MS);
  for (const [id, rec] of Object.entries(state.comments)) {
    if (rec.status !== "pending" && now - rec.seenAt > KEEP_RECORDS_MS) delete state.comments[id];
  }
}

// ---------------------------------------------------------------------------
// Talking to Instagram
// ---------------------------------------------------------------------------

// Returns { ok: true, data } or { ok: false, kind, message }.
// kind is one of: "rate" (slow down), "auth" (token problem), "retry" (try later), "other".
async function api(method, pathname, query, body) {
  const url = new URL(BASE + pathname);
  for (const [k, v] of Object.entries(query || {})) url.searchParams.set(k, v);

  let res;
  try {
    res = await fetch(url, {
      method,
      headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    return { ok: false, kind: "retry", message: "Network problem: " + e.message };
  }

  const data = await res.json().catch(() => ({}));
  if (res.ok && !data.error) return { ok: true, data };

  const e = data.error || {};
  const message = `${e.message || "Unknown error"} (code ${e.code ?? "?"}, subcode ${e.error_subcode ?? "?"})`;
  let kind = "other";
  if (res.status === 429 || [4, 17, 32, 613, 80002, 80006].includes(e.code)) kind = "rate";
  else if (e.code === 190 || res.status === 401) kind = "auth";
  else if (e.is_transient || res.status >= 500 || [1, 2].includes(e.code)) kind = "retry";
  return { ok: false, kind, message };
}

function stopIfSerious(result, doing) {
  if (result.ok) return;
  if (result.kind === "auth") {
    throw new FatalError(
      `Instagram rejected the token while ${doing}: ${result.message}. ` +
        "Generate a new token in the Meta dashboard and put it in .env."
    );
  }
}

// Lists your posts, newest first, page by page, until MEDIA_LIMIT posts are collected.
async function getRecentMedia() {
  const all = [];
  let after = null;
  while (all.length < MEDIA_LIMIT) {
    const query = { fields: "id,comments_count,timestamp", limit: String(Math.min(50, MEDIA_LIMIT - all.length)) };
    if (after) query.after = after;
    const r = await api("GET", `/${IG_ID}/media`, query);
    stopIfSerious(r, "reading your posts");
    if (!r.ok) return r;
    const list = r.data.data || [];
    all.push(...list);
    after = r.data.paging && r.data.paging.next && r.data.paging.cursors ? r.data.paging.cursors.after : null;
    if (!after || !list.length) break;
  }
  return { ok: true, data: { data: all.slice(0, MEDIA_LIMIT) } };
}

// Reads the comments of one post, page by page.
// Stops early when it reaches comments it already knows (only safe when newest come first).
async function getComments(mediaId, known, readEverything) {
  const all = [];
  let after = null;
  let newestFirst = false;
  for (let page = 0; page < MAX_PAGES; page++) {
    const query = { fields: "id,text,username,timestamp", limit: "50" };
    if (after) query.after = after;
    const r = await api("GET", `/${mediaId}/comments`, query);
    stopIfSerious(r, "reading comments");
    if (!r.ok) return { ok: false, kind: r.kind, message: r.message, comments: all };

    const list = r.data.data || [];
    all.push(...list);

    if (page === 0 && list.length >= 2) {
      newestFirst = new Date(list[0].timestamp) >= new Date(list[list.length - 1].timestamp);
    }
    const hasUnknown = list.some((c) => !known[c.id]);
    after = r.data.paging && r.data.paging.cursors && r.data.paging.next ? r.data.paging.cursors.after : null;
    if (!after) break;
    if (!readEverything && newestFirst && !hasUnknown) break;
  }
  return { ok: true, comments: all };
}

// ---------------------------------------------------------------------------
// One full check
// ---------------------------------------------------------------------------

async function runCycle(state, config, ownUsername) {
  const now = Date.now();
  tidyState(state);

  if (state.pauseUntil > now) {
    const mins = Math.ceil((state.pauseUntil - now) / 60000);
    log(`Resting because Instagram asked to slow down. ${mins} minute(s) left.`);
    return;
  }

  state.cycles += 1;
  const firstRun = !state.started;
  // When this version starts for the first time on an existing memory, it begins watching older posts too.
  // Their existing comments are only noted, never answered, just like on a first run.
  const upgradeRun = state.started && !state.watchAll;
  const noteOnly = firstRun || upgradeRun;
  const fullScan = noteOnly || state.cycles % FULL_SCAN_EVERY === 0; // now and then, look at every post again

  const media = await getRecentMedia();
  if (!media.ok) {
    if (media.kind === "rate") state.pauseUntil = now + RATE_LIMIT_PAUSE_MS;
    log("Could not read your posts right now:", media.message);
    await saveState(state);
    return;
  }

  let found = 0;
  let scanFailed = false;
  for (const m of media.data.data || []) {
    const count = m.comments_count || 0;
    if (!fullScan && state.mediaCounts[m.id] === count) continue; // nothing new on this post

    const result = await getComments(m.id, state.comments, noteOnly);
    for (const c of result.comments) {
      if (state.comments[c.id]) continue;
      const rec = { seenAt: now, status: "ignored" };
      const age = now - new Date(c.timestamp).getTime();
      const isMine = ownUsername && c.username === ownUsername;
      const action = !noteOnly && !isMine && age < REPLY_WINDOW_MS ? decide(config, c.text, m.id) : null;

      if (action) {
        rec.status = "pending";
        rec.action = action;
        rec.mediaId = m.id;
        rec.username = c.username || "";
        rec.text = c.text || "";
        rec.ts = c.timestamp;
        rec.dm = false;
        rec.pub = false;
        rec.tries = 0;
        found += 1;
        const what = action === "quiz" ? "normal comment -> result reply only" : "link request -> DM + public reply";
        log(`New comment from @${rec.username || "someone"}: "${short(rec.text, 60)}" (${what})`);
      }
      state.comments[c.id] = rec;
    }

    if (!result.ok) {
      scanFailed = true;
      if (result.kind === "rate") state.pauseUntil = now + RATE_LIMIT_PAUSE_MS;
      log("Could not finish reading comments on one post:", result.message);
      break; // keep the old count so this post is read again next time
    }
    state.mediaCounts[m.id] = count;
  }

  // Only mark the first run as complete when every post was read without a problem.
  if (noteOnly && !scanFailed) {
    const total = Object.keys(state.comments).length;
    if (firstRun) {
      log(`First run: noted ${total} existing comment(s). They will NOT get a reply. Only new comments from now on.`);
    } else {
      log(`Now watching all ${(media.data.data || []).length} posts. Existing comments were noted and will NOT get a reply. Only new comments from now on.`);
    }
    state.started = true;
    state.watchAll = true;
  }
  await saveState(state);

  if (found) log(`${found} new comment(s) added to the queue.`);
  if (state.started && state.pauseUntil <= Date.now()) await sendPending(state, config);
}

// ---------------------------------------------------------------------------
// Sending the DM and the public reply
// ---------------------------------------------------------------------------

// Sends one request and sorts the result into: "ok", "stop" (end this round), or "failed".
async function attempt(state, doing, who, call) {
  const r = await call();
  stopIfSerious(r, doing);
  if (r.ok) return { outcome: "ok" };
  if (r.kind === "rate") {
    state.pauseUntil = Date.now() + RATE_LIMIT_PAUSE_MS;
    log("Instagram asked to slow down. Resting for 15 minutes.", r.message);
    return { outcome: "stop" };
  }
  if (r.kind === "retry") {
    log(`Problem while ${doing} for ${who}, will try again later:`, r.message);
    return { outcome: "stop" };
  }
  return { outcome: "failed", message: r.message };
}

// Builds the DM. In "button" mode the link goes on a tap-able button and the text points to it.
// Returns { message, style }.
function buildDm(config, texts, fill, rawText) {
  const plain = { message: { text: fill(rawText) }, style: "text" };
  if (config.link.dmStyle !== "button" || !texts.url || !rawText.includes("{link}")) return plain;
  const body = fill(rawText.replaceAll("{link}", "👇")).slice(0, 640);
  return {
    message: {
      attachment: {
        type: "template",
        payload: {
          template_type: "button",
          text: body,
          buttons: [{ type: "web_url", url: texts.url, title: config.link.buttonText }],
        },
      },
    },
    style: "button",
    fallback: plain.message,
  };
}

async function sendPending(state, config) {
  const pending = Object.entries(state.comments)
    .filter(([, rec]) => rec.status === "pending")
    .sort((a, b) => new Date(a[1].ts) - new Date(b[1].ts));

  let dmCapLogged = false;
  let pubCapLogged = false;

  // If the memory cannot be saved, stop sending. Sending without saving could reply to people twice.
  let storageDown = false;
  const persist = async () => {
    if (!(await saveState(state))) storageDown = true;
  };
  if (pending.length) {
    await persist();
    if (storageDown) {
      log("The memory database is not reachable, so nothing is sent in this round.");
      return;
    }
  }

  for (const [commentId, rec] of pending) {
    if (stopping) break;
    if (storageDown) {
      log("Stopped sending because the memory could not be saved. Will continue when the database is back.");
      break;
    }
    const now = Date.now();
    const who = `@${rec.username || "someone"}`;
    const action = rec.action || "link"; // records saved by the older version were all link requests
    let didSomething = false;

    if (now - new Date(rec.ts).getTime() > REPLY_WINDOW_MS) {
      rec.status = "failed";
      rec.reason = "Too old to reply (more than about 7 days).";
      log(`Skipped ${who}: comment is too old.`);
      await persist();
      continue;
    }

    // If you changed rules.json since this comment was queued, respect the new choice.
    if (!rec.dm && !rec.pub && decide(config, rec.text, rec.mediaId) !== action) {
      rec.status = "ignored";
      await persist();
      continue;
    }

    const texts = textsFor(config, action, rec.mediaId);
    const fill = (t) => t.replaceAll("{username}", rec.username || "there").replaceAll("{link}", texts.url);
    if ((action === "link" && !texts.dm.length) || (action === "quiz" && !texts.pub.length)) {
      rec.status = "ignored";
      await persist();
      continue;
    }

    state.sent = state.sent.filter((t) => now - t < HOUR_MS);
    state.sentPub = state.sentPub.filter((t) => now - t < HOUR_MS);

    // Step 1 (link requests only): the private DM
    if (action === "link" && !rec.dm) {
      if (state.sent.length >= MAX_DMS_PER_HOUR) {
        if (!dmCapLogged) log(`Hourly limit of ${MAX_DMS_PER_HOUR} DMs reached. The rest will go out later.`);
        dmCapLogged = true;
        continue;
      }
      const dm = buildDm(config, texts, fill, pickFresh(state, "dm", texts.dm));
      if (DRY_RUN) {
        const shown = dm.style === "button" ? `${dm.message.attachment.payload.text} [button: ${config.link.buttonText}]` : dm.message.text;
        log(`[DRY RUN] Would DM ${who}: "${short(shown, 70)}"`);
        rec.dm = true;
      } else {
        const send = (message) =>
          attempt(state, "sending a DM", who, () => api("POST", `/${IG_ID}/messages`, null, { recipient: { comment_id: commentId }, message }));
        let a = await send(dm.message);
        if (a.outcome === "failed" && dm.style === "button") {
          // Instagram refused the button. The one allowed DM was not used, so send the plain text version.
          log(`Button DM to ${who} was refused (${a.message}). Sending the plain text version.`);
          a = await send(dm.fallback);
        }
        didSomething = true;
        if (a.outcome === "stop") {
          await persist();
          break;
        }
        if (a.outcome === "failed") {
          rec.tries += 1;
          log(`DM to ${who} failed (try ${rec.tries} of ${MAX_TRIES}):`, a.message);
          if (rec.tries >= MAX_TRIES) {
            rec.status = "failed";
            rec.reason = a.message;
          }
          await persist();
          continue;
        }
        rec.dm = true;
        state.sent.push(Date.now());
        log(`DM sent to ${who}.`);
      }
      await persist();
      if (storageDown) continue; // the loop stops at the top of the next round
    }

    // Step 2: the public reply under the comment.
    // For link requests this happens only after the DM really went out.
    const readyForPublic = action === "quiz" || rec.dm;
    if (readyForPublic && !rec.pub && texts.pub.length) {
      if (state.sentPub.length >= MAX_REPLIES_PER_HOUR) {
        if (!pubCapLogged) log(`Hourly limit of ${MAX_REPLIES_PER_HOUR} public replies reached. The rest will go out later.`);
        pubCapLogged = true;
        await persist();
        if (didSomething) await sleep(DELAY_SECONDS * 1000 * (0.8 + Math.random() * 0.6));
        continue;
      }
      const text = fill(pickFresh(state, action === "quiz" ? "quiz" : "pub", texts.pub));
      if (DRY_RUN) {
        log(`[DRY RUN] Would reply publicly to ${who}: "${short(text, 70)}"`);
        rec.pub = true;
      } else {
        const a = await attempt(state, "posting a public reply", who, () =>
          api("POST", `/${commentId}/replies`, null, { message: text })
        );
        didSomething = true;
        if (a.outcome === "stop") {
          await persist();
          break;
        }
        if (a.outcome === "failed") {
          rec.pubTries = (rec.pubTries || 0) + 1;
          log(`Public reply for ${who} failed (try ${rec.pubTries} of ${MAX_TRIES}):`, a.message);
          if (rec.pubTries >= MAX_TRIES) rec.pub = "skipped";
        } else {
          rec.pub = true;
          state.sentPub.push(Date.now());
          log(`Public reply posted for ${who}.`);
        }
      }
    }

    // Is this comment finished?
    if (action === "quiz") {
      if (rec.pub === true) rec.status = "done";
      else if (rec.pub === "skipped") {
        rec.status = "failed";
        rec.reason = "Public reply could not be posted.";
      }
    } else if (rec.dm && (rec.pub || !texts.pub.length)) {
      rec.status = "done";
    }
    if (rec.status !== "pending") delete rec.text; // no need to keep the comment text any more
    await persist();

    // Wait a little before the next person, with a small random extra, so it does not look like a burst.
    if (didSomething) await sleep(DELAY_SECONDS * 1000 * (0.8 + Math.random() * 0.6));
  }
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

let stopping = false;
function askToStop() {
  if (stopping) process.exit(0);
  stopping = true;
  log("Stopping after the current step... (press Ctrl+C again to stop right now)");
}
process.on("SIGINT", askToStop); // Ctrl+C on your laptop
process.on("SIGTERM", askToStop); // what an online host sends before a restart

// A tiny web page, only used when the host gives us a PORT (Render does).
// It shows no names, no comments and no token.
const status = { startedAt: new Date(), lastCheck: null, checks: 0 };
function startStatusPage() {
  const port = Number(process.env.PORT);
  if (!port) return;
  http
    .createServer((req, res) => {
      res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
      res.end(
        "Padho bot is running.\n" +
          `Started: ${status.startedAt.toISOString()}\n` +
          `Last check: ${status.lastCheck ? status.lastCheck.toISOString() : "not yet"}\n` +
          `Checks done: ${status.checks}\n`
      );
    })
    .listen(port, () => log(`Status page is open on port ${port}.`));
}

function describeMode(config) {
  const words = config.link.keywords.join(", ");
  const linkTo = config.link.trigger === "any" ? "every comment" : `comments with a keyword (${words})`;
  switch (config.defaultMode) {
    case "keyword":
      return `DM only for comments with a keyword (${words}); every other comment gets the result reply.`;
    case "auto":
      return `Comments with a number get the result reply; of the rest, the DM goes to ${linkTo}.`;
    case "quiz":
      return "Comments with a number get the result reply; nothing else is answered.";
    case "link":
      return `The DM goes to ${linkTo}; nothing else is answered.`;
    default:
      return "Posts are ignored unless they have their own setting.";
  }
}

async function main() {
  if (!TOKEN || !IG_ID) {
    throw new FatalError("IG_TOKEN or IG_ID is missing. Create the .env file first (see env-example.txt).");
  }
  const config = loadRules();
  startStatusPage();
  const state = await loadState();

  const me = await api("GET", `/${IG_ID}`, { fields: "username" });
  stopIfSerious(me, "checking your account");
  if (!me.ok) throw new FatalError("Could not reach your Instagram account: " + me.message);
  const ownUsername = me.data.username || "";

  log(`Connected as @${ownUsername}.`);
  log(
    (MEDIA_LIMIT >= MAX_MEDIA ? "Watching all your posts" : `Watching the last ${MEDIA_LIMIT} posts`) +
      `, checking every ${POLL_SECONDS}s. ` +
      `Default mode: ${config.defaultMode}. ` +
      describeMode(config) +
      ` Posts with their own setting: ${Object.keys(config.posts).length}.` +
      (DRY_RUN ? " DRY RUN: nothing will be sent." : "")
  );

  while (!stopping) {
    try {
      await runCycle(state, config, ownUsername);
    } catch (e) {
      if (e instanceof FatalError) throw e;
      log("Something went wrong in this check, will try again:", e.message);
    }
    status.lastCheck = new Date();
    status.checks += 1;
    if (RUN_ONCE) break;
    for (let waited = 0; waited < POLL_SECONDS && !stopping; waited++) await sleep(1000);
  }
  log("Stopped.");
}

main()
  .then(() => process.exit(0)) // the status page and the database connection would otherwise keep it alive
  .catch((e) => {
    log(e instanceof FatalError ? "STOPPED: " + e.message : "Unexpected error: " + (e.stack || e.message));
    process.exit(1);
  });