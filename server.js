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

/* =========================
   TEAM MATCHING
========================= */
function teamAliasMap() {
  return {
    "new york yankees": ["new york yankees", "yankees", "nyy"],
    "san francisco giants": ["san francisco giants", "giants"],
    "los angeles dodgers": ["los angeles dodgers", "dodgers"],
    "chicago cubs": ["chicago cubs", "cubs"],
    "atlanta braves": ["atlanta braves", "braves"],
    "cincinnati reds": ["cincinnati reds", "reds"],
    "milwaukee brewers": ["milwaukee brewers", "brewers"],
    "st. louis cardinals": ["st louis cardinals", "st. louis cardinals", "cardinals"],
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
    "athletics": ["athletics", "oakland athletics"],
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

function normalizeMarketType(market = "") {
  const m = clean(market).toLowerCase();

  if (m.includes("home run")) return "player_home_run";
  if (m.includes("total bases")) return "player_total_bases";
  if (m.includes("moneyline")) return "moneyline";

  return m;
}

function extractLine(market = "") {
  const match = clean(market).match(/(\d+)\+/);
  return match ? `${match[1]}+` : "";
}

function normalizeLeg(leg, fallbackEvent = "") {
  return {
    event: clean(leg.event || fallbackEvent),
    participant: clean(leg.selection),
    marketType: normalizeMarketType(leg.market),
    line: extractLine(leg.market),
    rawMarket: clean(leg.market)
  };
}

/* =========================
   MOCK OPTIONS
========================= */
function getMockBetMGMOptions() {
  return [
    {
      marketId: "MGM_MARKET_HR",
      options: [
        { optionId: "MGM_OPTION_HELIOT_RAMOS_HR", participant: "Heliot Ramos" },
        { optionId: "MGM_OPTION_AUSTIN_WELLS_HR", participant: "Austin Wells" },
        { optionId: "MGM_OPTION_MICHAEL_BUSCH_HR", participant: "Michael Busch" },
        { optionId: "MGM_OPTION_ELLY_DE_LA_CRUZ_HR", participant: "Elly De La Cruz" },
        { optionId: "MGM_OPTION_RONALD_ACUNA_JR_HR", participant: "Ronald Acuna Jr." }
      ]
    },
    {
      marketId: "MGM_MARKET_TOTAL_BASES",
      options: [
        {
          optionId: "MGM_OPTION_LUIS_ARRAEZ_TOTAL_BASES_2_PLUS",
          participant: "Luis Arraez",
          line: "2+"
        }
      ]
    },
    {
      marketId: "MGM_MARKET_MONEYLINE",
      options: [
        { optionId: "MGM_OPTION_ORIOLES_ML", participant: "Baltimore Orioles" },
        { optionId: "MGM_OPTION_WHITE_SOX_ML", participant: "Chicago White Sox" },
        { optionId: "MGM_OPTION_PIRATES_ML", participant: "Pittsburgh Pirates" },
        { optionId: "MGM_OPTION_PHILLIES_ML", participant: "Philadelphia Phillies" },
        { optionId: "MGM_OPTION_BLUE_JAYS_ML", participant: "Toronto Blue Jays" },
        { optionId: "MGM_OPTION_BRAVES_ML", participant: "Atlanta Braves" },
        { optionId: "MGM_OPTION_CUBS_ML", participant: "Chicago Cubs" },
        { optionId: "MGM_OPTION_BREWERS_ML", participant: "Milwaukee Brewers" },
        { optionId: "MGM_OPTION_METS_ML", participant: "New York Mets" },
        { optionId: "MGM_OPTION_ASTROS_ML", participant: "Houston Astros" },
        { optionId: "MGM_OPTION_YANKEES_ML", participant: "New York Yankees" },
        { optionId: "MGM_OPTION_GIANTS_ML", participant: "San Francisco Giants" },
        { optionId: "MGM_OPTION_DODGERS_ML", participant: "Los Angeles Dodgers" },
        { optionId: "MGM_OPTION_TWINS_ML", participant: "Minnesota Twins" },
        { optionId: "MGM_OPTION_ROYALS_ML", participant: "Kansas City Royals" },
        { optionId: "MGM_OPTION_RANGERS_ML", participant: "Texas Rangers" },
        { optionId: "MGM_OPTION_MARLINS_ML", participant: "Miami Marlins" },
        { optionId: "MGM_OPTION_REDS_ML", participant: "Cincinnati Reds" },
        { optionId: "MGM_OPTION_NATIONALS_ML", participant: "Washington Nationals" },
        { optionId: "MGM_OPTION_ROCKIES_ML", participant: "Colorado Rockies" },
        { optionId: "MGM_OPTION_ATHLETICS_ML", participant: "Athletics" },
        { optionId: "MGM_OPTION_ANGELS_ML", participant: "Los Angeles Angels" },
        { optionId: "MGM_OPTION_RAYS_ML", participant: "Tampa Bay Rays" },
        { optionId: "MGM_OPTION_CARDINALS_ML", participant: "St. Louis Cardinals" },
        { optionId: "MGM_OPTION_RED_SOX_ML", participant: "Boston Red Sox" },
        { optionId: "MGM_OPTION_MARINERS_ML", participant: "Seattle Mariners" },
        { optionId: "MGM_OPTION_PADRES_ML", participant: "San Diego Padres" },
        { optionId: "MGM_OPTION_GUARDIANS_ML", participant: "Cleveland Guardians" }
      ]
    }
  ];
}

/* =========================
   ODDS API + RESOLVER
========================= */
async function fetchOddsApiMLBEvents() {
  const now = Date.now();

  if (oddsCache.data.length && now - oddsCache.fetchedAt < ODDS_CACHE_TTL_MS) {
    return { success: true, error: null, data: oddsCache.data, cached: true };
  }

  if (!ODDS_API_KEY) {
    return { success: false, error: "ODDS_API_KEY missing", data: [] };
  }

  const url =
    `https://api.the-odds-api.com/v4/sports/baseball_mlb/odds` +
    `?apiKey=${ODDS_API_KEY}&regions=us&markets=h2h`;

  const resp = await fetch(url);
  const data = await resp.json().catch(() => []);

  if (!resp.ok) {
    return {
      success: false,
      error: Array.isArray(data)
        ? `The Odds API HTTP ${resp.status}`
        : (data?.message || `The Odds API HTTP ${resp.status}`),
      data: []
    };
  }

  oddsCache = { fetchedAt: now, data: Array.isArray(data) ? data : [] };
  return { success: true, error: null, data: oddsCache.data, cached: false };
}

function extractEventTeamsFromOddsApiEvent(eventObj) {
  const candidates = [eventObj.home_team, eventObj.away_team].filter(Boolean);
  const found = [];

  for (const candidate of candidates) {
    const canonical = canonicalizeTeamName(candidate);
    if (canonical) found.push(canonical);
  }

  return [...new Set(found)];
}

async function searchBetMGMFixtures(leg, oddsData = null) {
  const wantedTeams = extractTeamsFromLegEvent(leg.event);

  if (wantedTeams.length < 2) {
    return {
      resolved: false,
      reason: "Could not identify both teams from parsed event",
      wantedTeams
    };
  }

  const odds = oddsData || await fetchOddsApiMLBEvents();

  if (!odds.success) {
    return {
      resolved: false,
      reason: odds.error || "The Odds API lookup failed",
      wantedTeams
    };
  }

  for (const eventObj of odds.data) {
    const eventTeams = extractEventTeamsFromOddsApiEvent(eventObj);
    const allMatched = wantedTeams.every((team) => eventTeams.includes(team));

    if (allMatched) {
      return {
        resolved: true,
        fixtureId: clean(eventObj.id || ""),
        wantedTeams,
        matchedTeams: eventTeams
      };
    }
  }

  return {
    resolved: false,
    reason: "No live The Odds API event matched parsed teams",
    wantedTeams
  };
}

async function searchBetMGMMarkets(_fixtureId, leg) {
  const marketTable = {
    player_home_run: "MGM_MARKET_HR",
    player_total_bases: "MGM_MARKET_TOTAL_BASES",
    moneyline: "MGM_MARKET_MONEYLINE"
  };

  const marketId = marketTable[leg.marketType];
  if (!marketId) return { resolved: false };
  return { resolved: true, marketId };
}

async function searchBetMGMOptions(_fixtureId, marketId, leg) {
  const bucket = getMockBetMGMOptions().find((o) => o.marketId === marketId);
  if (!bucket) return { resolved: false };

  const option = bucket.options.find((o) => {
    const sameParticipant =
      clean(o.participant).toLowerCase() === clean(leg.participant).toLowerCase();
    const sameLine =
      !o.line || !leg.line || clean(o.line) === clean(leg.line);
    return sameParticipant && sameLine;
  });

  if (!option) return { resolved: false };
  return { resolved: true, optionId: option.optionId };
}

async function resolveLeg(leg, oddsData = null) {
  const fixture = await searchBetMGMFixtures(leg, oddsData);

  if (!fixture.resolved) {
    return {
      ...leg,
      fixtureId: "NOT_FOUND",
      marketId: "NOT_FOUND",
      optionId: "NOT_FOUND",
      resolverNote: fixture.reason || "Fixture not found",
      wantedTeams: fixture.wantedTeams || [],
      matchedTeams: []
    };
  }

  const market = await searchBetMGMMarkets(fixture.fixtureId, leg);

  if (!market.resolved) {
    return {
      ...leg,
      fixtureId: fixture.fixtureId,
      marketId: "NOT_FOUND",
      optionId: "NOT_FOUND",
      resolverNote: "Market not found",
      wantedTeams: fixture.wantedTeams || [],
      matchedTeams: fixture.matchedTeams || []
    };
  }

  const option = await searchBetMGMOptions(fixture.fixtureId, market.marketId, leg);

  return {
    ...leg,
    fixtureId: fixture.fixtureId,
    marketId: market.marketId,
    optionId: option.resolved ? option.optionId : "NOT_FOUND",
    resolverNote: option.resolved ? "" : "Option not found",
    wantedTeams: fixture.wantedTeams || [],
    matchedTeams: fixture.matchedTeams || []
  };
}

/* =========================
   BUILDERS + SEND
========================= */
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

function buildDebug(resolved) {
  return resolved
    .map((l, i) => {
      const extra =
        l.fixtureId === "NOT_FOUND"
          ? `\nwantedTeams: ${(l.wantedTeams || []).join(" | ") || "none"}`
          : `\nwantedTeams: ${(l.wantedTeams || []).join(" | ") || "none"}\nmatchedTeams: ${(l.matchedTeams || []).join(" | ") || "none"}`;

      return `${i + 1}. ${l.participant}
event: ${l.event}
market: ${l.rawMarket}
marketType: ${l.marketType}
line: ${l.line}
fixtureId: ${l.fixtureId}
marketId: ${l.marketId}
optionId: ${l.optionId}
resolverNote: ${l.resolverNote || ""}${extra}`;
    })
    .join("\n\n");
}

function buildUnresolved(resolved) {
  const failed = resolved.filter((l) => l.fixtureId === "NOT_FOUND");

  if (!failed.length) {
    return "All legs resolved ✅";
  }

  return failed
    .map(
      (l, i) => `${i + 1}. ${l.participant}
event: ${l.event}
market: ${l.rawMarket}
resolverNote: ${l.resolverNote || ""}
wantedTeams: ${(l.wantedTeams || []).join(" | ") || "none"}`
    )
    .join("\n\n");
}

async function buildOddsLinesMessage() {
  const odds = await fetchOddsApiMLBEvents();

  if (!odds.success) {
    return `Odds debug failed\n${odds.error || "Unknown error"}`;
  }

  const lines = [
    "Odds lines",
    `eventCount: ${odds.data.length}`,
    `cached: ${odds.cached ? "yes" : "no"}`,
    ""
  ];

  for (const eventObj of odds.data.slice(0, 10)) {
    lines.push(`fixtureId: ${clean(eventObj.id)}`);
    lines.push(`home: ${clean(eventObj.home_team) || "none"}`);
    lines.push(`away: ${clean(eventObj.away_team) || "none"}`);
    lines.push("");
  }

  return lines.join("\n").slice(0, 1900);
}

async function sendMessage(id, text) {
  const chunks = splitIntoChunks(String(text || ""), 1800);

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
app.get("/", (_req, res) => {
  res.send("running");
});

app.get("/webhook", (req, res) => {
  if (req.query["hub.verify_token"] === VERIFY_TOKEN) {
    return res.send(req.query["hub.challenge"]);
  }
  res.sendStatus(403);
});

app.post("/webhook", async (req, res) => {
  try {
    const entries = req.body?.entry || [];

    for (const entry of entries) {
      for (const event of entry.messaging || []) {
        if (!event.message || event.message.is_echo) continue;
        if (!event.sender || !event.sender.id) continue;

        const sender = event.sender.id;
        const text = event.message?.text || "";

        let imageUrl = null;
        if (event.message.attachments) {
          const img = event.message.attachments.find((a) => a.type === "image");
          if (img?.payload?.url) {
            imageUrl = img.payload.url;
          }
        }

        if (text.toLowerCase() === "reset") {
          delete userSlipStore[sender];
          await sendMessage(sender, "Session cleared ✅\nSend a new slip.");
          continue;
        }

        if (imageUrl) {
          const ai = await fetch("https://api.openai.com/v1/responses", {
            method: "POST",
            headers: {
              Authorization: `Bearer ${OPENAI_API_KEY}`,
              "Content-Type": "application/json"
            },
            body: JSON.stringify({
              model: "gpt-4.1-mini",
              input: [
                {
                  role: "user",
                  content: [
                    {
                      type: "input_text",
                      text:
                        'Return ONLY valid JSON. No explanation. No markdown. Format EXACTLY like this: {"bet_type":"","source_sportsbook":"","odds":"","stake":"","payout":"","event":"","legs":[{"event":"","market":"","selection":""}]}. IMPORTANT: include the full matchup for each leg event when visible, for example "Chicago Cubs @ Cincinnati Reds". If a leg event is missing, use the top-level event field as fallback.'
                    },
                    {
                      type: "input_image",
                      image_url: imageUrl
                    }
                  ]
                }
              ]
            })
          });

          const data = await ai.json();
          const raw = data.output?.[0]?.content?.[0]?.text || "";
          const parsed = safeParseJSON(raw);

          if (!parsed || !Array.isArray(parsed.legs) || !parsed.legs.length) {
            await sendMessage(sender, "parse failed");
            continue;
          }

          const fallbackEvent = clean(parsed.event);

          userSlipStore[sender] = {
            legs: parsed.legs.map((leg) => normalizeLeg(leg, fallbackEvent)),
            resolved: null
          };

          await sendMessage(sender, "Slip copied ✅\n\nReply: BetMGM");
          continue;
        }

        if (text.toLowerCase() === "betmgm") {
          const saved = userSlipStore[sender];

          if (!saved?.legs) {
            await sendMessage(
              sender,
              "⚠️ Session expired.\n\nSend the slip image again, then reply BetMGM."
            );
            continue;
          }

          const odds = await fetchOddsApiMLBEvents();

          const resolved = [];
          for (const leg of saved.legs) {
            resolved.push(await resolveLeg(leg, odds));
          }

          userSlipStore[sender].resolved = resolved;

          const slip = buildBetMGMBetslip(resolved);
          const link = buildBetMGMDeepLink(resolved);

          const total = resolved.length;
          const success = resolved.filter((l) => l.fixtureId !== "NOT_FOUND").length;

          await sendMessage(sender, `BetMGM ready ✅\nResolved: ${success}/${total}`);
          await sendMessage(sender, JSON.stringify(slip, null, 2));

          if (link) {
            await sendMessage(sender, link);
          }
          continue;
        }

        if (text.toLowerCase() === "payload debug") {
          const saved = userSlipStore[sender];

          if (!saved?.resolved) {
            await sendMessage(sender, "Run BetMGM first");
            continue;
          }

          await sendMessage(sender, buildDebug(saved.resolved));
          continue;
        }

        if (text.toLowerCase() === "unresolved") {
          const saved = userSlipStore[sender];

          if (!saved?.resolved) {
            await sendMessage(sender, "Run BetMGM first");
            continue;
          }

          await sendMessage(sender, buildUnresolved(saved.resolved));
          continue;
        }

        if (text.toLowerCase() === "odds lines") {
          const msg = await buildOddsLinesMessage();
          await sendMessage(sender, msg);
          continue;
        }

        if (!text) continue;
        await sendMessage(sender, "Send slip image");
      }
    }

    res.sendStatus(200);
  } catch (e) {
    console.error(e);
    res.sendStatus(500);
  }
});

app.listen(PORT, () => console.log("running"));
