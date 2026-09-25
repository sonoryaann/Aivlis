const THEMES = [
  "theme-wiki",
  "theme-blog2000",
  "theme-tabloid",
  "theme-corporate",
  "theme-forum",
  "theme-govdoc",
  "theme-terminal",
];

const FAVICON_COLORS = ["#e8710a", "#1a73e8", "#188038", "#d93025", "#9334e6", "#f9ab00", "#12b5cb"];

const TRENDING_QUERIES = [
  "chi ha inventato la pizza",
  "perché il cielo è blu",
  "chi sono i sette nani",
  "come funzionano le maree",
  "cos'è un meganoma",
  "perché i gatti fanno le fusa",
  "quanti anni ha l'universo",
  "chi ha costruito le piramidi",
];

const HISTORY_KEY = "aivlis_history";
const MAX_HISTORY = 15;

const state = {
  results: new Map(), // id -> result
  themeById: new Map(), // id -> assigned theme (stable per result)
  currentQuery: "",
  eventSource: null,
  skeletons: [], // elementi <div class="skeleton-card"> ancora in attesa di una risposta
  imageCardsById: new Map(), // id risultato -> { card, img }
  imagesTabOpened: false, // true dopo il primo click su "Immagini" per questa ricerca
  searchDone: false, // true quando la ricerca testuale è terminata (serve prima di generare le immagini)
  imagesStarted: false, // true dopo aver avviato la generazione immagini per questa ricerca
  imagesEventSource: null,
  silvyHistory: [], // [{role:"user"|"assistant", content}] per la chat con Silvy
  silvyBusy: false,
};

const els = {
  home: document.getElementById("home"),
  results: document.getElementById("results"),
  page: document.getElementById("page"),
  searchForm: document.getElementById("search-form"),
  searchInput: document.getElementById("search-input"),
  searchDropdown: document.getElementById("search-dropdown"),
  searchForm2: document.getElementById("search-form-2"),
  searchInput2: document.getElementById("search-input-2"),
  searchDropdown2: document.getElementById("search-dropdown-2"),
  homeHistory: document.getElementById("home-history"),
  homeTrending: document.getElementById("home-trending"),
  resultsList: document.getElementById("results-list"),
  resultsStatus: document.getElementById("results-status"),
  infoPanel: document.getElementById("info-panel"),
  resultsTabs: document.querySelectorAll(".results-tab"),
  tabAll: document.getElementById("tab-all"),
  tabImages: document.getElementById("tab-images"),
  imagesGrid: document.getElementById("images-grid"),
  imagesStatus: document.getElementById("images-status"),
  logoSmall: document.getElementById("logo-small"),
  backBtn: document.getElementById("back-btn"),
  pageFakeUrl: document.getElementById("page-fake-url"),
  pageContent: document.getElementById("page-content"),
  silvyFab: document.getElementById("silvy-fab"),
  silvyPanel: document.getElementById("silvy-panel"),
  silvyClose: document.getElementById("silvy-close"),
  silvyMessages: document.getElementById("silvy-messages"),
  silvyForm: document.getElementById("silvy-form"),
  silvyInput: document.getElementById("silvy-input"),
};

function showView(view) {
  for (const v of [els.home, els.results, els.page]) v.classList.remove("active");
  view.classList.add("active");
}

function faviconColorFor(site) {
  let hash = 0;
  for (let i = 0; i < site.length; i++) hash = (hash * 31 + site.charCodeAt(i)) >>> 0;
  return FAVICON_COLORS[hash % FAVICON_COLORS.length];
}

function faviconInitials(site) {
  const words = site.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "?";
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}

/* ---------- Cronologia ricerche (localStorage) ---------- */

function getHistory() {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

function addToHistory(query) {
  try {
    const list = getHistory().filter((q) => q.toLowerCase() !== query.toLowerCase());
    list.unshift(query);
    localStorage.setItem(HISTORY_KEY, JSON.stringify(list.slice(0, MAX_HISTORY)));
  } catch {
    /* storage non disponibile: la cronologia semplicemente non persiste */
  }
}

function clearHistory() {
  try {
    localStorage.removeItem(HISTORY_KEY);
  } catch {
    /* ignora */
  }
  renderHomeChips();
  renderDropdown(els.searchInput, els.searchDropdown);
  renderDropdown(els.searchInput2, els.searchDropdown2);
}

/* ---------- Home: chip di cronologia + di tendenza ---------- */

function renderChipRow(container, label, items, opts = {}) {
  container.innerHTML = "";
  if (items.length === 0) return;

  const labelEl = document.createElement("div");
  labelEl.className = "chip-block-label";
  labelEl.textContent = label;
  container.appendChild(labelEl);

  const row = document.createElement("div");
  row.className = "chip-row";
  for (const item of items) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "chip";
    chip.textContent = item;
    chip.addEventListener("click", () => runSearch(item));
    row.appendChild(chip);
  }
  container.appendChild(row);
  if (opts.clearable) {
    const clear = document.createElement("button");
    clear.type = "button";
    clear.className = "chip";
    clear.textContent = "cancella cronologia";
    clear.addEventListener("click", clearHistory);
    row.appendChild(clear);
  }
}

function renderHomeChips() {
  const history = getHistory();
  renderChipRow(els.homeHistory, "Le tue ricerche recenti", history.slice(0, 8), { clearable: history.length > 0 });
  renderChipRow(els.homeTrending, "Prova a cercare", TRENDING_QUERIES);
}

/* ---------- Dropdown cronologia sulla barra di ricerca ---------- */

function renderDropdown(input, dropdown) {
  const query = input.value.trim().toLowerCase();
  const history = getHistory().filter((q) => !query || q.toLowerCase().includes(query));

  dropdown.innerHTML = "";
  if (history.length === 0) {
    dropdown.innerHTML = `<div class="search-dropdown-empty">Nessuna ricerca recente</div>`;
    return;
  }
  for (const item of history.slice(0, 8)) {
    const row = document.createElement("div");
    row.className = "search-dropdown-item";
    row.innerHTML = `<span class="icon">&#8634;</span><span>${escapeHtml(item)}</span>`;
    row.addEventListener("mousedown", (e) => {
      e.preventDefault();
      runSearch(item);
    });
    dropdown.appendChild(row);
  }
  const footer = document.createElement("div");
  footer.className = "search-dropdown-footer";
  footer.textContent = "Cancella cronologia";
  footer.addEventListener("mousedown", (e) => {
    e.preventDefault();
    clearHistory();
  });
  dropdown.appendChild(footer);
}

function wireDropdown(input, dropdown) {
  input.addEventListener("focus", () => {
    renderDropdown(input, dropdown);
    dropdown.classList.add("open");
  });
  input.addEventListener("input", () => {
    renderDropdown(input, dropdown);
    dropdown.classList.add("open");
  });
  input.addEventListener("blur", () => {
    dropdown.classList.remove("open");
  });
}

/* ---------- Skeleton loader (pagine ancora in generazione) ---------- */

function renderSkeletonCard() {
  const card = document.createElement("div");
  card.className = "result-card skeleton-card";
  card.innerHTML = `
    <div class="skeleton-favicon-row">
      <span class="skeleton-favicon skeleton-line"></span>
      <span class="skeleton-site skeleton-line"></span>
    </div>
    <div class="skeleton-url skeleton-line"></div>
    <div class="skeleton-title skeleton-line"></div>
    <div class="skeleton-desc skeleton-line"></div>
    <div class="skeleton-desc skeleton-line short"></div>
  `;
  return card;
}

function renderSkeletons(count) {
  clearSkeletons();
  for (let i = 0; i < count; i++) {
    const card = renderSkeletonCard();
    els.resultsList.appendChild(card);
    state.skeletons.push(card);
  }
}

function removeOneSkeleton() {
  const card = state.skeletons.shift();
  if (card) card.remove();
}

function clearSkeletons() {
  for (const card of state.skeletons) card.remove();
  state.skeletons = [];
}

/* ---------- Ricerca ---------- */

function runSearch(query) {
  query = query.trim();
  if (!query) return;

  addToHistory(query);
  state.currentQuery = query;
  state.results.clear();
  state.themeById.clear();
  els.searchInput.value = query;
  els.searchInput2.value = query;
  els.searchDropdown.classList.remove("open");
  els.searchDropdown2.classList.remove("open");
  els.resultsList.innerHTML = "";
  els.infoPanel.innerHTML = "";
  els.imagesGrid.innerHTML = "";
  els.imagesStatus.textContent = "";
  els.resultsTabs.forEach((t) => t.classList.toggle("active", t.dataset.tab === "all"));
  els.tabAll.classList.add("active");
  els.tabImages.classList.remove("active");
  state.skeletons = [];
  state.imageCardsById.clear();
  state.imagesTabOpened = false;
  state.searchDone = false;
  state.imagesStarted = false;
  if (state.imagesEventSource) state.imagesEventSource.close();
  els.resultsStatus.textContent = "Sto cercando (fonti totalmente inaffidabili in arrivo)...";
  showView(els.results);

  if (state.eventSource) {
    state.eventSource.close();
  }

  const es = new EventSource(`/api/search-stream?q=${encodeURIComponent(query)}`);
  state.eventSource = es;
  let count = 0;
  let total = 0;
  let fromCache = false;
  let quotaExhausted = false;

  es.addEventListener("meta", (e) => {
    const info = JSON.parse(e.data);
    total = info.total || 0;
    renderSkeletons(total);
    els.resultsStatus.textContent = statusText(count, total, fromCache);
  });

  es.addEventListener("result", (e) => {
    const result = JSON.parse(e.data);
    if (result.cached) fromCache = true;
    state.results.set(result.id, result);
    count++;
    removeOneSkeleton();
    const card = renderResultCard(result);
    // i risultati completati restano sopra, le skeleton ancora in attesa restano in fondo
    els.resultsList.insertBefore(card, state.skeletons[0] || null);
    els.resultsStatus.textContent = statusText(count, total, fromCache);
    renderInfoPanel(query);
    els.imagesGrid.appendChild(renderImageCard(result));
  });

  es.addEventListener("error", (e) => {
    // could be a named "error" SSE event (model failure) or a connection error
    if (e.data) {
      try {
        const info = JSON.parse(e.data);
        console.warn("Modello fallito:", info.model, info.message);
        if (info.dailyLimit) quotaExhausted = true;
      } catch {
        /* connection-level error, ignore */
      }
      removeOneSkeleton();
      els.resultsStatus.textContent = statusText(count, total, fromCache, quotaExhausted);
    }
  });

  es.addEventListener("done", (e) => {
    es.close();
    clearSkeletons();
    try {
      const info = JSON.parse(e.data);
      if (info.quotaExhausted) quotaExhausted = true;
    } catch {
      /* ignora */
    }
    if (count === 0 && !quotaExhausted) {
      els.resultsStatus.textContent = "Nessun risultato. Anche l'inaffidabilità ha i suoi limiti (controlla server/API key).";
    } else {
      els.resultsStatus.textContent = statusText(count, total, fromCache, quotaExhausted);
    }
    state.searchDone = true;
    maybeStartImages();
  });
}

function statusText(count, total, fromCache, quotaExhausted) {
  const base = `Circa ${count} risultati (nessuno affidabile)`;
  if (quotaExhausted) {
    return `${base} — quota giornaliera gratuita di OpenRouter esaurita, riprova più tardi`;
  }
  const pending = Math.max(total - count, 0);
  const withPending = pending > 0 ? `${base} — altri ${pending} risultati...` : base;
  return fromCache ? `${base} — dalla cache, nessuna nuova bugia generata` : withPending;
}

/* ---------- Pannello informazioni (riempie lo spazio, riusa i dati già generati) ---------- */

function renderInfoPanel(query) {
  const results = [...state.results.values()];
  if (results.length === 0) {
    els.infoPanel.innerHTML = "";
    return;
  }
  const first = results[0];
  const sources = [...new Set(results.map((r) => r.site).filter(Boolean))].slice(0, 6);

  els.infoPanel.innerHTML = `
    <div class="info-panel-card">
      <div class="info-panel-title">${escapeHtml(capitalize(query))}</div>
      <div class="info-panel-desc">${escapeHtml(first.description || "")}</div>
      <div class="info-panel-divider"></div>
      <div class="info-panel-label">Fonti concordi</div>
      <ul class="info-panel-sources">
        ${sources.map((s) => `<li>${escapeHtml(s)}</li>`).join("")}
      </ul>
    </div>
  `;
}

function capitalize(str) {
  return str.charAt(0).toUpperCase() + str.slice(1);
}

function renderResultCard(result) {
  const card = document.createElement("div");
  card.className = "result-card";
  card.innerHTML = `
    <div class="result-favicon-row">
      <span class="result-favicon" style="background:${faviconColorFor(result.site || "")}">${escapeHtml(faviconInitials(result.site || ""))}</span>
      <span class="result-site">${escapeHtml(result.site)}</span>
    </div>
    <div class="result-url">${escapeHtml(result.url)}</div>
    <a class="result-title" href="#">${escapeHtml(result.title)}</a>
    <div class="result-desc">${escapeHtml(result.description)}</div>
    <div class="result-meta">${escapeHtml(result.author)}${result.author && result.date ? " &middot; " : ""}${escapeHtml(result.date)}</div>
  `;
  card.addEventListener("click", (e) => {
    e.preventDefault();
    openPage(result.id);
  });
  return card;
}

/* ---------- Tab Immagini (generate dal backend con inclusionai/ming-image-0.1-design,
   gratis ma ~30s a immagine) ----------
   Le immagini partono solo quando ENTRAMBE le condizioni sono vere: la ricerca testuale
   è finita (altrimenti mancherebbero i titoli dei risultati arrivati dopo) e l'utente ha
   aperto la tab (per non generarle a vuoto se nessuno le guarda). */

function renderImageCard(result) {
  const card = document.createElement("div");
  card.className = "image-card";
  card.title = result.title;
  card.innerHTML = `
    <div class="image-card-line"></div>
    <img alt="${escapeHtml(result.title)}" loading="lazy" />
    <div class="image-card-caption">${escapeHtml(result.site)}</div>
  `;
  const img = card.querySelector("img");
  card.addEventListener("click", () => openPage(result.id));
  state.imageCardsById.set(result.id, { card, img });
  return card;
}

function updateImagesStatus() {
  if (!state.imagesTabOpened) return;
  if (!state.searchDone) {
    els.imagesStatus.textContent = "Aspetto che la ricerca finisca prima di generare le immagini...";
    return;
  }
  if (!state.imagesStarted) return;
  const total = state.imageCardsById.size;
  let done = 0;
  for (const { card } of state.imageCardsById.values()) {
    if (card.querySelector("img").classList.contains("loaded") || card.classList.contains("image-failed")) done++;
  }
  els.imagesStatus.textContent =
    done < total
      ? `Sto cercando delle cazzate... — ${done}/${total}...`
      : `${total} cazzate trovate`;
}

function maybeStartImages() {
  updateImagesStatus();
  if (!state.imagesTabOpened || !state.searchDone || state.imagesStarted) return;
  state.imagesStarted = true;

  const items = [...state.imageCardsById.entries()].map(([id, { card }]) => ({
    id,
    prompt: `${card.title}, fotografia editoriale, stile giornalistico`,
  }));
  if (items.length === 0) return;
  updateImagesStatus();

  if (state.imagesEventSource) state.imagesEventSource.close();
  const es = new EventSource(`/api/images-stream?items=${encodeURIComponent(JSON.stringify(items))}`);
  state.imagesEventSource = es;

  es.addEventListener("image", (e) => {
    const { id, dataUrl } = JSON.parse(e.data);
    const entry = state.imageCardsById.get(id);
    if (!entry) return;
    entry.img.addEventListener(
      "load",
      () => {
        entry.img.classList.add("loaded");
        entry.card.classList.add("loaded");
        updateImagesStatus();
      },
      { once: true }
    );
    entry.img.src = dataUrl;
  });

  es.addEventListener("error", (e) => {
    if (e.data) {
      const { id } = JSON.parse(e.data);
      const entry = state.imageCardsById.get(id);
      if (entry) entry.card.classList.add("image-failed");
      updateImagesStatus();
    }
  });

  es.addEventListener("done", () => {
    es.close();
    updateImagesStatus();
  });
}

function openPage(id) {
  const result = state.results.get(id);
  if (!result) return;

  if (!state.themeById.has(id)) {
    const theme = THEMES[Math.floor(Math.random() * THEMES.length)];
    state.themeById.set(id, theme);
  }
  const theme = state.themeById.get(id);

  els.pageFakeUrl.textContent = result.url;
  els.pageContent.innerHTML = `
    <div class="page-theme ${theme}">
      <header class="site-header">
        <span class="site-logo">${escapeHtml(result.site)}</span>
        <nav class="site-nav"></nav>
      </header>
      <div class="site-body">
        <div class="article">
          <h1>${escapeHtml(result.title)}</h1>
          <div class="article-meta">${escapeHtml(result.site)} &middot; ${escapeHtml(result.author)} &middot; ${escapeHtml(result.date)}</div>
          <div class="article-body">${marked.parse(result.content || "")}</div>
        </div>
      </div>
    </div>
  `;
  showView(els.page);
  window.scrollTo(0, 0);
}

/* ---------- Ask Silvy (chat persistente, indipendente dalla ricerca) ---------- */

function openSilvy() {
  els.silvyPanel.classList.add("open");
  if (els.silvyMessages.children.length === 0) {
    const intro = document.createElement("div");
    intro.className = "silvy-intro";
    intro.textContent = "Sono Silvy. Dimmi tutto, o non dirmi niente: tanto lo so già.";
    els.silvyMessages.appendChild(intro);
  }
  els.silvyInput.focus();
}

function closeSilvy() {
  els.silvyPanel.classList.remove("open");
}

function appendSilvyMessage(role, text) {
  const bubble = document.createElement("div");
  bubble.className = `silvy-msg ${role}`;
  bubble.textContent = text;
  els.silvyMessages.appendChild(bubble);
  els.silvyMessages.scrollTop = els.silvyMessages.scrollHeight;
  return bubble;
}

async function sendToSilvy(message) {
  if (state.silvyBusy || !message.trim()) return;
  state.silvyBusy = true;
  els.silvyInput.disabled = true;

  appendSilvyMessage("user", message);
  const typing = appendSilvyMessage("silvy typing", "sta scrivendo...");

  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ history: state.silvyHistory, message }),
    });
    const data = await res.json().catch(() => ({}));
    typing.remove();
    if (!res.ok || !data.reply) {
      appendSilvyMessage("error", "Silvy non risponde al momento. Riprova tra poco.");
      return;
    }
    appendSilvyMessage("silvy", data.reply);
    state.silvyHistory.push({ role: "user", content: message });
    state.silvyHistory.push({ role: "assistant", content: data.reply });
  } catch {
    typing.remove();
    appendSilvyMessage("error", "Silvy non risponde al momento. Riprova tra poco.");
  } finally {
    state.silvyBusy = false;
    els.silvyInput.disabled = false;
    els.silvyInput.focus();
  }
}

els.silvyFab.addEventListener("click", openSilvy);
els.silvyClose.addEventListener("click", closeSilvy);
els.silvyForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const message = els.silvyInput.value;
  els.silvyInput.value = "";
  sendToSilvy(message);
});

function escapeHtml(str) {
  return (str || "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[c]));
}

els.searchForm.addEventListener("submit", (e) => {
  e.preventDefault();
  runSearch(els.searchInput.value);
});
els.searchForm2.addEventListener("submit", (e) => {
  e.preventDefault();
  runSearch(els.searchInput2.value);
});
els.backBtn.addEventListener("click", () => showView(els.results));
els.resultsTabs.forEach((tab) => {
  tab.addEventListener("click", () => {
    els.resultsTabs.forEach((t) => t.classList.remove("active"));
    tab.classList.add("active");
    const isImages = tab.dataset.tab === "images";
    els.tabAll.classList.toggle("active", !isImages);
    els.tabImages.classList.toggle("active", isImages);
    if (isImages && !state.imagesTabOpened) {
      state.imagesTabOpened = true;
      maybeStartImages();
    }
  });
});
els.logoSmall.addEventListener("click", (e) => {
  e.preventDefault();
  renderHomeChips();
  showView(els.home);
});

wireDropdown(els.searchInput, els.searchDropdown);
wireDropdown(els.searchInput2, els.searchDropdown2);
renderHomeChips();
