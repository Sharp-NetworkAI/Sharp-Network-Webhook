const express = require("express");
const axios = require("axios");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const VERIFY_TOKEN = "sharpnetworkbot";
const MAKE_WEBHOOK_URL = "https://hook.us2.make.com/1203tu1fsdw8mieaalgxrqm9okou7en6";

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
    const body = req.body;

    if (body.object === "page") {
      for (const entry of body.entry || []) {
        for (const event of entry.messaging || []) {
          const sender = event.sender?.id;

          if (!sender) continue;

          if (event.message?.attachments?.length) {
            const attachment = event.message.attachments[0];

            if (attachment.type === "image" && attachment.payload?.url) {
              if (MAKE_WEBHOOK_URL && MAKE_WEBHOOK_URL !== "PASTE_YOUR_MAKE_WEBHOOK_URL_HERE") {
                await axios.post(
                  MAKE_WEBHOOK_URL,
                  {
                    sender,
                    image_url: attachment.payload.url,
                    raw_event: event
                  },
                  { headers: { "Content-Type": "application/json" } }
                );
              }

              return res.sendStatus(200);
            }
          }

          if (event.message?.text) {
            if (MAKE_WEBHOOK_URL && MAKE_WEBHOOK_URL !== "PASTE_YOUR_MAKE_WEBHOOK_URL_HERE") {
              await axios.post(
                MAKE_WEBHOOK_URL,
                {
                  sender,
                  message: event.message.text,
                  raw_event: event
                },
                { headers: { "Content-Type": "application/json" } }
              );
            }

            return res.sendStatus(200);
          }
        }
      }
    }

    return res.sendStatus(200);
  } catch (error) {
    console.error("Forwarding error:", error.response?.data || error.message);
    return res.sendStatus(500);
  }
});

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
