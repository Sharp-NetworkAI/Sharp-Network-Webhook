const express = require("express");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || "sharpnetworkbot";
const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

const userSlipStore = {};

/* =========================
   STEP 1: MOCK EVENT SOURCE
========================= */
function getMockBetMGMEvents() {
  return [
    {
      fixtureId: "MGM_REAL_FIXTURE_001",
      homeTeam: "San Francisco Giants",
      awayTeam: "New York Yankees"
    },
    {
      fixtureId: "MGM_REAL_FIXTURE_002",
      homeTeam: "Los Angeles Dodgers",
      awayTeam: "Chicago Cubs"
    }
  ];
}

/* =========================
   HELPERS
========================= */
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

/* =========================
   NORMALIZATION
========================= */
function normalizeMarketType(market = "") {
  const m = clean(market).toLowerCase();

  if (m.includes("home run")) return "player_home_run";
  if (m.includes("total bases")) return "player_total_bases";

  return m.replace(/\s+/g, "_");
}

function extractLine(market = "") {
  const text = clean(market);
  const plusMatch = text.match(/(\d+(\.\d+)?)\+/);

  if (plusMatch) return plusMatch[1] + "+";

  return "";
}

function normalizeLeg(leg = {}) {
  return {
    event: clean(leg.event),
    participant: clean(leg.selection),
    marketType: normalizeMarketType(leg.market),
    line: extractLine(leg.market),
    rawMarket: clean(leg.market)
  };
}

function normalizeSlip(parsedSlip = {}) {
  return {
    betType: clean(parsedSlip.bet_type),
    legs: (parsedSlip.legs || []).map(normalizeLeg)
  };
}

/* =========================
   FIXTURE RESOLVER (STEP 1)
========================= */
async function searchBetMGMFixtures(normalizedLeg) {
  const events = getMockBetMGMEvents();
  const eventText = normalizedLeg.event.toLowerCase();

  for (const event of events) {
    const home = event.homeTeam.toLowerCase();
    const away = event.awayTeam.toLowerCase();

    if (
      eventText.includes(home.split(" ")[0]) &&
      eventText.includes(away.split(" ")[0])
    ) {
      return {
        resolved: true,
        fixtureId: event.fixtureId
      };
    }
  }

  return {
    resolved: false,
    reason: "No matching mock event found"
  };
}

/* =========================
   RESPONSE BUILDERS
========================= */
function buildSlipSummary(slip) {
  return [
    "Slip copied ✅",
    "",
    `${slip.legs.length} legs detected`,
    "",
    "Reply with:",
    "• BetMGM"
  ].join("\n");
}

function buildPayloadDebug(matchResult) {
  const lines = matchResult.map((leg, i) => {
    return [
      `${i + 1}. ${leg.participant}`,
      `   fixtureId: ${leg.fixtureId}`,
      leg.note ? `   note: ${leg.note}` : null
    ]
      .filter(Boolean)
      .join("\n");
  });

  return ["BetMGM payload debug:", "", ...lines].join("\n");
}

/* =========================
   SEND MESSAGE
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
  res.send("Running");
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

    for (const entry of body.entry || []) {
      for (const event of entry.messaging || []) {
        if (!event.message || event.message.is_echo) continue;

        const sender = event.sender.id;
        const text = event.message.text || "";

        let imageUrl = null;

        if (event.message.attachments) {
          for (const a of event.message.attachments) {
            if (a.type === "image") {
              imageUrl = a.payload.url;
              break;
            }
          }
        }

        /* IMAGE HANDLING */
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
                        'Return ONLY JSON: {"bet_type":"","legs":[{"event":"","market":"","selection":""}]}'
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

          const data = await openai.json();
          const raw = data.output?.[0]?.content?.[0]?.text || "";
          const parsed = safeParseJSON(raw);

          if (!parsed) {
            await sendMessage(sender, "Parse failed");
            continue;
          }

          const normalized = normalizeSlip(parsed);

          userSlipStore[sender] = normalized;

          await sendMessage(sender, buildSlipSummary(normalized));
          continue;
        }

        /* BETMGM COMMAND */
        if (text.toLowerCase() === "betmgm") {
          const saved = userSlipStore[sender];

          if (!saved) {
            await sendMessage(sender, "Send slip first");
            continue;
          }

          const results = [];

          for (const leg of saved.legs) {
            const reso = await searchBetMGMFixtures(leg);

            results.push({
              participant: leg.participant,
              fixtureId: reso.resolved
                ? reso.fixtureId
                : "NOT_FOUND",
              note: reso.reason
            });
          }

          userSlipStore[sender].resolved = results;

          await sendMessage(sender, "Fixture matching complete");
          continue;
        }

        /* DEBUG */
        if (text.toLowerCase() === "payload debug") {
          const saved = userSlipStore[sender];

          if (!saved?.resolved) {
            await sendMessage(sender, "Run BetMGM first");
            continue;
          }

          await sendMessage(sender, buildPayloadDebug(saved.resolved));
          continue;
        }

        await sendMessage(sender, "Send a betting slip image.");
      }
    }

    res.sendStatus(200);
  } catch (e) {
    console.error(e);
    res.sendStatus(500);
  }
});

app.listen(PORT, () => {
  console.log("Server running");
});
