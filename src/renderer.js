const state = {
  settings: {},
  home: null,
  currentView: "home",
  activeLibrary: null,
  activeItem: null,
  episodes: [],
  player: {
    active: false,
    title: "",
    positionSeconds: 0,
    durationSeconds: 0,
    isPaused: false
  },
  returnItemId: null,
  loading: false
};

const appEl = document.querySelector("#app");

function formatMinutes(ticks) {
  if (!ticks) return "";
  const minutes = Math.round(ticks / 10000000 / 60);
  if (minutes < 60) return `${minutes} 分钟`;
  return `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分钟`;
}

function formatClock(seconds) {
  const total = Math.max(0, Math.floor(seconds || 0));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  if (hours) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
  }
  return `${minutes}:${String(secs).padStart(2, "0")}`;
}

function episodeCode(item) {
  if (!item.SeriesName) return "";
  const season = item.ParentIndexNumber ? `S${String(item.ParentIndexNumber).padStart(2, "0")}` : "";
  const episode = item.IndexNumber ? `E${String(item.IndexNumber).padStart(2, "0")}` : "";
  return `${season}${episode}`;
}

function posterStyle(item) {
  const image = item.PrimaryImageUrl || item.ThumbImageUrl || item.BackdropImageUrl;
  return image ? `style="background-image:url('${image.replace(/'/g, "%27")}')"` : "";
}

function setNotice(message, type = "info") {
  const notice = document.querySelector(".notice");
  if (!notice) return;
  notice.textContent = message;
  notice.dataset.type = type;
  notice.hidden = !message;
}

function renderShell(content) {
  const loggedIn = state.settings?.accessToken && state.settings?.server;
  appEl.innerHTML = `
    <div class="shell view-${state.currentView}">
      <aside class="sidebar">
        <button class="brand" data-action="home">
          <span class="brand-mark">W</span>
          <span class="brand-name">Wemby</span>
        </button>
        <nav class="nav">
          <span class="nav-label">媒体</span>
          <button data-action="home" class="${state.currentView === "home" ? "active" : ""}"><span class="nav-icon home-icon"></span>首页</button>
          <button data-action="search" class="${state.currentView === "search" ? "active" : ""}"><span class="nav-icon search-icon"></span>搜索</button>
          <span class="nav-label">我的</span>
          <button data-action="settings" class="${state.currentView === "settings" ? "active" : ""}"><span class="nav-icon settings-icon"></span>设置</button>
        </nav>
        <div class="server-pill">
          <span>${loggedIn ? state.settings.userName || state.settings.username || "已登录" : "未登录"}</span>
          <small>${loggedIn ? state.settings.server : "连接 Emby 后开始"}</small>
        </div>
      </aside>
      <main class="main">
        <header class="app-header">
          <div class="app-title">
            <span>${state.currentView === "player" ? "正在播放" : "媒体库"}</span>
            <small>${loggedIn ? "Emby 已连接" : "未连接"}</small>
          </div>
          <div class="app-actions">
            <button class="icon-button" data-action="search" title="搜索" aria-label="搜索"><span class="search-icon"></span></button>
            <button class="icon-button" data-action="settings" title="设置" aria-label="设置"><span class="settings-icon"></span></button>
            <span class="avatar">${(state.settings.userName || state.settings.username || "W").slice(0, 1).toUpperCase()}</span>
            <span class="window-controls" aria-label="窗口控制">
              <button class="window-button" data-window-action="minimize" title="最小化" aria-label="最小化"></button>
              <button class="window-button maximize" data-window-action="toggleMaximize" title="最大化" aria-label="最大化"></button>
              <button class="window-button close" data-window-action="close" title="关闭" aria-label="关闭"></button>
            </span>
          </div>
        </header>
        <div class="notice" hidden></div>
        <div class="content">${content}</div>
      </main>
    </div>
  `;
}

function renderLogin() {
  renderShell(`
    <section class="login-panel">
      <form id="loginForm" class="form">
        <h1>连接 Emby</h1>
        <label>
          <span>服务器</span>
          <input name="server" placeholder="http://192.168.1.10:8096" value="${state.settings.server || ""}" required />
        </label>
        <label>
          <span>用户名</span>
          <input name="username" value="${state.settings.username || ""}" required />
        </label>
        <label>
          <span>密码</span>
          <input name="password" type="password" />
        </label>
        <button class="primary" type="submit">登录</button>
      </form>
    </section>
  `);
}

function mediaCard(item) {
  const progress = item.UserData?.PlaybackPositionTicks && item.RunTimeTicks
    ? Math.min(100, Math.round((item.UserData.PlaybackPositionTicks / item.RunTimeTicks) * 100))
    : 0;
  const sub = [
    item.Type === "Episode" ? episodeCode(item) : item.ProductionYear,
    formatMinutes(item.RunTimeTicks)
  ].filter(Boolean).join(" · ");

  return `
    <button class="media-card" data-item="${item.Id}">
      <span class="poster" ${posterStyle(item)}></span>
      ${progress ? `<span class="progress" style="width:${progress}%"></span>` : ""}
      <span class="media-title">${item.Name}</span>
      <span class="media-sub">${sub || item.Type || ""}</span>
    </button>
  `;
}

function renderRail(title, items = []) {
  if (!items.length) return "";
  return `
    <section class="rail">
      <div class="section-heading">
        <h2>${title}</h2>
        <button class="rail-more" type="button" aria-label="${title} 更多"></button>
      </div>
      <div class="media-row">${items.map(mediaCard).join("")}</div>
    </section>
  `;
}

function renderHomeHero(items = []) {
  const hero = items.find((item) => item.BackdropImageUrl || item.ThumbImageUrl || item.PrimaryImageUrl);
  if (!hero) return "";
  const image = hero.BackdropImageUrl || hero.ThumbImageUrl || hero.PrimaryImageUrl;
  const canPlay = hero.Type !== "Series";
  const resumeTicks = hero.UserData?.PlaybackPositionTicks || 0;
  const meta = [
    hero.ProductionYear,
    formatMinutes(hero.RunTimeTicks),
    hero.Type
  ].filter(Boolean).join(" · ");

  return `
    <section class="home-hero" style="background-image:linear-gradient(90deg, rgba(14,17,20,.96) 0%, rgba(14,17,20,.72) 44%, rgba(14,17,20,.2) 100%), url('${image.replace(/'/g, "%27")}')">
      <div class="hero-copy">
        <span class="eyebrow">${hero.SeriesName || "推荐观看"}</span>
        <h1>${hero.Name}</h1>
        <div class="hero-meta">${meta}</div>
        <p>${hero.Overview || "从这里继续你的观影。"} </p>
        <div class="actions">
          ${canPlay ? `<button class="primary play-button" data-play="${hero.Id}" data-start="${resumeTicks}"><span class="play-icon"></span>${resumeTicks ? "继续播放" : "播放"}</button>` : ""}
          <button class="round-button" data-item="${hero.Id}" title="查看详情" aria-label="查看详情">+</button>
        </div>
      </div>
      <div class="hero-dots" aria-hidden="true"><span></span><span></span><span></span><span></span></div>
    </section>
  `;
}

function getPlayerHostBounds() {
  const host = document.querySelector("#playerHost");
  if (!host) return null;
  const rect = host.getBoundingClientRect();
  return {
    x: rect.left,
    y: rect.top,
    width: rect.width,
    height: rect.height
  };
}

function updatePlayerChrome() {
  const title = document.querySelector("#playerTitle");
  const time = document.querySelector("#playerTime");
  const pause = document.querySelector("[data-player-command='togglePause']");
  if (title) title.textContent = state.player.title || "正在启动播放";
  if (time) {
    time.textContent = `${formatClock(state.player.positionSeconds)} / ${formatClock(state.player.durationSeconds)}`;
  }
  if (pause) pause.textContent = state.player.isPaused ? "继续" : "暂停";
}

async function syncPlayerBounds() {
  if (state.currentView !== "player") return;
  const bounds = getPlayerHostBounds();
  if (bounds) await window.wemby.setPlayerBounds(bounds);
}

function renderPlayerView(itemId) {
  state.currentView = "player";
  renderShell(`
    <section class="topbar player-topbar">
      <div>
        <h1 id="playerTitle">${state.player.title || "正在启动播放"}</h1>
        <p>mpv 内嵌播放，视频解码和拖动仍交给 mpv 处理。</p>
      </div>
      <button class="ghost" data-action="close-player">关闭播放</button>
    </section>
    <section class="embedded-player" data-playing-item="${itemId}">
      <div id="playerHost" class="player-host">
        <span>正在准备 mpv 画面...</span>
      </div>
      <div class="player-controls">
        <button class="ghost" data-player-command="seek" data-value="-10">-10 秒</button>
        <button class="primary" data-player-command="togglePause">暂停</button>
        <button class="ghost" data-player-command="seek" data-value="30">+30 秒</button>
        <span id="playerTime" class="player-time">0:00 / 0:00</span>
        <button class="ghost danger" data-action="close-player">停止</button>
      </div>
    </section>
  `);
  requestAnimationFrame(() => {
    syncPlayerBounds();
    updatePlayerChrome();
  });
}

async function renderHome() {
  state.currentView = "home";
  if (!state.settings?.accessToken) return renderLogin();
  renderShell(`<section class="loading">正在加载媒体库...</section>`);
  try {
    state.home = await window.wemby.home();
    const views = (state.home.views || []).map((view) => `
      <button class="library-button" data-library="${view.Id}">
        <span>${view.Name}</span>
        <small>${view.CollectionType || "媒体库"}</small>
      </button>
    `).join("");
    renderShell(`
      ${renderHomeHero([...(state.home.resume || []), ...(state.home.latest || [])])}
      <section class="topbar library-topbar">
        <div>
          <h1>首页</h1>
          <p>继续观看、最新入库和媒体库。</p>
        </div>
        <button class="ghost" data-action="refresh">刷新</button>
      </section>
      <section class="library-grid">${views}</section>
      ${renderRail("继续观看", state.home.resume)}
      ${renderRail("最新入库", state.home.latest)}
    `);
  } catch (error) {
    renderShell(`<section class="empty-state"><h1>连接失败</h1><p>${error.message}</p><button class="primary" data-action="settings">检查设置</button></section>`);
  }
}

async function renderLibrary(libraryId) {
  state.currentView = "library";
  state.activeLibrary = libraryId;
  renderShell(`<section class="loading">正在展开媒体库...</section>`);
  try {
    const data = await window.wemby.items({ parentId: libraryId });
    const library = state.home?.views?.find((item) => item.Id === libraryId);
    renderShell(`
      <section class="topbar">
        <div>
          <h1>${library?.Name || "媒体库"}</h1>
          <p>${data.TotalRecordCount || data.Items?.length || 0} 个条目</p>
        </div>
        <button class="ghost" data-action="home">返回</button>
      </section>
      <section class="media-grid">${(data.Items || []).map(mediaCard).join("")}</section>
    `);
  } catch (error) {
    renderShell(`<section class="empty-state"><h1>加载失败</h1><p>${error.message}</p></section>`);
  }
}

function renderSearch() {
  state.currentView = "search";
  renderShell(`
    <section class="search-view">
      <form id="searchForm" class="search-box">
        <input name="query" placeholder="搜索电影、剧集或单集" autofocus />
        <button class="primary" type="submit">搜索</button>
      </form>
      <section id="searchResults" class="media-grid"></section>
    </section>
  `);
}

async function performSearch(query) {
  const results = document.querySelector("#searchResults");
  results.innerHTML = `<div class="loading inline">搜索中...</div>`;
  try {
    const data = await window.wemby.search({ query });
    results.innerHTML = (data.Items || []).length
      ? data.Items.map(mediaCard).join("")
      : `<div class="empty-state compact"><h2>没有结果</h2><p>换个关键词试试。</p></div>`;
  } catch (error) {
    results.innerHTML = `<div class="empty-state compact"><h2>搜索失败</h2><p>${error.message}</p></div>`;
  }
}

async function renderDetail(itemId) {
  state.currentView = "detail";
  renderShell(`<section class="loading">正在读取详情...</section>`);
  try {
    const item = await window.wemby.detail({ itemId });
    state.activeItem = item;
    state.episodes = [];
    if (item.Type === "Series") {
      const data = await window.wemby.episodes({ seriesId: item.Id });
      state.episodes = data.Items || [];
    }

    const resumeTicks = item.UserData?.PlaybackPositionTicks || 0;
    const background = item.BackdropImageUrl || item.ThumbImageUrl || item.PrimaryImageUrl || "";
    renderShell(`
      <section class="detail-hero" style="${background ? `background-image:linear-gradient(90deg, rgba(16,19,24,.98), rgba(16,19,24,.78), rgba(16,19,24,.48)), url('${background.replace(/'/g, "%27")}')` : ""}">
        <button class="ghost back" data-action="back">返回</button>
        <div class="detail-copy">
          <span class="eyebrow">${item.Type || ""} ${item.ProductionYear || ""}</span>
          <h1>${item.Name}</h1>
          <p>${item.Overview || "暂无简介。"}</p>
          <div class="detail-meta">
            <span>${formatMinutes(item.RunTimeTicks)}</span>
            ${item.Genres?.slice(0, 4).map((genre) => `<span>${genre}</span>`).join("") || ""}
          </div>
          <div class="actions">
            ${item.Type !== "Series" ? `<button class="primary" data-play="${item.Id}" data-start="${resumeTicks}">${resumeTicks ? "继续播放" : "播放"}</button>` : ""}
            ${resumeTicks && item.Type !== "Series" ? `<button class="ghost" data-play="${item.Id}" data-start="0">从头播放</button>` : ""}
          </div>
        </div>
      </section>
      ${state.episodes.length ? `
        <section class="rail">
          <div class="section-heading"><h2>剧集</h2></div>
          <div class="episode-list">
            ${state.episodes.map((episode) => `
              <button class="episode" data-item="${episode.Id}">
                <span>${episodeCode(episode)}</span>
                <strong>${episode.Name}</strong>
                <small>${formatMinutes(episode.RunTimeTicks)}</small>
              </button>
            `).join("")}
          </div>
        </section>
      ` : ""}
    `);
  } catch (error) {
    renderShell(`<section class="empty-state"><h1>详情加载失败</h1><p>${error.message}</p></section>`);
  }
}

function renderSettings() {
  state.currentView = "settings";
  renderShell(`
    <section class="settings-view">
      <form id="settingsForm" class="form wide">
        <h1>设置</h1>
        <label>
          <span>Emby 服务器</span>
          <input name="server" value="${state.settings.server || ""}" placeholder="http://host:8096" />
        </label>
        <label>
          <span>mpv.exe 路径</span>
          <input name="mpvPath" value="${state.settings.mpvPath || ""}" placeholder="留空则自动查找 PATH 或 vendor/mpv/mpv.exe" />
        </label>
        <div class="form-actions">
          <button class="primary" type="submit">保存</button>
          <button class="ghost" type="button" data-action="detect-mpv">检测 mpv</button>
          <button class="ghost" type="button" data-action="login">重新登录</button>
        </div>
      </form>
    </section>
  `);
}

async function play(itemId, startTicks = 0) {
  state.returnItemId = state.activeItem?.Id || null;
  state.player = {
    active: true,
    title: "正在启动播放",
    positionSeconds: 0,
    durationSeconds: 0,
    isPaused: false
  };
  renderPlayerView(itemId);
  setNotice("正在启动 mpv...");
  try {
    const result = await window.wemby.play({
      itemId,
      startTicks: Number(startTicks || 0),
      hostBounds: getPlayerHostBounds()
    });
    state.player.title = result.title;
    updatePlayerChrome();
    setNotice(`已开始播放：${result.title}`, "success");
    setTimeout(() => setNotice(""), 3000);
  } catch (error) {
    setNotice(error.message, "error");
  }
}

async function loadSettings() {
  state.settings = await window.wemby.getSettings();
}

appEl.addEventListener("click", async (event) => {
  const actionButton = event.target.closest("[data-action]");
  const mediaButton = event.target.closest("[data-item]");
  const libraryButton = event.target.closest("[data-library]");
  const playButton = event.target.closest("[data-play]");
  const playerCommand = event.target.closest("[data-player-command]");
  const windowAction = event.target.closest("[data-window-action]");

  if (windowAction) {
    const action = windowAction.dataset.windowAction;
    if (action === "minimize") await window.wemby.minimizeWindow();
    if (action === "toggleMaximize") await window.wemby.toggleMaximizeWindow();
    if (action === "close") await window.wemby.closeWindow();
    return;
  }

  if (playerCommand) {
    await window.wemby.playerCommand({
      action: playerCommand.dataset.playerCommand,
      value: playerCommand.dataset.value
    });
    return;
  }

  if (playButton) {
    await play(playButton.dataset.play, playButton.dataset.start);
    return;
  }

  if (mediaButton) {
    renderDetail(mediaButton.dataset.item);
    return;
  }

  if (libraryButton) {
    renderLibrary(libraryButton.dataset.library);
    return;
  }

  if (!actionButton) return;
  const action = actionButton.dataset.action;
  if (state.currentView === "player" && ["home", "search", "settings", "login", "back"].includes(action)) {
    await window.wemby.stopPlayer();
  }
  if (action === "home" || action === "refresh") renderHome();
  if (action === "search") renderSearch();
  if (action === "settings") renderSettings();
  if (action === "back") renderHome();
  if (action === "login") renderLogin();
  if (action === "close-player") {
    await window.wemby.stopPlayer();
    if (state.returnItemId) renderDetail(state.returnItemId);
    else renderHome();
  }
  if (action === "detect-mpv") {
    const found = await window.wemby.findMpv();
    setNotice(found ? `找到 mpv：${found}` : "未找到 mpv，请填写 mpv.exe 路径。", found ? "success" : "warn");
  }
});

appEl.addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.target;
  const data = Object.fromEntries(new FormData(form).entries());

  if (form.id === "loginForm") {
    setNotice("正在登录...");
    try {
      const result = await window.wemby.login(data);
      state.settings = result.settings;
      setNotice("登录成功", "success");
      await renderHome();
    } catch (error) {
      setNotice(error.message, "error");
    }
  }

  if (form.id === "searchForm") {
    if (data.query?.trim()) performSearch(data.query.trim());
  }

  if (form.id === "settingsForm") {
    state.settings = await window.wemby.saveSettings(data);
    setNotice("设置已保存", "success");
  }
});

window.addEventListener("resize", () => {
  syncPlayerBounds();
});

window.addEventListener("scroll", () => {
  syncPlayerBounds();
}, true);

window.wemby.onNotice((notice) => setNotice(notice.message, notice.type || "info"));
window.wemby.onPlayerState((playerState) => {
  state.player = { ...state.player, ...playerState };
  updatePlayerChrome();
});

loadSettings().then(() => {
  if (state.settings?.accessToken) renderHome();
  else renderLogin();
});
