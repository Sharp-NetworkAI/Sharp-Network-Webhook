const express = require("express");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || "sharpnetworkbot";
const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const SPORTSGAMEODDS_API_KEY = process.env.SPORTSGAMEODDS_API_KEY;

const userSlipStore = {};

/* =========================
   MOCK DATA (market + option still mocked)
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
        { optionId: "MGM_OPTION_TWINS_ML", participant: "Minnesota Twins" },
        { optionId: "MGM_OPTION_ORIOLES_ML", participant: "Baltimore Orioles" },
        { optionId: "MGM_OPTION_WHITE_SOX_ML", participant: "Chicago White Sox" },
        { optionId: "MGM_OPTION_PIRATES_ML", participant: "Pittsburgh Pirates" },
        { optionId: "MGM_OPTION_PHILLIES_ML", participant: "Philadelphia Phillies" }
      ]
    }
  ];
}

/* =========================
   HELPERS
========================= */
function safeParseJSON(text) {
  try {
    return JSON.parse(text);
  } catch {
    const match = text.match(/\{[\s\S]*\}/);
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
  return clean(eventText).replace(/\([^)]*\)/g, " ").replace(/\s+/g, " ").trim();
}

function teamAliasMap() {
  return {
    "new york yankees": ["new york yankees", "yankees"],
    "san francisco giants": ["san francisco giants", "giants"],
    "los angeles dodgers": ["los angeles dodgers", "dodgers", "lad"],
    "chicago cubs": ["chicago cubs", "cubs"],
    "atlanta braves": ["atlanta braves", "braves", "atl"],
    "cincinnati reds": ["cincinnati reds", "reds"],
    "milwaukee brewers": ["milwaukee brewers", "brewers"],
    "st louis cardinals": ["st louis cardinals", "cardinals"],
    "new york mets": ["new york mets", "mets"],
    "philadelphia phillies": ["philadelphia phillies", "phillies"],
    "boston red sox": ["boston red sox", "red sox"],
    "baltimore orioles": ["baltimore orioles", "orioles"],
    "cleveland guardians": ["cleveland guardians", "guardians"],
    "minnesota twins": ["minnesota twins", "twins"],
    "houston astros": ["houston astros", "astros"],
    "los angeles angels": ["los angeles angels", "angels"],
    "arizona diamondbacks": ["arizona diamondbacks", "diamondbacks", "dbacks"],
    "washington nationals": ["washington nationals", "nationals", "nats"],
    "seattle mariners": ["seattle mariners", "mariners"],
    "kansas city royals": ["kansas city royals", "royals"],
    "toronto blue jays": ["toronto blue jays", "blue jays", "jays"],
    "pittsburgh pirates": ["pittsburgh pirates", "pirates"],
    "tampa bay rays": ["tampa bay rays", "rays"],
    "texas rangers": ["texas rangers", "rangers"],
    "miami marlins": ["miami marlins", "marlins"],
    "oakland athletics": ["oakland athletics", "athletics", "as", "a s"],
    "detroit tigers": ["detroit tigers", "tigers"],
    "san diego padres": ["san diego padres", "padres", "sd"],
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

function getNameCandidatesFromTeamObject(teamObj) {
  if (!teamObj || typeof teamObj !== "object") return [];

  const namesObj = teamObj.names || {};
  const candidates = [
    namesObj.short,
    namesObj.medium,
    namesObj.long,
    teamObj.name,
    teamObj.displayName,
    teamObj.fullName,
    teamObj.abbreviation
  ];

  for (const value of Object.values(namesObj)) {
    if (typeof value === "string") candidates.push(value);
  }

  return candidates.filter(Boolean);
}

function extractEventTeamsFromSportsGameOddsEvent(eventObj) {
  const candidates = [];

  candidates.push(...getNameCandidatesFromTeamObject(eventObj?.teams?.home));
  candidates.push(...getNameCandidatesFromTeamObject(eventObj?.teams?.away));

  const found = [];

  for (const candidate of candidates) {
    const canonical = canonicalizeTeamName(candidate);
    if (canonical) found.push(canonical);
  }

  return [...new Set(found)];
}

/* =========================
   NORMALIZATION
========================= */
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
   LIVE FIXTURE RESOLVER
========================= */
async function fetchSportsGameOddsMLBEvents() {
  if (!SPORTSGAMEODDS_API_KEY) {
    return { success: false, error: "SPORTSGAMEODDS_API_KEY missing", data: [] };
  }

  const url = "https://api.sportsgameodds.com/v2/events?leagueID=MLB&limit=50";

  const resp = await fetch(url, {
    headers: {
      "x-api-key": SPORTSGAMEODDS_API_KEY
    }
  });

  const data = await resp.json().catch(() => ({}));

  if (!resp.ok) {
    return {
      success: false,
      error: data?.error || `SportsGameOdds HTTP ${resp.status}`,
      data: []
    };
  }

  return {
    success: data?.success !== false,
    error: data?.error || null,
    data: Array.isArray(data?.data) ? data.data : []
  };
}

async function searchBetMGMFixtures(leg) {
  const wantedTeams = extractTeamsFromLegEvent(leg.event);

  if (wantedTeams.length < 2) {
    return {
      resolved: false,
      reason: "Could not identify both teams from parsed event"
    };
  }

  const sgo = await fetchSportsGameOddsMLBEvents();

  if (!sgo.success) {
    return {
      resolved: false,
      reason: sgo.error || "SportsGameOdds lookup failed"
    };
  }

  for (const eventObj of sgo.data) {
    const eventTeams = extractEventTeamsFromSportsGameOddsEvent(eventObj);
    const allMatched = wantedTeams.every((team) => eventTeams.includes(team));

    if (allMatched) {
      return {
        resolved: true,
        fixtureId: clean(eventObj.eventID || ""),
        rawEvent: eventObj
      };
    }
  }

  return {
    resolved: false,
    reason: "No live SportsGameOdds event matched parsed teams"
  };
}

/* =========================
   MOCK MARKET + OPTION RESOLVERS
========================= */
async function searchBetMGMMarkets(fixtureId, leg) {
  const marketTable = {
    player_home_run: "MGM_MARKET_HR",
    player_total_bases: "MGM_MARKET_TOTAL_BASES",
    moneyline: "MGM_MARKET_MONEYLINE"
  };

  const marketId = marketTable[leg.marketType];
  if (!marketId) return { resolved: false };
  return { resolved: true, marketId };
}

async function searchBetMGMOptions(fixtureId, marketId, leg) {
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

async function resolveLeg(leg) {
  const fixture = await searchBetMGMFixtures(leg);

  if (!fixture.resolved) {
    return {
      ...leg,
      fixtureId: "NOT_FOUND",
      marketId: "NOT_FOUND",
      optionId: "NOT_FOUND",
      resolverNote: fixture.reason || "Fixture not found"
    };
  }

  const market = await searchBetMGMMarkets(fixture.fixtureId, leg);

  if (!market.resolved) {
    return {
      ...leg,
      fixtureId: fixture.fixtureId,
      marketId: "NOT_FOUND",
      optionId: "NOT_FOUND",
      resolverNote: "Market not found"
    };
  }

  const option = await searchBetMGMOptions(fixture.fixtureId, market.marketId, leg);

  return {
    ...leg,
    fixtureId: fixture.fixtureId,
    marketId: market.marketId,
    optionId: option.resolved ? option.optionId : "NOT_FOUND",
    resolverNote: option.resolved ? "" : "Option not found"
  };
}

/* =========================
   BUILDERS
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
  const validLegs = resolvedLegs.filter(
    (l) =>
      l.fixtureId !== "NOT_FOUND" &&
      l.marketId !== "NOT_FOUND" &&
      l.optionId !== "NOT_FOUND"
  );

  if (!validLegs.length) return null;

  const optionsString = validLegs
    .map((l) => `${l.fixtureId}-${l.marketId}-${l.optionId}`)
    .join(",");

  return `https://sports.betmgm.com/en/sports?options=${encodeURIComponent(optionsString)}`;
}

function buildBetslipMessage(betslip, deepLink) {
  const lines = [
    "🎯 BetMGM Slip Ready",
    "",
    "Copy payload:",
    "",
    JSON.stringify(betslip, null, 2)
  ];

  if (deepLink) {
    lines.push("", "Deep link:", "", deepLink);
  } else {
    lines.push("", "Deep link:", "", "Could not build link because one or more IDs were missing.");
  }

  return lines.join("\n");
}

function buildDebug(resolved) {
  return resolved
    .map(
      (l, i) => `${i + 1}. ${l.participant}
event: ${l.event}
market: ${l.rawMarket}
marketType: ${l.marketType}
line: ${l.line}
fixtureId: ${l.fixtureId}
marketId: ${l.marketId}
optionId: ${l.optionId}
resolverNote: ${l.resolverNote || ""}`
    )
    .join("\n\n");
}

async function buildSgoLinesMessage() {
  const sgo = await fetchSportsGameOddsMLBEvents();

  if (!sgo.success) {
    return `SGO lines failed\n${sgo.error || "Unknown error"}`;
  }

  const lines = ["SGO lines", `eventCount: ${sgo.data.length}`, ""];

  for (const eventObj of sgo.data.slice(0, 10)) {
    const fixtureId = clean(eventObj.eventID || "");
    const homeNames = getNameCandidatesFromTeamObject(eventObj?.teams?.home);
    const awayNames = getNameCandidatesFromTeamObject(eventObj?.teams?.away);

    lines.push(`fixtureId: ${fixtureId}`);
    lines.push(`home: ${homeNames.join(" | ") || "none"}`);
    lines.push(`away: ${awayNames.join(" | ") || "none"}`);
    lines.push("");
  }

  return lines.join("\n").slice(0, 1900);
}

/* =========================
   SEND
========================= */
async function sendMessage(id, text) {
  const resp = await fetch(
    `https://graph.facebook.com/v18.0/me/messages?access_token=${PAGE_ACCESS_TOKEN}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        recipient: { id },
        message: { text }
      })
    }
  );

  if (!resp.ok) {
    const err = await resp.text().catch(() => "");
    console.error("FB send error:", err);
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

        const sender = event.sender.id;
        const text = event.message.text;

        let imageUrl = null;
        if (event.message.attachments) {
          const img = event.message.attachments.find((a) => a.type === "image");
          if (img) imageUrl = img.payload.url;
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

        if (text?.toLowerCase() === "betmgm") {
          const saved = userSlipStore[sender];

          if (!saved?.legs) {
            await sendMessage(sender, "Send slip first");
            continue;
          }

          const resolved = [];
          for (const leg of saved.legs) {
            resolved.push(await resolveLeg(leg));
          }

          userSlipStore[sender].resolved = resolved;

          const betslip = buildBetMGMBetslip(resolved);
          const deepLink = buildBetMGMDeepLink(resolved);

          await sendMessage(sender, buildBetslipMessage(betslip, deepLink));
          continue;
        }

        if (text?.toLowerCase() === "payload debug") {
          const saved = userSlipStore[sender];

          if (!saved?.resolved) {
            await sendMessage(sender, "Run BetMGM first");
            continue;
          }

          await sendMessage(sender, buildDebug(saved.resolved));
          continue;
        }

        if (text?.toLowerCase() === "sgo lines") {
          const msg = await buildSgoLinesMessage();
          await sendMessage(sender, msg);
          continue;
        }

        await sendMessage(sender, "Send slip image");
      }
    }

    res.sendStatus(200);
  } catch (err) {
    console.error(err);
    res.sendStatus(500);
  }
});

app.listen(PORT, () => {
  console.log("running");
});
