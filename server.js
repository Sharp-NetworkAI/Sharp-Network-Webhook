const express = require("express");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || "sharpnetworkbot";
const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

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

    if (body.object !== "page") {
      return res.sendStatus(404);
    }

    for (const entry of body.entry || []) {
      for (const event of entry.messaging || []) {
        // Ignore delivery/read/postback/etc.
        if (!event.message) {
          continue;
        }

        // Ignore the bot's own echoed messages to stop loops
        if (event.message.is_echo) {
          continue;
        }

        const senderId = event.sender?.id;
        if (!senderId) {
          continue;
        }

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
                      text: "Read this betting slip image and extract all bet legs. Return short plain text."
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
            replyText =
              openaiData.output?.[0]?.content?.[0]?.text ||
              "I couldn't extract the slip.";
          }
        } else if (text) {
          replyText = "Send me a betting slip image.";
        }

        // Only send if we actually created a reply
        if (!replyText) {
          continue;
        }

        const fbResp = await fetch(
          `https://graph.facebook.com/v18.0/me/messages?access_token=${PAGE_ACCESS_TOKEN}`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json"
            },
            body: JSON.stringify({
              recipient: { id: senderId },
              message: { text: replyText }
            })
          }
        );

        const fbData = await fbResp.json();
        if (!fbResp.ok) {
          console.error("Facebook send error:", fbData);
        }
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
