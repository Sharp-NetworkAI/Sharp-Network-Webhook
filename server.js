const express = require("express");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || "sharpnetworkbot";
const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

const userSlipStore = {};

/* =========================
   MOCK DATA
========================= */
function getMockBetMGMEvents() {
  return [
    {
      fixtureId: "MGM_REAL_FIXTURE_001",
      homeTeam: "San Francisco Giants",
      awayTeam: "New York Yankees"
    }
  ];
}

function getMockBetMGMMkts() {
  return [
    {
      fixtureId: "MGM_REAL_FIXTURE_001",
      markets: [
        {
          marketId: "MGM_MARKET_HR",
          type: "player_home_run"
        },
        {
          marketId: "MGM_MARKET_TOTAL_BASES",
          type: "player_total_bases"
        }
      ]
    }
  ];
}

function getMockBetMGMOptions() {
  return [
    {
      fixtureId: "MGM_REAL_FIXTURE_001",
      marketId: "MGM_MARKET_HR",
      options: [
        {
          optionId: "MGM_OPTION_HELIOT_RAMOS_HR",
          participant: "Heliot Ramos"
        },
        {
          optionId: "MGM_OPTION_AUSTIN_WELLS_HR",
          participant: "Austin Wells"
        }
      ]
    },
    {
      fixtureId: "MGM_REAL_FIXTURE_001",
      marketId: "MGM_MARKET_TOTAL_BASES",
      options: [
        {
          optionId: "MGM_OPTION_LUIS_ARRAEZ_TOTAL_BASES_2_PLUS",
          participant: "Luis Arraez",
          line: "2+"
        }
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
  return String(v || "").trim();
}

/* =========================
   NORMALIZATION
========================= */
function normalizeMarketType(market = "") {
  const m = clean(market).toLowerCase();

  if (m.includes("home run")) return "player_home_run";
  if (m.includes("total bases")) return "player_total_bases";

  return m;
}

function extractLine(market = "") {
  const match = clean(market).match(/(\d+)\+/);
  return match ? `${match[1]}+` : "";
}

function normalizeLeg(leg) {
  return {
    event: clean(leg.event),
    participant: clean(leg.selection),
    marketType: normalizeMarketType(leg.market),
    line: extractLine(leg.market),
    rawMarket: clean(leg.market)
  };
}

/* =========================
   RESOLVERS
========================= */
async function searchBetMGMFixtures(leg) {
  const text = clean(leg.event).toLowerCase();

  for (const event of getMockBetMGMEvents()) {
    const home = event.homeTeam.toLowerCase();
    const away = event.awayTeam.toLowerCase();

    if (text.includes("yankees") && text.includes("giants")) {
      return {
        resolved: true,
        fixtureId: event.fixtureId
      };
    }

    if (text.includes(home.split(" ")[0]) && text.includes(away.split(" ")[0])) {
      return {
        resolved: true,
        fixtureId: event.fixtureId
      };
    }
  }

  return { resolved: false };
}

async function searchBetMGMMarkets(fixtureId, leg) {
  const fixture = getMockBetMGMMkts().find((f) => f.fixtureId === fixtureId);

  if (!fixture) {
    return { resolved: false };
  }

  const market = fixture.markets.find((m) => m.type === leg.marketType);

  if (!market) {
    return { resolved: false };
  }

  return {
    resolved: true,
    marketId: market.marketId
  };
}

async function searchBetMGMOptions(fixtureId, marketId, leg) {
  const bucket = getMockBetMGMOptions().find(
    (o) => o.fixtureId === fixtureId && o.marketId === marketId
  );

  if (!bucket) {
    return { resolved: false };
  }

  const option = bucket.options.find((o) => {
    const sameParticipant =
      clean(o.participant).toLowerCase() === clean(leg.participant).toLowerCase();

    const sameLine =
      !o.line || !leg.line || clean(o.line) === clean(leg.line);

    return sameParticipant && sameLine;
  });

  if (!option) {
    return { resolved: false };
  }

  return {
    resolved: true,
    optionId: option.optionId
  };
}

async function resolveLeg(leg) {
  const fixture = await searchBetMGMFixtures(leg);

  if (!fixture.resolved) {
    return {
      ...leg,
      fixtureId: "NOT_FOUND",
      marketId: "NOT_FOUND",
      optionId: "NOT_FOUND"
    };
  }

  const market = await searchBetMGMMarkets(fixture.fixtureId, leg);

  if (!market.resolved) {
    return {
      ...leg,
      fixtureId: fixture.fixtureId,
      marketId: "NOT_FOUND",
      optionId: "NOT_FOUND"
    };
  }

  const option = await searchBetMGMOptions(fixture.fixtureId, market.marketId, leg);

  return {
    ...leg,
    fixtureId: fixture.fixtureId,
    marketId: market.marketId,
    optionId: option.resolved ? option.optionId : "NOT_FOUND"
  };
}

/* =========================
   BETSLIP / DEEP LINK BUILDER
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
      l.fixtureId &&
      l.marketId &&
      l.optionId &&
      l.fixtureId !== "NOT_FOUND" &&
      l.marketId !== "NOT_FOUND" &&
      l.optionId !== "NOT_FOUND"
  );

  if (!validLegs.length) {
    return null;
  }

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
market: ${l.rawMarket}
marketType: ${l.marketType}
line: ${l.line}
fixtureId: ${l.fixtureId}
marketId: ${l.marketId}
optionId: ${l.optionId}`
    )
    .join("\n\n");
}

/* =========================
   SEND
========================= */
async function sendMessage(id, text) {
  await fetch(
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
                        'Return ONLY valid JSON. No explanation. No markdown. Format EXACTLY like this: {"bet_type":"","source_sportsbook":"","odds":"","stake":"","payout":"","legs":[{"event":"","market":"","selection":""}]}'
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

          userSlipStore[sender] = {
            legs: parsed.legs.map(normalizeLeg),
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
