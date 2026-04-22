const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("parserApp", {
  importEml:  ()        => ipcRenderer.invoke("parser:import-eml"),
  parseFile:  (payload) => ipcRenderer.invoke("parser:parse-file", payload),
  resolvePath: (payload) => ipcRenderer.invoke("parser:resolve-path", payload),
  saveAssignment: (payload) => ipcRenderer.invoke("parser:save-assignment", payload),
  saveRejection: (payload) => ipcRenderer.invoke("parser:save-rejection", payload),
  teach: (payload) => ipcRenderer.invoke("parser:teach", payload),
  openFolder:       (folderPath)  => ipcRenderer.invoke("shell:open-folder", folderPath),
  pickFile:         (opts)        => ipcRenderer.invoke("dialog:pick-file", opts || {}),
  pickFolder:       ()            => ipcRenderer.invoke("dialog:pick-folder"),
  listAttachments:  (payload)     => ipcRenderer.invoke("email:list-attachments", payload),
  composeEmail:     (payload)     => ipcRenderer.invoke("email:compose", payload),
  setTitle:            (title)   => ipcRenderer.invoke("app:set-title", title),
  generateGiftLetter:  (payload) => ipcRenderer.invoke("documents:generate-gift-letter", payload),
  saveJson:            (payload) => ipcRenderer.invoke("file:save-json", payload),
  backupSave:          (payload) => ipcRenderer.invoke("backup:save", payload),
  backupRestore:       (payload) => ipcRenderer.invoke("backup:restore", payload),
  openFile:            (payload) => ipcRenderer.invoke("documents:open-file", payload),
});
