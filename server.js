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

function convertToSearchText(leg) {
  const selection = clean(leg.selection);
  const market = clean(leg.market).toLowerCase();

  if (market.includes("home run")) {
    return `${selection} home run`;
  }

  if (market.includes("total bases")) {
    return `${selection} total bases`;
  }

  if (market.includes("points")) {
    return `${selection} points`;
  }

  if (market.includes("rebounds")) {
    return `${selection} rebounds`;
  }

  if (market.includes("assists")) {
    return `${selection} assists`;
  }

  return `${selection} ${market}`;
}

function buildSlipSummary(slip) {
  const legs = slip.legs || [];

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

function buildRebuildMessage(book, slip) {
  const legs = slip.legs || [];

  const lines = legs.map((leg) => {
    return `• ${convertToSearchText(leg)}`;
  });

  return [
    `🎯 ${book} Ready`,
    "",
    "Copy & search each line:",
    "",
    ...lines,
    "",
    "Paste directly into sportsbook search 🔍"
  ].join("\n");
}

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
  const body = req.body;

  for (const entry of body.entry || []) {
    for (const event of entry.messaging || []) {
      if (!event.message || event.message.is_echo) continue;

      const sender = event.sender.id;
      const text = event.message.text;

      let imageUrl = null;

      if (event.message.attachments) {
        for (const a of event.message.attachments) {
          if (a.type === "image") {
            imageUrl = a.payload.url;
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
                      "Return ONLY JSON. Extract betting slip into {legs:[{selection,market}]}."
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

        const slip = safeParseJSON(raw);

        if (!slip) {
          await sendMessage(sender, "Couldn't read slip.");
          continue;
        }

        userSlipStore[sender] = slip;

        await sendMessage(sender, buildSlipSummary(slip));
      } else if (text) {
        const book = normalizeBookName(text);

        if (book) {
          const saved = userSlipStore[sender];

          if (!saved) {
            await sendMessage(sender, "Send a betting slip first.");
          } else {
            await sendMessage(sender, buildRebuildMessage(book, saved));
          }
        } else {
          await sendMessage(sender, "Send a betting slip image.");
        }
      }
    }
  }

  res.sendStatus(200);
});

app.listen(PORT);
