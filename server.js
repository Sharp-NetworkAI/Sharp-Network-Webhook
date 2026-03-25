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

function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function shortenMarket(market) {
  const m = cleanText(market).toLowerCase();

  if (!m) return "";
  if (m.includes("home run")) return "HR";
  if (m.includes("total bases")) return "Total Bases";
  if (m.includes("hits")) return "Hits";
  if (m.includes("points")) return "Points";
  if (m.includes("rebounds")) return "Rebounds";
  if (m.includes("assists")) return "Assists";
  if (m.includes("three")) return "3PM";

  return cleanText(market);
}

function formatLegForBook(book, leg) {
  const selection = cleanText(leg.selection);
  const market = cleanText(leg.market);
  const shortMarket = shortenMarket(market);

  if (book === "FanDuel") {
    return `• ${selection} (${shortMarket || market})`;
  }

  if (book === "DraftKings") {
    return `• ${selection} — ${market}`;
  }

  if (book === "BetMGM") {
    return `• ${selection}\n  Market: ${market}`;
  }

  if (book === "Caesars") {
    return `• Selection: ${selection}\n  Market: ${market}`;
  }

  if (book === "ESPN Bet") {
    return `• ${selection} | ${market}`;
  }

  return `• ${selection} — ${market}`;
}

function buildSlipSummary(slip) {
  const legs = Array.isArray(slip.legs) ? slip.legs : [];

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
  const legs = Array.isArray(slip.legs) ? slip.legs : [];
  const lines = legs.map((leg) => formatLegForBook(book, leg));

  const introByBook = {
    FanDuel: "Search these in FanDuel to rebuild your slip:",
    DraftKings: "Search these in DraftKings to rebuild your slip:",
    BetMGM: "Use these picks in BetMGM to rebuild your slip:",
    Caesars: "Use these picks in Caesars to rebuild your slip:",
    "ESPN Bet": "Use these picks in ESPN Bet to rebuild your slip:"
  };

  return [
    `🎯 ${book} Ready`,
    "",
    introByBook[book] || "Use these picks to rebuild your slip:",
    "",
    ...lines,
    "",
    "Send another slip anytime."
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
                        'Return ONLY valid JSON. Extract the betting slip into this exact shape: {"legs":[{"selection":"","market":""}]}. Do not use markdown. Do not add explanation.'
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
          const slip = safeParseJSON(raw);

          if (!slip || !Array.isArray(slip.legs) || !slip.legs.length) {
            await sendMessage(sender, "Couldn't read slip.");
            continue;
          }

          userSlipStore[sender] = slip;
          await sendMessage(sender, buildSlipSummary(slip));
          continue;
        }

        if (text) {
          const book = normalizeBookName(text);

          if (book) {
            const savedSlip = userSlipStore[sender];

            if (!savedSlip) {
              await sendMessage(sender, "Send a betting slip first.");
              continue;
            }

            await sendMessage(sender, buildRebuildMessage(book, savedSlip));
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
