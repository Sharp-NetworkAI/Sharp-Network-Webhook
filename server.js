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

// 🔥 SLIP PAGE
app.get("/s/:slipId", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "slip.html"));
});

// 🔥 API FOR SLIP DATA
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

// HEALTH CHECK
app.get("/", (_req, res) => {
  res.send("running");
});

// META VERIFY
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

        let imageUrl = null;
        if (event.message?.attachments) {
          const img = event.message.attachments.find(
            (a) => a.type === "image"
          );
          if (img?.payload?.url) imageUrl = img.payload.url;
        }

        // ===== IMAGE RECEIVED =====
        if (imageUrl) {
          // 🔥 TEMP MOCK DATA (next step we plug real resolver back in)
          const resolved = [
            { team: "Kansas City Royals", odds: "-110" },
            { team: "Miami Marlins", odds: "+120" },
            { team: "Atlanta Braves", odds: "-150" }
          ];

          // 🔥 CREATE ID
          const slipId = createSlipId();

          // 🔥 STORE SLIP
          publicSlipStore[slipId] = {
            legs: resolved,
            createdAt: Date.now()
          };

          // 🔥 SEND LINK
          await sendMessage(
            sender,
            `Slip ready ✅\n\nhttps://your-render-url.onrender.com/s/${slipId}`
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
