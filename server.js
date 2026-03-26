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
        { marketId: "MGM_MARKET_HR", type: "player_home_run" },
        { marketId: "MGM_MARKET_TOTAL_BASES", type: "player_total_bases" }
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
          optionId: "MGM_OPTION_LUIS_ARRAEZ_TB",
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
  const m = market.toLowerCase();
  if (m.includes("home run")) return "player_home_run";
  if (m.includes("total bases")) return "player_total_bases";
  return m;
}

function extractLine(market = "") {
  const match = market.match(/(\d+)\+/);
  return match ? match[1] + "+" : "";
}

function normalizeLeg(leg) {
  return {
    event: clean(leg.event),
    participant: clean(leg.selection),
    marketType: normalizeMarketType(leg.market),
    line: extractLine(leg.market),
    rawMarket: leg.market
  };
}

/* =========================
   RESOLVERS
========================= */
async function searchBetMGMFixtures(leg) {
  const text = leg.event.toLowerCase();

  if (text.includes("yankees") && text.includes("giants")) {
    return { resolved: true, fixtureId: "MGM_REAL_FIXTURE_001" };
  }

  return { resolved: false };
}

async function searchBetMGMMarkets(fixtureId, leg) {
  const data = getMockBetMGMMkts();
  const match = data.find(d => d.fixtureId === fixtureId);

  if (!match) return { resolved: false };

  const market = match.markets.find(
    m => m.type === leg.marketType
  );

  if (!market) return { resolved: false };

  return { resolved: true, marketId: market.marketId };
}

async function searchBetMGMOptions(fixtureId, marketId, leg) {
  const data = getMockBetMGMOptions();

  const match = data.find(
    d => d.fixtureId === fixtureId && d.marketId === marketId
  );

  if (!match) return { resolved: false };

  const option = match.options.find(o =>
    o.participant.toLowerCase() === leg.participant.toLowerCase()
  );

  if (!option) return { resolved: false };

  return { resolved: true, optionId: option.optionId };
}

async function resolveLeg(leg) {
  const fixture = await searchBetMGMFixtures(leg);

  if (!fixture.resolved) {
    return { ...leg, fixtureId: "NOT_FOUND", marketId: "NOT_FOUND", optionId: "NOT_FOUND" };
  }

  const market = await searchBetMGMMarkets(fixture.fixtureId, leg);

  if (!market.resolved) {
    return { ...leg, fixtureId: fixture.fixtureId, marketId: "NOT_FOUND", optionId: "NOT_FOUND" };
  }

  const option = await searchBetMGMOptions(
    fixture.fixtureId,
    market.marketId,
    leg
  );

  return {
    ...leg,
    fixtureId: fixture.fixtureId,
    marketId: market.marketId,
    optionId: option.resolved ? option.optionId : "NOT_FOUND"
  };
}

/* =========================
   BETSLIP BUILDER
========================= */
function buildBetMGMBetslip(resolvedLegs) {
  return {
    sportsbook: "BetMGM",
    type: "sgp",
    legs: resolvedLegs.map(l => ({
      fixtureId: l.fixtureId,
      marketId: l.marketId,
      optionId: l.optionId
    }))
  };
}

function buildBetslipMessage(betslip) {
  return [
    "🎯 BetMGM Slip Ready",
    "",
    "Copy payload:",
    "",
    JSON.stringify(betslip, null, 2)
  ].join("\n");
}

/* =========================
   DEBUG
========================= */
function buildDebug(resolved) {
  return resolved.map((l, i) =>
`${i + 1}. ${l.participant}
fixtureId: ${l.fixtureId}
marketId: ${l.marketId}
optionId: ${l.optionId}`
  ).join("\n\n");
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
app.post("/webhook", async (req, res) => {
  for (const entry of req.body.entry || []) {
    for (const event of entry.messaging || []) {

      if (!event.message || event.message.is_echo) continue;

      const sender = event.sender.id;
      const text = event.message.text;

      let imageUrl = null;

      if (event.message.attachments) {
        const img = event.message.attachments.find(a => a.type === "image");
        if (img) imageUrl = img.payload.url;
      }

      /* IMAGE */
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
                      'Return ONLY valid JSON. {"bet_type":"","legs":[{"event":"","market":"","selection":""}]}'
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

        if (!parsed || !parsed.legs) {
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

      /* BETMGM */
      if (text?.toLowerCase() === "betmgm") {
        const saved = userSlipStore[sender];

        const resolved = [];

        for (const leg of saved.legs) {
          resolved.push(await resolveLeg(leg));
        }

        userSlipStore[sender].resolved = resolved;

        const betslip = buildBetMGMBetslip(resolved);

        await sendMessage(sender, buildBetslipMessage(betslip));
        continue;
      }

      /* DEBUG */
      if (text?.toLowerCase() === "payload debug") {
        const saved = userSlipStore[sender];
        await sendMessage(sender, buildDebug(saved.resolved));
        continue;
      }

      await sendMessage(sender, "Send slip image");
    }
  }

  res.sendStatus(200);
});

app.listen(PORT, () => console.log("running"));
