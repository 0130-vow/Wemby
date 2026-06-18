const { app, BrowserWindow, ipcMain, shell } = require("electron");
const { spawn, execFile } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const net = require("net");
const os = require("os");
const path = require("path");

const APP_NAME = "Wemby";
const CLIENT_VERSION = "0.1.0";
const DIRECT_TYPES = ["Movie", "Episode", "Video"];
const ITEM_FIELDS = [
  "PrimaryImageAspectRatio",
  "Overview",
  "MediaSources",
  "RunTimeTicks",
  "Genres",
  "DateCreated",
  "ProductionYear",
  "UserData",
  "ChildCount",
  "SeriesName",
  "ParentIndexNumber",
  "IndexNumber"
].join(",");

let mainWindow;
let activePlayback = null;
let playerWindow = null;
let lastPlayerHostBounds = null;
let mpvProvisionPromise = null;

function settingsPath() {
  return path.join(app.getPath("userData"), "settings.json");
}

function readSettings() {
  try {
    return JSON.parse(fs.readFileSync(settingsPath(), "utf8"));
  } catch {
    return {};
  }
}

function saveSettings(settings) {
  const previous = readSettings();
  const next = { ...previous, ...settings };
  fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
  fs.writeFileSync(settingsPath(), JSON.stringify(next, null, 2));
  return next;
}

function getDeviceId() {
  const settings = readSettings();
  if (settings.deviceId) return settings.deviceId;
  const deviceId = crypto.randomUUID();
  saveSettings({ deviceId });
  return deviceId;
}

function authHeader(token, userId) {
  const pairs = [
    `Client="${APP_NAME}"`,
    `Device="${os.hostname()}"`,
    `DeviceId="${getDeviceId()}"`,
    `Version="${CLIENT_VERSION}"`
  ];
  if (userId) pairs.push(`UserId="${userId}"`);
  if (token) pairs.push(`Token="${token}"`);
  return `Emby ${pairs.join(", ")}`;
}

function normalizeServer(server) {
  if (!server) throw new Error("请填写 Emby 服务器地址");
  const trimmed = server.trim().replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(trimmed)) {
    return `http://${trimmed}`;
  }
  return trimmed;
}

function apiUrl(server, apiPath, params = {}) {
  const base = normalizeServer(server);
  const root = /\/emby$/i.test(base) ? base : `${base}/emby`;
  const url = new URL(`${root}${apiPath}`);
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, String(value));
    }
  });
  return url.toString();
}

async function embyFetch(apiPath, options = {}) {
  const settings = readSettings();
  const server = options.server || settings.server;
  const token = options.token || settings.accessToken;
  const userId = options.userId || settings.userId;
  const url = apiUrl(server, apiPath, options.params);
  const headers = {
    "Accept": "application/json",
    "Content-Type": "application/json",
    "X-Emby-Authorization": authHeader(token, userId),
    ...(options.headers || {})
  };
  if (token) headers["X-Emby-Token"] = token;

  const response = await fetch(url, {
    method: options.method || "GET",
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Emby API ${response.status}: ${text || response.statusText}`);
  }

  const text = await response.text();
  return text ? JSON.parse(text) : {};
}

function imageUrl(item, tagName = "Primary", width = 440) {
  const settings = readSettings();
  if (!item?.Id || !settings.server) return null;
  return apiUrl(settings.server, `/Items/${item.Id}/Images/${tagName}`, {
    maxWidth: width,
    quality: 88,
    tag: item.ImageTags?.[tagName]
  });
}

function enrichItem(item) {
  return {
    ...item,
    PrimaryImageUrl: imageUrl(item, "Primary", 520),
    BackdropImageUrl: item.BackdropImageTags?.length
      ? apiUrl(readSettings().server, `/Items/${item.Id}/Images/Backdrop/0`, { maxWidth: 1200, quality: 86 })
      : null,
    ThumbImageUrl: imageUrl(item, "Thumb", 700)
  };
}

function userRuntimeMpvPath() {
  return path.join(app.getPath("userData"), "runtime", "mpv", "mpv.exe");
}

function notify(type, message) {
  mainWindow?.webContents.send("app:notice", { type, message });
}

async function findMpv() {
  const settings = readSettings();
  const candidates = [
    settings.mpvPath,
    userRuntimeMpvPath(),
    path.join(app.getAppPath(), "vendor", "mpv", "mpv.exe"),
    path.join(process.cwd(), "vendor", "mpv", "mpv.exe")
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }

  const command = process.platform === "win32" ? "where" : "which";
  const names = process.platform === "win32" ? ["mpv.exe", "mpv"] : ["mpv"];
  for (const name of names) {
    const found = await new Promise((resolve) => {
      execFile(command, [name], { windowsHide: true }, (error, stdout) => {
        resolve(error ? null : stdout.split(/\r?\n/).find(Boolean));
      });
    });
    if (found) return found.trim();
  }

  return null;
}

function isInside(parent, target) {
  const relative = path.relative(parent, target);
  return relative && !relative.startsWith("..") && !path.isAbsolute(relative);
}

async function downloadFile(url, targetPath) {
  const response = await fetch(url, {
    headers: {
      "User-Agent": `${APP_NAME}/${CLIENT_VERSION}`,
      "Accept": "application/octet-stream"
    }
  });
  if (!response.ok) {
    throw new Error(`下载 mpv 失败：HTTP ${response.status}`);
  }
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  const buffer = Buffer.from(await response.arrayBuffer());
  fs.writeFileSync(targetPath, buffer);
}

async function extractArchive(archivePath, destination) {
  fs.mkdirSync(destination, { recursive: true });
  await new Promise((resolve, reject) => {
    execFile("tar", ["-xf", archivePath, "-C", destination], { windowsHide: true }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`解压 mpv 失败：${stderr || error.message}`));
      } else {
        resolve(stdout);
      }
    });
  });
}

function findFileRecursive(root, fileName) {
  const entries = fs.readdirSync(root, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(root, entry.name);
    if (entry.isFile() && entry.name.toLowerCase() === fileName.toLowerCase()) return fullPath;
    if (entry.isDirectory()) {
      const found = findFileRecursive(fullPath, fileName);
      if (found) return found;
    }
  }
  return null;
}

function selectMpvAsset(assets) {
  const arch = process.arch === "arm64" ? "aarch64" : "x86_64";
  const exact = new RegExp(`^mpv-${arch}-\\\\d{8}-git-[a-z0-9]+\\\\.7z$`, "i");
  return assets.find((asset) => exact.test(asset.name))
    || assets.find((asset) => asset.name.startsWith(`mpv-${arch}-`) && asset.name.endsWith(".7z") && !asset.name.includes("debug") && !asset.name.includes("dev") && !asset.name.includes("-v3-"));
}

async function downloadBundledMpv() {
  const existing = await findMpv();
  if (existing) return existing;

  notify("info", "首次播放正在准备内置 mpv，请稍等...");
  const releaseResponse = await fetch("https://api.github.com/repos/zhongfly/mpv-winbuild/releases/latest", {
    headers: {
      "User-Agent": `${APP_NAME}/${CLIENT_VERSION}`,
      "Accept": "application/vnd.github+json"
    }
  });
  if (!releaseResponse.ok) {
    throw new Error(`获取 mpv 下载信息失败：HTTP ${releaseResponse.status}`);
  }

  const release = await releaseResponse.json();
  const asset = selectMpvAsset(release.assets || []);
  if (!asset?.browser_download_url) {
    throw new Error("没有找到适合当前系统的 mpv Windows 构建。");
  }

  const runtimeRoot = path.join(app.getPath("userData"), "runtime");
  const downloadPath = path.join(runtimeRoot, "downloads", asset.name);
  const extractRoot = path.join(runtimeRoot, "mpv-extract");
  const targetRoot = path.dirname(userRuntimeMpvPath());

  for (const target of [extractRoot, targetRoot]) {
    if (fs.existsSync(target)) {
      if (!isInside(app.getPath("userData"), target)) throw new Error(`拒绝清理异常路径：${target}`);
      fs.rmSync(target, { recursive: true, force: true });
    }
  }

  notify("info", `正在下载内置 mpv：${asset.name}`);
  await downloadFile(asset.browser_download_url, downloadPath);
  notify("info", "正在解压内置 mpv...");
  await extractArchive(downloadPath, extractRoot);

  const extractedMpv = findFileRecursive(extractRoot, "mpv.exe");
  if (!extractedMpv) throw new Error("mpv 下载完成，但压缩包里没有找到 mpv.exe。");

  fs.mkdirSync(targetRoot, { recursive: true });
  fs.cpSync(path.dirname(extractedMpv), targetRoot, { recursive: true });
  if (!fs.existsSync(userRuntimeMpvPath())) {
    throw new Error("mpv 已解压，但安装目录里没有找到 mpv.exe。");
  }

  saveSettings({ bundledMpvPath: userRuntimeMpvPath(), bundledMpvVersion: release.tag_name });
  notify("success", "内置 mpv 已准备好，正在启动播放。");
  return userRuntimeMpvPath();
}

async function ensureMpv() {
  const existing = await findMpv();
  if (existing) return existing;
  if (!mpvProvisionPromise) {
    mpvProvisionPromise = downloadBundledMpv().finally(() => {
      mpvProvisionPromise = null;
    });
  }
  return mpvProvisionPromise;
}

function buildStreamUrl(itemId, mediaSourceId, startTicks = 0) {
  const settings = readSettings();
  return apiUrl(settings.server, `/Videos/${itemId}/stream`, {
    static: "true",
    MediaSourceId: mediaSourceId,
    api_key: settings.accessToken,
    StartTimeTicks: startTicks || undefined
  });
}

async function sendPlaybackEvent(kind, payload) {
  try {
    const map = {
      start: "/Sessions/Playing",
      progress: "/Sessions/Playing/Progress",
      stopped: "/Sessions/Playing/Stopped"
    };
    await embyFetch(map[kind], { method: "POST", body: payload });
  } catch (error) {
    mainWindow?.webContents.send("app:notice", {
      type: "warn",
      message: `播放进度上报失败：${error.message}`
    });
  }
}

function ticksFromSeconds(seconds) {
  return Math.max(0, Math.round((seconds || 0) * 10000000));
}

function nativeWindowHandleToString(buffer) {
  if (process.platform === "win32" && buffer.length >= 8) {
    return buffer.readBigUInt64LE(0).toString();
  }
  return String(buffer.readUInt32LE(0));
}

function notifyPlayerState(extra = {}) {
  if (!mainWindow) return;
  mainWindow.webContents.send("player:state", {
    active: Boolean(activePlayback?.process && !activePlayback.process.killed),
    itemId: activePlayback?.itemId || null,
    title: activePlayback?.title || "",
    positionSeconds: activePlayback?.positionSeconds || 0,
    durationSeconds: activePlayback?.durationSeconds || 0,
    isPaused: Boolean(activePlayback?.isPaused),
    volume: activePlayback?.volume ?? 100,
    isMuted: Boolean(activePlayback?.isMuted),
    speed: activePlayback?.speed || 1,
    embedded: Boolean(activePlayback?.embedded),
    ...extra
  });
}

function ensurePlayerWindow() {
  if (playerWindow && !playerWindow.isDestroyed()) return playerWindow;

  playerWindow = new BrowserWindow({
    parent: mainWindow,
    width: 640,
    height: 360,
    frame: false,
    show: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    backgroundColor: "#000000",
    title: "Wemby Player",
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true
    }
  });

  playerWindow.loadURL("data:text/html,<html><body style='margin:0;background:#000'></body></html>");
  playerWindow.on("closed", () => {
    playerWindow = null;
  });
  return playerWindow;
}

function setPlayerWindowBounds(rect) {
  if (!rect || !mainWindow || mainWindow.isDestroyed()) return;
  lastPlayerHostBounds = rect;
  const win = ensurePlayerWindow();
  const content = mainWindow.getContentBounds();
  const bounds = {
    x: Math.round(content.x + Number(rect.x || 0)),
    y: Math.round(content.y + Number(rect.y || 0)),
    width: Math.max(80, Math.round(Number(rect.width || 0))),
    height: Math.max(45, Math.round(Number(rect.height || 0)))
  };
  win.setBounds(bounds, false);
  if (!win.isVisible()) win.showInactive();
}

function destroyPlayerWindow() {
  if (playerWindow && !playerWindow.isDestroyed()) {
    playerWindow.destroy();
  }
  playerWindow = null;
  lastPlayerHostBounds = null;
}

function sendMpvCommand(command) {
  if (!activePlayback?.socket || activePlayback.socket.destroyed) return false;
  activePlayback.socket.write(`${JSON.stringify({ command })}\n`);
  return true;
}

function stopActivePlayback() {
  if (activePlayback?.process && !activePlayback.process.killed) {
    activePlayback.process.kill();
    return true;
  }
  destroyPlayerWindow();
  notifyPlayerState({ active: false });
  return false;
}

async function attachMpvIpc(pipePath, playback) {
  let tries = 0;
  const socket = new net.Socket();

  await new Promise((resolve, reject) => {
    const attempt = () => {
      tries += 1;
      socket.connect(pipePath, resolve);
      socket.once("error", (error) => {
        socket.removeAllListeners("connect");
        if (tries > 30) reject(error);
        else setTimeout(attempt, 250);
      });
    };
    attempt();
  });

  let buffer = "";
  const send = (command) => socket.write(`${JSON.stringify({ command })}\n`);
  send(["observe_property", 1, "time-pos"]);
  send(["observe_property", 2, "duration"]);
  send(["observe_property", 3, "pause"]);
  send(["observe_property", 4, "volume"]);
  send(["observe_property", 5, "mute"]);
  send(["observe_property", 6, "speed"]);

  socket.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || "";
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line);
        if (event.event === "property-change") {
          if (event.name === "time-pos") playback.positionSeconds = Number(event.data || 0);
          if (event.name === "duration") playback.durationSeconds = Number(event.data || 0);
          if (event.name === "pause") playback.isPaused = Boolean(event.data);
          if (event.name === "volume") playback.volume = Number(event.data ?? playback.volume ?? 100);
          if (event.name === "mute") playback.isMuted = Boolean(event.data);
          if (event.name === "speed") playback.speed = Number(event.data || 1);
          notifyPlayerState();
        }
      } catch {
        // Ignore noisy IPC lines from mpv.
      }
    }
  });

  playback.socket = socket;
  notifyPlayerState();
}

async function playWithMpv(item, startTicks = 0, hostBounds = null) {
  if (!DIRECT_TYPES.includes(item.Type)) {
    throw new Error("当前条目不是可直接播放的视频，请打开剧集或电影条目。");
  }

  const mediaSource = item.MediaSources?.[0];
  const mediaSourceId = mediaSource?.Id || item.Id;
  const mpvPath = await ensureMpv();
  if (!mpvPath) {
    throw new Error("没有找到 mpv.exe，也无法自动准备内置 mpv。");
  }

  stopActivePlayback();

  let embeddedWindowId = null;
  if (hostBounds) {
    const win = ensurePlayerWindow();
    setPlayerWindowBounds(hostBounds);
    embeddedWindowId = nativeWindowHandleToString(win.getNativeWindowHandle());
  }

  const pipeName = `wemby-${process.pid}-${Date.now()}`;
  const pipePath = process.platform === "win32" ? `\\\\.\\pipe\\${pipeName}` : path.join(os.tmpdir(), pipeName);
  const streamUrl = buildStreamUrl(item.Id, mediaSourceId, startTicks);
  const title = item.SeriesName
    ? `${item.SeriesName} S${String(item.ParentIndexNumber || 0).padStart(2, "0")}E${String(item.IndexNumber || 0).padStart(2, "0")} ${item.Name}`
    : item.Name;

  const args = [
    streamUrl,
    "--force-window=yes",
    "--hwdec=auto-safe",
    "--profile=fast",
    "--cache=yes",
    "--demuxer-max-bytes=256MiB",
    "--demuxer-max-back-bytes=128MiB",
    "--demuxer-readahead-secs=60",
    "--hr-seek=yes",
    "--keep-open=no",
    "--no-terminal",
    `--title=${title}`,
    `--input-ipc-server=${pipePath}`,
    `--user-agent=${APP_NAME}/${CLIENT_VERSION}`
  ];
  if (embeddedWindowId) args.push(`--wid=${embeddedWindowId}`);

  const child = spawn(mpvPath, args, {
    detached: false,
    stdio: "ignore",
    windowsHide: Boolean(embeddedWindowId)
  });

  const playback = {
    itemId: item.Id,
    mediaSourceId,
    title,
    process: child,
    embedded: Boolean(embeddedWindowId),
    positionSeconds: startTicks / 10000000,
    durationSeconds: item.RunTimeTicks ? item.RunTimeTicks / 10000000 : 0,
    isPaused: false,
    volume: 100,
    isMuted: false,
    speed: 1,
    progressTimer: null,
    socket: null
  };
  activePlayback = playback;
  notifyPlayerState();

  await sendPlaybackEvent("start", {
    ItemId: item.Id,
    MediaSourceId: mediaSourceId,
    PlayMethod: "DirectStream",
    CanSeek: true,
    PositionTicks: startTicks
  });

  attachMpvIpc(pipePath, playback).catch(() => {
    mainWindow?.webContents.send("app:notice", {
      type: "warn",
      message: "mpv 已启动，但本次无法连接 IPC，播放进度可能不会实时同步。"
    });
  });

  playback.progressTimer = setInterval(() => {
    sendPlaybackEvent("progress", {
      ItemId: playback.itemId,
      MediaSourceId: playback.mediaSourceId,
      PlayMethod: "DirectStream",
      CanSeek: true,
      IsPaused: playback.isPaused,
      PositionTicks: ticksFromSeconds(playback.positionSeconds)
    });
  }, 10000);

  child.once("exit", () => {
    clearInterval(playback.progressTimer);
    playback.socket?.destroy();
    if (playback.embedded && activePlayback === playback) destroyPlayerWindow();
    sendPlaybackEvent("stopped", {
      ItemId: playback.itemId,
      MediaSourceId: playback.mediaSourceId,
      PositionTicks: ticksFromSeconds(playback.positionSeconds)
    });
    if (activePlayback === playback) activePlayback = null;
    notifyPlayerState({ active: false });
  });

  return { ok: true, title };
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 1040,
    minHeight: 680,
    backgroundColor: "#101318",
    title: APP_NAME,
    frame: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, "index.html"));
  mainWindow.on("move", () => {
    if (lastPlayerHostBounds) setPlayerWindowBounds(lastPlayerHostBounds);
  });
  mainWindow.on("resize", () => {
    if (lastPlayerHostBounds) setPlayerWindowBounds(lastPlayerHostBounds);
  });
}

app.whenReady().then(() => {
  ipcMain.handle("settings:get", () => readSettings());
  ipcMain.handle("settings:save", (_event, settings) => saveSettings(settings));
  ipcMain.handle("system:openExternal", (_event, url) => shell.openExternal(url));
  ipcMain.handle("system:findMpv", () => findMpv());
  ipcMain.handle("system:ensureMpv", () => ensureMpv());
  ipcMain.handle("window:minimize", () => {
    mainWindow?.minimize();
    return { ok: true };
  });
  ipcMain.handle("window:toggleMaximize", () => {
    if (!mainWindow) return { ok: false, maximized: false };
    if (mainWindow.isMaximized()) mainWindow.unmaximize();
    else mainWindow.maximize();
    return { ok: true, maximized: mainWindow.isMaximized() };
  });
  ipcMain.handle("window:close", () => {
    mainWindow?.close();
    return { ok: true };
  });

  ipcMain.handle("emby:login", async (_event, { server, username, password }) => {
    const normalizedServer = normalizeServer(server);
    const result = await embyFetch("/Users/AuthenticateByName", {
      server: normalizedServer,
      method: "POST",
      body: { Username: username, Pw: password },
      headers: { "X-Emby-Authorization": authHeader(null, null) }
    });

    const next = saveSettings({
      server: normalizedServer,
      username,
      accessToken: result.AccessToken,
      serverId: result.ServerId,
      userId: result.User?.Id,
      userName: result.User?.Name
    });

    return {
      settings: next,
      user: result.User,
      serverId: result.ServerId
    };
  });

  ipcMain.handle("emby:home", async () => {
    const settings = readSettings();
    if (!settings.server || !settings.accessToken || !settings.userId) {
      throw new Error("请先登录 Emby。");
    }

    const [views, latest, resume] = await Promise.all([
      embyFetch(`/Users/${settings.userId}/Views`),
      embyFetch(`/Users/${settings.userId}/Items/Latest`, {
        params: {
          Limit: 30,
          Fields: ITEM_FIELDS,
          ImageTypeLimit: 1,
          EnableImageTypes: "Primary,Backdrop,Thumb"
        }
      }),
      embyFetch(`/Users/${settings.userId}/Items/Resume`, {
        params: {
          Limit: 24,
          Recursive: true,
          Fields: ITEM_FIELDS,
          ImageTypeLimit: 1,
          EnableImageTypes: "Primary,Backdrop,Thumb"
        }
      })
    ]);

    return {
      views: (views.Items || []).map(enrichItem),
      latest: (latest || []).map(enrichItem),
      resume: (resume.Items || []).map(enrichItem)
    };
  });

  ipcMain.handle("emby:items", async (_event, { parentId, startIndex = 0, limit = 100 }) => {
    const settings = readSettings();
    const data = await embyFetch(`/Users/${settings.userId}/Items`, {
      params: {
        ParentId: parentId,
        Recursive: true,
        IncludeItemTypes: "Movie,Series,Episode,Video",
        SortBy: "SortName",
        SortOrder: "Ascending",
        Fields: ITEM_FIELDS,
        ImageTypeLimit: 1,
        EnableImageTypes: "Primary,Backdrop,Thumb",
        StartIndex: startIndex,
        Limit: limit
      }
    });
    return { ...data, Items: (data.Items || []).map(enrichItem) };
  });

  ipcMain.handle("emby:search", async (_event, { query }) => {
    const settings = readSettings();
    const data = await embyFetch(`/Users/${settings.userId}/Items`, {
      params: {
        SearchTerm: query,
        Recursive: true,
        IncludeItemTypes: "Movie,Series,Episode,Video",
        Limit: 60,
        Fields: ITEM_FIELDS,
        ImageTypeLimit: 1,
        EnableImageTypes: "Primary,Backdrop,Thumb"
      }
    });
    return { ...data, Items: (data.Items || []).map(enrichItem) };
  });

  ipcMain.handle("emby:detail", async (_event, { itemId }) => {
    const settings = readSettings();
    const item = await embyFetch(`/Users/${settings.userId}/Items/${itemId}`, {
      params: { Fields: ITEM_FIELDS }
    });
    return enrichItem(item);
  });

  ipcMain.handle("emby:episodes", async (_event, { seriesId }) => {
    const settings = readSettings();
    const data = await embyFetch(`/Shows/${seriesId}/Episodes`, {
      params: {
        UserId: settings.userId,
        Fields: ITEM_FIELDS,
        ImageTypeLimit: 1,
        EnableImageTypes: "Primary,Backdrop,Thumb"
      }
    });
    return { ...data, Items: (data.Items || []).map(enrichItem) };
  });

  ipcMain.handle("player:play", async (_event, { itemId, startTicks = 0, hostBounds = null }) => {
    const settings = readSettings();
    const item = await embyFetch(`/Users/${settings.userId}/Items/${itemId}`, {
      params: { Fields: ITEM_FIELDS }
    });
    return playWithMpv(item, startTicks, hostBounds);
  });

  ipcMain.handle("player:setBounds", (_event, bounds) => {
    setPlayerWindowBounds(bounds);
    return { ok: true };
  });

  ipcMain.handle("player:command", (_event, { action, value } = {}) => {
    if (action === "togglePause") return { ok: sendMpvCommand(["cycle", "pause"]) };
    if (action === "seek") return { ok: sendMpvCommand(["seek", Number(value || 0), "relative+exact"]) };
    if (action === "seekAbsolute") return { ok: sendMpvCommand(["seek", Number(value || 0), "absolute+exact"]) };
    if (action === "setVolume") return { ok: sendMpvCommand(["set_property", "volume", Math.max(0, Math.min(130, Number(value || 0)))]) };
    if (action === "toggleMute") return { ok: sendMpvCommand(["cycle", "mute"]) };
    if (action === "setSpeed") return { ok: sendMpvCommand(["set_property", "speed", Math.max(0.25, Math.min(3, Number(value || 1)))]) };
    if (action === "stop") return { ok: stopActivePlayback() };
    return { ok: false };
  });

  ipcMain.handle("player:stop", () => {
    stopActivePlayback();
    return { ok: true };
  });

  ipcMain.handle("player:getState", () => ({
    active: Boolean(activePlayback?.process && !activePlayback.process.killed),
    itemId: activePlayback?.itemId || null,
    title: activePlayback?.title || "",
    positionSeconds: activePlayback?.positionSeconds || 0,
    durationSeconds: activePlayback?.durationSeconds || 0,
    isPaused: Boolean(activePlayback?.isPaused),
    volume: activePlayback?.volume ?? 100,
    isMuted: Boolean(activePlayback?.isMuted),
    speed: activePlayback?.speed || 1,
    embedded: Boolean(activePlayback?.embedded)
  }));

  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
