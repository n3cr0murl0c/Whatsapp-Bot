// Enhanced base64 image parsing and decoding functions
import { Buffer } from "buffer";
import WAWebJS, { Client, LocalAuth } from "whatsapp-web.js";
import json2md from "json2md";

import amqp from "amqplib";
import type { WhatsAppMessage } from "./Types";
import { sendWhatsAppMessage } from "./bas64.handler";

// RabbitMQ Configuration
const rabbitSettings = {
  protocol: "amqp",
  hostname: process.env.RABBITMQ_URL || "ectrmqasbs01",
  port: 5672,
  username: process.env.RABBITMQ_USER,
  password: process.env.RABBITMQ_PASSWORD,
  vhost: "/",
  heartbeat: 60,
  locale: "es_EC",
};

const QUEUE_NAME = process.env.QUEUE_NAME || "whatsapp_messages";
// Function to parse and validate base64 image data
function parseBase64Image(base64String: string): {
  mimetype: string;
  data: string;
  extension: string;
} | null {
  try {
    // Remove data URL prefix if present (data:image/jpeg;base64,)
    let cleanBase64 = base64String;
    let detectedMimetype = "image/jpeg"; // default

    if (base64String.includes(",")) {
      const parts = base64String.split(",");
      if (parts.length === 2) {
        const header = parts[0];
        cleanBase64 = parts[1];

        // Extract mimetype from data URL
        const mimetypeMatch = header.match(/data:([^;]+);base64/);
        if (mimetypeMatch) {
          detectedMimetype = mimetypeMatch[1];
        }
      }
    }

    // Validate base64 string
    if (!isValidBase64(cleanBase64)) {
      console.error("Invalid base64 string");
      return null;
    }

    // Get file extension from mimetype
    const extension = getExtensionFromMimetype(detectedMimetype);

    return {
      mimetype: detectedMimetype,
      data: cleanBase64,
      extension: extension,
    };
  } catch (error) {
    console.error("Error parsing base64 image:", error);
    return null;
  }
}

// Function to validate base64 string
function isValidBase64(str: string): boolean {
  try {
    // Check if string contains only valid base64 characters
    const base64Regex = /^[A-Za-z0-9+/]*={0,2}$/;
    if (!base64Regex.test(str)) {
      return false;
    }

    // Try to decode to verify it's valid
    Buffer.from(str, "base64");
    return true;
  } catch {
    return false;
  }
}

// Function to get file extension from mimetype
function getExtensionFromMimetype(mimetype: string): string {
  const mimetypeMap: { [key: string]: string } = {
    "image/jpeg": "jpg",
    "image/jpg": "jpg",
    "image/png": "png",
    "image/gif": "gif",
    "image/webp": "webp",
    "image/bmp": "bmp",
    "image/svg+xml": "svg",
    "image/tiff": "tiff",
    "video/mp4": "mp4",
    "video/avi": "avi",
    "video/mov": "mov",
    "audio/mp3": "mp3",
    "audio/wav": "wav",
    "audio/ogg": "ogg",
    "application/pdf": "pdf",
    "application/msword": "doc",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
      "docx",
  };

  return mimetypeMap[mimetype.toLowerCase()] || "bin";
}

// Utility function to sanitize message text
export function sanitizeMessage(message: string): string {
  if (!message || typeof message !== "string") {
    return "";
  }

  // Remove or replace problematic characters
  return message
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, "") // Remove control characters
    .replace(/\uFEFF/g, "") // Remove BOM
    .trim();
}

// Utility function to validate message data
export function validateMessageData(messageData: WhatsAppMessage): boolean {
  if (!messageData.to) {
    console.error("Missing 'to' field in message data");
    return false;
  }

  if (
    !messageData.message &&
    !messageData.base64Data &&
    !messageData.mediaUrl
  ) {
    console.error("Missing message content");
    return false;
  }

  return true;
}

const client = new Client({
  authStrategy: new LocalAuth({
    clientId: "whatsapp-bot",
    dataPath: "./whatsapp-sessions",
  }),
  puppeteer: {
    headless: false,
  },
});

let rabbitConnection: amqp.ChannelModel | null = null;
let rabbitChannel: amqp.Channel | null = null;

// Initialize RabbitMQ connection
async function initRabbitMQ() {
  try {
    console.log("Connecting to RabbitMQ...");
    rabbitConnection = await amqp.connect(rabbitSettings);
    rabbitChannel = await rabbitConnection.createChannel();

    await rabbitChannel.assertQueue(QUEUE_NAME, { durable: true });
    await rabbitChannel.prefetch(1);

    console.log(`✅ Connected to RabbitMQ. Listening on queue: ${QUEUE_NAME}`);
    await consumeMessages();
  } catch (error) {
    console.error("❌ Failed to connect to RabbitMQ:", error);
    setTimeout(initRabbitMQ, 5000);
  }
}

// Consume messages from RabbitMQ queue
async function consumeMessages() {
  if (!rabbitChannel) {
    console.error("RabbitMQ channel not available");
    return;
  }

  await rabbitChannel.consume(QUEUE_NAME, async (msg) => {
    if (!msg) return;

    try {
      const messageData: WhatsAppMessage = JSON.parse(msg.content.toString());
      console.log("📨 Received message from queue:", messageData);

      // Validate message data
      if (!validateMessageData(messageData)) {
        console.error("Invalid message data, rejecting message");
        rabbitChannel?.nack(msg, false, false);
        return;
      }

      // Wait for WhatsApp client to be ready
      if (!client.info) {
        console.log("⏳ WhatsApp client not ready, queuing message...");
        rabbitChannel?.nack(msg, false, true);
        return;
      }

      await sendWhatsAppMessage(client, messageData);
      rabbitChannel?.ack(msg);
      console.log("✅ Message sent and acknowledged");
    } catch (error) {
      console.error("❌ Error processing message:", error);
      rabbitChannel?.nack(msg, false, false);
    }
  });
}

// // Send WhatsApp message based on queue data
// async function sendWhatsAppMessage(messageData: WhatsAppMessage) {
//   try {
//     const recipients = Array.isArray(messageData.to)
//       ? messageData.to
//       : [messageData.to];
//     const results = [];

//     for (const recipient of recipients) {
//       try {
//         let phoneNumber = recipient.includes("@c.us")
//           ? recipient
//           : `${recipient}@c.us`;

//         let result;

//         if (messageData.type === "base64" && messageData.base64Data) {
//           console.log("Processing base64 media message...");

//           // Parse and validate the base64 image
//           const parsedImage = parseBase64Image(messageData.base64Data);

//           if (!parsedImage) {
//             throw new Error("Failed to parse base64 image data");
//           }

//           console.log(
//             `Detected mimetype: ${parsedImage.mimetype}, extension: ${parsedImage.extension}`
//           );

//           // Create media data object for WhatsApp
//           const mediaData = {
//             mimetype: messageData.mimetype || parsedImage.mimetype,
//             data: parsedImage.data,
//             filename:
//               messageData.filename ||
//               `image_${Date.now()}.${parsedImage.extension}`,
//           };

//           // Validate that we have actual image data
//           try {
//             const buffer = Buffer.from(parsedImage.data, "base64");
//             console.log(`Base64 decoded to ${buffer.length} bytes`);

//             if (buffer.length === 0) {
//               throw new Error("Decoded image buffer is empty");
//             }
//           } catch (decodeError) {
//             throw new Error(`Failed to decode base64 data: ${decodeError}`);
//           }

//           // Use caption for base64 messages, sanitize the text
//           const caption = sanitizeMessage(
//             messageData.caption || messageData.message || ""
//           );

//           console.log("Sending base64 media to WhatsApp...");
//           result = await client.sendMessage(phoneNumber, mediaData, {
//             caption: caption,
//             ...messageData.options,
//           });
//         } else if (messageData.type === "media" && messageData.mediaUrl) {
//           console.log("Processing media URL message...");

//           // Handle media URL messages
//           const response = await fetch(messageData.mediaUrl);

//           if (!response.ok) {
//             throw new Error(
//               `Failed to fetch media: ${response.status} ${response.statusText}`
//             );
//           }

//           const buffer = await response.arrayBuffer();
//           const mediaData = {
//             mimetype:
//               response.headers.get("content-type") ||
//               "application/octet-stream",
//             data: Buffer.from(buffer).toString("base64"),
//             filename:
//               messageData.filename ||
//               messageData.mediaUrl.split("/").pop() ||
//               "media",
//           };

//           const caption = sanitizeMessage(messageData.caption || "");

//           result = await client.sendMessage(phoneNumber, mediaData, {
//             caption: caption,
//             ...messageData.options,
//           });
//         } else {
//           // Handle text messages - sanitize the message
//           const sanitizedMessage = sanitizeMessage(messageData.message);

//           if (!sanitizedMessage) {
//             throw new Error("Message is empty after sanitization");
//           }

//           result = await client.sendMessage(
//             phoneNumber,
//             sanitizedMessage,
//             messageData.options
//           );
//         }

//         results.push({
//           recipient: phoneNumber,
//           success: true,
//           messageId: result.id._serialized,
//         });
//         console.log(`📤 Message sent successfully to ${phoneNumber}`);

//         // Add a small delay between messages to avoid rate limiting
//         await new Promise((resolve) => setTimeout(resolve, 1000));
//       } catch (error) {
//         console.error(`❌ Error sending message to ${recipient}:`, error);
//         const errorMessage =
//           error instanceof Error ? error.message : String(error);
//         results.push({ recipient, success: false, error: errorMessage });
//       }
//     }

//     return results;
//   } catch (error) {
//     console.error("❌ Error processing WhatsApp message:", error);
//     throw error;
//   }
// }

// Handle RabbitMQ connection errors
function setupRabbitMQErrorHandlers() {
  if (rabbitConnection) {
    rabbitConnection.on("error", (err) => {
      console.error("RabbitMQ connection error:", err);
    });

    rabbitConnection.on("close", () => {
      console.log("RabbitMQ connection closed. Attempting to reconnect...");
      rabbitConnection = null;
      rabbitChannel = null;
      setTimeout(initRabbitMQ, 5000);
    });
  }
}

client.initialize();

client.on("loading_screen", (percent, message) => {
  console.log("LOADING SCREEN", percent, message);
});

let pairingCodeRequested = false;
client.on("qr", async (qr) => {
  console.log("QR RECEIVED", qr);

  const pairingCodeEnabled = false;
  if (pairingCodeEnabled && !pairingCodeRequested) {
    const pairingCode = await client.requestPairingCode("96170100100");
    console.log("Pairing code enabled, code: " + pairingCode);
    pairingCodeRequested = true;
  }
});

client.on("authenticated", () => {
  console.log("AUTHENTICATED");
});

client.on("auth_failure", (msg) => {
  console.error("AUTHENTICATION FAILURE", msg);
});

client.on("ready", async () => {
  console.log("READY");
  const debugWWebVersion = await client.getWWebVersion();
  console.log(`WWebVersion = ${debugWWebVersion}`);

  client.pupPage?.on("pageerror", function (err) {
    console.log("Page error: " + err.toString());
  });
  client.pupPage?.on("error", function (err) {
    console.log("Page error: " + err.toString());
  });

  await initRabbitMQ();
  setupRabbitMQErrorHandlers();
});

client.on("message", async (msg) => {
  console.log("MESSAGE RECEIVED", `from:${msg.from}, body:${msg.body}`);

  if (!msg.body || typeof msg.body !== "string") {
    console.log("Message body is empty or not a string, skipping...");
    return;
  }

  console.log("SPLIT:", msg.body.split(" "));
  if (msg.body.split(" ")[0] === "/jarvis") {
    if (!msg.hasMedia) {
      try {
        const prompt = msg.body.split(" ").slice(1).join(" "); // Fix: get the actual prompt
        const payload = JSON.stringify({
          model: "jarvis-es",
          prompt: `${prompt}. Siempre responde en español usando JSON, con la respuesta en la llave: respuesta`,
          format: "json",
          stream: false,
        });

        const res = await fetch("http://localhost:11434/api/generate", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: payload,
        });

        if (res.status === 200) {
          const jss = await res.json();
          console.log("RESPONSE de ollama:", jss.response);

          try {
            const parsed = JSON.parse(jss.response);
            console.log("PARSED:", parsed);

            // Sanitize the response before sending
            const response = sanitizeMessage(json2md(parsed.respuesta));
            if (response) {
              await client.sendMessage(msg.from, response);
            } else {
              await client.sendMessage(
                msg.from,
                "Lo siento, no pude generar una respuesta válida."
              );
            }
          } catch (parseError) {
            console.error("Error parsing Ollama response:", parseError);
            await client.sendMessage(
              msg.from,
              "Error procesando la respuesta del asistente."
            );
          }
        } else {
          await client.sendMessage(msg.from, `Error: ${res.statusText}`);
        }
      } catch (error) {
        console.error("Error with Jarvis command:", error);
        await client.sendMessage(
          msg.from,
          "Error comunicándose con el asistente."
        );
      }
    } else {
      await client.sendMessage(
        msg.from,
        "Disculpa no puedo interpretar imágenes, por favor escribe tu requerimiento"
      );
    }
  } else {
    runCommand(msg);
  }
});

// Rest of your event handlers remain the same...
client.on("message_create", async (msg) => {
  if (msg.fromMe) {
    // do stuff here
  }

  if (
    msg.fromMe &&
    msg.body &&
    typeof msg.body === "string" &&
    msg.body.startsWith("!unpin")
  ) {
    const pinnedMsg = await msg.getQuotedMessage();
    if (pinnedMsg) {
      const result = await pinnedMsg.unpin();
      console.log(result);
    }
  }
});

client.on("message_ciphertext", (msg) => {
  msg.body = "Waiting for this message. Check your phone.";
});

client.on("message_revoke_everyone", async (after, before) => {
  console.log(after);
  if (before) {
    console.log(before);
  }
});

client.on("message_revoke_me", async (msg) => {
  console.log(msg.body);
});

client.on("message_ack", (msg, ack) => {
  if (ack == 3) {
    // The message was read
  }
});

let rejectCalls = true;

client.on("call", async (call) => {
  console.log("Call received, rejecting. GOTO Line 261 to disable", call);
  if (rejectCalls) await call.reject();
  if (call.from)
    await client.sendMessage(
      call.from,
      `[${call.fromMe ? "Outgoing" : "Incoming"}] Phone call from ${
        call.from
      }, type ${call.isGroup ? "group" : ""} ${
        call.isVideo ? "video" : "audio"
      } call. ${
        rejectCalls ? "This call was automatically rejected by the script." : ""
      }`
    );
});

client.on("disconnected", async (reason) => {
  console.log("Client was logged out", reason);
  if (rabbitConnection) {
    await rabbitConnection.close();
  }
});

process.on("SIGINT", async () => {
  console.log("Shutting down gracefully...");

  if (rabbitChannel) {
    await rabbitChannel.close();
  }

  if (rabbitConnection) {
    await rabbitConnection.close();
  }

  await client.destroy();
  process.exit(0);
});

async function runCommand(msg: WAWebJS.Message) {
  if (!msg.body || typeof msg.body !== "string") {
    console.log(
      "Message body is empty or not a string, skipping command processing..."
    );
    return;
  }

  // Sanitize message body for command processing
  const sanitizedBody = sanitizeMessage(msg.body);

  if (sanitizedBody === "!ping reply") {
    msg.reply("pong");
  } else if (sanitizedBody === "!ping") {
    client.sendMessage(msg.from, "pong");
  } else if (sanitizedBody.startsWith("!sendto ")) {
    let number = sanitizedBody.split(" ")[1];
    let messageIndex = sanitizedBody.indexOf(number) + number.length;
    let message = sanitizeMessage(
      sanitizedBody.slice(messageIndex, sanitizedBody.length)
    );
    number = number.includes("@c.us") ? number : `${number}@c.us`;
    let chat = await msg.getChat();
    chat.sendSeen();
    if (message) {
      client.sendMessage(number, message);
    }
  } else if (sanitizedBody.startsWith("!subject ")) {
    let chat = await msg.getChat();
    if (chat.isGroup) {
      let newSubject = sanitizeMessage(sanitizedBody.slice(9));
      if (newSubject) {
        // chat.setSubject(newSubject);
      }
    } else {
      msg.reply("This command can only be used in a group!");
    }
  } else if (sanitizedBody.startsWith("!echo ")) {
    const echoText = sanitizeMessage(sanitizedBody.slice(6));
    if (echoText) {
      msg.reply(echoText);
    }
  } else if (sanitizedBody.startsWith("!preview ")) {
    const text = sanitizeMessage(sanitizedBody.slice(9));
    if (text) {
      msg.reply(text, undefined, { linkPreview: true });
    }
  } else if (sanitizedBody.startsWith("!desc ")) {
    let chat = await msg.getChat();
    if (chat.isGroup) {
      let newDescription = sanitizeMessage(sanitizedBody.slice(6));
      if (newDescription) {
        // chat.setDescription(newDescription);
      }
    } else {
      msg.reply("This command can only be used in a group!");
    }
  } else if (sanitizedBody === "!leave") {
    let chat = await msg.getChat();
    if (chat.isGroup) {
      // chat.leave();
    } else {
      msg.reply("This command can only be used in a group!");
    }
  } else if (sanitizedBody === "!chats") {
    const chats = await client.getChats();
    client.sendMessage(msg.from, `The bot has ${chats.length} chats open.`);
  } else if (sanitizedBody === "!info") {
    let info = client.info;
    client.sendMessage(
      msg.from,
      `*Connection info*
User name: ${info.pushname}
My number: ${info.wid.user}
Platform: ${info.platform}`
    );
  } else if (sanitizedBody === "!mediainfo" && msg.hasMedia) {
    const attachmentData = await msg.downloadMedia();
    msg.reply(`*Media info*
MimeType: ${attachmentData.mimetype}
Filename: ${attachmentData.filename}
Data (length): ${attachmentData.data.length}`);
  } else if (sanitizedBody === "!quoteinfo" && msg.hasQuotedMsg) {
    const quotedMsg = await msg.getQuotedMessage();
    quotedMsg.reply(`ID: ${quotedMsg.id._serialized}
Type: ${quotedMsg.type}
Author: ${quotedMsg.author || quotedMsg.from}
Timestamp: ${quotedMsg.timestamp}
Has Media? ${quotedMsg.hasMedia}`);
  } else if (sanitizedBody === "!resendmedia" && msg.hasQuotedMsg) {
    const quotedMsg = await msg.getQuotedMessage();
    if (quotedMsg.hasMedia) {
      const attachmentData = await quotedMsg.downloadMedia();
      client.sendMessage(msg.from, attachmentData, {
        caption: "Here's your requested media.",
      });
    }
    if (quotedMsg.hasMedia && quotedMsg.type === "audio") {
      const audio = await quotedMsg.downloadMedia();
      await client.sendMessage(msg.from, audio, { sendAudioAsVoice: true });
    }
  } else if (sanitizedBody === "!isviewonce" && msg.hasQuotedMsg) {
    const quotedMsg = await msg.getQuotedMessage();
    if (quotedMsg.hasMedia) {
      const media = await quotedMsg.downloadMedia();
      await client.sendMessage(msg.from, media, { isViewOnce: true });
    }
  } else if (sanitizedBody.startsWith("!status ")) {
    const newStatus = sanitizeMessage(sanitizedBody.split(" ")[1]);
    if (newStatus) {
      await client.setStatus(newStatus);
      msg.reply(`Status was updated to *${newStatus}*`);
    }
  } else if (sanitizedBody === "!delete") {
    if (msg.hasQuotedMsg) {
      const quotedMsg = await msg.getQuotedMessage();
      if (quotedMsg.fromMe) {
        quotedMsg.delete(true);
      } else {
        msg.reply("I can only delete my own messages");
      }
    }
  } else if (sanitizedBody === "!pin") {
    const chat = await msg.getChat();
    await chat.pin();
  } else if (sanitizedBody === "!archive") {
    const chat = await msg.getChat();
    await chat.archive();
  } else if (sanitizedBody === "!mute") {
    const chat = await msg.getChat();
    const unmuteDate = new Date();
    unmuteDate.setSeconds(unmuteDate.getSeconds() + 20);
    await chat.mute(unmuteDate);
  } else if (sanitizedBody === "!typing") {
    const chat = await msg.getChat();
    chat.sendStateTyping();
  } else if (sanitizedBody === "!recording") {
    const chat = await msg.getChat();
    chat.sendStateRecording();
  } else if (sanitizedBody === "!clearstate") {
    const chat = await msg.getChat();
    chat.clearState();
  } else if (sanitizedBody === "!jumpto") {
    if (msg.hasQuotedMsg) {
      const quotedMsg = await msg.getQuotedMessage();
      client.interface.openChatWindowAt(quotedMsg.id._serialized);
    }
  } else if (sanitizedBody === "!reaction") {
    msg.react("👍");
  } else if (sanitizedBody === "!edit") {
    if (msg.hasQuotedMsg) {
      const quotedMsg = await msg.getQuotedMessage();
      if (quotedMsg.fromMe) {
        const editText = sanitizeMessage(sanitizedBody.replace("!edit", ""));
        if (editText) {
          quotedMsg.edit(editText);
        }
      } else {
        msg.reply("I can only edit my own messages");
      }
    }
  } else if (sanitizedBody === "!updatelabels") {
    const chat = await msg.getChat();
    await chat.changeLabels([0, 1]);
  } else if (sanitizedBody === "!addlabels") {
    const chat = await msg.getChat();
    let labels = (await chat.getLabels()).map((l) => l.id);
    labels.push("0");
    labels.push("1");
    await chat.changeLabels(labels);
  } else if (sanitizedBody === "!removelabels") {
    const chat = await msg.getChat();
    await chat.changeLabels([]);
  }
}
