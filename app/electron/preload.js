const { contextBridge, ipcRenderer, webUtils } = require("electron");

contextBridge.exposeInMainWorld("parserApp", {
  parseFile:  (payload) => ipcRenderer.invoke("parser:parse-file", payload),
  resolvePath: (payload) => ipcRenderer.invoke("parser:resolve-path", payload),
  saveAssignment: (payload) => ipcRenderer.invoke("parser:save-assignment", payload),
  saveRejection: (payload) => ipcRenderer.invoke("parser:save-rejection", payload),
  getLearningSummary: () => ipcRenderer.invoke("parser:learning-summary"),
  resetFieldLearning: (payload) => ipcRenderer.invoke("parser:reset-field-learning", payload || {}),
  teach: (payload) => ipcRenderer.invoke("parser:teach", payload),
  getWorkspaceState: (payload) => ipcRenderer.invoke("workspace:get-state", payload || {}),
  addFilesToInbox: (payload) => ipcRenderer.invoke("workspace:add-to-inbox", payload || {}),
  openInboxItem: (payload) => ipcRenderer.invoke("workspace:open-inbox-item", payload || {}),
  openAttachment: (payload) => ipcRenderer.invoke("workspace:open-attachment", payload || {}),
  getAttachmentInfo: (payload) => ipcRenderer.invoke("workspace:attachment-info", payload || {}),
  hideInboxItem: (payload) => ipcRenderer.invoke("workspace:hide-inbox-item", payload || {}),
  hideInboxWorkspaceOnly: (payload) => ipcRenderer.invoke("workspace:hide-inbox-workspace-only", payload || {}),
  markInboxOrder: (payload) => ipcRenderer.invoke("workspace:mark-inbox-order", payload || {}),
  markInboxNotOrder: (payload) => ipcRenderer.invoke("workspace:mark-inbox-not-order", payload || {}),
  undoInboxOrderMark: (payload) => ipcRenderer.invoke("workspace:undo-inbox-order-mark", payload || {}),
  setInboxLinkedOrder: (payload) => ipcRenderer.invoke("workspace:set-inbox-linked-order", payload || {}),
  getHelperState:   ()            => ipcRenderer.invoke("helper:get-state"),
  saveHelperSettings: (payload)   => ipcRenderer.invoke("helper:save-settings", payload || {}),
  restartHelper:    ()            => ipcRenderer.invoke("helper:restart"),
  openHelperLogs:   ()            => ipcRenderer.invoke("helper:open-logs"),
  openHelperFolder: (payload)     => ipcRenderer.invoke("helper:open-folder", payload || {}),
  clearHelperFolder: (payload)    => ipcRenderer.invoke("helper:clear-folder", payload || {}),
  pickUnmatchedFolder: ()         => ipcRenderer.invoke("helper:pick-unmatched-folder"),
  openFolder:       (folderPath)  => ipcRenderer.invoke("shell:open-folder", folderPath),
  pickFile:         (opts)        => ipcRenderer.invoke("dialog:pick-file", opts || {}),
  pickFolder:       ()            => ipcRenderer.invoke("dialog:pick-folder"),
  listAttachments:  (payload)     => ipcRenderer.invoke("email:list-attachments", payload),
  getEmailEnvironment: ()         => ipcRenderer.invoke("email:get-environment"),
  resolveAttachments: (payload)   => ipcRenderer.invoke("email:resolve-attachments", payload || {}),
  composeEmail:     (payload)     => ipcRenderer.invoke("email:compose", payload),
  testSmtpConnection: (payload)   => ipcRenderer.invoke("email:test-smtp", payload || {}),
  testImapConnection: (payload)   => ipcRenderer.invoke("email:test-imap", payload || {}),
  sendDockEmail:    (payload)     => ipcRenderer.invoke("email:send-smtp", payload || {}),
  getFilePath:       (file)       => webUtils.getPathForFile(file),
  setTitle:            (title)   => ipcRenderer.invoke("app:set-title", title),
  getSupportAppInfo:   ()        => ipcRenderer.invoke("support:get-app-info"),
  createSupportDiagnostics: (payload) => ipcRenderer.invoke("support:create-diagnostics", payload || {}),
  exportPrintPdf:      (payload) => ipcRenderer.invoke("orders:export-print-pdf", payload),
  generateGiftLetter:  (payload) => ipcRenderer.invoke("documents:generate-gift-letter", payload),
  copyDocumentToDocs:  (payload) => ipcRenderer.invoke("documents:copy-to-docs", payload || {}),
  syncThankYouTemplate:(payload) => ipcRenderer.invoke("documents:sync-thank-you-template", payload || {}),
  saveJson:            (payload) => ipcRenderer.invoke("file:save-json", payload),
  backupSave:          (payload) => ipcRenderer.invoke("backup:save", payload),
  backupRestore:       (payload) => ipcRenderer.invoke("backup:restore", payload),
  onBackupProgress:    (callback) => {
    if (typeof callback !== "function") return () => {};
    const handler = (_event, payload) => callback(payload || {});
    ipcRenderer.on("backup:progress", handler);
    return () => ipcRenderer.removeListener("backup:progress", handler);
  },
  onRestoreProgress:   (callback) => {
    if (typeof callback !== "function") return () => {};
    const handler = (_event, payload) => callback(payload || {});
    ipcRenderer.on("restore:progress", handler);
    return () => ipcRenderer.removeListener("restore:progress", handler);
  },
  openFile:            (payload) => ipcRenderer.invoke("documents:open-file", payload),
  getAccountProfile:   ()        => ipcRenderer.invoke("account:get-profile"),
  updateAccountProfile:(patch)   => ipcRenderer.invoke("account:update-profile", patch || {}),
  getOrderFieldLayout: ()        => ipcRenderer.invoke("account:get-order-field-layout"),
  updateOrderFieldLayout: (layout) => ipcRenderer.invoke("account:update-order-field-layout", layout || {}),
  getPricingRules:     ()        => ipcRenderer.invoke("account:get-pricing-rules"),
  updatePricingRules:  (rules)   => ipcRenderer.invoke("account:update-pricing-rules", rules || {}),
});

contextBridge.exposeInMainWorld("electronAPI", {
  openExternal: (url) => ipcRenderer.invoke("open-external", url),
});
