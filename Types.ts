// Message interface for RabbitMQ
export interface WhatsAppMessage {
  to: string | string[];
  message: string;
  type?: "text" | "media" | "base64";
  mediaUrl?: string;
  base64Data?: string;
  mimetype?: string;
  filename?: string;
  caption?: string;
  options?: {
    linkPreview?: boolean;
    isViewOnce?: boolean;
    sendAudioAsVoice?: boolean;
  };
}
