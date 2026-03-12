const express = require("express");
const axios = require("axios");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const VERIFY_TOKEN = "sharpnetworkbot";
const MAKE_WEBHOOK_URL = "PASTE_YOUR_MAKE_WEBHOOK_URL_HERE";

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

app.post("/webhook", async (req, res) => {
  try {
    if (MAKE_WEBHOOK_URL && MAKE_WEBHOOK_URL !== "PASTE_YOUR_MAKE_WEBHOOK_URL_HERE") {
      await axios.post(MAKE_WEBHOOK_URL, req.body, {
        headers: { "Content-Type": "application/json" }
      });
    }

    return res.sendStatus(200);
  } catch (error) {
    console.error("Forwarding error:", error.message);
    return res.sendStatus(500);
  }
});

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
