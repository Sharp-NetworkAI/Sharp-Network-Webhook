const express = require("express");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || "sharpnetworkbot";
const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

// Temporary in-memory storage for each user's last parsed slip
// Format: { [senderId]: { slip: object, savedAt: number } }
const userSlipStore = {};

const SUPPORTED_BOOKS = [
  "fanduel",
  "draftkings",
  "betmgm",
  "caesars",
  "espn bet"
];

app.get("/", (_req, res) => {
  res.send("Sharp Network webhook is running.");
});

app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }

  return res.sendStatus(403);
});

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
  const legs = Array.isArray(slip.legs) ? slip.legs : [];
  if (!legs.length) {
    return "I copied the slip, but I couldn't find any legs.";
  }

  const legLines = legs.map((leg, index) => {
    const event = leg.event || "";
    const market = leg.market || "";
    const selection = leg.selection || "";

    return `${index + 1}. ${selection} — ${market} — ${event}`;
  });

  return [
    "Slip copied.",
    "",
    `Bet type: ${slip.bet_type || ""}`,
    `Sportsbook shown: ${slip.source_sportsbook || ""}`,
    `Odds: ${slip.odds || ""}`,
    `Stake: ${slip.stake || ""}`,
    `Payout: ${slip.payout || ""}`,
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

function buildBookReply(bookName, slip) {
  const legs = Array.isArray(slip.legs) ? slip.legs : [];
  const legCount = legs.length;

  return [
    `Got it — ${bookName} selected.`,
    "",
    `I saved your last copied slip with ${legCount} leg${legCount === 1 ? "" : "s"}.`,
    "",
    "Next step:",
    "I can now turn this saved slip into a sportsbook-specific version for rebuilding."
  ].join("\n");
}

async function sendMessengerText(recipientId, text) {
  const fbResp = await fetch(
    `https://graph.facebook.com/v18.0/me/messages?access_token=${PAGE_ACCESS_TOKEN}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        recipient: { id: recipientId },
        message: { text }
      })
    }
  );

  const fbData = await fbResp.json();

  if (!fbResp.ok) {
    console.error("Facebook send error:", fbData);
  }
}

app.post("/webhook", async (req, res) => {
  try {
    const body = req.body;

    if (body.object !== "page") {
      return res.sendStatus(404);
    }

    for (const entry of body.entry || []) {
      for (const event of entry.messaging || []) {
        if (!event.message) continue;
        if (event.message.is_echo) continue;

        const senderId = event.sender?.id;
        if (!senderId) continue;

        const text = event.message.text || null;

        let imageUrl = null;
        if (event.message.attachments?.length) {
          for (const att of event.message.attachments) {
            if (att.type === "image" && att.payload?.url) {
              imageUrl = att.payload.url;
              break;
            }
          }
        }

        let replyText = null;

        if (imageUrl) {
          const openaiResp = await fetch("https://api.openai.com/v1/responses", {
            method: "POST",
            headers: {
              "Authorization": `Bearer ${OPENAI_API_KEY}`,
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
                        "Read this betting slip image and extract the slip into valid JSON only. Return this exact shape: {\"bet_type\":\"\",\"source_sportsbook\":\"\",\"odds\":\"\",\"stake\":\"\",\"payout\":\"\",\"legs\":[{\"event\":\"\",\"market\":\"\",\"selection\":\"\"}]}. Do not use markdown. Do not add explanation. If a field is missing, use an empty string."
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

          const openaiData = await openaiResp.json();

          if (!openaiResp.ok) {
            console.error("OpenAI error:", openaiData);
            replyText = "I couldn't read that slip image.";
          } else {
            const rawText =
              openaiData.output?.[0]?.content?.[0]?.text || "";

            let parsedSlip = null;

            try {
              parsedSlip = JSON.parse(rawText);
            } catch (parseError) {
              console.error("JSON parse error:", parseError, rawText);
            }

            if (!parsedSlip) {
              replyText = "I copied the image, but I couldn't turn it into slip data.";
            } else {
              userSlipStore[senderId] = {
                slip: parsedSlip,
                savedAt: Date.now()
              };

              replyText = buildSlipSummary(parsedSlip);
            }
          }
        } else if (text) {
          const selectedBook = normalizeBookName(text);

          if (selectedBook) {
            const saved = userSlipStore[senderId];

            if (!saved?.slip) {
              replyText = "I don't have a saved slip for you yet. Send me a betting slip image first.";
            } else {
              replyText = buildBookReply(selectedBook, saved.slip);
            }
          } else {
            replyText = "Send me a betting slip image.";
          }
        }

        if (!replyText) continue;

        await sendMessengerText(senderId, replyText);
      }
    }

    return res.sendStatus(200);
  } catch (error) {
    console.error("Webhook error:", error);
    return res.sendStatus(500);
  }
});

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
