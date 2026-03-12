const express = require("express");
const axios = require("axios");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const VERIFY_TOKEN = "sharpnetworkbot";

// Replace this later with your Make webhook URL
const MAKE_WEBHOOK_URL = "https://hook.us2.make.com/1203tu1fsdw8mieaalgxrqm9okou7en6";

app.get("/", (_req, res) => {
  res.send("Sharp Network webhook is running");
});

// Facebook verification endpoint
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    console.log("Webhook verified");
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

// Receive messages from Facebook
app.post("/webhook", async (req, res) => {
  try {
    const entry = req.body.entry;

    if (entry && entry.length > 0) {
      const event = entry[0].messaging[0];
      const senderId = event.sender.id;
      const messageText = event.message?.text;

      console.log("Message received:", messageText);

      if (messageText) {
        await axios.post(MAKE_WEBHOOK_URL, {
          sender: senderId,
          message: messageText
        });
      }
    }

    res.sendStatus(200);
  } catch (error) {
    console.error("Webhook error:", error);
    res.sendStatus(500);
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
