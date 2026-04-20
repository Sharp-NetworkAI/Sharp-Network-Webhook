"use strict";

/**
 * Sharp Network AI — server.js
 *
 * ENV VARS (set in Render dashboard):
 *   PAGE_ACCESS_TOKEN   Long-lived Facebook Page access token
 *   PAGE_ID             Numeric Facebook Page ID
 *   VERIFY_TOKEN        Webhook verify token
 *   APP_SECRET          Facebook App Secret (optional)
 *   OPENAI_API_KEY      GPT-4o vision parsing
 *   BASE_URL            Your full public URL e.g. https://sharp-network-webhook.onrender.com
 *   TRIGGER_KEYWORD     Keyword in comments that activates the bot (default: slipcopy)
 *   PORT                Server port (default: 3000)
 */

const express = require("express");
const path    = require("path");
const crypto  = require("crypto");
const fs      = require("fs");

const app = express();

app.use(express.json({
  verify: (req, _res, buf) => { req.rawBody = buf; }
}));
app.use(express.static(path.join(__dirname, "public")));

/* =============================================================================
   CONFIG
============================================================================= */
const PORT         = process.env.PORT              || 3000;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN      || "";
const PAGE_TOKEN   = process.env.PAGE_ACCESS_TOKEN || "";
const APP_SECRET   = process.env.APP_SECRET        || "";
const PAGE_ID      = process.env.PAGE_ID           || "";
const OPENAI_KEY   = process.env.OPENAI_API_KEY    || "";
const BASE_URL     = (process.env.BASE_URL         || "").replace(/\/$/, "");
const TRIGGER_KW   = (process.env.TRIGGER_KEYWORD  || "slipcopy").toLowerCase();
const GRAPH        = "https://graph.facebook.com/v20.0";
const SLIP_TTL_MS  = 72 * 60 * 60 * 1000;

console.log("=== Sharp Network AI — startup ===");
console.log("  PAGE_TOKEN :", PAGE_TOKEN  ? `set (${PAGE_TOKEN.length} chars)` : "MISSING");
console.log("  OPENAI_KEY :", OPENAI_KEY  ? "set" : "MISSING — demo mode");
console.log("  BASE_URL   :", BASE_URL    || "MISSING");
console.log("  TRIGGER_KW :", TRIGGER_KW);
console.log("==================================");

/* =============================================================================
   PERSISTENT FILE-BASED STORE
============================================================================= */
const STORE_FILE = path.join(__dirname, "slips.json");

function _loadFromDisk() {
  try {
    if (fs.existsSync(STORE_FILE)) {
      const raw  = fs.readFileSync(STORE_FILE, "utf8");
      const data = JSON.parse(raw);
      const now  = Date.now();
      for (const [id, slip] of Object.entries(data)) {
        if (slip.expiresAt && new Date(slip.expiresAt).getTime() < now) delete data[id];
      }
      return data;
    }
  } catch (e) { console.error("[store] load error:", e.message); }
  return {};
}

const _storeData = _loadFromDisk();
let _saveTimer = null;

function _saveToDisk() {
  if (_saveTimer) clearTimeout(_saveTimer);
  _saveTimer = setTimeout(() => {
    try { fs.writeFileSync(STORE_FILE, JSON.stringify(_storeData, null, 2)); }
    catch (e) { console.error("[store] save error:", e.message); }
  }, 1000);
}

const slipStore = {
  get(id) {
    const slip = _storeData[id];
    if (!slip) return null;
    if (slip.expiresAt && new Date(slip.expiresAt).getTime() < Date.now()) {
      delete _storeData[id]; _saveToDisk(); return null;
    }
    return slip;
  },
  set(id, slip) {
    if (!slip.expiresAt) slip.expiresAt = new Date(Date.now() + SLIP_TTL_MS).toISOString();
    _storeData[id] = slip; _saveToDisk(); return slip;
  },
  mutate(id, fn) {
    const slip = this.get(id);
    if (!slip) return null;
    fn(slip); _storeData[id] = slip; _saveToDisk(); return slip;
  },
};

setInterval(() => {
  const now = Date.now(); let pruned = 0;
  for (const [id, slip] of Object.entries(_storeData)) {
    if (slip.expiresAt && new Date(slip.expiresAt).getTime() < now) { delete _storeData[id]; pruned++; }
  }
  if (pruned > 0) { console.log(`[store] Pruned ${pruned} expired slip(s)`); _saveToDisk(); }
}, 60 * 60 * 1000);

console.log(`[store] Loaded ${Object.keys(_storeData).length} slip(s) from disk`);

/* =============================================================================
   DEDUP
============================================================================= */
const processedIds = new Set();
function markProcessed(id) {
  if (processedIds.has(id)) return true;
  processedIds.add(id);
  if (processedIds.size > 5000) {
    const iter = processedIds.values();
    for (let i = 0; i < 500; i++) processedIds.delete(iter.next().value);
  }
  return false;
}

/* =============================================================================
   HELPERS
============================================================================= */
function clean(v) { return String(v || "").replace(/\s+/g, " ").trim(); }
function norm(v)  { return clean(v).toLowerCase(); }
function createSlipId() { return crypto.randomBytes(5).toString("hex"); }
function splitChunks(text, maxLen = 1900) {
  if (text.length <= maxLen) return [text];
  const chunks = [];
  for (let i = 0; i < text.length; i += maxLen) chunks.push(text.slice(i, i + maxLen));
  return chunks;
}

/* =============================================================================
   SIGNATURE VERIFICATION
============================================================================= */
function verifySignature(req) {
  if (!APP_SECRET) return true;
  const sig = req.headers["x-hub-signature-256"];
  if (!sig) return false;
  const rawBody = req.rawBody;
  if (!rawBody || rawBody.length === 0) return false;
  const expected = "sha256=" + crypto.createHmac("sha256", APP_SECRET).update(rawBody).digest("hex");
  try { return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected)); }
  catch { return false; }
}

/* =============================================================================
   MANUAL DEEP LINK BUILDER
   Constructs direct game/bet page URLs for each sportsbook using
   team names and sport extracted by GPT-4o — no paid API needed.
============================================================================= */

function slugify(str) {
  return norm(str).replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

// Sport codes per sportsbook URL format
const SPORT_PATHS = {
  fanduel: {
    NFL:    "football/nfl",
    NBA:    "basketball/nba",
    MLB:    "baseball/mlb",
    NHL:    "hockey/nhl",
    NCAAF:  "football/ncaaf",
    NCAAB:  "basketball/ncaab",
    Soccer: "soccer",
    default:"sports",
  },
  draftkings: {
    NFL:    "football/nfl",
    NBA:    "basketball/nba",
    MLB:    "baseball/mlb",
    NHL:    "hockey/nhl",
    NCAAF:  "football/college-football",
    NCAAB:  "basketball/ncaab",
    Soccer: "soccer",
    default:"sports",
  },
  betmgm: {
    NFL:    "football/nfl",
    NBA:    "basketball/nba",
    MLB:    "baseball/mlb",
    NHL:    "hockey/nhl",
    NCAAF:  "football/ncaaf",
    NCAAB:  "basketball/ncaab",
    Soccer: "soccer",
    default:"sports",
  },
};

function getSportPath(book, sport) {
  const map = SPORT_PATHS[book] || {};
  return map[(sport || "").toUpperCase()] || map.default || "sports";
}

function buildManualLinks(legs) {
  // Get the most common sport in the slip
  const sportCounts = {};
  for (const leg of legs) {
    const s = (leg.sport || "MLB").toUpperCase();
    sportCounts[s] = (sportCounts[s] || 0) + 1;
  }
  const primarySport = Object.entries(sportCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || "MLB";

  // Get primary team from first leg that has one
  const primaryLeg = legs.find(l => l.team) || legs[0];
  const teamSlug   = slugify(primaryLeg?.team || primaryLeg?.player || "");
  const sport      = primaryLeg?.sport || primarySport;

  // FanDuel — direct to sport section
  const fdSport  = getSportPath("fanduel", sport);
  const fdLink   = teamSlug
    ? `https://sportsbook.fanduel.com/${fdSport}?q=${encodeURIComponent(primaryLeg?.team || primaryLeg?.player || "")}`
    : `https://sportsbook.fanduel.com/${fdSport}`;

  // DraftKings — direct to sport section
  const dkSport  = getSportPath("draftkings", sport);
  const dkLink   = `https://sportsbook.draftkings.com/leagues/${dkSport}`;

  // BetMGM — direct to sport section
  const mgmSport = getSportPath("betmgm", sport);
  const mgmLink  = `https://sports.betmgm.com/en/sports/${mgmSport}`;

  // Caesars — sport lobby
  const caesarsMap = {
    NFL: "https://sportsbook.caesars.com/us/oh/bet/football/nfl/matches",
    NBA: "https://sportsbook.caesars.com/us/oh/bet/basketball/nba/matches",
    MLB: "https://sportsbook.caesars.com/us/oh/bet/baseball/mlb/matches",
    NHL: "https://sportsbook.caesars.com/us/oh/bet/ice-hockey/nhl/matches",
  };
  const caesarsLink = caesarsMap[(sport || "").toUpperCase()] || "https://sportsbook.caesars.com";

  // bet365 — sport lobby
  const bet365Map = {
    NFL:    "https://www.bet365.com/#/AS/B18/",
    NBA:    "https://www.bet365.com/#/AS/B7/",
    MLB:    "https://www.bet365.com/#/AS/B14/",
    NHL:    "https://www.bet365.com/#/AS/B17/",
    Soccer: "https://www.bet365.com/#/AS/B1/",
  };
  const bet365Link = bet365Map[(sport || "").toUpperCase()] || "https://www.bet365.com";

  // ESPN BET — sport lobby
  const espnMap = {
    NFL:  "https://espnbet.com/sport/football/organization/us/competition/nfl",
    NBA:  "https://espnbet.com/sport/basketball/organization/us/competition/nba",
    MLB:  "https://espnbet.com/sport/baseball/organization/us/competition/mlb",
    NHL:  "https://espnbet.com/sport/hockey/organization/us/competition/nhl",
  };
  const espnLink = espnMap[(sport || "").toUpperCase()] || "https://espnbet.com";

  // PointsBet & Barstool — homepage (limited URL routing)
  const pointsbetLink = "https://pointsbet.com/sports";
  const barstoolLink  = "https://www.barstoolsportsbook.com";

  return {
    fanduel:    fdLink,
    draftkings: dkLink,
    betmgm:     mgmLink,
    caesars:    caesarsLink,
    bet365:     bet365Link,
    espnbet:    espnLink,
    pointsbet:  pointsbetLink,
    barstool:   barstoolLink,
  };
}

/* =============================================================================
   OPENAI — GPT-4o VISION PARSER
============================================================================= */
const PARSE_PROMPT = `You are a sports betting slip parser. Extract ALL betting legs from this slip.

For each leg return a JSON object with:
- "team": selected team name (for moneylines/spreads) OR null for props
- "player": player name (for player props) OR null
- "market": bet type with line — e.g. "Moneyline", "Spread -6.5", "Over 295.5 Passing Yards"
- "selection": exactly what was selected — e.g. "Chiefs ML", "Over", "Ravens +6.5"
- "odds": American odds string — e.g. "-160", "+250" — omit if not visible
- "sport": sport code — NFL, NBA, MLB, NHL, NCAAF, NCAAB, Soccer, or Other

RULES:
- Return ONLY a valid JSON array, no markdown, no explanation
- Extract EVERY leg even if partially visible
- For same-game parlays, list each leg separately
- Never return both teams for a moneyline — only the SELECTED side
- Player props: put player name in "player", leave "team" null

Example output:
[
  {"team":"Kansas City Chiefs","market":"Moneyline","selection":"Chiefs ML","odds":"-160","sport":"NFL"},
  {"player":"Patrick Mahomes","market":"Over 295.5 Passing Yards","selection":"Over","odds":"-115","sport":"NFL"},
  {"team":"Los Angeles Lakers","market":"Spread +4.5","selection":"Lakers +4.5","odds":"-110","sport":"NBA"}
]`;

async function parseSlipImage(imageUrl) {
  console.log("[openai] parseSlipImage — url:", imageUrl ? imageUrl.slice(0, 80) : "null");
  if (!OPENAI_KEY) {
    return [
      { team: "Kansas City Chiefs", market: "Moneyline",              selection: "Chiefs ML",   odds: "-160", sport: "NFL" },
      { player: "Patrick Mahomes",  market: "Over 295.5 Pass. Yards", selection: "Over",        odds: "-115", sport: "NFL" },
      { team: "Los Angeles Lakers", market: "Spread +4.5",            selection: "Lakers +4.5", odds: "-110", sport: "NBA" },
    ];
  }
  try {
    const imgResp = await fetch(imageUrl);
    if (!imgResp.ok) { console.error("[openai] image download failed:", imgResp.status); return []; }
    const imgBuffer   = await imgResp.arrayBuffer();
    const base64Image = Buffer.from(imgBuffer).toString("base64");
    const contentType = imgResp.headers.get("content-type") || "image/jpeg";
    const dataUri     = `data:${contentType};base64,${base64Image}`;

    const resp = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${OPENAI_KEY}` },
      body: JSON.stringify({
        model: "gpt-4o",
        max_tokens: 1500,
        temperature: 0.1,
        messages: [
          { role: "system", content: PARSE_PROMPT },
          { role: "user", content: [{ type: "image_url", image_url: { url: dataUri, detail: "high" } }] },
        ],
      }),
    });

    const data    = await resp.json();
    if (data.error) { console.error("[openai] API error:", data.error.message); return []; }
    const raw     = data.choices?.[0]?.message?.content || "[]";
    const cleaned = raw.replace(/```json?\n?/g, "").replace(/```/g, "").trim();
    const legs    = JSON.parse(cleaned);
    const filtered = Array.isArray(legs) ? legs.filter(l => l.market && l.selection) : [];
    console.log("[openai] parsed legs:", filtered.length);
    return filtered;
  } catch (e) { console.error("[openai] error:", e.message); return []; }
}

async function parseSlipText(text) {
  if (!OPENAI_KEY || !text.trim()) return [];
  try {
    const resp = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${OPENAI_KEY}` },
      body: JSON.stringify({
        model: "gpt-4o",
        max_tokens: 1000,
        temperature: 0.1,
        messages: [
          { role: "system", content: PARSE_PROMPT },
          { role: "user", content: `Parse this betting slip text:\n\n${text}` },
        ],
      }),
    });
    const data    = await resp.json();
    const raw     = data.choices?.[0]?.message?.content || "[]";
    const cleaned = raw.replace(/```json?\n?/g, "").replace(/```/g, "").trim();
    const legs    = JSON.parse(cleaned);
    return Array.isArray(legs) ? legs.filter(l => l.market && l.selection) : [];
  } catch (e) { console.error("[openai] text parse error:", e.message); return []; }
}

/* =============================================================================
   MESSENGER SEND API
============================================================================= */
async function sendMessage(psid, text) {
  if (!PAGE_TOKEN) return;
  const chunks = splitChunks(String(text || ""));
  for (const chunk of chunks) {
    try {
      const resp = await fetch(`${GRAPH}/me/messages?access_token=${PAGE_TOKEN}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          recipient: { id: psid },
          message: { text: chunk },
          messaging_type: "RESPONSE",
        }),
      });
      const data = await resp.json();
      if (!resp.ok) console.error("[send] failed:", resp.status, JSON.stringify(data));
    } catch (e) { console.error("[send] threw:", e.message); }
  }
}

async function sendSlipCard(psid, slipUrl, legCount) {
  if (!PAGE_TOKEN) return;
  try {
    const resp = await fetch(`${GRAPH}/me/messages?access_token=${PAGE_TOKEN}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        recipient: { id: psid },
        messaging_type: "RESPONSE",
        message: {
          attachment: {
            type: "template",
            payload: {
              template_type: "button",
              text: `🎯 Your ${legCount}-leg slip is ready! Choose your sportsbook and it's pre-loaded:`,
              buttons: [{
                type: "web_url",
                url: slipUrl,
                title: "Copy My Slip →",
                webview_height_ratio: "tall",
                messenger_extensions: false,
              }],
            },
          },
        },
      }),
    });
    const data = await resp.json();
    if (!resp.ok) {
      console.error("[send] card failed:", resp.status, JSON.stringify(data));
      await sendMessage(psid, `🎯 Slip ready! Choose your sportsbook:\n${slipUrl}`);
    }
  } catch (e) {
    console.error("[send] card threw:", e.message);
    await sendMessage(psid, `🎯 Slip ready! Choose your sportsbook:\n${slipUrl}`);
  }
}

async function replyToComment(commentId, message) {
  await fetch(`${GRAPH}/${commentId}/replies?access_token=${PAGE_TOKEN}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message }),
  }).catch(e => console.error("[comment reply] error:", e.message));
}

async function fetchPostImageUrl(postId) {
  try {
    const resp = await fetch(
      `${GRAPH}/${postId}?fields=full_picture,attachments{media,subattachments}&access_token=${PAGE_TOKEN}`
    );
    const data = await resp.json();
    if (data.full_picture) return data.full_picture;
    const att = data.attachments?.data?.[0];
    if (att?.media?.image?.src) return att.media.image.src;
    const sub = att?.subattachments?.data?.[0];
    if (sub?.media?.image?.src) return sub.media.image.src;
  } catch {}
  return null;
}

/* =============================================================================
   CORE SLIP PIPELINE
============================================================================= */
async function processSlip({ imageUrl, text, platform, userId }) {
  console.log(`[pipeline] start — platform=${platform}, imageUrl=${!!imageUrl}`);

  const legs = imageUrl
    ? await parseSlipImage(imageUrl)
    : await parseSlipText(text || "");

  if (!legs || legs.length === 0) {
    console.warn("[pipeline] No legs found");
    return null;
  }

  const storedLegs = legs.map(leg => ({
    team:      clean(leg.team   || ""),
    player:    clean(leg.player || ""),
    market:    clean(leg.market || ""),
    selection: clean(leg.selection || ""),
    odds:      clean(leg.odds   || ""),
    sport:     clean(leg.sport  || ""),
  }));

  // Build manual deep links
  const links = buildManualLinks(storedLegs);

  const slipId = createSlipId();
  slipStore.set(slipId, {
    legs:       storedLegs,
    links,
    platform:   platform || "messenger",
    userId:     userId   || null,
    parsedAt:   new Date().toISOString(),
    expiresAt:  new Date(Date.now() + SLIP_TTL_MS).toISOString(),
    clickCount: 0,
    bookClicks: {},
  });

  const slipUrl = `${BASE_URL}/s/${slipId}`;
  console.log(`[pipeline] slip created — id=${slipId}, legs=${storedLegs.length}`);
  return { slipId, slipUrl, legs: storedLegs, links };
}

/* =============================================================================
   ROUTES
============================================================================= */
app.get("/", (_req, res) => res.send("Sharp Network AI — running ✅"));

app.get("/webhook", (req, res) => {
  if (req.query["hub.verify_token"] === VERIFY_TOKEN) return res.send(req.query["hub.challenge"]);
  res.sendStatus(403);
});

app.get("/s/:slipId", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "slip.html"));
});

app.get("/api/slip/:slipId", (req, res) => {
  const slip = slipStore.get(req.params.slipId);
  if (!slip) return res.status(404).json({ success: false, error: "Slip not found or expired" });
  return res.json({ success: true, slip });
});

app.post("/api/slip/:slipId/click/:book", (req, res) => {
  const slip = slipStore.mutate(req.params.slipId, s => {
    s.clickCount = (s.clickCount || 0) + 1;
    s.bookClicks = s.bookClicks || {};
    s.bookClicks[req.params.book] = (s.bookClicks[req.params.book] || 0) + 1;
  });
  if (!slip) return res.status(404).json({ success: false, error: "Not found" });
  const link = slip.links?.[req.params.book] || "https://sportsbook.fanduel.com";
  return res.json({ success: true, link });
});

/* =============================================================================
   WEBHOOK HANDLER
============================================================================= */
app.post("/webhook", async (req, res) => {
  res.sendStatus(200);

  if (!verifySignature(req)) return;

  const body = req.body;
  if (body.object !== "page") return;

  for (const entry of (body.entry || [])) {
    // ── MESSENGER DIRECT MESSAGES ───────────────────────────────────────────
    for (const event of (entry.messaging || [])) {
      if (!event.message || event.message.is_echo) continue;
      if (!event.sender?.id) continue;

      const senderId = event.sender.id;
      const msgId    = event.message.mid;
      if (markProcessed(msgId)) continue;

      const text     = event.message.text || "";
      const imgAtt   = (event.message.attachments || []).find(a => a.type === "image");
      const imageUrl = imgAtt?.payload?.url || null;

      if (!imageUrl && !text.trim()) {
        await sendMessage(senderId, "Hey! Send me a betting slip screenshot 📸 and Sharp Network AI will create a link to copy it into any sportsbook instantly.");
        continue;
      }

      const result = await processSlip({ imageUrl, text, platform: "messenger", userId: senderId });

      if (!result) {
        await sendMessage(senderId, "Sharp Network AI couldn't read any betting legs from that image. Try a clearer screenshot showing the full slip.");
        continue;
      }

      await sendSlipCard(senderId, result.slipUrl, result.legs.length);
    }

    // ── PAGE FEED COMMENTS ──────────────────────────────────────────────────
    for (const change of (entry.changes || [])) {
      if (change.field !== "feed") continue;
      const v = change.value;
      if (v?.item !== "comment" || v?.verb !== "add") continue;

      const commentId  = v.comment_id;
      const postId     = v.post_id;
      const senderId   = v.sender_id;
      const senderName = v.sender_name || "";
      const msgText    = (v.message || "").toLowerCase();

      if (!commentId || !postId)         continue;
      if (markProcessed(commentId))      continue;
      if (senderId === PAGE_ID)          continue;
      if (!msgText.includes(TRIGGER_KW)) continue;

      console.log(`[feed] comment from @${senderName} on post ${postId}`);

      const imageUrl = await fetchPostImageUrl(postId);
      const result   = await processSlip({ imageUrl, text: v.message || "", platform: "facebook", userId: senderId });

      if (!result) {
        await replyToComment(commentId,
          `Hey ${senderName}! Sharp Network AI couldn't find a betting slip in this post. Make sure there's a clear screenshot in the image. 📋`
        );
        continue;
      }

      const { slipUrl, legs } = result;
      const parlayLabel = legs.length === 1 ? "slip" : `${legs.length}-leg parlay`;

      await replyToComment(commentId,
        `Hey ${senderName}! ⚡ Sharp Network AI locked in your ${parlayLabel}.\n\nPick your sportsbook — slip is pre-loaded:\n${slipUrl}\n\n(FanDuel · DraftKings · BetMGM · Caesars + more)`
      );
    }
  }
});

/* =============================================================================
   START
============================================================================= */
app.listen(PORT, () => console.log(`Sharp Network AI running on :${PORT}`));
