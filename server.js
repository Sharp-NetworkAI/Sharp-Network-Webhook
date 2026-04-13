const express = require("express");
const path = require("path");

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const PORT = process.env.PORT || 3000;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || "";
const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN || "";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const ODDS_API_KEY = process.env.ODDS_API_KEY || "";

const publicSlipStore = {};

/* =========================
   HELPERS
========================= */
function clean(v) {
  return String(v || "").replace(/\s+/g, " ").trim();
}

function splitIntoChunks(text, maxLen = 1800) {
  if (text.length <= maxLen) return [text];
  const chunks = [];
  for (let i = 0; i < text.length; i += maxLen) {
    chunks.push(text.slice(i, i + maxLen));
  }
  return chunks;
}

function createSlipId() {
  return Math.random().toString(36).slice(2, 10);
}

/* =========================
   SEND MESSAGE
========================= */
async function sendMessage(id, text) {
  const chunks = splitIntoChunks(String(text || ""));

  for (const chunk of chunks) {
    await fetch(
      `https://graph.facebook.com/v18.0/me/messages?access_token=${PAGE_ACCESS_TOKEN}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          recipient: { id },
          message: { text: chunk }
        })
      }
    );
  }
}

/* =========================
   OPENAI PARSER
========================= */
async function parseSlipFromImage(imageUrl) {
  const resp = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${OPENAI_API_KEY}`
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
                'Return ONLY valid JSON. No markdown. Extract a betting slip into this exact shape: {"legs":[{"team":"","odds":""}]}.'
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

  const data = await resp.json();

  const raw =
    data.output?.[0]?.content?.[0]?.text ||
    data.output_text ||
    "";

  try {
    return JSON.parse(raw);
  } catch (err) {
    console.error("Parse error:", raw);
    return { legs: [] };
  }
}

/* =========================
   ODDS API
========================= */
async function fetchMLBEvents() {
  const url =
    `https://api.the-odds-api.com/v4/sports/baseball_mlb/odds` +
    `?apiKey=${ODDS_API_KEY}&regions=us&markets=h2h`;

  const resp = await fetch(url);
  const data = await resp.json().catch(() => []);

  if (!resp.ok) {
    console.error("Odds API error:", data);
    return [];
  }

  return Array.isArray(data) ? data : [];
}

function findMatchingEvent(teamName, events) {
  const target = clean(teamName).toLowerCase();

  for (const event of events) {
    const home = clean(event.home_team).toLowerCase();
    const away = clean(event.away_team).toLowerCase();

    if (
      home.includes(target) ||
      away.includes(target) ||
      target.includes(home) ||
      target.includes(away)
    ) {
      return event;
    }
  }

  return null;
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

app.get("/s/:slipId", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "slip.html"));
});

app.get("/api/slip/:slipId", (req, res) => {
  const slip = publicSlipStore[req.params.slipId];

  if (!slip) {
    return res.status(404).json({
      success: false,
      error: "Slip not found"
    });
  }

  return res.json({
    success: true,
    slip
  });
});

/* =========================
   WEBHOOK
========================= */
app.post("/webhook", async (req, res) => {
  try {
    const entries = req.body?.entry || [];

    for (const entry of entries) {
      for (const event of entry.messaging || []) {
        if (!event.sender?.id) continue;

        const sender = event.sender.id;

        let imageUrl = null;
        if (event.message?.attachments) {
          const img = event.message.attachments.find(a => a.type === "image");
          if (img?.payload?.url) imageUrl = img.payload.url;
        }

        if (imageUrl) {
          const parsed = await parseSlipFromImage(imageUrl);
          const resolved = Array.isArray(parsed.legs) ? parsed.legs : [];

          const events = await fetchMLBEvents();

          const enrichedLegs = resolved.map((leg) => {
            const eventMatch = findMatchingEvent(leg.team, events);

            if (!eventMatch) {
              return {
                ...leg,
                eventId: "NOT_FOUND"
              };
            }

            return {
              ...leg,
              eventId: eventMatch.id,
              home: eventMatch.home_team,
              away: eventMatch.away_team
            };
          });

          const slipId = createSlipId();

          publicSlipStore[slipId] = {
            legs: enrichedLegs,
            betmgmLink: "https://sports.betmgm.com/",
            fanduelCopy: enrichedLegs.map((l, i) => `${i + 1}. ${l.team}`).join("\n"),
            draftkingsCopy: enrichedLegs.map((l, i) => `${i + 1}. ${l.team}`).join("\n")
          };

          await sendMessage(
            sender,
            `Slip ready ✅\n\nhttps://sharp-network-webhook.onrender.com/s/${slipId}`
          );

          continue;
        }

        await sendMessage(sender, "Send a betting slip image 📸");
      }
    }

    res.sendStatus(200);
  } catch (e) {
    console.error(e);
    res.sendStatus(500);
  }
});

app.listen(PORT, () => console.log("running"));
