"use strict";

/**
 * SlipCopy Bot — server.js
 *
 * ENV VARS (set in Render dashboard):
 *   PAGE_ACCESS_TOKEN   Long-lived Facebook Page access token
 *   PAGE_ID             Numeric Facebook Page ID
 *   VERIFY_TOKEN        Webhook verify token (any string you choose)
 *   APP_SECRET          Facebook App Secret (for webhook signature verification)
 *   OPENAI_API_KEY      GPT-4o vision parsing
 *   ODDS_API_KEY        The Odds API key (optional — enables real event deep links)
 *   BASE_URL            Your full public URL, e.g. https://sharp-network-webhook.onrender.com
 *   TRIGGER_KEYWORD     Keyword in comments that activates the bot (default: slipcopy)
 *   PORT                Server port (default: 3000)
 */

const express = require("express");
const path    = require("path");
const crypto  = require("crypto");
const fs      = require("fs");

const app = express();

// ─── Raw body capture (must come BEFORE express.json) ────────────────────────
// Needed for Meta webhook signature verification
app.use((req, _res, next) => {
  const chunks = [];
  req.on("data", (chunk) => chunks.push(chunk));
  req.on("end", () => {
    req.rawBody = Buffer.concat(chunks);
    next();
  });
});
app.use(express.json());
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
const ODDS_KEY     = process.env.ODDS_API_KEY      || "";
const BASE_URL     = (process.env.BASE_URL         || "").replace(/\/$/, "");
const TRIGGER_KW   = (process.env.TRIGGER_KEYWORD  || "slipcopy").toLowerCase();
const GRAPH        = "https://graph.facebook.com/v20.0";
const SLIP_TTL_MS  = 72 * 60 * 60 * 1000; // 72 hours

/* =============================================================================
   PERSISTENT FILE-BASED STORE
   Slips are written to slips.json on disk so they survive Render spin-downs,
   restarts, and new deploys. 72-hour TTL enforced on read and during hourly prune.
============================================================================= */
const STORE_FILE = path.join(__dirname, "slips.json");

function _loadFromDisk() {
  try {
    if (fs.existsSync(STORE_FILE)) {
      const raw  = fs.readFileSync(STORE_FILE, "utf8");
      const data = JSON.parse(raw);
      const now  = Date.now();
      // Drop already-expired slips on startup
      for (const [id, slip] of Object.entries(data)) {
        if (slip.expiresAt && new Date(slip.expiresAt).getTime() < now) {
          delete data[id];
        }
      }
      return data;
    }
  } catch (e) {
    console.error("[store] Failed to load slips.json:", e.message);
  }
  return {};
}

const _storeData = _loadFromDisk();
let   _saveTimer = null;

function _saveToDisk() {
  // Debounced — write at most once per second
  if (_saveTimer) clearTimeout(_saveTimer);
  _saveTimer = setTimeout(() => {
    try {
      fs.writeFileSync(STORE_FILE, JSON.stringify(_storeData, null, 2));
    } catch (e) {
      console.error("[store] Failed to write slips.json:", e.message);
    }
  }, 1000);
}

const slipStore = {
  get(id) {
    const slip = _storeData[id];
    if (!slip) return null;
    if (slip.expiresAt && new Date(slip.expiresAt).getTime() < Date.now()) {
      delete _storeData[id];
      _saveToDisk();
      return null;
    }
    return slip;
  },

  set(id, slip) {
    if (!slip.expiresAt) {
      slip.expiresAt = new Date(Date.now() + SLIP_TTL_MS).toISOString();
    }
    _storeData[id] = slip;
    _saveToDisk();
    return slip;
  },

  mutate(id, fn) {
    // Read → mutate → write back (for click counting etc.)
    const slip = this.get(id);
    if (!slip) return null;
    fn(slip);
    _storeData[id] = slip;
    _saveToDisk();
    return slip;
  },
};

// Prune expired slips from disk every hour
setInterval(() => {
  const now = Date.now();
  let pruned = 0;
  for (const [id, slip] of Object.entries(_storeData)) {
    if (slip.expiresAt && new Date(slip.expiresAt).getTime() < now) {
      delete _storeData[id];
      pruned++;
    }
  }
  if (pruned > 0) {
    console.log(`[store] Pruned ${pruned} expired slip(s)`);
    _saveToDisk();
  }
}, 60 * 60 * 1000);

console.log(`[store] Loaded ${Object.keys(_storeData).length} slip(s) from disk`);

/* =============================================================================
   DEDUP — prevent double-processing webhook events
============================================================================= */
const processedIds = new Set();

function markProcessed(id) {
  if (processedIds.has(id)) return true;
  processedIds.add(id);
  // Keep set bounded
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

function createSlipId() {
  return crypto.randomBytes(5).toString("hex"); // 10-char hex
}

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
  if (!APP_SECRET) return true; // dev mode — skip
  const sig = req.headers["x-hub-signature-256"];
  if (!sig) return false;
  const expected = "sha256=" + crypto
    .createHmac("sha256", APP_SECRET)
    .update(req.rawBody || "")
    .digest("hex");
  try {
    return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
  } catch {
    return false;
  }
}

/* =============================================================================
   TEAM NAME NORMALIZATION
============================================================================= */
const TEAM_ALIASES = {
  // MLB
  "arizona diamondbacks":  ["arizona diamondbacks", "diamondbacks", "dbacks"],
  "atlanta braves":        ["atlanta braves", "braves"],
  "athletics":             ["athletics", "oakland athletics", "a's", "as"],
  "baltimore orioles":     ["baltimore orioles", "orioles"],
  "boston red sox":        ["boston red sox", "red sox", "bosox"],
  "chicago cubs":          ["chicago cubs", "cubs"],
  "chicago white sox":     ["chicago white sox", "white sox"],
  "cincinnati reds":       ["cincinnati reds", "reds"],
  "cleveland guardians":   ["cleveland guardians", "guardians"],
  "colorado rockies":      ["colorado rockies", "rockies"],
  "detroit tigers":        ["detroit tigers", "tigers"],
  "houston astros":        ["houston astros", "astros"],
  "kansas city royals":    ["kansas city royals", "royals"],
  "los angeles angels":    ["los angeles angels", "angels", "la angels"],
  "los angeles dodgers":   ["los angeles dodgers", "dodgers", "la dodgers"],
  "miami marlins":         ["miami marlins", "marlins"],
  "milwaukee brewers":     ["milwaukee brewers", "brewers"],
  "minnesota twins":       ["minnesota twins", "twins"],
  "new york mets":         ["new york mets", "mets", "ny mets"],
  "new york yankees":      ["new york yankees", "yankees", "ny yankees"],
  "philadelphia phillies": ["philadelphia phillies", "phillies"],
  "pittsburgh pirates":    ["pittsburgh pirates", "pirates"],
  "san diego padres":      ["san diego padres", "padres"],
  "san francisco giants":  ["san francisco giants", "giants", "sf giants"],
  "seattle mariners":      ["seattle mariners", "mariners"],
  "st. louis cardinals":   ["st. louis cardinals", "st louis cardinals", "cardinals"],
  "tampa bay rays":        ["tampa bay rays", "rays"],
  "texas rangers":         ["texas rangers", "rangers"],
  "toronto blue jays":     ["toronto blue jays", "blue jays", "jays"],
  "washington nationals":  ["washington nationals", "nationals", "nats"],
  // NBA
  "atlanta hawks":         ["atlanta hawks", "hawks"],
  "boston celtics":        ["boston celtics", "celtics"],
  "brooklyn nets":         ["brooklyn nets", "nets"],
  "charlotte hornets":     ["charlotte hornets", "hornets"],
  "chicago bulls":         ["chicago bulls", "bulls"],
  "cleveland cavaliers":   ["cleveland cavaliers", "cavaliers", "cavs"],
  "dallas mavericks":      ["dallas mavericks", "mavericks", "mavs"],
  "denver nuggets":        ["denver nuggets", "nuggets"],
  "detroit pistons":       ["detroit pistons", "pistons"],
  "golden state warriors": ["golden state warriors", "warriors", "gsw"],
  "houston rockets":       ["houston rockets", "rockets"],
  "indiana pacers":        ["indiana pacers", "pacers"],
  "los angeles clippers":  ["los angeles clippers", "clippers", "la clippers"],
  "los angeles lakers":    ["los angeles lakers", "lakers", "la lakers"],
  "memphis grizzlies":     ["memphis grizzlies", "grizzlies"],
  "miami heat":            ["miami heat", "heat"],
  "milwaukee bucks":       ["milwaukee bucks", "bucks"],
  "minnesota timberwolves":["minnesota timberwolves", "timberwolves", "wolves"],
  "new orleans pelicans":  ["new orleans pelicans", "pelicans"],
  "new york knicks":       ["new york knicks", "knicks"],
  "oklahoma city thunder": ["oklahoma city thunder", "thunder", "okc"],
  "orlando magic":         ["orlando magic", "magic"],
  "philadelphia 76ers":    ["philadelphia 76ers", "76ers", "sixers"],
  "phoenix suns":          ["phoenix suns", "suns"],
  "portland trail blazers":["portland trail blazers", "trail blazers", "blazers"],
  "sacramento kings":      ["sacramento kings", "kings"],
  "san antonio spurs":     ["san antonio spurs", "spurs"],
  "toronto raptors":       ["toronto raptors", "raptors"],
  "utah jazz":             ["utah jazz", "jazz"],
  "washington wizards":    ["washington wizards", "wizards"],
  // NFL
  "arizona cardinals":     ["arizona cardinals", "cardinals", "az cardinals"],
  "atlanta falcons":       ["atlanta falcons", "falcons"],
  "baltimore ravens":      ["baltimore ravens", "ravens"],
  "buffalo bills":         ["buffalo bills", "bills"],
  "carolina panthers":     ["carolina panthers", "panthers"],
  "chicago bears":         ["chicago bears", "bears"],
  "cincinnati bengals":    ["cincinnati bengals", "bengals"],
  "cleveland browns":      ["cleveland browns", "browns"],
  "dallas cowboys":        ["dallas cowboys", "cowboys"],
  "denver broncos":        ["denver broncos", "broncos"],
  "detroit lions":         ["detroit lions", "lions"],
  "green bay packers":     ["green bay packers", "packers"],
  "houston texans":        ["houston texans", "texans"],
  "indianapolis colts":    ["indianapolis colts", "colts"],
  "jacksonville jaguars":  ["jacksonville jaguars", "jaguars", "jags"],
  "kansas city chiefs":    ["kansas city chiefs", "chiefs"],
  "las vegas raiders":     ["las vegas raiders", "raiders"],
  "los angeles chargers":  ["los angeles chargers", "chargers", "la chargers"],
  "los angeles rams":      ["los angeles rams", "rams", "la rams"],
  "miami dolphins":        ["miami dolphins", "dolphins"],
  "minnesota vikings":     ["minnesota vikings", "vikings"],
  "new england patriots":  ["new england patriots", "patriots", "pats"],
  "new orleans saints":    ["new orleans saints", "saints"],
  "new york giants":       ["new york giants", "giants", "ny giants"],
  "new york jets":         ["new york jets", "jets"],
  "philadelphia eagles":   ["philadelphia eagles", "eagles"],
  "pittsburgh steelers":   ["pittsburgh steelers", "steelers"],
  "san francisco 49ers":   ["san francisco 49ers", "49ers", "niners"],
  "seattle seahawks":      ["seattle seahawks", "seahawks"],
  "tampa bay buccaneers":  ["tampa bay buccaneers", "buccaneers", "bucs"],
  "tennessee titans":      ["tennessee titans", "titans"],
  "washington commanders": ["washington commanders", "commanders"],
};

function canonicalizeTeam(team) {
  const t = norm(team);
  for (const [canonical, aliases] of Object.entries(TEAM_ALIASES)) {
    if (aliases.some((a) => t === norm(a) || t.includes(norm(a)) || norm(a).includes(t))) {
      return canonical;
    }
  }
  return t;
}

/* =============================================================================
   OPENAI — GPT-4o VISION PARSER
============================================================================= */
const PARSE_PROMPT = `You are a sports betting slip parser. Extract ALL betting legs from this slip.

For each leg return a JSON object with:
- "team": selected team name (for moneylines/spreads) OR null for props
- "player": player name (for player props) OR null
- "market": bet type with line — e.g. "Moneyline", "Spread -6.5", "Over 295.5 Passing Yards", "Anytime TD Scorer"
- "selection": exactly what was selected — e.g. "Chiefs ML", "Over", "Ravens +6.5", "Yes"
- "odds": American odds string — e.g. "-160", "+250" — omit if not visible
- "sport": sport code — NFL, NBA, MLB, NHL, NCAAF, NCAAB, Soccer, or Other

RULES:
- Return ONLY a valid JSON array, no markdown, no explanation
- Extract EVERY leg even if partially visible
- For same-game parlays, list each leg separately
- Never return both teams for a moneyline — only the SELECTED side
- Player props: put player name in "player", leave "team" null
- If you see "Seattle Mariners @ San Diego Padres" and Mariners is highlighted, return team: "Seattle Mariners"

Example output:
[
  {"team":"Kansas City Chiefs","market":"Moneyline","selection":"Chiefs ML","odds":"-160","sport":"NFL"},
  {"player":"Patrick Mahomes","market":"Over 295.5 Passing Yards","selection":"Over","odds":"-115","sport":"NFL"},
  {"team":"Los Angeles Lakers","market":"Spread +4.5","selection":"Lakers +4.5","odds":"-110","sport":"NBA"}
]`;

async function parseSlipImage(imageUrl) {
  if (!OPENAI_KEY) {
    // Demo mode — return mock legs so the UI is always testable
    return [
      { team: "Kansas City Chiefs", market: "Moneyline",              selection: "Chiefs ML",    odds: "-160", sport: "NFL" },
      { player: "Patrick Mahomes",  market: "Over 295.5 Pass. Yards", selection: "Over",         odds: "-115", sport: "NFL" },
      { team: "Los Angeles Lakers", market: "Spread +4.5",            selection: "Lakers +4.5",  odds: "-110", sport: "NBA" },
    ];
  }

  try {
    const resp = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${OPENAI_KEY}` },
      body: JSON.stringify({
        model: "gpt-4o",
        max_tokens: 1500,
        temperature: 0.1,
        messages: [
          { role: "system", content: PARSE_PROMPT },
          { role: "user", content: [{ type: "image_url", image_url: { url: imageUrl, detail: "high" } }] },
        ],
      }),
    });
    const data = await resp.json();
    const raw  = data.choices?.[0]?.message?.content || "[]";
    const cleaned = raw.replace(/```json?\n?/g, "").replace(/```/g, "").trim();
    const legs = JSON.parse(cleaned);
    return Array.isArray(legs) ? legs.filter((l) => l.market && l.selection) : [];
  } catch (e) {
    console.error("[openai] image parse error:", e.message);
    return [];
  }
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
    const data = await resp.json();
    const raw  = data.choices?.[0]?.message?.content || "[]";
    const cleaned = raw.replace(/```json?\n?/g, "").replace(/```/g, "").trim();
    const legs = JSON.parse(cleaned);
    return Array.isArray(legs) ? legs.filter((l) => l.market && l.selection) : [];
  } catch (e) {
    console.error("[openai] text parse error:", e.message);
    return [];
  }
}

/* =============================================================================
   ODDS API — MULTI-SPORT EVENT LOOKUP
============================================================================= */
const SPORT_KEYS = {
  NFL:   "americanfootball_nfl",
  NBA:   "basketball_nba",
  MLB:   "baseball_mlb",
  NHL:   "icehockey_nhl",
  NCAAF: "americanfootball_ncaaf",
  NCAAB: "basketball_ncaab",
};

async function fetchOddsEvents(sportCode) {
  if (!ODDS_KEY) return [];
  const sportKey = SPORT_KEYS[sportCode?.toUpperCase()] || "baseball_mlb";
  try {
    const resp = await fetch(
      `https://api.the-odds-api.com/v4/sports/${sportKey}/odds` +
      `?apiKey=${ODDS_KEY}&regions=us&markets=h2h&oddsFormat=american&includeLinks=true`
    );
    if (!resp.ok) return [];
    const data = await resp.json();
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

function findMatchingEvent(teamName, events) {
  const target = canonicalizeTeam(teamName);
  for (const ev of events) {
    const home = canonicalizeTeam(ev.home_team);
    const away = canonicalizeTeam(ev.away_team);
    if (
      home === target || away === target ||
      home.includes(target) || away.includes(target) ||
      target.includes(home) || target.includes(away)
    ) {
      return ev;
    }
  }
  return null;
}

/* =============================================================================
   DEEP LINK BUILDERS
============================================================================= */
function buildLinks(enrichedLegs) {
  return {
    fanduel:    buildFanDuelLink(enrichedLegs),
    draftkings: buildDraftKingsLink(enrichedLegs),
    betmgm:     buildBetMGMLink(enrichedLegs),
    caesars:    "https://www.caesars.com/sportsbook-and-casino",
    bet365:     "https://www.bet365.com",
    espnbet:    "https://espnbet.com",
    pointsbet:  "https://pointsbet.com",
    barstool:   "https://www.barstoolsportsbook.com",
  };
}

function buildFanDuelLink(legs) {
  const links = legs.flatMap((l) => {
    if (!l.oddsEvent) return [];
    const book = l.oddsEvent.bookmakers?.find((b) => b.key === "fanduel");
    if (!book) return [];
    const market = book.markets?.find((m) => m.key === "h2h");
    if (!market) return [];
    const outcome = market.outcomes?.find(
      (o) => canonicalizeTeam(o.name) === canonicalizeTeam(l.team || l.selection)
    );
    return outcome?.link ? [outcome.link] : [];
  });

  if (links.length > 0 && links.length === legs.filter((l) => l.team).length) {
    return links.length === 1
      ? links[0]
      : `https://sportsbook.fanduel.com/parlay-hub?legs=${encodeURIComponent(links.join(","))}`;
  }
  return legs.length === 1
    ? "https://sportsbook.fanduel.com"
    : "https://sportsbook.fanduel.com/parlay-hub";
}

function buildDraftKingsLink(legs) {
  const links = legs.flatMap((l) => {
    if (!l.oddsEvent) return [];
    const book = l.oddsEvent.bookmakers?.find((b) => b.key === "draftkings");
    if (!book) return [];
    const market = book.markets?.find((m) => m.key === "h2h");
    if (!market) return [];
    const outcome = market.outcomes?.find(
      (o) => canonicalizeTeam(o.name) === canonicalizeTeam(l.team || l.selection)
    );
    return outcome?.link ? [outcome.link] : [];
  });
  return links.length > 0 ? links[0] : "https://sportsbook.draftkings.com";
}

function buildBetMGMLink(legs) {
  // Try Odds API link first
  const links = legs.flatMap((l) => {
    if (!l.oddsEvent) return [];
    const book = l.oddsEvent.bookmakers?.find((b) => b.key === "betmgm");
    return book?.link ? [book.link] : [];
  });
  if (links.length > 0) return links[0];

  // Fallback: native tuple map (add matchups here as you collect them)
  const nativeMap = {
    "arizona diamondbacks @ baltimore orioles": {
      fixtureId: "e7bc40f9611b8baa6328e83959820910",
      marketId:  "MGM_MARKET_MONEYLINE",
      options: {
        "baltimore orioles":    "MGM_OPTION_ORIOLES_ML",
        "arizona diamondbacks": "MGM_OPTION_DIAMONDBACKS_ML",
      },
    },
  };
  const tuples = [];
  for (const leg of legs) {
    if (!leg.home || !leg.away) continue;
    const key     = `${norm(leg.away)} @ ${norm(leg.home)}`;
    const matchup = nativeMap[key];
    if (!matchup) continue;
    const optionId = matchup.options?.[canonicalizeTeam(leg.team)];
    if (!optionId) continue;
    tuples.push(`${matchup.fixtureId}-${matchup.marketId}-${optionId}`);
  }
  return tuples.length
    ? `https://sports.betmgm.com/en/sports?options=${encodeURIComponent(tuples.join(","))}`
    : "https://sports.betmgm.com";
}

/* =============================================================================
   CORE SLIP PIPELINE
   parse → enrich with Odds API → build links → persist to disk
============================================================================= */
async function processSlip({ imageUrl, text, platform, userId }) {
  // 1. Parse with GPT-4o
  const legs = imageUrl
    ? await parseSlipImage(imageUrl)
    : await parseSlipText(text || "");

  if (!legs || legs.length === 0) return null;

  // 2. Group by sport and fetch events in parallel (minimises Odds API calls)
  const sportGroups = {};
  for (const leg of legs) {
    const sport = (leg.sport || "MLB").toUpperCase();
    if (!sportGroups[sport]) sportGroups[sport] = [];
    sportGroups[sport].push(leg);
  }

  const allEvents = {};
  await Promise.all(
    Object.keys(sportGroups).map(async (sport) => {
      allEvents[sport] = await fetchOddsEvents(sport);
    })
  );

  // 3. Enrich each leg with matched event data
  const enrichedLegs = legs.map((leg) => {
    const sport    = (leg.sport || "MLB").toUpperCase();
    const events   = allEvents[sport] || [];
    const teamName = leg.team || leg.selection;
    const ev       = teamName ? findMatchingEvent(teamName, events) : null;
    return {
      ...leg,
      team:      clean(leg.team   || ""),
      player:    clean(leg.player || ""),
      oddsEvent: ev || null,
      eventId:   ev?.id         || null,
      home:      ev?.home_team  || null,
      away:      ev?.away_team  || null,
    };
  });

  // 4. Build sportsbook links
  const links = buildLinks(enrichedLegs);

  // 5. Strip the large oddsEvent object before storing
  const storedLegs = enrichedLegs.map(({ oddsEvent, ...rest }) => rest);

  // 6. Persist to disk
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
  return { slipId, slipUrl, legs: storedLegs, links };
}

/* =============================================================================
   MESSENGER SEND API
============================================================================= */
async function sendMessage(psid, text) {
  const chunks = splitChunks(String(text || ""));
  for (const chunk of chunks) {
    await fetch(`${GRAPH}/${PAGE_ID}/messages?access_token=${PAGE_TOKEN}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        recipient:      { id: psid },
        message:        { text: chunk },
        messaging_type: "RESPONSE",
      }),
    }).catch((e) => console.error("[send] error:", e.message));
  }
}

async function sendSlipCard(psid, slipUrl, legCount) {
  const resp = await fetch(`${GRAPH}/${PAGE_ID}/messages?access_token=${PAGE_TOKEN}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      recipient:      { id: psid },
      messaging_type: "RESPONSE",
      message: {
        attachment: {
          type: "template",
          payload: {
            template_type: "button",
            text: `🎯 Your ${legCount}-leg slip is ready! Choose your sportsbook and it's pre-loaded:`,
            buttons: [{
              type:                 "web_url",
              url:                  slipUrl,
              title:                "Copy My Slip →",
              webview_height_ratio: "tall",
              messenger_extensions: false,
            }],
          },
        },
      },
    }),
  });

  if (!resp.ok) {
    // Fallback to plain text if button template fails (e.g. missing permissions)
    await sendMessage(
      psid,
      `🎯 Slip ready!\n\nChoose your sportsbook to copy all ${legCount} leg${legCount !== 1 ? "s" : ""}:\n${slipUrl}`
    );
  }
}

/* =============================================================================
   GRAPH API — PAGE COMMENT REPLY
============================================================================= */
async function replyToComment(commentId, message) {
  await fetch(`${GRAPH}/${commentId}/replies?access_token=${PAGE_TOKEN}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message }),
  }).catch((e) => console.error("[comment reply] error:", e.message));
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
   ROUTES
============================================================================= */
app.get("/", (_req, res) => res.send("Sharp Network AI — running ✅"));

// Meta webhook verification handshake
app.get("/webhook", (req, res) => {
  if (req.query["hub.verify_token"] === VERIFY_TOKEN) {
    return res.send(req.query["hub.challenge"]);
  }
  res.sendStatus(403);
});

// Serve the slip page HTML shell
app.get("/s/:slipId", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "slip.html"));
});

// Slip data API — called by slip.html on load
app.get("/api/slip/:slipId", (req, res) => {
  const slip = slipStore.get(req.params.slipId);
  if (!slip) {
    return res.status(404).json({ success: false, error: "Slip not found or expired" });
  }
  return res.json({ success: true, slip });
});

// Click tracking — called by slip.html when user taps a sportsbook button
app.post("/api/slip/:slipId/click/:book", (req, res) => {
  const slip = slipStore.mutate(req.params.slipId, (s) => {
    s.clickCount = (s.clickCount || 0) + 1;
    s.bookClicks = s.bookClicks || {};
    s.bookClicks[req.params.book] = (s.bookClicks[req.params.book] || 0) + 1;
  });
  if (!slip) {
    return res.status(404).json({ success: false, error: "Not found" });
  }
  const link = slip.links?.[req.params.book] || "https://sportsbook.fanduel.com";
  return res.json({ success: true, link });
});

/* =============================================================================
   WEBHOOK — MAIN HANDLER
============================================================================= */
app.post("/webhook", async (req, res) => {
  // ACK immediately — Meta requires 200 within 20 seconds
  res.sendStatus(200);

  if (!verifySignature(req)) {
    console.warn("[webhook] invalid signature — ignoring");
    return;
  }

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
      const imgAtt   = (event.message.attachments || []).find((a) => a.type === "image");
      const imageUrl = imgAtt?.payload?.url || null;

      console.log(`[messenger] from ${senderId} — image: ${!!imageUrl}, text: "${text.slice(0, 60)}"`);

      if (!imageUrl && !text.trim()) {
        await sendMessage(senderId, "Hey! Send me a betting slip screenshot 📸 and Sharp Network AI will create a link to copy it into any sportsbook instantly.");
        continue;
      }

      const result = await processSlip({ imageUrl, text, platform: "messenger", userId: senderId });

      if (!result) {
        await sendMessage(senderId,
          "Sharp Network AI couldn't read any betting legs from that image. Try a clearer screenshot showing the full slip."
        );
        continue;
      }

      await sendSlipCard(senderId, result.slipUrl, result.legs.length);
    }

    // ── PAGE FEED — COMMENT TRIGGER ─────────────────────────────────────────
    for (const change of (entry.changes || [])) {
      if (change.field !== "feed") continue;
      const v = change.value;
      if (v?.item !== "comment" || v?.verb !== "add") continue;

      const commentId  = v.comment_id;
      const postId     = v.post_id;
      const senderId   = v.sender_id;
      const senderName = v.sender_name || "";
      const msgText    = (v.message   || "").toLowerCase();

      if (!commentId || !postId)          continue;
      if (markProcessed(commentId))       continue;
      if (senderId === PAGE_ID)           continue; // don't reply to own comments
      if (!msgText.includes(TRIGGER_KW))  continue; // keyword gate

      console.log(`[feed] comment from @${senderName} on post ${postId}`);

      const imageUrl = await fetchPostImageUrl(postId);
      const result   = await processSlip({
        imageUrl,
        text:     v.message || "",
        platform: "facebook",
        userId:   senderId,
      });

      if (!result) {
        await replyToComment(commentId,
          `Hey ${senderName}! Sharp Network AI couldn't find a betting slip in this post. ` +
          `Make sure there's a clear screenshot in the image above. 📋`
        );
        continue;
      }

      const { slipUrl, legs } = result;
      const legWord     = legs.length === 1 ? "leg"   : "legs";
      const parlayLabel = legs.length === 1 ? "slip"  : `${legs.length}-leg parlay`;

      await replyToComment(commentId,
        `Hey ${senderName}! ⚡ Sharp Network AI locked in your ${parlayLabel} (${legs.length} ${legWord}).\n\n` +
        `Pick your sportsbook — slip is pre-loaded:\n${slipUrl}\n\n` +
        `(FanDuel · DraftKings · BetMGM · Caesars + more)`
      );
    }
  }
});

/* =============================================================================
   START
============================================================================= */
app.listen(PORT, () => console.log(`Sharp Network AI running on :${PORT}`));
