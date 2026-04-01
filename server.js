const express = require("express");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || "sharpnetworkbot";
const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const ODDS_API_KEY = process.env.ODDS_API_KEY;

const userSlipStore = {};

let oddsCache = {
  fetchedAt: 0,
  data: []
};

const ODDS_CACHE_TTL_MS = 60 * 1000;

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

function teamAliasMap() {
  return {
    "baltimore orioles": ["orioles", "baltimore orioles", "bal"],
    "texas rangers": ["rangers", "texas rangers", "tex"],
    "miami marlins": ["marlins", "miami marlins", "mia"],
    "chicago white sox": ["white sox", "cws"],
    "pittsburgh pirates": ["pirates", "pit"],
    "cincinnati reds": ["reds", "cin"],
    "philadelphia phillies": ["phillies", "phi"],
    "washington nationals": ["nationals", "nats", "was"],
    "houston astros": ["astros", "hou"],
    "boston red sox": ["red sox", "bos"]
  };
}

function extractTeams(eventText) {
  const text = slug(stripPitchers(eventText));
  const aliases = teamAliasMap();
  const found = [];

  for (const [team, names] of Object.entries(aliases)) {
    if (names.some(n => text.includes(slug(n)))) {
      found.push(team);
    }
  }

  return [...new Set(found)];
}
async function fetchOdds() {
  const now = Date.now();

  if (oddsCache.data.length && now - oddsCache.fetchedAt < ODDS_CACHE_TTL_MS) {
    return oddsCache.data;
  }

  const url = `https://api.the-odds-api.com/v4/sports/baseball_mlb/odds?apiKey=${ODDS_API_KEY}&regions=us&markets=h2h`;

  const res = await fetch(url);
  const data = await res.json();

  oddsCache = {
    fetchedAt: now,
    data
  };

  return data;
}

async function resolveLeg(leg) {
  const teams = extractTeams(leg.event);

  if (teams.length < 2) {
    return { ...leg, fixtureId: "NOT_FOUND" };
  }

  const odds = await fetchOdds();

  for (const game of odds) {
    const home = slug(game.home_team);
    const away = slug(game.away_team);

    if (
      teams.every(t =>
        home.includes(slug(t)) || away.includes(slug(t))
      )
    ) {
      return {
        ...leg,
        fixtureId: game.id,
        marketId: "MGM_MARKET_MONEYLINE",
        optionId: `MGM_OPTION_${leg.participant.toUpperCase().replace(/\s/g, "_")}_ML`
      };
    }
  }

  return { ...leg, fixtureId: "NOT_FOUND" };
}

async function sendMessage(id, text) {
  await fetch(`https://graph.facebook.com/v18.0/me/messages?access_token=${PAGE_ACCESS_TOKEN}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      recipient: { id },
      message: { text }
    })
  });
}

app.post("/webhook", async (req, res) => {
  const msg = req.body.entry?.[0]?.messaging?.[0];

  if (!msg) return res.sendStatus(200);

  const sender = msg.sender.id;
  const text = msg.message?.text;

  if (text === "test") {
    await sendMessage(sender, "working ✅");
  }

  res.sendStatus(200);
});

app.listen(PORT, () => console.log("running"));
