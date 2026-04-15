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

function norm(v) {
  return clean(v).toLowerCase();
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

function matchupKey(away, home) {
  return `${norm(away)} @ ${norm(home)}`;
}

function canonicalizeTeamName(team) {
  const t = norm(team);

  const aliases = {
    "arizona diamondbacks": ["arizona diamondbacks", "diamondbacks", "dbacks"],
    "atlanta braves": ["atlanta braves", "braves"],
    "athletics": ["athletics", "oakland athletics", "a's", "as"],
    "baltimore orioles": ["baltimore orioles", "orioles"],
    "boston red sox": ["boston red sox", "red sox"],
    "chicago cubs": ["chicago cubs", "cubs"],
    "chicago white sox": ["chicago white sox", "white sox"],
    "cincinnati reds": ["cincinnati reds", "reds"],
    "cleveland guardians": ["cleveland guardians", "guardians"],
    "colorado rockies": ["colorado rockies", "rockies"],
    "detroit tigers": ["detroit tigers", "tigers"],
    "houston astros": ["houston astros", "astros"],
    "kansas city royals": ["kansas city royals", "royals"],
    "los angeles angels": ["los angeles angels", "angels"],
    "los angeles dodgers": ["los angeles dodgers", "dodgers"],
    "miami marlins": ["miami marlins", "marlins"],
    "milwaukee brewers": ["milwaukee brewers", "brewers"],
    "minnesota twins": ["minnesota twins", "twins"],
    "new york mets": ["new york mets", "mets"],
    "new york yankees": ["new york yankees", "yankees"],
    "philadelphia phillies": ["philadelphia phillies", "phillies"],
    "pittsburgh pirates": ["pittsburgh pirates", "pirates"],
    "san diego padres": ["san diego padres", "padres"],
    "san francisco giants": ["san francisco giants", "giants"],
    "seattle mariners": ["seattle mariners", "mariners"],
    "st. louis cardinals": ["st. louis cardinals", "st louis cardinals", "cardinals"],
    "tampa bay rays": ["tampa bay rays", "rays"],
    "texas rangers": ["texas rangers", "rangers"],
    "toronto blue jays": ["toronto blue jays", "blue jays", "jays"],
    "washington nationals": ["washington nationals", "nationals", "nats"]
  };

  for (const [canonical, names] of Object.entries(aliases)) {
    if (names.some((name) => t === norm(name) || t.includes(norm(name)) || norm(name).includes(t))) {
      return canonical;
    }
  }

  return t;
}

/* =========================
   BETMGM NATIVE MAP
========================= */
/*
  This is now the correct layer.

  Shape:
  {
    "away team @ home team": {
      fixtureId: "BETMGM_FIXTURE_ID",
      marketId: "MGM_MARKET_MONEYLINE",
      options: {
        "selected team canonical name": "BETMGM_OPTION_ID"
      }
    }
  }

  Example:
  "arizona diamondbacks @ baltimore orioles": {
    fixtureId: "REAL_FIXTURE_ID_HERE",
    marketId: "MGM_MARKET_MONEYLINE",
    options: {
      "baltimore orioles": "MGM_OPTION_ORIOLES_ML",
      "arizona diamondbacks": "MGM_OPTION_DIAMONDBACKS_ML"
    }
  }
*/
function getBetMGMMoneylineNativeMap() {
  return {
    // Fill this with REAL BetMGM-native fixture/option IDs.
  };
}

function buildBetMGMLinkFromNativeMap(legs) {
  const nativeMap = getBetMGMMoneylineNativeMap();
  const tuples = [];
  const unresolved = [];

  for (const leg of legs) {
    if (!leg.home || !leg.away) {
      unresolved.push({
        team: leg.team,
        reason: "Missing matched home/away teams"
      });
      continue;
    }

    const key = matchupKey(leg.away, leg.home);
    const matchup = nativeMap[key];

    if (!matchup) {
      unresolved.push({
        team: leg.team,
        reason: `No BetMGM native mapping for matchup: ${key}`
      });
      continue;
    }

    const selectedTeam = canonicalizeTeamName(leg.team);
    const optionId = matchup.options?.[selectedTeam];

    if (!optionId) {
      unresolved.push({
        team: leg.team,
        reason: `No BetMGM optionId for selected team: ${selectedTeam}`
      });
      continue;
    }

    tuples.push(`${matchup.fixtureId}-${matchup.marketId}-${optionId}`);
  }

  const link = tuples.length
    ? `https://sports.betmgm.com/en/sports?options=${encodeURIComponent(tuples.join(","))}`
    : null;

  return {
    link,
    resolvedCount: tuples.length,
    unresolved
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
- Return ONLY valid JSON
- No markdown
- No explanation
- Format EXACTLY like this:
{
  "legs": [
    { "team": "Team Name", "odds": "+123" }
  ]
}

INSTRUCTIONS:
- Extract EVERY selected bet shown in the image
- Focus on MONEYLINE picks
- The TEAM is the selected side only
- Ignore headers, dates, timestamps, league labels, and UI noise
- Odds are usually on the right

IMPORTANT:
- If you see "Seattle Mariners @ San Diego Padres" and Mariners is selected,
  return "Seattle Mariners"
- Never return both teams
- Only return the selected team

Be aggressive and extract the selected teams even if formatting is messy.
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
  const target = canonicalizeTeamName(teamName);

  for (const event of events) {
    const home = canonicalizeTeamName(event.home_team);
    const away = canonicalizeTeamName(event.away_team);

    if (
      home === target ||
      away === target ||
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
        if (!event.message || event.message.is_echo) continue;
        if (!event.sender?.id) continue;

        const sender = event.sender.id;

        let imageUrl = null;
        if (event.message.attachments) {
          const img = event.message.attachments.find((a) => a.type === "image");
          if (img?.payload?.url) {
            imageUrl = img.payload.url;
          }
        }

        if (imageUrl) {
          const parsed = await parseSlipFromImage(imageUrl);
          const resolved = Array.isArray(parsed.legs) ? parsed.legs : [];

          if (!resolved.length) {
            await sendMessage(
              sender,
              "I couldn’t read that slip clearly. Send a clearer screenshot that shows the full bet slip."
            );
            continue;
          }

          const events = await fetchMLBEvents();

          const enrichedLegs = resolved.map((leg) => {
            const match = findMatchingEvent(leg.team, events);

            if (!match) {
              return {
                ...leg,
                team: clean(leg.team),
                eventId: "NOT_FOUND"
              };
            }

            return {
              ...leg,
              team: clean(leg.team),
              eventId: match.id, // Odds API ID for display/matching only
              home: match.home_team,
              away: match.away_team
            };
          });

          const betmgm = buildBetMGMLinkFromNativeMap(enrichedLegs);
          const slipId = createSlipId();

          publicSlipStore[slipId] = {
            legs: enrichedLegs,
            betmgmLink: betmgm.link,
            betmgmResolvedCount: betmgm.resolvedCount,
            betmgmUnresolved: betmgm.unresolved,
            fanduelCopy: enrichedLegs.map((l, i) => `${i + 1}. ${l.team}`).join("\n"),
            draftkingsCopy: enrichedLegs.map((l, i) => `${i + 1}. ${l.team}`).join("\n")
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
