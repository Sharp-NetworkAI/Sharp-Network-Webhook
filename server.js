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
  }
  return null;
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

function teamAliasMap() {
  return {
    "new york yankees": ["new york yankees", "yankees", "nyy"],
    "san francisco giants": ["san francisco giants", "giants"],
    "los angeles dodgers": ["los angeles dodgers", "dodgers"],
    "chicago cubs": ["chicago cubs", "cubs"],
    "atlanta braves": ["atlanta braves", "braves"],
    "cincinnati reds": ["cincinnati reds", "reds"],
    "milwaukee brewers": ["milwaukee brewers", "brewers"],
    "st. louis cardinals": ["st louis cardinals", "cardinals"],
    "new york mets": ["new york mets", "mets"],
    "philadelphia phillies": ["philadelphia phillies", "phillies"],
    "boston red sox": ["boston red sox", "red sox"],
    "baltimore orioles": ["baltimore orioles", "orioles"],
    "cleveland guardians": ["cleveland guardians", "guardians"],
    "minnesota twins": ["minnesota twins", "twins"],
    "houston astros": ["houston astros", "astros"],
    "los angeles angels": ["los angeles angels", "angels"],
    "arizona diamondbacks": ["arizona diamondbacks", "diamondbacks"],
    "washington nationals": ["washington nationals", "nationals"],
    "seattle mariners": ["seattle mariners", "mariners"],
    "kansas city royals": ["kansas city royals", "royals"],
    "toronto blue jays": ["toronto blue jays", "blue jays"],
    "pittsburgh pirates": ["pittsburgh pirates", "pirates"],
    "tampa bay rays": ["tampa bay rays", "rays"],
    "texas rangers": ["texas rangers", "rangers"],
    "miami marlins": ["miami marlins", "marlins"],
    "athletics": ["athletics"],
    "san diego padres": ["san diego padres", "padres"],
    "colorado rockies": ["colorado rockies", "rockies"],
    "chicago white sox": ["chicago white sox", "white sox"]
  };
}

function canonicalizeTeamName(text) {
  const s = slug(text);
  const aliases = teamAliasMap();

  for (const [canonical, names] of Object.entries(aliases)) {
    if (names.some((name) => s.includes(slug(name)))) {
      return canonical;
    }
  }

  return "";
}

function extractTeamsFromLegEvent(eventText) {
  const text = slug(stripPitchers(eventText));
  const aliases = teamAliasMap();
  const matches = [];

  for (const [canonical, names] of Object.entries(aliases)) {
    if (names.some((name) => text.includes(slug(name)))) {
      matches.push(canonical);
    }
  }

  return [...new Set(matches)];
}

async function fetchOddsApiMLBEvents() {
  if (!ODDS_API_KEY) return { success: false, data: [] };

  const resp = await fetch(
    `https://api.the-odds-api.com/v4/sports/baseball_mlb/odds?apiKey=${ODDS_API_KEY}&regions=us&markets=h2h`
  );

  const data = await resp.json().catch(() => []);
  return { success: true, data };
}

function extractEventTeamsFromOddsApiEvent(e) {
  return [
    canonicalizeTeamName(e.home_team),
    canonicalizeTeamName(e.away_team)
  ].filter(Boolean);
}

async function resolveLeg(leg, oddsData) {
  const wantedTeams = extractTeamsFromLegEvent(leg.event);

  for (const event of oddsData.data) {
    const teams = extractEventTeamsFromOddsApiEvent(event);

    if (wantedTeams.every((t) => teams.includes(t))) {
      return {
        ...leg,
        fixtureId: event.id,
        marketId: "MGM_MARKET_MONEYLINE",
        optionId: `MGM_OPTION_${leg.participant.toUpperCase().replace(/ /g, "_")}_ML`,
        resolverNote: "",
        wantedTeams,
        matchedTeams: teams
      };
    }
  }

  return {
    ...leg,
    fixtureId: "NOT_FOUND",
    marketId: "NOT_FOUND",
    optionId: "NOT_FOUND",
    resolverNote: "No match",
    wantedTeams
  };
}

function buildBetMGMBetslip(resolvedLegs) {
  return {
    sportsbook: "BetMGM",
    type: "sgp",
    legs: resolvedLegs.map((l) => ({
      fixtureId: l.fixtureId,
      marketId: l.marketId,
      optionId: l.optionId
    }))
  };
}

function buildBetMGMDeepLink(resolvedLegs) {
  const valid = resolvedLegs.filter((l) => l.fixtureId !== "NOT_FOUND");

  if (!valid.length) return null;

  const str = valid
    .map((l) => `${l.fixtureId}-${l.marketId}-${l.optionId}`)
    .join(",");

  return `https://sports.betmgm.com/en/sports?options=${encodeURIComponent(str)}`;
}

function buildDebug(resolved) {
  return resolved
    .map(
      (l, i) =>
        `${i + 1}. ${l.participant}
fixtureId: ${l.fixtureId}
wanted: ${(l.wantedTeams || []).join(", ")}`
    )
    .join("\n\n");
}

async function sendMessage(id, text) {
  const chunks = splitIntoChunks(text);

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

app.post("/webhook", async (req, res) => {
  try {
    const entry = req.body.entry || [];

    for (const e of entry) {
      for (const m of e.messaging || []) {
        const sender = m.sender.id;
        const text = m.message?.text;

        if (text === "BetMGM") {
          const saved = userSlipStore[sender];
          if (!saved) return;

          const odds = await fetchOddsApiMLBEvents();

          const resolved = [];
          for (const leg of saved.legs) {
            resolved.push(await resolveLeg(leg, odds));
          }

          const slip = buildBetMGMBetslip(resolved);
          const link = buildBetMGMDeepLink(resolved);

          await sendMessage(
            sender,
            JSON.stringify(slip, null, 2) + "\n\n" + (link || "")
          );
        } else {
          await sendMessage(sender, "Send slip image");
        }
      }
    }

    res.sendStatus(200);
  } catch (e) {
    console.error(e);
    res.sendStatus(500);
  }
});

app.listen(PORT, () => console.log("running"));
