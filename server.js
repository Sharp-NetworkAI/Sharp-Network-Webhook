const express = require("express");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || "sharpnetworkbot";
const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

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

function buildRebuildMessage(book, normalizedSlip) {
  const legs = normalizedSlip.legs || [];

  const lines = legs.map((leg) => {
    return `• ${leg.participant} — ${leg.rawMarket}`;
  });

  return [
    `🎯 ${book} Ready`,
    "",
    "Rebuild list:",
    "",
    ...lines,
    "",
    "Send another slip anytime."
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

            await sendMessage(sender, buildRebuildMessage(book, saved.normalizedSlip));
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
