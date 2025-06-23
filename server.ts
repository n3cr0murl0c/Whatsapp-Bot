import WAWebJS, { Client, LocalAuth } from "whatsapp-web.js";
import json2md from "json2md";
import amqp from "amqplib";
// RabbitMQ Configuration

const rabbitSettings = {
  protocol: "amqp",
  hostname: process.env.RABBITMQ_URL || "ectrmqasbs01", // Cambia por la IP o hostname de tu broker
  port: 5672,
  username: process.env.RABBITMQ_USER,
  password: process.env.RABBITMQ_PASSWORD,
  vhost: "/", // Opcional, por defecto es "/"
  heartbeat: 60, // Intervalo de latido en segundos
  locale: "es_EC", // Configuración regional
};

// RabbitMQ Configuration
const QUEUE_NAME = process.env.QUEUE_NAME || "whatsapp_messages";

// Message interface for RabbitMQ
interface WhatsAppMessage {
  to: string | string[]; // Single number or array of phone numbers
  message: string;
  type?: "text" | "media" | "base64";
  mediaUrl?: string;
  base64Data?: string; // Base64 encoded image data
  mimetype?: string; // MIME type for base64 data (e.g., 'image/jpeg', 'image/png')
  filename?: string; // Optional filename for the media
  caption?: string;
  options?: {
    linkPreview?: boolean;
    isViewOnce?: boolean;
    sendAudioAsVoice?: boolean;
  };
}

const client = new Client({
  authStrategy: new LocalAuth({
    clientId: "whatsapp-bot", // Unique identifier for this client
    dataPath: "./whatsapp-sessions", // Directory to store session data
  }),
  // proxyAuthentication: { username: 'username', password: 'password' },
  puppeteer: {
    // args: ['--proxy-server=proxy-server-that-requires-authentication.example.com'],
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

    // Ensure queue exists
    await rabbitChannel.assertQueue(QUEUE_NAME, { durable: true });

    // Set prefetch to 1 to handle one message at a time
    await rabbitChannel.prefetch(1);

    console.log(`✅ Connected to RabbitMQ. Listening on queue: ${QUEUE_NAME}`);

    // Start consuming messages
    await consumeMessages();
  } catch (error) {
    console.error("❌ Failed to connect to RabbitMQ:", error);
    // Retry connection after 5 seconds
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

      // Wait for WhatsApp client to be ready
      if (!client.info) {
        console.log("⏳ WhatsApp client not ready, queuing message...");
        // Reject and requeue the message
        rabbitChannel?.nack(msg, false, true);
        return;
      }

      await sendWhatsAppMessage(messageData);

      // Acknowledge the message
      rabbitChannel?.ack(msg);
      console.log("✅ Message sent and acknowledged");
    } catch (error) {
      console.error("❌ Error processing message:", error);
      // Reject message without requeue (send to dead letter queue if configured)
      rabbitChannel?.nack(msg, false, false);
    }
  });
}

// Send WhatsApp message based on queue data
async function sendWhatsAppMessage(messageData: WhatsAppMessage) {
  try {
    // Handle multiple recipients
    const recipients = Array.isArray(messageData.to)
      ? messageData.to
      : [messageData.to];
    const results = [];

    for (const recipient of recipients) {
      try {
        // Format phone number
        let phoneNumber = recipient.includes("@c.us")
          ? recipient
          : `${recipient}@c.us`;

        let result;
        if (messageData.type === "base64" && messageData.base64Data) {
          // Handle base64 image messages
          const mediaData = {
            mimetype: messageData.mimetype || "image/jpeg",
            data: messageData.base64Data,
            filename: messageData.filename || "image.jpg",
          };

          result = await client.sendMessage(phoneNumber, mediaData, {
            caption: messageData.caption || messageData.message,
            ...messageData.options,
          });
        } else if (messageData.type === "media" && messageData.mediaUrl) {
          // Handle media URL messages
          const response = await fetch(messageData.mediaUrl);
          const buffer = await response.arrayBuffer();
          const mediaData = {
            mimetype:
              response.headers.get("content-type") ||
              "application/octet-stream",
            data: Buffer.from(buffer).toString("base64"),
            filename:
              messageData.filename ||
              messageData.mediaUrl.split("/").pop() ||
              "media",
          };

          result = await client.sendMessage(phoneNumber, mediaData, {
            caption: messageData.caption,
            ...messageData.options,
          });
        } else {
          // Handle text messages
          result = await client.sendMessage(
            phoneNumber,
            messageData.message,
            messageData.options
          );
        }

        results.push({
          recipient: phoneNumber,
          success: true,
          messageId: result.id._serialized,
        });
        console.log(`📤 Message sent to ${phoneNumber}`);
      } catch (error) {
        console.error(`❌ Error sending message to ${recipient}:`, error);
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        results.push({ recipient, success: false, error: errorMessage });
      }
    }

    return results;
  } catch (error) {
    console.error("❌ Error processing WhatsApp message:", error);
    throw error;
  }
}

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

// client initialize does not finish at ready now.
client.initialize();

client.on("loading_screen", (percent, message) => {
  console.log("LOADING SCREEN", percent, message);
});

// Pairing code only needs to be requested once
let pairingCodeRequested = false;
client.on("qr", async (qr) => {
  // NOTE: This event will not be fired if a session is specified.
  console.log("QR RECEIVED", qr);

  // paiuting code example
  const pairingCodeEnabled = false;
  if (pairingCodeEnabled && !pairingCodeRequested) {
    const pairingCode = await client.requestPairingCode("96170100100"); // enter the target phone number
    console.log("Pairing code enabled, code: " + pairingCode);
    pairingCodeRequested = true;
  }
});

client.on("authenticated", () => {
  console.log("AUTHENTICATED");
});

client.on("auth_failure", (msg) => {
  // Fired if session restore was unsuccessful
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

  // Initialize RabbitMQ after WhatsApp is ready
  await initRabbitMQ();
  setupRabbitMQErrorHandlers();
});

client.on("message", async (msg) => {
  console.log("MESSAGE RECEIVED", `from:${msg.from}, body:${msg.body}`);

  // Check if msg.body exists and is a string before processing
  if (!msg.body || typeof msg.body !== "string") {
    console.log("Message body is empty or not a string, skipping...");
    return;
  }

  console.log("SPLIT:", msg.body.split(" "));
  if (msg.body.split(" ")[0] === "/jarvis") {
    if (!msg.hasMedia) {
      const payload = JSON.stringify({
        model: "jarvis-es",
        prompt: `${msg.body
          .split(" ")
          .shift()}. Siempre responde en español usando JSON, con la respuesta en la llave: respuesta`,
        format: "json",
        stream: false,
      });
      const res = await fetch("http://localhost:11434/api/generate", {
        method: "POST",
        body: payload,
      });
      if (res.status === 200) {
        const jss = await res.json();
        console.log("RESPONSE de ollama:", jss.response);
        const parsed = JSON.parse(jss.response);
        console.log("PARSED:", parsed);
        client.sendMessage(msg.from, `${json2md(parsed.respuesta)}`);
      } else {
        client.sendMessage(msg.from, `${res.statusText}`);
      }
    } else {
      client.sendMessage(
        msg.from,
        "Disculpa no puedo interpretar imagenes, por favor escribe tu requerimiento"
      );
    }
  } else {
    runCommand(msg);
  }
});

client.on("message_create", async (msg) => {
  // Fired on all message creations, including your own
  if (msg.fromMe) {
    // do stuff here
  }

  // Unpins a message
  if (
    msg.fromMe &&
    msg.body &&
    typeof msg.body === "string" &&
    msg.body.startsWith("!unpin")
  ) {
    const pinnedMsg = await msg.getQuotedMessage();
    if (pinnedMsg) {
      // Will unpin a message
      const result = await pinnedMsg.unpin();
      console.log(result); // True if the operation completed successfully, false otherwise
    }
  }
});

client.on("message_ciphertext", (msg) => {
  // Receiving new incoming messages that have been encrypted
  // msg.type === 'ciphertext'
  msg.body = "Waiting for this message. Check your phone.";

  // do stuff here
});

client.on("message_revoke_everyone", async (after, before) => {
  // Fired whenever a message is deleted by anyone (including you)
  console.log(after); // message after it was deleted.
  if (before) {
    console.log(before); // message before it was deleted.
  }
});

client.on("message_revoke_me", async (msg) => {
  // Fired whenever a message is only deleted in your own view.
  console.log(msg.body); // message before it was deleted.
});

client.on("message_ack", (msg, ack) => {
  /*
        == ACK VALUES ==
        ACK_ERROR: -1
        ACK_PENDING: 0
        ACK_SERVER: 1
        ACK_DEVICE: 2
        ACK_READ: 3
        ACK_PLAYED: 4
    */

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
  // Close RabbitMQ connection
  if (rabbitConnection) {
    await rabbitConnection.close();
  }
});

// Graceful shutdown
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
  // Check if msg.body exists and is a string before processing
  if (!msg.body || typeof msg.body !== "string") {
    console.log(
      "Message body is empty or not a string, skipping command processing..."
    );
    return;
  }

  if (msg.body === "!ping reply") {
    // Send a new message as a reply to the current one
    msg.reply("pong");
  } else if (msg.body === "!ping") {
    // Send a new message to the same chat
    client.sendMessage(msg.from, "pong");
  } else if (msg.body.startsWith("!sendto ")) {
    // Direct send a new message to specific id
    let number = msg.body.split(" ")[1];
    let messageIndex = msg.body.indexOf(number) + number.length;
    let message = msg.body.slice(messageIndex, msg.body.length);
    number = number.includes("@c.us") ? number : `${number}@c.us`;
    let chat = await msg.getChat();
    chat.sendSeen();
    client.sendMessage(number, message);
  } else if (msg.body.startsWith("!subject ")) {
    // Change the group subject
    let chat = await msg.getChat();
    if (chat.isGroup) {
      let newSubject = msg.body.slice(9);
      // chat.setSubject(newSubject);
    } else {
      msg.reply("This command can only be used in a group!");
    }
  } else if (msg.body.startsWith("!echo ")) {
    // Replies with the same message
    msg.reply(msg.body.slice(6));
  } else if (msg.body.startsWith("!preview ")) {
    const text = msg.body.slice(9);
    msg.reply(text, undefined, { linkPreview: true });
  } else if (msg.body.startsWith("!desc ")) {
    // Change the group description
    let chat = await msg.getChat();
    if (chat.isGroup) {
      let newDescription = msg.body.slice(6);
      // chat.setDescription(newDescription);
    } else {
      msg.reply("This command can only be used in a group!");
    }
  } else if (msg.body === "!leave") {
    // Leave the group
    let chat = await msg.getChat();
    if (chat.isGroup) {
      // chat.leave();
    } else {
      msg.reply("This command can only be used in a group!");
    }
  } else if (msg.body === "!chats") {
    const chats = await client.getChats();
    client.sendMessage(msg.from, `The bot has ${chats.length} chats open.`);
  } else if (msg.body === "!info") {
    let info = client.info;
    client.sendMessage(
      msg.from,
      `
                *Connection info*
                User name: ${info.pushname}
                My number: ${info.wid.user}
                Platform: ${info.platform}
            `
    );
  } else if (msg.body === "!mediainfo" && msg.hasMedia) {
    const attachmentData = await msg.downloadMedia();
    msg.reply(`
                *Media info*
                MimeType: ${attachmentData.mimetype}
                Filename: ${attachmentData.filename}
                Data (length): ${attachmentData.data.length}
            `);
  } else if (msg.body === "!quoteinfo" && msg.hasQuotedMsg) {
    const quotedMsg = await msg.getQuotedMessage();

    quotedMsg.reply(`
                ID: ${quotedMsg.id._serialized}
                Type: ${quotedMsg.type}
                Author: ${quotedMsg.author || quotedMsg.from}
                Timestamp: ${quotedMsg.timestamp}
                Has Media? ${quotedMsg.hasMedia}
            `);
  } else if (msg.body === "!resendmedia" && msg.hasQuotedMsg) {
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
  } else if (msg.body === "!isviewonce" && msg.hasQuotedMsg) {
    const quotedMsg = await msg.getQuotedMessage();
    if (quotedMsg.hasMedia) {
      const media = await quotedMsg.downloadMedia();
      await client.sendMessage(msg.from, media, { isViewOnce: true });
    }
  } else if (msg.body.startsWith("!status ")) {
    const newStatus = msg.body.split(" ")[1];
    await client.setStatus(newStatus);
    msg.reply(`Status was updated to *${newStatus}*`);
  } else if (msg.body === "!delete") {
    if (msg.hasQuotedMsg) {
      const quotedMsg = await msg.getQuotedMessage();
      if (quotedMsg.fromMe) {
        quotedMsg.delete(true);
      } else {
        msg.reply("I can only delete my own messages");
      }
    }
  } else if (msg.body === "!pin") {
    const chat = await msg.getChat();
    await chat.pin();
  } else if (msg.body === "!archive") {
    const chat = await msg.getChat();
    await chat.archive();
  } else if (msg.body === "!mute") {
    const chat = await msg.getChat();
    // mute the chat for 20 seconds
    const unmuteDate = new Date();
    unmuteDate.setSeconds(unmuteDate.getSeconds() + 20);
    await chat.mute(unmuteDate);
  } else if (msg.body === "!typing") {
    const chat = await msg.getChat();
    // simulates typing in the chat
    chat.sendStateTyping();
  } else if (msg.body === "!recording") {
    const chat = await msg.getChat();
    // simulates recording audio in the chat
    chat.sendStateRecording();
  } else if (msg.body === "!clearstate") {
    const chat = await msg.getChat();
    // stops typing or recording in the chat
    chat.clearState();
  } else if (msg.body === "!jumpto") {
    if (msg.hasQuotedMsg) {
      const quotedMsg = await msg.getQuotedMessage();
      client.interface.openChatWindowAt(quotedMsg.id._serialized);
    }
  } else if (msg.body === "!reaction") {
    msg.react("👍");
  } else if (msg.body === "!edit") {
    if (msg.hasQuotedMsg) {
      const quotedMsg = await msg.getQuotedMessage();
      if (quotedMsg.fromMe) {
        quotedMsg.edit(msg.body.replace("!edit", ""));
      } else {
        msg.reply("I can only edit my own messages");
      }
    }
  } else if (msg.body === "!updatelabels") {
    const chat = await msg.getChat();
    await chat.changeLabels([0, 1]);
  } else if (msg.body === "!addlabels") {
    const chat = await msg.getChat();
    let labels = (await chat.getLabels()).map((l) => l.id);
    labels.push("0");
    labels.push("1");
    await chat.changeLabels(labels);
  } else if (msg.body === "!removelabels") {
    const chat = await msg.getChat();
    await chat.changeLabels([]);
  }
}
