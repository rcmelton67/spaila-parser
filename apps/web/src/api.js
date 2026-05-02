import { createApiClient } from "../../../shared/api/client.mjs";
import { createArchiveApi } from "../../../shared/api/archive.mjs";
import { createAttachmentsApi } from "../../../shared/api/attachments.mjs";
import { createOrdersApi } from "../../../shared/api/orders.mjs";
import { createSettingsApi } from "../../../shared/api/settings.mjs";

export const api = createApiClient();
export const ordersApi = createOrdersApi(api);
export const archiveApi = createArchiveApi(api);
export const attachmentsApi = createAttachmentsApi(api);
export const settingsApi = createSettingsApi(api);
