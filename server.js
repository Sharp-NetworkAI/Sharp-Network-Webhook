const express = require("express");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || "sharpnetworkbot";
const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

const userSlipStore = {};

function normalizeBookName(text) {
  const cleaned = (text || "").trim().toLowerCase();

  if (cleaned === "fanduel") return "FanDuel";
  if (cleaned === "draftkings") return "DraftKings";
  if (cleaned === "betmgm") return "BetMGM";
  if (cleaned === "caesars") return "Caesars";
  if (cleaned === "espn bet" || cleaned === "espnbet") return "ESPN Bet";

  return null;
}

function buildSlipSummary(slip) {
  const legs = slip.legs || [];

  const legLines = legs.map((leg, i) => {
    return `${i + 1}. ${leg.selection} — ${leg.market}`;
  });

  return [
    "Slip copied.",
    "",
    "Legs:",
    ...legLines,
    "",
    "Reply with your sportsbook:",
    "FanDuel",
    "DraftKings",
    "BetMGM",
    "Caesars",
    "ESPN Bet"
  ].join("\n");
}

function buildRebuildMessage(book, slip) {
  const legs = slip.legs || [];

  const lines = legs.map((leg, i) => {
    return `${i + 1}. ${leg.selection} — ${leg.market}`;
  });

  return [
    `${book} Slip:`,
    "",
    ...lines,
    "",
    "Search these in the app to rebuild your bet."
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
                      "Extract this betting slip into JSON with fields bet_type, odds, stake, payout, and legs (selection + market only)."
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

        let slip = null;

        try {
          slip = JSON.parse(data.output[0].content[0].text);
        } catch {}

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
            await sendMessage(
              sender,
              "Send a betting slip image first."
            );
          } else {
            await sendMessage(
              sender,
              buildRebuildMessage(book, saved)
            );
          }
        } else {
          await sendMessage(
            sender,
            "Send a betting slip image."
          );
        }
      }
    }
  }

  res.sendStatus(200);
});

app.listen(PORT);
