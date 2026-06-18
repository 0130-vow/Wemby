const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("wemby", {
  getSettings: () => ipcRenderer.invoke("settings:get"),
  saveSettings: (settings) => ipcRenderer.invoke("settings:save", settings),
  findMpv: () => ipcRenderer.invoke("system:findMpv"),
  openExternal: (url) => ipcRenderer.invoke("system:openExternal", url),
  login: (payload) => ipcRenderer.invoke("emby:login", payload),
  home: () => ipcRenderer.invoke("emby:home"),
  items: (payload) => ipcRenderer.invoke("emby:items", payload),
  search: (payload) => ipcRenderer.invoke("emby:search", payload),
  detail: (payload) => ipcRenderer.invoke("emby:detail", payload),
  episodes: (payload) => ipcRenderer.invoke("emby:episodes", payload),
  play: (payload) => ipcRenderer.invoke("player:play", payload),
  onNotice: (handler) => ipcRenderer.on("app:notice", (_event, notice) => handler(notice))
});
