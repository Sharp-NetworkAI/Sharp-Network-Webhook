const express = require("express");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || "sharpnetworkbot";
const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

// Optional future env vars for real BetMGM integration
const BETMGM_API_BASE = process.env.BETMGM_API_BASE || "";
const BETMGM_API_KEY = process.env.BETMGM_API_KEY || "";

const userSlipStore = {};

function normalizeBookName(text) {
  const t = (text || "").toLowerCase().trim();

  if (t === "fanduel") return "FanDuel";
  if (t === "draftkings") return "DraftKings";
  if (t === "betmgm") return "BetMGM";
  if (t === "caesars") return "Caesars";
  if (t.includes("espn")) return "ESPN Bet";

  return null;
}

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

function normalizeLeague(eventText = "") {
  const e = eventText.toLowerCase();

  if (
    e.includes("yankees") ||
    e.includes("giants") ||
    e.includes("dodgers") ||
    e.includes("mets") ||
    e.includes("red sox") ||
    e.includes("cubs") ||
    e.includes("astros") ||
    e.includes("guardians") ||
    e.includes("diamondbacks") ||
    e.includes("angels") ||
    e.includes("twins") ||
    e.includes("nationals") ||
    e.includes("mariners") ||
    e.includes("orioles")
  ) {
    return "MLB";
  }

  if (
    e.includes("lakers") ||
    e.includes("celtics") ||
    e.includes("knicks") ||
    e.includes("warriors") ||
    e.includes("suns") ||
    e.includes("raptors")
  ) {
    return "NBA";
  }

  if (
    e.includes("chiefs") ||
    e.includes("ravens") ||
    e.includes("cowboys") ||
    e.includes("49ers") ||
    e.includes("eagles")
  ) {
    return "NFL";
  }

  return "";
}

function normalizeMarketType(market = "") {
  const m = clean(market).toLowerCase();

  if (!m) return "";

  if (m.includes("home run")) return "player_home_run";
  if (m.includes("total bases")) return "player_total_bases";
  if (m.includes("hits")) return "player_hits";
  if (m.includes("points")) return "player_points";
  if (m.includes("rebounds")) return "player_rebounds";
  if (m.includes("assists")) return "player_assists";
  if (m.includes("made threes") || m.includes("3pt") || m.includes("three pointers")) {
    return "player_threes";
  }
  if (m.includes("strikeouts")) return "player_strikeouts";
  if (m.includes("runs scored")) return "player_runs_scored";
  if (m.includes("rbis") || m.includes("runs batted in")) return "player_rbis";

  return m.replace(/\s+/g, "_");
}

function extractLine(market = "") {
  const text = clean(market);

  const plusMatch = text.match(/(\d+(\.\d+)?)\+/);
  if (plusMatch) {
    return plusMatch[1] + "+";
  }

  const overUnderMatch = text.match(/(over|under)\s+(\d+(\.\d+)?)/i);
  if (overUnderMatch) {
    return `${overUnderMatch[1].toLowerCase()} ${overUnderMatch[2]}`;
  }

  return "";
}

function normalizeLeg(leg = {}) {
  return {
    league: normalizeLeague(leg.event || ""),
    event: clean(leg.event),
    participant: clean(leg.selection),
    marketType: normalizeMarketType(leg.market),
    line: extractLine(leg.market),
    rawMarket: clean(leg.market),
    rawSelection: clean(leg.selection)
  };
}

function normalizeSlip(parsedSlip = {}) {
  const rawLegs = Array.isArray(parsedSlip.legs) ? parsedSlip.legs : [];

  return {
    betType: clean(parsedSlip.bet_type),
    sourceSportsbook: clean(parsedSlip.source_sportsbook),
    odds: clean(parsedSlip.odds),
    stake: clean(parsedSlip.stake),
    payout: clean(parsedSlip.payout),
    legs: rawLegs.map(normalizeLeg)
  };
}

function buildSlipSummary(normalizedSlip) {
  const legs = normalizedSlip.legs || [];

  return [
    "Slip copied ✅",
    "",
    `${legs.length} legs detected`,
    "",
    "Choose your sportsbook:",
    "• FanDuel",
    "• DraftKings",
    "• BetMGM",
    "• Caesars",
    "• ESPN Bet"
  ].join("\n");
}

function buildNormalizedDebugMessage(normalizedSlip) {
  const legs = normalizedSlip.legs || [];

  const lines = legs.map((leg, i) => {
    return [
      `${i + 1}. ${leg.participant}`,
      `   league: ${leg.league || ""}`,
      `   event: ${leg.event || ""}`,
      `   marketType: ${leg.marketType || ""}`,
      `   line: ${leg.line || ""}`
    ].join("\n");
  });

  return [
    "Normalized slip debug:",
    "",
    `betType: ${normalizedSlip.betType || ""}`,
    `sourceSportsbook: ${normalizedSlip.sourceSportsbook || ""}`,
    `odds: ${normalizedSlip.odds || ""}`,
    `stake: ${normalizedSlip.stake || ""}`,
    `payout: ${normalizedSlip.payout || ""}`,
    "",
    "Normalized legs:",
    ...lines
  ].join("\n");
}

function mapMarketKey(marketType, book) {
  const table = {
    player_home_run: {
      FanDuel: "FD_PLAYER_HR",
      DraftKings: "DK_PLAYER_HR",
      BetMGM: "MGM_PLAYER_HR",
      Caesars: "CZR_PLAYER_HR",
      "ESPN Bet": "ESPN_PLAYER_HR"
    },
    player_total_bases: {
      FanDuel: "FD_PLAYER_TOTAL_BASES",
      DraftKings: "DK_PLAYER_TOTAL_BASES",
      BetMGM: "MGM_PLAYER_TOTAL_BASES",
      Caesars: "CZR_PLAYER_TOTAL_BASES",
      "ESPN Bet": "ESPN_PLAYER_TOTAL_BASES"
    },
    player_hits: {
      FanDuel: "FD_PLAYER_HITS",
      DraftKings: "DK_PLAYER_HITS",
      BetMGM: "MGM_PLAYER_HITS",
      Caesars: "CZR_PLAYER_HITS",
      "ESPN Bet": "ESPN_PLAYER_HITS"
    },
    player_points: {
      FanDuel: "FD_PLAYER_POINTS",
      DraftKings: "DK_PLAYER_POINTS",
      BetMGM: "MGM_PLAYER_POINTS",
      Caesars: "CZR_PLAYER_POINTS",
      "ESPN Bet": "ESPN_PLAYER_POINTS"
    },
    player_rebounds: {
      FanDuel: "FD_PLAYER_REBOUNDS",
      DraftKings: "DK_PLAYER_REBOUNDS",
      BetMGM: "MGM_PLAYER_REBOUNDS",
      Caesars: "CZR_PLAYER_REBOUNDS",
      "ESPN Bet": "ESPN_PLAYER_REBOUNDS"
    },
    player_assists: {
      FanDuel: "FD_PLAYER_ASSISTS",
      DraftKings: "DK_PLAYER_ASSISTS",
      BetMGM: "MGM_PLAYER_ASSISTS",
      Caesars: "CZR_PLAYER_ASSISTS",
      "ESPN Bet": "ESPN_PLAYER_ASSISTS"
    },
    player_threes: {
      FanDuel: "FD_PLAYER_THREES",
      DraftKings: "DK_PLAYER_THREES",
      BetMGM: "MGM_PLAYER_THREES",
      Caesars: "CZR_PLAYER_THREES",
      "ESPN Bet": "ESPN_PLAYER_THREES"
    }
  };

  return table[marketType]?.[book] || `${book.toUpperCase().replace(/\s+/g, "_")}_${marketType.toUpperCase()}`;
}

function mapMarketLabelForBook(book, leg) {
  const marketType = leg.marketType || "";

  const labels = {
    FanDuel: {
      player_home_run: "To Hit a Home Run",
      player_total_bases: leg.line ? `${leg.line} Total Bases` : "Total Bases",
      player_hits: leg.line ? `${leg.line} Hits` : "Hits",
      player_points: leg.line ? `${leg.line} Points` : "Points",
      player_rebounds: leg.line ? `${leg.line} Rebounds` : "Rebounds",
      player_assists: leg.line ? `${leg.line} Assists` : "Assists",
      player_threes: leg.line ? `${leg.line} Threes` : "Made Threes"
    },
    DraftKings: {
      player_home_run: "To Hit A Home Run",
      player_total_bases: leg.line ? `${leg.line} Total Bases` : "Total Bases",
      player_hits: leg.line ? `${leg.line} Hits` : "Hits",
      player_points: leg.line ? `${leg.line} Points` : "Points",
      player_rebounds: leg.line ? `${leg.line} Rebounds` : "Rebounds",
      player_assists: leg.line ? `${leg.line} Assists` : "Assists",
      player_threes: leg.line ? `${leg.line} Threes` : "Threes"
    },
    BetMGM: {
      player_home_run: "Player To Hit Home Run",
      player_total_bases: leg.line ? `${leg.line} Total Bases` : "Player Total Bases",
      player_hits: leg.line ? `${leg.line} Hits` : "Player Hits",
      player_points: leg.line ? `${leg.line} Points` : "Player Points",
      player_rebounds: leg.line ? `${leg.line} Rebounds` : "Player Rebounds",
      player_assists: leg.line ? `${leg.line} Assists` : "Player Assists",
      player_threes: leg.line ? `${leg.line} Made Threes` : "Player Made Threes"
    },
    Caesars: {
      player_home_run: "To Hit Home Run",
      player_total_bases: leg.line ? `${leg.line} Total Bases` : "Total Bases",
      player_hits: leg.line ? `${leg.line} Hits` : "Hits",
      player_points: leg.line ? `${leg.line} Points` : "Points",
      player_rebounds: leg.line ? `${leg.line} Rebounds` : "Rebounds",
      player_assists: leg.line ? `${leg.line} Assists` : "Assists",
      player_threes: leg.line ? `${leg.line} 3PM` : "3PM"
    },
    "ESPN Bet": {
      player_home_run: "To Hit a Home Run",
      player_total_bases: leg.line ? `${leg.line} Total Bases` : "Total Bases",
      player_hits: leg.line ? `${leg.line} Hits` : "Hits",
      player_points: leg.line ? `${leg.line} Points` : "Points",
      player_rebounds: leg.line ? `${leg.line} Rebounds` : "Rebounds",
      player_assists: leg.line ? `${leg.line} Assists` : "Assists",
      player_threes: leg.line ? `${leg.line} Threes` : "Threes"
    }
  };

  return labels[book]?.[marketType] || leg.rawMarket || marketType;
}

function estimateConfidence(book, leg) {
  let score = 0.7;

  if (leg.league) score += 0.08;
  if (leg.event) score += 0.05;
  if (leg.participant) score += 0.06;
  if (leg.marketType) score += 0.06;
  if (leg.line) score += 0.05;

  if (book === "FanDuel" && leg.marketType === "player_home_run") score += 0.03;
  if (book === "DraftKings" && leg.marketType === "player_total_bases") score += 0.03;
  if (book === "BetMGM" && leg.marketType === "player_points") score += 0.03;

  return Math.min(score, 0.99);
}

function buildSimId(prefix, value) {
  const cleaned = clean(value)
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40);

  return `${prefix}_${cleaned || "SIM"}`;
}

function buildBuilderPayload(book, leg, mappedMarketKey) {
  return {
    sportsbook: book,
    participant: leg.participant,
    event: leg.event,
    marketKey: mappedMarketKey,
    marketType: leg.marketType,
    line: leg.line || "",
    query: `${leg.participant} ${leg.rawMarket}`.trim()
  };
}

function simulateMatchLeg(book, leg) {
  const mappedMarketKey = mapMarketKey(leg.marketType, book);
  const displayMarket = mapMarketLabelForBook(book, leg);
  const confidence = estimateConfidence(book, leg);
  const status = confidence >= 0.8 ? "matched" : "review";

  const fixtureId = buildSimId(`${book.slice(0, 3).toUpperCase()}_FIXTURE`, leg.event);
  const marketId = buildSimId(`${book.slice(0, 3).toUpperCase()}_MARKET`, `${mappedMarketKey}_${leg.line || "NA"}`);
  const optionId = buildSimId(`${book.slice(0, 3).toUpperCase()}_OPTION`, `${leg.participant}_${mappedMarketKey}_${leg.line || "NA"}`);

  return {
    sportsbook: book,
    participant: leg.participant,
    event: leg.event,
    league: leg.league,
    marketType: leg.marketType,
    mappedMarketKey,
    displayMarket,
    line: leg.line,
    status,
    confidence,
    searchText: `${leg.participant} ${displayMarket}`.trim(),
    fixtureId,
    marketId,
    optionId,
    builderPayload: buildBuilderPayload(book, leg, mappedMarketKey)
  };
}

function simulateMatchSlip(book, normalizedSlip) {
  const legs = normalizedSlip.legs || [];
  const matchedLegs = legs.map((leg) => simulateMatchLeg(book, leg));

  return {
    sportsbook: book,
    betType: normalizedSlip.betType,
    matchedLegs,
    resolverStatus: book === "BetMGM" ? "resolver_scaffold_ready" : "simulated_only"
  };
}

// -------- BetMGM resolver scaffold --------

async function searchBetMGMFixtures(normalizedLeg) {
  // Placeholder for future real API search.
  // This is where you would query BetMGM by league + teams/event.
  return {
    resolved: false,
    reason: "No live BetMGM fixture resolver connected yet.",
    requested: {
      league: normalizedLeg.league,
      event: normalizedLeg.event
    }
  };
}

async function searchBetMGMMarketAndOption(normalizedLeg) {
  // Placeholder for future real API search.
  // This is where you would resolve market + option IDs.
  return {
    resolved: false,
    reason: "No live BetMGM market resolver connected yet.",
    requested: {
      participant: normalizedLeg.participant,
      marketType: normalizedLeg.marketType,
      line: normalizedLeg.line
    }
  };
}

async function resolveBetMGMLeg(matchedLeg) {
  const fixtureResolution = await searchBetMGMFixtures(matchedLeg);
  const marketResolution = await searchBetMGMMarketAndOption(matchedLeg);

  if (fixtureResolution.resolved && marketResolution.resolved) {
    return {
      ...matchedLeg,
      fixtureId: fixtureResolution.fixtureId,
      marketId: marketResolution.marketId,
      optionId: marketResolution.optionId,
      status: "resolved",
      resolver: "betmgm_live",
      builderPayload: {
        ...matchedLeg.builderPayload,
        fixtureId: fixtureResolution.fixtureId,
        marketId: marketResolution.marketId,
        optionId: marketResolution.optionId
      }
    };
  }

  return {
    ...matchedLeg,
    resolver: "betmgm_scaffold",
    resolutionNotes: [
      fixtureResolution.reason,
      marketResolution.reason
    ].filter(Boolean)
  };
}

async function resolveBetMGMSlip(matchResult) {
  const resolvedLegs = [];

  for (const leg of matchResult.matchedLegs) {
    const resolvedLeg = await resolveBetMGMLeg(leg);
    resolvedLegs.push(resolvedLeg);
  }

  return {
    ...matchResult,
    resolverStatus: "betmgm_scaffold",
    matchedLegs: resolvedLegs
  };
}

// -------- Message builders --------

function buildMatchDebugMessage(matchResult) {
  const lines = matchResult.matchedLegs.map((leg, i) => {
    return [
      `${i + 1}. ${leg.participant}`,
      `   market: ${leg.displayMarket}`,
      `   mappedMarketKey: ${leg.mappedMarketKey}`,
      `   fixtureId: ${leg.fixtureId}`,
      `   marketId: ${leg.marketId}`,
      `   optionId: ${leg.optionId}`,
      `   status: ${leg.status}`,
      `   confidence: ${leg.confidence.toFixed(2)}`,
      `   searchText: ${leg.searchText}`
    ].join("\n");
  });

  return [
    `${matchResult.sportsbook} match debug:`,
    "",
    `betType: ${matchResult.betType || ""}`,
    `resolverStatus: ${matchResult.resolverStatus || ""}`,
    "",
    "Matched legs:",
    ...lines
  ].join("\n");
}

function buildPayloadDebugMessage(matchResult) {
  const lines = matchResult.matchedLegs.map((leg, i) => {
    return [
      `${i + 1}. ${leg.participant}`,
      `   fixtureId: ${leg.fixtureId}`,
      `   marketId: ${leg.marketId}`,
      `   optionId: ${leg.optionId}`,
      `   builderPayload: ${JSON.stringify(leg.builderPayload)}`,
      leg.resolutionNotes?.length
        ? `   resolutionNotes: ${leg.resolutionNotes.join(" | ")}`
        : null
    ].filter(Boolean).join("\n");
  });

  return [
    `${matchResult.sportsbook} payload debug:`,
    "",
    `resolverStatus: ${matchResult.resolverStatus || ""}`,
    "",
    "Betslip-ready leg objects:",
    ...lines
  ].join("\n");
}

function buildRebuildMessage(book, matchResult) {
  const lines = matchResult.matchedLegs.map((leg) => {
    const confidenceTag = leg.status === "matched" || leg.status === "resolved" ? "✅" : "⚠️";
    return `• ${confidenceTag} ${leg.searchText}`;
  });

  const footer =
    book === "BetMGM"
      ? [
          "Matched = high-confidence sportsbook version.",
          "Resolver scaffold is active for BetMGM.",
          "Reply payload debug to inspect betslip-ready objects."
        ]
      : [
          "Matched = high-confidence sportsbook version.",
          "Review = likely right, but double-check before placing."
        ];

  return [
    `🎯 ${book} Ready`,
    "",
    "Rebuild list:",
    "",
    ...lines,
    "",
    ...footer
  ].join("\n");
}

async function sendMessage(id, text) {
  const response = await fetch(
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

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    console.error("Facebook send error:", data);
  }
}

app.get("/", (_req, res) => {
  res.send("Sharp Network webhook is running.");
});

app.get("/webhook", (req, res) => {
  if (
    req.query["hub.mode"] === "subscribe" &&
    req.query["hub.verify_token"] === VERIFY_TOKEN
  ) {
    return res.send(req.query["hub.challenge"]);
  }

  res.sendStatus(403);
});

app.post("/webhook", async (req, res) => {
  try {
    const body = req.body;

    if (body.object !== "page") {
      return res.sendStatus(404);
    }

    for (const entry of body.entry || []) {
      for (const event of entry.messaging || []) {
        if (!event.message || event.message.is_echo) continue;

        const sender = event.sender?.id;
        if (!sender) continue;

        const text = event.message.text || "";
        let imageUrl = null;

        if (event.message.attachments) {
          for (const attachment of event.message.attachments) {
            if (attachment.type === "image" && attachment.payload?.url) {
              imageUrl = attachment.payload.url;
              break;
            }
          }
        }

        if (imageUrl) {
          const openai = await fetch("https://api.openai.com/v1/responses", {
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
                        'Return ONLY valid JSON. Extract the betting slip into this exact shape: {"bet_type":"","source_sportsbook":"","odds":"","stake":"","payout":"","legs":[{"event":"","market":"","selection":""}]}. Do not use markdown. Do not add explanation.'
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

          const data = await openai.json().catch(() => ({}));

          if (!openai.ok) {
            console.error("OpenAI error:", data);
            await sendMessage(sender, "Couldn't read slip.");
            continue;
          }

          const raw = data.output?.[0]?.content?.[0]?.text || "";
          const parsedSlip = safeParseJSON(raw);

          if (!parsedSlip || !Array.isArray(parsedSlip.legs) || !parsedSlip.legs.length) {
            await sendMessage(sender, "Couldn't read slip.");
            continue;
          }

          const normalizedSlip = normalizeSlip(parsedSlip);

          userSlipStore[sender] = {
            parsedSlip,
            normalizedSlip,
            matchedByBook: {},
            savedAt: Date.now()
          };

          await sendMessage(sender, buildSlipSummary(normalizedSlip));
          continue;
        }

        if (text) {
          const lowered = text.toLowerCase().trim();

          if (lowered === "debug") {
            const saved = userSlipStore[sender];
            if (!saved?.normalizedSlip) {
              await sendMessage(sender, "No saved slip to debug.");
            } else {
              await sendMessage(sender, buildNormalizedDebugMessage(saved.normalizedSlip));
            }
            continue;
          }

          const book = normalizeBookName(text);

          if (book) {
            const saved = userSlipStore[sender];

            if (!saved?.normalizedSlip) {
              await sendMessage(sender, "Send a betting slip first.");
              continue;
            }

            let matchResult = simulateMatchSlip(book, saved.normalizedSlip);

            if (book === "BetMGM") {
              matchResult = await resolveBetMGMSlip(matchResult);
            }

            saved.matchedByBook[book] = matchResult;

            await sendMessage(sender, buildRebuildMessage(book, matchResult));
            continue;
          }

          if (lowered === "match debug") {
            const saved = userSlipStore[sender];
            const books = saved?.matchedByBook ? Object.keys(saved.matchedByBook) : [];

            if (!books.length) {
              await sendMessage(sender, "No matched sportsbook version yet. Reply with a sportsbook first.");
            } else {
              const latestBook = books[books.length - 1];
              await sendMessage(sender, buildMatchDebugMessage(saved.matchedByBook[latestBook]));
            }
            continue;
          }

          if (lowered === "payload debug") {
            const saved = userSlipStore[sender];
            const books = saved?.matchedByBook ? Object.keys(saved.matchedByBook) : [];

            if (!books.length) {
              await sendMessage(sender, "No matched sportsbook version yet. Reply with a sportsbook first.");
            } else {
              const latestBook = books[books.length - 1];
              await sendMessage(sender, buildPayloadDebugMessage(saved.matchedByBook[latestBook]));
            }
            continue;
          }

          await sendMessage(sender, "Send a betting slip image.");
        }
      }
    }

    res.sendStatus(200);
  } catch (error) {
    console.error("Webhook error:", error);
    res.sendStatus(500);
  }
});

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
