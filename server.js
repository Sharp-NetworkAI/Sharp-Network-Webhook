const express = require("express");
const path = require("path");

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const PORT = process.env.PORT || 3000;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || "";
const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN || "";

const userSlipStore = {};
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
   ROUTES
========================= */

// Slip page
app.get("/s/:slipId", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "slip.html"));
});

// API for slip data
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

// Health check
app.get("/", (_req, res) => {
  res.send("running");
});

// Meta verify
app.get("/webhook", (req, res) => {
  if (req.query["hub.verify_token"] === VERIFY_TOKEN) {
    return res.send(req.query["hub.challenge"]);
  }
  res.sendStatus(403);
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
        const text = clean(event.message?.text || "");

        let imageUrl = null;
        if (event.message?.attachments) {
          const img = event.message.attachments.find(
            (a) => a.type === "image"
          );
          if (img?.payload?.url) imageUrl = img.payload.url;
        }

        // ===== IMAGE RECEIVED =====
        if (imageUrl) {
          // Temporary mock data for the slip page
          const resolved = [
            { team: "Kansas City Royals", odds: "-110" },
            { team: "Miami Marlins", odds: "+120" },
            { team: "Atlanta Braves", odds: "-150" }
          ];

          const slipId = createSlipId();

          publicSlipStore[slipId] = {
            legs: resolved,
            betmgmLink: "https://sports.betmgm.com/",
            fanduelCopy: resolved.map((leg, i) => `${i + 1}. ${leg.team}`).join("\n"),
            draftkingsCopy: resolved.map((leg, i) => `${i + 1}. ${leg.team}`).join("\n"),
            createdAt: Date.now()
          };

          await sendMessage(
            sender,
            `Slip ready ✅\n\nhttps://sharp-network-webhook.onrender.com/s/${slipId}`
          );

          continue;
        }

        if (text) {
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
