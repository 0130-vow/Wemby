const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("wemby", {
  getSettings: () => ipcRenderer.invoke("settings:get"),
  saveSettings: (settings) => ipcRenderer.invoke("settings:save", settings),
  findMpv: () => ipcRenderer.invoke("system:findMpv"),
  openExternal: (url) => ipcRenderer.invoke("system:openExternal", url),
  minimizeWindow: () => ipcRenderer.invoke("window:minimize"),
  toggleMaximizeWindow: () => ipcRenderer.invoke("window:toggleMaximize"),
  closeWindow: () => ipcRenderer.invoke("window:close"),
  login: (payload) => ipcRenderer.invoke("emby:login", payload),
  home: () => ipcRenderer.invoke("emby:home"),
  items: (payload) => ipcRenderer.invoke("emby:items", payload),
  search: (payload) => ipcRenderer.invoke("emby:search", payload),
  detail: (payload) => ipcRenderer.invoke("emby:detail", payload),
  episodes: (payload) => ipcRenderer.invoke("emby:episodes", payload),
  play: (payload) => ipcRenderer.invoke("player:play", payload),
  setPlayerBounds: (bounds) => ipcRenderer.invoke("player:setBounds", bounds),
  playerCommand: (payload) => ipcRenderer.invoke("player:command", payload),
  stopPlayer: () => ipcRenderer.invoke("player:stop"),
  getPlayerState: () => ipcRenderer.invoke("player:getState"),
  onPlayerState: (handler) => ipcRenderer.on("player:state", (_event, state) => handler(state)),
  onNotice: (handler) => ipcRenderer.on("app:notice", (_event, notice) => handler(notice))
});
