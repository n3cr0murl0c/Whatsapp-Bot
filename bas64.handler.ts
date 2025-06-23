// Enhanced base64 image parsing and decoding functions
import { Buffer } from "buffer";
import type { WhatsAppMessage } from "./Types";
import { sanitizeMessage } from "./server2";
import { Client } from "whatsapp-web.js";

// Function to parse and validate base64 image data
export function parseBase64Image(base64String: string): {
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
export function isValidBase64(str: string): boolean {
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
export function getExtensionFromMimetype(mimetype: string): string {
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

// Enhanced sendWhatsAppMessage function with improved base64 handling
export async function sendWhatsAppMessage(
  client: Client,
  messageData: WhatsAppMessage
) {
  try {
    const recipients = Array.isArray(messageData.to)
      ? messageData.to
      : messageData.to.split(",").map((r) => r.trim());
    const results = [];

    for (const recipient of recipients) {
      try {
        let phoneNumber = recipient.includes("@c.us")
          ? recipient
          : `${recipient}@c.us`;

        let result;

        if (messageData.type === "base64" && messageData.base64Data) {
          console.log("Processing base64 media message...");

          // Parse and validate the base64 image
          const parsedImage = parseBase64Image(messageData.base64Data);

          if (!parsedImage) {
            throw new Error("Failed to parse base64 image data");
          }

          console.log(
            `Detected mimetype: ${parsedImage.mimetype}, extension: ${parsedImage.extension}`
          );

          // Validate that we have actual image data
          let buffer: Buffer;
          try {
            buffer = Buffer.from(parsedImage.data, "base64");
            console.log(`Base64 decoded to ${buffer.length} bytes`);

            if (buffer.length === 0) {
              throw new Error("Decoded image buffer is empty");
            }
          } catch (decodeError) {
            throw new Error(`Failed to decode base64 data: ${decodeError}`);
          }

          // Create MessageMedia object using whatsapp-web.js MessageMedia class
          const { MessageMedia } = require("whatsapp-web.js");
          const media = new MessageMedia(
            messageData.mimetype || parsedImage.mimetype,
            parsedImage.data,
            messageData.filename ||
              `image_${Date.now()}.${parsedImage.extension}`
          );

          // Use caption for base64 messages, sanitize the text
          const caption = sanitizeMessage(
            messageData.caption || messageData.message || ""
          );

          console.log("Sending base64 media to WhatsApp...");

          // Send with proper MessageMedia object and caption
          if (caption) {
            result = await client.sendMessage(phoneNumber, media, {
              caption: caption,
              ...messageData.options,
            });
          } else {
            result = await client.sendMessage(
              phoneNumber,
              media,
              messageData.options
            );
          }
        } else if (messageData.type === "media" && messageData.mediaUrl) {
          console.log("Processing media URL message...");

          // Handle media URL messages
          const response = await fetch(messageData.mediaUrl);

          if (!response.ok) {
            throw new Error(
              `Failed to fetch media: ${response.status} ${response.statusText}`
            );
          }

          const buffer = await response.arrayBuffer();
          const base64Data = Buffer.from(buffer).toString("base64");
          const contentType =
            response.headers.get("content-type") || "application/octet-stream";
          const filename =
            messageData.filename ||
            messageData.mediaUrl.split("/").pop() ||
            "media";

          // Create MessageMedia object
          const { MessageMedia } = require("whatsapp-web.js");
          const media = new MessageMedia(contentType, base64Data, filename);

          const caption = sanitizeMessage(messageData.caption || "");

          if (caption) {
            result = await client.sendMessage(phoneNumber, media, {
              caption: caption,
              ...messageData.options,
            });
          } else {
            result = await client.sendMessage(
              phoneNumber,
              media,
              messageData.options
            );
          }
        } else {
          // Handle text messages - sanitize the message
          const sanitizedMessage = sanitizeMessage(messageData.message);

          if (!sanitizedMessage) {
            throw new Error("Message is empty after sanitization");
          }

          result = await client.sendMessage(
            phoneNumber,
            sanitizedMessage,
            messageData.options
          );
        }

        results.push({
          recipient: phoneNumber,
          success: true,
          messageId: result.id._serialized,
        });
        console.log(`📤 Message sent successfully to ${phoneNumber}`);

        // Add a small delay between messages to avoid rate limiting
        await new Promise((resolve) => setTimeout(resolve, 1000));
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

// Example usage for testing base64 parsing
function testBase64Parsing() {
  // Test with data URL format
  const dataUrl = "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEAAAAAAAD...";
  const parsed = parseBase64Image(dataUrl);
  console.log("Parsed data URL:", parsed);

  // Test with raw base64
  const rawBase64 = "/9j/4AAQSkZJRgABAQEAAAAAAAD...";
  const parsed2 = parseBase64Image(rawBase64);
  console.log("Parsed raw base64:", parsed2);
}
