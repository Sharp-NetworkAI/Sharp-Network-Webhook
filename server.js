const express = require("express");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || "";
const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN || "";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const ODDS_API_KEY = process.env.ODDS_API_KEY || "";

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
    "st. louis cardinals": ["st. louis cardinals", "st louis cardinals", "cardinals"],
    "detroit tigers": ["detroit tigers", "tigers"],
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
    "athletics": ["athletics", "oakland athletics", "a s"],
    "san diego padres": ["san diego padres", "padres"],
    "colorado rockies": ["colorado rockies", "rockies"],
    "chicago white sox": ["chicago white sox", "white sox"]
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
   OPTION MAPS
========================= */
function betmgmMoneylineOptionIdMap() {
  return {
    "baltimore orioles": "MGM_OPTION_ORIOLES_ML",
    "chicago white sox": "MGM_OPTION_WHITE_SOX_ML",
    "pittsburgh pirates": "MGM_OPTION_PIRATES_ML",
    "philadelphia phillies": "MGM_OPTION_PHILLIES_ML",
    "toronto blue jays": "MGM_OPTION_BLUE_JAYS_ML",
    "atlanta braves": "MGM_OPTION_BRAVES_ML",
    "chicago cubs": "MGM_OPTION_CUBS_ML",
    "milwaukee brewers": "MGM_OPTION_BREWERS_ML",
    "new york mets": "MGM_OPTION_METS_ML",
    "houston astros": "MGM_OPTION_ASTROS_ML",
    "new york yankees": "MGM_OPTION_YANKEES_ML",
    "san francisco giants": "MGM_OPTION_GIANTS_ML",
    "los angeles dodgers": "MGM_OPTION_DODGERS_ML",
    "minnesota twins": "MGM_OPTION_TWINS_ML",
    "kansas city royals": "MGM_OPTION_ROYALS_ML",
    "texas rangers": "MGM_OPTION_RANGERS_ML",
    "miami marlins": "MGM_OPTION_MARLINS_ML",
    "cincinnati reds": "MGM_OPTION_REDS_ML",
    "washington nationals": "MGM_OPTION_NATIONALS_ML",
    "colorado rockies": "MGM_OPTION_ROCKIES_ML",
    "athletics": "MGM_OPTION_ATHLETICS_ML",
    "los angeles angels": "MGM_OPTION_ANGELS_ML",
    "tampa bay rays": "MGM_OPTION_RAYS_ML",
    "st. louis cardinals": "MGM_OPTION_CARDINALS_ML",
    "detroit tigers": "MGM_OPTION_TIGERS_ML",
    "boston red sox": "MGM_OPTION_RED_SOX_ML",
    "seattle mariners": "MGM_OPTION_MARINERS_ML",
    "san diego padres": "MGM_OPTION_PADRES_ML",
    "cleveland guardians": "MGM_OPTION_GUARDIANS_ML",
    "arizona diamondbacks": "MGM_OPTION_DIAMONDBACKS_ML"
  };
}

function fanduelMoneylineSelectionMap() {
  return {
    "baltimore orioles": "Baltimore Orioles",
    "chicago white sox": "Chicago White Sox",
    "pittsburgh pirates": "Pittsburgh Pirates",
    "philadelphia phillies": "Philadelphia Phillies",
    "toronto blue jays": "Toronto Blue Jays",
    "atlanta braves": "Atlanta Braves",
    "chicago cubs": "Chicago Cubs",
    "milwaukee brewers": "Milwaukee Brewers",
    "new york mets": "New York Mets",
    "houston astros": "Houston Astros",
    "new york yankees": "New York Yankees",
    "san francisco giants": "San Francisco Giants",
    "los angeles dodgers": "Los Angeles Dodgers",
    "minnesota twins": "Minnesota Twins",
    "kansas city royals": "Kansas City Royals",
    "texas rangers": "Texas Rangers",
    "miami marlins": "Miami Marlins",
    "cincinnati reds": "Cincinnati Reds",
    "washington nationals": "Washington Nationals",
    "colorado rockies": "Colorado Rockies",
    "athletics": "Athletics",
    "los angeles angels": "Los Angeles Angels",
    "tampa bay rays": "Tampa Bay Rays",
    "st. louis cardinals": "St. Louis Cardinals",
    "detroit tigers": "Detroit Tigers",
    "boston red sox": "Boston Red Sox",
    "seattle mariners": "Seattle Mariners",
    "san diego padres": "San Diego Padres",
    "cleveland guardians": "Cleveland Guardians",
    "arizona diamondbacks": "Arizona Diamondbacks"
  };
}

function draftkingsMoneylineSelectionMap() {
  return {
    "baltimore orioles": "Baltimore Orioles",
    "chicago white sox": "Chicago White Sox",
    "pittsburgh pirates": "Pittsburgh Pirates",
    "philadelphia phillies": "Philadelphia Phillies",
    "toronto blue jays": "Toronto Blue Jays",
    "atlanta braves": "Atlanta Braves",
    "chicago cubs": "Chicago Cubs",
    "milwaukee brewers": "Milwaukee Brewers",
    "new york mets": "New York Mets",
    "houston astros": "Houston Astros",
    "new york yankees": "New York Yankees",
    "san francisco giants": "San Francisco Giants",
    "los angeles dodgers": "Los Angeles Dodgers",
    "minnesota twins": "Minnesota Twins",
    "kansas city royals": "Kansas City Royals",
    "texas rangers": "Texas Rangers",
    "miami marlins": "Miami Marlins",
    "cincinnati reds": "Cincinnati Reds",
    "washington nationals": "Washington Nationals",
    "colorado rockies": "Colorado Rockies",
    "athletics": "Athletics",
    "los angeles angels": "Los Angeles Angels",
    "tampa bay rays": "Tampa Bay Rays",
    "st. louis cardinals": "St. Louis Cardinals",
    "detroit tigers": "Detroit Tigers",
    "boston red sox": "Boston Red Sox",
    "seattle mariners": "Seattle Mariners",
    "san diego padres": "San Diego Padres",
    "cleveland guardians": "Cleveland Guardians",
    "arizona diamondbacks": "Arizona Diamondbacks"
  };
}

/* =========================
   LEG NORMALIZATION
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

function inferMoneylineParticipant(selection = "", eventText = "") {
  const selectionCanonical = canonicalizeTeamName(selection);
  if (selectionCanonical) return selectionCanonical;

  const eventTeams = extractTeamsFromLegEvent(eventText);
  if (eventTeams.length === 2) {
    const selectionSlug = slug(selection);
    for (const team of eventTeams) {
      if (selectionSlug && containsAliasPhrase(team, selectionSlug)) {
        return team;
      }
    }
  }

  return clean(selection);
}

function normalizeLeg(leg, fallbackEvent = "") {
  const event = clean(leg.event || fallbackEvent);
  const rawMarket = clean(leg.market);
  const marketType = normalizeMarketType(rawMarket);
  const rawSelection = clean(leg.selection);

  const participant =
    marketType === "moneyline"
      ? inferMoneylineParticipant(rawSelection, event)
      : rawSelection;

  return {
    event,
    participant,
    marketType,
    line: extractLine(rawMarket),
    rawMarket,
    rawSelection
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
        { optionId: "MGM_OPTION_RONALD_ACUNA_JR_HR", participant: "Ronald Acuna Jr" }
      ]
    },
    {
      marketId: "MGM_MARKET_TOTAL_BASES",
      options: [
        {
          optionId: "MGM_OPTION_LUIS_ARRAEZ_TOTAL_BASES_2PLUS",
          participant: "Luis Arraez",
          line: "2+"
        }
      ]
    }
  ];
}

/* =========================
   ODDS API
========================= */
async function fetchOddsApiMLBEvents() {
  const now = Date.now();

  if (oddsCache.data.length && now - oddsCache.fetchedAt < ODDS_CACHE_TTL_MS) {
    return { success: true, error: null, data: oddsCache.data, cached: true };
  }

  if (!ODDS_API_KEY) {
    return { success: false, error: "ODDS_API_KEY missing", data: [], cached: false };
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
      data: [],
      cached: false
    };
  }

  oddsCache = {
    fetchedAt: now,
    data: Array.isArray(data) ? data : []
  };

  return { success: true, error: null, data: oddsCache.data, cached: false };
}

function extractEventTeamsFromOddsApiEvent(eventObj) {
  const candidates = [eventObj.home_team, eventObj.away_team];
  const found = [];

  for (const candidate of candidates) {
    const canonical = canonicalizeTeamName(candidate);
    if (canonical) found.push(canonical);
  }

  return [...new Set(found)];
}

/* =========================
   RESOLVER
========================= */
async function searchBetMGMFixtures(leg, oddsData = null) {
  const wantedTeams = extractTeamsFromLegEvent(leg.event);

  if (wantedTeams.length < 2) {
    return {
      resolved: false,
      reason: "Could not identify both teams from leg event",
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

function resolveBetMGMOptionId(leg, marketId) {
  if (marketId === "MGM_MARKET_MONEYLINE") {
    const canonical = canonicalizeTeamName(leg.participant);
    if (!canonical) return null;
    return betmgmMoneylineOptionIdMap()[canonical] || null;
  }

  const bucket = getMockBetMGMOptions().find((o) => o.marketId === marketId);
  if (!bucket) return null;

  const option = bucket.options.find((o) => {
    const sameParticipant =
      clean(o.participant).toLowerCase() === clean(leg.participant).toLowerCase();

    const sameLine =
      !o.line || !leg.line || clean(o.line) === clean(leg.line);

    return sameParticipant && sameLine;
  });

  return option?.optionId || null;
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

  const optionId = resolveBetMGMOptionId(leg, market.marketId);

  return {
    ...leg,
    fixtureId: fixture.fixtureId,
    marketId: market.marketId,
    optionId: optionId || "NOT_FOUND",
    resolverNote: optionId ? "" : "Option not found",
    wantedTeams: fixture.wantedTeams || [],
    matchedTeams: fixture.matchedTeams || []
  };
}

/* =========================
   BOOK BUILDERS
========================= */
function getResolvedSuccessCounts(resolvedLegs) {
  const total = resolvedLegs.length;
  const success = resolvedLegs.filter(
    (l) =>
      l.fixtureId !== "NOT_FOUND" &&
      l.marketId !== "NOT_FOUND" &&
      l.optionId !== "NOT_FOUND"
  ).length;

  return { success, total };
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

function buildFanDuelPayload(resolvedLegs) {
  const selectionMap = fanduelMoneylineSelectionMap();

  return {
    sportsbook: "FanDuel",
    type: "same_game_parlay",
    supported: resolvedLegs.every((l) => l.marketType === "moneyline"),
    note: "Structured replication payload only. Live FanDuel deep link not yet wired.",
    legs: resolvedLegs.map((l) => {
      const canonical = canonicalizeTeamName(l.participant);
      return {
        event: l.event,
        market: l.marketType,
        selection: selectionMap[canonical] || l.rawSelection || l.participant
      };
    })
  };
}

function buildDraftKingsPayload(resolvedLegs) {
  const selectionMap = draftkingsMoneylineSelectionMap();

  return {
    sportsbook: "DraftKings",
    type: "sgp",
    supported: resolvedLegs.every((l) => l.marketType === "moneyline"),
    note: "Structured replication payload only. Live DraftKings deep link not yet wired.",
    legs: resolvedLegs.map((l) => {
      const canonical = canonicalizeTeamName(l.participant);
      return {
        event: l.event,
        market: l.marketType,
        selection: selectionMap[canonical] || l.rawSelection || l.participant
      };
    })
  };
}

function buildFanDuelGuide(resolvedLegs) {
  const lines = ["FanDuel copy guide"];
  resolvedLegs.forEach((l, i) => {
    lines.push(`${i + 1}. ${l.rawSelection || l.participant}`);
    lines.push(`   Event: ${l.event}`);
    lines.push(`   Market: Moneyline`);
  });
  return lines.join("\n");
}

function buildDraftKingsGuide(resolvedLegs) {
  const lines = ["DraftKings copy guide"];
  resolvedLegs.forEach((l, i) => {
    lines.push(`${i + 1}. ${l.rawSelection || l.participant}`);
    lines.push(`   Event: ${l.event}`);
    lines.push(`   Market: Moneyline`);
  });
  return lines.join("\n");
}

function buildMultiBookSummary(resolvedLegs) {
  const { success, total } = getResolvedSuccessCounts(resolvedLegs);

  const lines = [
    "Multi-book ready ✅",
    `Resolved: ${success}/${total}`,
    "",
    "Available outputs:",
    "- BetMGM: real deep link",
    "- FanDuel: structured payload + copy guide",
    "- DraftKings: structured payload + copy guide",
    "",
    'Reply with: "BetMGM", "FanDuel", or "DraftKings"'
  ];

  return lines.join("\n");
}

function buildLinkOnly(resolvedLegs) {
  const link = buildBetMGMDeepLink(resolvedLegs);
  return link || "No BetMGM deep link available yet.";
}

/* =========================
   DEBUG BUILDERS
========================= */
function buildDebug(resolved) {
  return resolved
    .map((l, i) => {
      const extra =
        l.fixtureId === "NOT_FOUND"
          ? `\nwantedTeams: ${(l.wantedTeams || []).join(" | ")}`
          : `\nwantedTeams: ${(l.wantedTeams || []).join(" | ")}\nmatchedTeams: ${(l.matchedTeams || []).join(" | ")}`;

      return `${i + 1}. ${l.participant}
rawSelection: ${l.rawSelection || ""}
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
  const failed = resolved.filter(
    (l) =>
      l.fixtureId === "NOT_FOUND" ||
      l.marketId === "NOT_FOUND" ||
      l.optionId === "NOT_FOUND"
  );

  if (!failed.length) {
    return "All legs resolved ✅";
  }

  return failed
    .map(
      (l, i) => `${i + 1}. ${l.participant}
rawSelection: ${l.rawSelection || ""}
event: ${l.event}
market: ${l.rawMarket}
resolverNote: ${l.resolverNote || ""}
wantedTeams: ${(l.wantedTeams || []).join(" | ")}`
    )
    .join("\n\n");
}

function buildStoredSlipMessage(saved) {
  if (!saved?.legs?.length) return "No saved slip.";

  return saved.legs
    .map(
      (leg, i) => `${i + 1}. ${leg.participant}
rawSelection: ${leg.rawSelection || ""}
event: ${leg.event}
market: ${leg.rawMarket}
marketType: ${leg.marketType}
line: ${leg.line}`
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
    lines.push(`home: ${clean(eventObj.home_team)}`);
    lines.push(`away: ${clean(eventObj.away_team)}`);
    lines.push("");
  }

  return lines.join("\n").slice(0, 1900);
}

/* =========================
   SEND
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
   RESOLUTION CACHE
========================= */
async function resolveSavedSlipForUser(sender) {
  const saved = userSlipStore[sender];

  if (!saved?.legs) {
    return { ok: false, reason: "⚠️ Session expired.\n\nSend the slip image again first." };
  }

  if (saved.resolved?.length) {
    return { ok: true, resolved: saved.resolved };
  }

  const odds = await fetchOddsApiMLBEvents();
  const resolved = [];

  for (const leg of saved.legs) {
    resolved.push(await resolveLeg(leg, odds));
  }

  userSlipStore[sender].resolved = resolved;
  return { ok: true, resolved };
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
        const text = clean(event.message?.text || "");
        const lower = text.toLowerCase();

        let imageUrl = null;
        if (event.message.attachments) {
          const img = event.message.attachments.find((a) => a.type === "image");
          if (img?.payload?.url) {
            imageUrl = img.payload.url;
          }
        }

        if (lower === "reset") {
          delete userSlipStore[sender];
          await sendMessage(sender, "Session cleared.");
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
                        'Return ONLY valid JSON. No markdown. Extract a betting slip into this exact shape: {"event":"","legs":[{"event":"","market":"","selection":""}]}. Use the top-level event if visible. Each leg must include event if visible, market, and selection.'
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
          const raw =
            data.output?.[0]?.content?.[0]?.text ||
            data.output_text ||
            "";

          const parsed = safeParseJSON(raw);

          if (!parsed || !Array.isArray(parsed.legs)) {
            await sendMessage(sender, "parse failed");
            continue;
          }

          const fallbackEvent = clean(parsed.event);

          userSlipStore[sender] = {
            legs: parsed.legs.map((leg) => normalizeLeg(leg, fallbackEvent)),
            resolved: null
          };

          await sendMessage(sender, "Slip copied ✅\n\nReply BetMGM, FanDuel, DraftKings, or all books");
          continue;
        }

        if (lower === "betmgm") {
          const result = await resolveSavedSlipForUser(sender);

          if (!result.ok) {
            await sendMessage(sender, result.reason);
            continue;
          }

          const resolved = result.resolved;
          const slip = buildBetMGMBetslip(resolved);
          const link = buildBetMGMDeepLink(resolved);
          const { success, total } = getResolvedSuccessCounts(resolved);

          await sendMessage(sender, `BetMGM ready ✅\nResolved: ${success}/${total}`);
          await sendMessage(sender, JSON.stringify(slip, null, 2));

          if (link) {
            await sendMessage(sender, link);
          }
          continue;
        }

        if (lower === "fanduel") {
          const result = await resolveSavedSlipForUser(sender);

          if (!result.ok) {
            await sendMessage(sender, result.reason);
            continue;
          }

          const resolved = result.resolved;
          const payload = buildFanDuelPayload(resolved);
          const guide = buildFanDuelGuide(resolved);

          await sendMessage(sender, "FanDuel ready ✅");
          await sendMessage(sender, JSON.stringify(payload, null, 2));
          await sendMessage(sender, guide);
          continue;
        }

        if (lower === "draftkings") {
          const result = await resolveSavedSlipForUser(sender);

          if (!result.ok) {
            await sendMessage(sender, result.reason);
            continue;
          }

          const resolved = result.resolved;
          const payload = buildDraftKingsPayload(resolved);
          const guide = buildDraftKingsGuide(resolved);

          await sendMessage(sender, "DraftKings ready ✅");
          await sendMessage(sender, JSON.stringify(payload, null, 2));
          await sendMessage(sender, guide);
          continue;
        }

        if (lower === "all books") {
          const result = await resolveSavedSlipForUser(sender);

          if (!result.ok) {
            await sendMessage(sender, result.reason);
            continue;
          }

          const resolved = result.resolved;
          await sendMessage(sender, buildMultiBookSummary(resolved));

          const betmgmSlip = buildBetMGMBetslip(resolved);
          const betmgmLink = buildBetMGMDeepLink(resolved);
          await sendMessage(sender, "BetMGM");
          await sendMessage(sender, JSON.stringify(betmgmSlip, null, 2));
          if (betmgmLink) {
            await sendMessage(sender, betmgmLink);
          }

          const fanduelPayload = buildFanDuelPayload(resolved);
          await sendMessage(sender, "FanDuel");
          await sendMessage(sender, JSON.stringify(fanduelPayload, null, 2));

          const draftkingsPayload = buildDraftKingsPayload(resolved);
          await sendMessage(sender, "DraftKings");
          await sendMessage(sender, JSON.stringify(draftkingsPayload, null, 2));
          continue;
        }

        if (lower === "payload debug") {
          const saved = userSlipStore[sender];

          if (!saved?.resolved) {
            await sendMessage(sender, "Run BetMGM, FanDuel, DraftKings, or all books first");
            continue;
          }

          await sendMessage(sender, buildDebug(saved.resolved));
          continue;
        }

        if (lower === "unresolved") {
          const saved = userSlipStore[sender];

          if (!saved?.resolved) {
            await sendMessage(sender, "Run BetMGM, FanDuel, DraftKings, or all books first");
            continue;
          }

          await sendMessage(sender, buildUnresolved(saved.resolved));
          continue;
        }

        if (lower === "deep link") {
          const saved = userSlipStore[sender];

          if (!saved?.resolved) {
            await sendMessage(sender, "Run BetMGM first");
            continue;
          }

          await sendMessage(sender, buildLinkOnly(saved.resolved));
          continue;
        }

        if (lower === "slip debug") {
          const saved = userSlipStore[sender];

          if (!saved?.legs) {
            await sendMessage(sender, "No saved slip. Send the image first.");
            continue;
          }

          await sendMessage(sender, buildStoredSlipMessage(saved));
          continue;
        }

        if (lower === "odds lines") {
          const msg = await buildOddsLinesMessage();
          await sendMessage(sender, msg);
          continue;
        }

        if (!text) continue;

        await sendMessage(
          sender,
          'Send slip image, then reply "BetMGM", "FanDuel", "DraftKings", or "all books".\nOther commands: deep link, unresolved, payload debug, slip debug, reset'
        );
      }
    }

    res.sendStatus(200);
  } catch (e) {
    console.error(e);
    res.sendStatus(500);
  }
});

app.listen(PORT, () => console.log("running"));
