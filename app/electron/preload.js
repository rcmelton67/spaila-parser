const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("parserApp", {
  importEml: () => ipcRenderer.invoke("parser:import-eml"),
  resolvePath: (payload) => ipcRenderer.invoke("parser:resolve-path", payload),
  saveAssignment: (payload) => ipcRenderer.invoke("parser:save-assignment", payload),
  saveRejection: (payload) => ipcRenderer.invoke("parser:save-rejection", payload),
  teach: (payload) => ipcRenderer.invoke("parser:teach", payload),
  openFolder: (folderPath) => ipcRenderer.invoke("shell:open-folder", folderPath),
});
