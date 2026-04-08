const express = require("express");
const path = require("path");

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const PORT = process.env.PORT || 3000;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || "";
const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN || "";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const ODDS_API_KEY = process.env.ODDS_API_KEY || "";

const userSlipStore = {};
const publicSlipStore = {};

let oddsCache = {
  fetchedAt: 0,
  data: []
};

const ODDS_CACHE_TTL_MS = 60 * 1000;

/* =========================
   HELPERS
========================= */
function safeParseJSON(text) {
  try {
    return JSON.parse(text);
  } catch {
    const match = String(text || "").match(/\{[\s\S]*\}/);
    if (match) {
      try {
        return JSON.parse(match[0]);
      } catch {}
    }
    return null;
  }
}

function clean(v) {
  return String(v || "").replace(/\s+/g, " ").trim();
}

function slug(text) {
  return clean(text)
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function stripPitchers(eventText) {
  return clean(eventText)
    .replace(/\([^)]*\)/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function splitIntoChunks(text, maxLen = 1800) {
  if (text.length <= maxLen) return [text];
  const chunks = [];
  for (let i = 0; i < text.length; i += maxLen) {
    chunks.push(text.slice(i, i + maxLen));
  }
  return chunks;
}

function containsAliasPhrase(haystack, alias) {
  const h = ` ${slug(haystack)} `;
  const a = ` ${slug(alias)} `;
  return h.includes(a);
}

/* 🔥 NEW */
function createSlipId() {
  return Math.random().toString(36).slice(2, 10);
}

/* =========================
   TEAM MATCHING
========================= */
function teamAliasMap() {
  return {
    "new york yankees": ["new york yankees", "yankees"],
    "san francisco giants": ["san francisco giants", "giants"],
    "los angeles dodgers": ["los angeles dodgers", "dodgers"],
    "chicago cubs": ["chicago cubs", "cubs"],
    "atlanta braves": ["atlanta braves", "braves"],
    "cincinnati reds": ["cincinnati reds", "reds"],
    "milwaukee brewers": ["milwaukee brewers", "brewers"],
    "st. louis cardinals": ["st. louis cardinals", "cardinals"],
    "detroit tigers": ["detroit tigers", "tigers"],
    "new york mets": ["new york mets", "mets"],
    "philadelphia phillies": ["philadelphia phillies", "phillies"],
    "boston red sox": ["boston red sox", "red sox"],
    "baltimore orioles": ["baltimore orioles", "orioles"],
    "cleveland guardians": ["cleveland guardians", "guardians"],
    "minnesota twins": ["minnesota twins", "twins"],
    "houston astros": ["houston astros", "astros"],
    "los angeles angels": ["los angeles angels", "angels"],
    "arizona diamondbacks": ["diamondbacks"],
    "washington nationals": ["nationals"],
    "seattle mariners": ["mariners"],
    "kansas city royals": ["royals"],
    "toronto blue jays": ["blue jays"],
    "pittsburgh pirates": ["pirates"],
    "tampa bay rays": ["rays"],
    "texas rangers": ["rangers"],
    "miami marlins": ["marlins"],
    "athletics": ["athletics"],
    "san diego padres": ["padres"],
    "colorado rockies": ["rockies"],
    "chicago white sox": ["white sox"]
  };
}

function canonicalizeTeamName(text) {
  const aliases = teamAliasMap();
  for (const [canonical, names] of Object.entries(aliases)) {
    if (names.some((name) => containsAliasPhrase(text, name))) {
      return canonical;
    }
  }
  return "";
}

function extractTeamsFromLegEvent(eventText) {
  const text = stripPitchers(eventText);
  const aliases = teamAliasMap();
  const matches = [];

  for (const [canonical, names] of Object.entries(aliases)) {
    if (names.some((name) => containsAliasPhrase(text, name))) {
      matches.push(canonical);
    }
  }

  return [...new Set(matches)];
}

/* =========================
   DEEP LINK BUILDER
========================= */
function buildBetMGMDeepLink(resolvedLegs) {
  const valid = resolvedLegs.filter(
    (l) =>
      l.fixtureId !== "NOT_FOUND" &&
      l.marketId !== "NOT_FOUND" &&
      l.optionId !== "NOT_FOUND"
  );

  if (!valid.length) return null;

  const str = valid
    .map((l) => `${l.fixtureId}-${l.marketId}-${l.optionId}`)
    .join(",");

  return `https://sports.betmgm.com/en/sports?options=${encodeURIComponent(str)}`;
}

/* =========================
   SEND MESSAGE
========================= */
async function sendMessage(id, text) {
  const chunks = splitIntoChunks(String(text || ""));

  for (const chunk of chunks) {
    await fetch(
      `https://graph.facebook.com/v18.0/me/messages?access_token=${PAGE_ACCESS_TOKEN}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          recipient: { id },
          message: { text: chunk }
        })
      }
    );
  }
}

/* =========================
   ROUTES
========================= */
app.get("/s/:slipId", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "slip.html"));
});

app.get("/", (_req, res) => {
  res.send("running");
});

app.get("/webhook", (req, res) => {
  if (req.query["hub.verify_token"] === VERIFY_TOKEN) {
    return res.send(req.query["hub.challenge"]);
  }
  res.sendStatus(403);
});

/* =========================
   WEBHOOK
========================= */
app.post("/webhook", async (req, res) => {
  try {
    const entries = req.body?.entry || [];

    for (const entry of entries) {
      for (const event of entry.messaging || []) {
        const sender = event.sender.id;

        let imageUrl = null;
        if (event.message?.attachments) {
          const img = event.message.attachments.find(a => a.type === "image");
          if (img?.payload?.url) imageUrl = img.payload.url;
        }

        // ===== IMAGE RECEIVED =====
        if (imageUrl) {
          // simulate parsed + resolved slip for now
          const resolved = [
            { participant: "Kansas City Royals", fixtureId: "abc", marketId: "MGM_MARKET_MONEYLINE", optionId: "MGM_OPTION_ROYALS_ML" }
          ];

          // 🔥 CREATE SLIP ID
          const slipId = createSlipId();

          // 🔥 STORE IT
          publicSlipStore[slipId] = {
            legs: resolved
          };

          // 🔥 SEND LINK
          await sendMessage(
            sender,
            `Slip ready ✅\n\nhttps://your-render-url.onrender.com/s/${slipId}`
          );

          continue;
        }

        await sendMessage(sender, "Send a slip image 📸");
      }
    }

    res.sendStatus(200);
  } catch (e) {
    console.error(e);
    res.sendStatus(500);
  }
});

app.listen(PORT, () => console.log("running"));
