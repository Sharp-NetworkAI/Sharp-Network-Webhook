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

function getBetMGMMoneylineOptionMap() {
  return {
    "baltimore orioles": "MGM_OPTION_ORIOLES_ML",
    "st. louis cardinals": "MGM_OPTION_CARDINALS_ML",
    "boston red sox": "MGM_OPTION_RED_SOX_ML",
    "detroit tigers": "MGM_OPTION_TIGERS_ML",
    "philadelphia phillies": "MGM_OPTION_PHILLIES_ML",
    "atlanta braves": "MGM_OPTION_BRAVES_ML",
    "toronto blue jays": "MGM_OPTION_BLUE_JAYS_ML",
    "chicago white sox": "MGM_OPTION_WHITE_SOX_ML",
    "san diego padres": "MGM_OPTION_PADRES_ML",
    "athletics": "MGM_OPTION_ATHLETICS_ML",
    "los angeles dodgers": "MGM_OPTION_DODGERS_ML",
    "seattle mariners": "MGM_OPTION_MARINERS_ML",
    "chicago cubs": "MGM_OPTION_CUBS_ML",
    "pittsburgh pirates": "MGM_OPTION_PIRATES_ML",
    "new york yankees": "MGM_OPTION_YANKEES_ML",
    "minnesota twins": "MGM_OPTION_TWINS_ML",
    "kansas city royals": "MGM_OPTION_ROYALS_ML",
    "cleveland guardians": "MGM_OPTION_GUARDIANS_ML",
    "miami marlins": "MGM_OPTION_MARLINS_ML",
    "arizona diamondbacks": "MGM_OPTION_DIAMONDBACKS_ML",
    "tampa bay rays": "MGM_OPTION_RAYS_ML",
    "houston astros": "MGM_OPTION_ASTROS_ML",
    "new york mets": "MGM_OPTION_METS_ML",
    "milwaukee brewers": "MGM_OPTION_BREWERS_ML",
    "texas rangers": "MGM_OPTION_RANGERS_ML",
    "los angeles angels": "MGM_OPTION_ANGELS_ML",
    "san francisco giants": "MGM_OPTION_GIANTS_ML",
    "washington nationals": "MGM_OPTION_NATIONALS_ML",
    "cincinnati reds": "MGM_OPTION_REDS_ML",
    "colorado rockies": "MGM_OPTION_ROCKIES_ML"
  };
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
              text: `
You are extracting a sports betting slip.

RULES:
- Return ONLY valid JSON (no markdown, no explanation)
- Format EXACTLY like this:
{
  "legs": [
    { "team": "Team Name", "odds": "+123" }
  ]
}

INSTRUCTIONS:
- Extract EVERY bet shown in the image
- Focus on MONEYLINE picks
- The TEAM is the selected side (NOT both teams)
- Ignore timestamps, league names, and headers
- Odds are usually on the right (like -162, +140)

IMPORTANT:
- If you see "Seattle Mariners @ San Diego Padres"
  and Mariners is selected → team = "Seattle Mariners"
- Do NOT return both teams
- Only return the selected team

Be aggressive — even if formatting is messy, extract the teams.

IMAGE:
`
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
app.get("/", (_req, res) => res.send("running"));

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
  if (!slip) return res.status(404).json({ success: false });

  res.json({ success: true, slip });
});

/* =========================
   WEBHOOK
========================= */
app.post("/webhook", async (req, res) => {
  try {
    const entries = req.body?.entry || [];

    for (const entry of entries) {
      for (const event of entry.messaging || []) {
        if (!event.message || event.message.is_echo) continue;
        if (!event.sender?.id) continue;

        const sender = event.sender.id;

        let imageUrl = null;
        if (event.message.attachments) {
          const img = event.message.attachments.find(a => a.type === "image");
          if (img?.payload?.url) imageUrl = img.payload.url;
        }

        if (imageUrl) {
          const parsed = await parseSlipFromImage(imageUrl);
          const resolved = Array.isArray(parsed.legs) ? parsed.legs : [];

          if (!resolved.length) {
            await sendMessage(sender, "Couldn’t read slip clearly.");
            continue;
          }

          const events = await fetchMLBEvents();

          const enrichedLegs = resolved.map((leg) => {
            const match = findMatchingEvent(leg.team, events);
            if (!match) return { ...leg, eventId: "NOT_FOUND" };

            return {
              ...leg,
              eventId: match.id,
              home: match.home_team,
              away: match.away_team
            };
          });

          const optionMap = getBetMGMMoneylineOptionMap();

          const options = enrichedLegs
            .filter(l => l.eventId !== "NOT_FOUND")
            .map(l => {
              const optionId = optionMap[clean(l.team).toLowerCase()];
              if (!optionId) return null;
              return `${l.eventId}-MGM_MARKET_MONEYLINE-${optionId}`;
            })
            .filter(Boolean)
            .join("%2C");

          const betmgmLink = `https://sports.betmgm.com/en/sports?options=${options}`;

          const slipId = createSlipId();

          publicSlipStore[slipId] = {
            legs: enrichedLegs,
            betmgmLink
          };

          await sendMessage(
            sender,
            `Slip ready ✅\n\nhttps://sharp-network-webhook.onrender.com/s/${slipId}`
          );

        } else {
          await sendMessage(sender, "Send a betting slip image 📸");
        }
      }
    }

    res.sendStatus(200);
  } catch (e) {
    console.error(e);
    res.sendStatus(500);
  }
});

app.listen(PORT, () => console.log("running"));
