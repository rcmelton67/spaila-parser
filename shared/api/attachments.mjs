import { API_ENDPOINTS } from "./endpoints.mjs";
import { normalizeAttachmentMetadata } from "../models/attachment.mjs";

export function createAttachmentsApi(apiClient) {
  return {
    async listForOrder(orderId) {
      const payload = await apiClient.get(API_ENDPOINTS.orderAttachments(orderId));
      const attachments = Array.isArray(payload?.attachments) ? payload.attachments : [];
      return attachments.map(normalizeAttachmentMetadata);
    },
  };
}
