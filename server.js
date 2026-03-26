const express = require("express");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || "sharpnetworkbot";
const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

const userSlipStore = {};

/* =========================
   SAFE PARSE
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
   MOCK RESOLVERS (unchanged)
========================= */
async function resolveLeg(leg) {
  return {
    ...leg,
    fixtureId: "MGM_REAL_FIXTURE_001",
    marketId:
      leg.marketType === "player_home_run"
        ? "MGM_MARKET_HR"
        : "MGM_MARKET_TOTAL_BASES",
    optionId: `MGM_OPTION_${leg.participant.replace(/ /g, "_").toUpperCase()}`
  };
}

/* =========================
   BUILD
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
app.get("/", (req, res) => res.send("running"));

app.post("/webhook", async (req, res) => {
  try {
    if (!req.body || !req.body.entry) {
      return res.sendStatus(200);
    }

    const entry = req.body.entry[0];
    const event = entry.messaging[0];

    if (!event || !event.message || event.message.is_echo) {
      return res.sendStatus(200);
    }

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
                    'Return ONLY valid JSON: {"legs":[{"event":"","market":"","selection":""}]}'
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
        return res.sendStatus(200);
      }

      userSlipStore[sender] = {
        legs: parsed.legs.map(normalizeLeg)
      };

      await sendMessage(sender, "Slip copied ✅\nReply: BetMGM");
      return res.sendStatus(200);
    }

    /* BETMGM */
    if (text?.toLowerCase() === "betmgm") {
      const saved = userSlipStore[sender];

      if (!saved?.legs) {
        await sendMessage(sender, "Send slip first");
        return res.sendStatus(200);
      }

      const resolved = [];

      for (const leg of saved.legs) {
        resolved.push(await resolveLeg(leg));
      }

      const betslip = buildBetMGMBetslip(resolved);

      await sendMessage(sender, JSON.stringify(betslip, null, 2));
      return res.sendStatus(200);
    }

    await sendMessage(sender, "Send slip image");
    res.sendStatus(200);

  } catch (err) {
    console.error(err);
    res.sendStatus(500);
  }
});

app.listen(PORT, () => console.log("running"));
