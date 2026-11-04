"use strict";

// Everything shown here is read from the private repository after login; this file holds no data.
const PATHS = {
  taxonomy: "config/taxonomy.json",
  sources: "config/sources.json",
  config: "config/config.json",
  companies: "config/companies.json",
  profile: "config/profile.json",
  languages: "config/languages.json",
  records: "data/applications.json",
  headhunters: "data/headhunters.json",
};
const INTERVALS = [1, 2, 3, 4, 6, 8, 12, 24];
const STORE = { token: "dash.token", repo: "dash.repo" };

const $ = (sel) => document.querySelector(sel);
const state = { taxonomy: null, sources: null, config: null, sha: null, records: [], recordsSha: null, view: "records",
  sort: { key: "date", asc: false },
  companies: null, companiesSha: null, companiesDirty: false,
  profile: null, profileSha: null, profileDirty: false, languages: null,
  hh: { agencies: [] }, hhSha: null, hhEditing: null };
// status → color group; groups in ARCHIVED move the record to the archive tab
const STATUSES = [
  ["Čeka odobrenje", "wait"], ["Odobreno – čeka CV", "todo"], ["Odobreno – CV spreman", "todo"], ["Poslato", "sent"],
  ["Review", "review"], ["Test", "review"], ["HR intervju", "interview"], ["Tehnički intervju", "interview"],
  ["Ponuda", "offer"], ["Odbijeno", "rejected"], ["Preskočeno", "closed"], ["Bez odgovora", "closed"],
];
const STATUS_GROUP = Object.fromEntries(STATUSES);
const ARCHIVED = new Set(["rejected", "closed"]);
const isArchived = (r) => ARCHIVED.has(STATUS_GROUP[r.status]);
const RULES = [
  ["language", "Obavezan jezik koji ne znam"],
  ["residency", "Mora da živi u drugoj zemlji (npr. samo SAD, samo Ukrajina)"],
  ["citizenship", "Traži se državljanstvo (npr. EU, SAD)"],
  ["clearance", "Bezbednosna provera (security clearance)"],
];

// ---------- storage (may be unavailable in private windows) ----------
function store(key, value) {
  try { value === null ? localStorage.removeItem(key) : localStorage.setItem(key, value); } catch (_) {}
}
function load(key) {
  try { return localStorage.getItem(key) || ""; } catch (_) { return ""; }
}

// ---------- GitHub contents API ----------
function b64ToText(b64) {
  const bin = atob(b64.replace(/\n/g, ""));
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}
function textToB64(text) {
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  bytes.forEach((b) => { bin += String.fromCharCode(b); });
  return btoa(bin);
}
async function gh(path, options = {}) {
  const res = await fetch(`https://api.github.com/repos/${load(STORE.repo)}/${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${load(STORE.token)}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(options.headers || {}),
    },
    cache: "no-store",
  });
  if (!res.ok) {
    const err = new Error(`${res.status}`);
    err.status = res.status;
    throw err;
  }
  return res;
}
const api = (path, options) => gh(`contents/${path}`, options);
async function readJson(path) {
  const meta = await (await api(path)).json();
  if (meta.content) return { data: JSON.parse(b64ToText(meta.content)), sha: meta.sha };
  // files over 1 MB come without inline content
  const raw = await api(path, { headers: { Accept: "application/vnd.github.raw+json" } });
  return { data: await raw.json(), sha: meta.sha };
}

// ---------- login ----------
async function start() {
  if (!load(STORE.token) || !load(STORE.repo)) return showLogin();
  try {
    const [tax, src, cfg] = await Promise.all([readJson(PATHS.taxonomy), readJson(PATHS.sources), readJson(PATHS.config)]);
    state.taxonomy = tax.data; state.sources = src.data; state.config = cfg.data; state.sha = cfg.sha;
    $("#login").classList.add("hidden");
    showTab(savedView()?.tab);  // open straight on the tab the reload came from, never flashing the settings
    await loadCompanies();
    await loadProfile();
    renderSettings();
    await loadRecords();
    await loadHeadhunters();
    restoreView();
    $("#loader").classList.add("hidden");
    $("#app").classList.remove("hidden");  // shown once, complete, with a short fade
    loadRuns();
    loadLastFullScan();
    startLiveUpdates();
  } catch (e) {
    showLogin(e.status === 401 ? "Ključ nije ispravan ili je istekao." :
      e.status === 404 ? "Repozitorijum nije pronađen ili ključ nema pristup." : "Greška pri učitavanju. Pokušaj ponovo.");
  }
}
function showLogin(message = "") {
  $("#loader").classList.add("hidden");
  $("#app").classList.add("hidden");
  $("#login").classList.remove("hidden");
  $("#login-error").textContent = message;
  $("#repo").value = load(STORE.repo);
}
$("#login-form").addEventListener("submit", (ev) => {
  ev.preventDefault();
  store(STORE.token, $("#token").value.trim());
  store(STORE.repo, $("#repo").value.trim().replace(/^https:\/\/github\.com\//, "").replace(/\/$/, ""));
  $("#token").value = "";
  start();
});
$("#logout").addEventListener("click", () => {
  store(STORE.token, null);
  store(STORE.repo, null);
  location.reload();
});

// ---------- tabs ----------
function showTab(tab) {
  const btn = document.querySelector(`.tab[data-tab="${tab}"]`);
  if (!btn) return null;
  document.querySelectorAll(".tab").forEach((b) => b.classList.toggle("active", b === btn));
  // the archive is the same table, filtered to finished records
  const panel = tab === "archive" ? "records" : tab;
  document.querySelectorAll(".tab-panel").forEach((p) => p.classList.toggle("hidden", p.id !== `tab-${panel}`));
  return panel;
}
document.querySelectorAll(".tab").forEach((btn) => btn.addEventListener("click", () => {
  const panel = showTab(btn.dataset.tab);
  if (panel === "records") {
    state.view = btn.dataset.tab;
    $("#status-filter").value = "";
    recordsStatus("");
    renderRecords();
  }
}));

// ---------- settings form ----------
function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  Object.entries(attrs).forEach(([k, v]) => {
    if (k === "text") node.textContent = v;
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v);
  });
  children.forEach((c) => node.append(c));
  return node;
}
function checkGroup(title, items, selected, onChange) {
  const box = el("div", { class: "checks" });
  items.forEach((item) => {
    const input = el("input", { type: "checkbox" });
    input.checked = selected.includes(item.id);
    input.addEventListener("change", () => onChange(item.id, input.checked));
    box.append(el("label", { class: "check", title: item.note || "" }, [input, item.name]));
  });
  return el("div", { class: "group" }, [el("div", { class: "group-title", text: title }), box]);
}
function toggle(list, id, on) {
  const i = list.indexOf(id);
  if (on && i < 0) list.push(id);
  if (!on && i >= 0) list.splice(i, 1);
}
function familyOf(id) {
  return state.taxonomy.families.find((f) => f.id === id) || state.taxonomy.families[0];
}
function newSearch() {
  const fam = state.taxonomy.families[0];
  return {
    id: `s-${Date.now().toString(36)}`, name: "Nova pretraga", family: fam.id,
    specializations: fam.specializations.map((s) => s.id), seniority: ["medior", "senior"],
    employment_types: ["full_time", "contract"], locations: ["remote"],
    include_keywords: [], exclude_keywords: [],
  };
}
function keywordInput(label, list) {
  const input = el("input", { type: "text", placeholder: "odvojeno zarezom" });
  input.value = list.join(", ");
  input.addEventListener("input", () => {
    list.splice(0, list.length, ...input.value.split(",").map((s) => s.trim()).filter(Boolean));
  });
  return el("label", {}, [label, input]);
}
function renderSearches() {
  const root = $("#searches");
  root.replaceChildren();
  const tax = state.taxonomy;
  state.config.searches.forEach((s, idx) => {
    ["specializations", "seniority", "employment_types", "locations", "include_keywords", "exclude_keywords"]
      .forEach((k) => { s[k] = s[k] || []; });
    const fam = familyOf(s.family);
    const name = el("input", { type: "text" });
    name.value = s.name || "";
    name.addEventListener("input", () => { s.name = name.value; });
    const family = el("select");
    tax.families.forEach((f) => family.append(el("option", { value: f.id, text: f.name })));
    family.value = fam.id;
    family.addEventListener("change", () => {
      s.family = family.value;
      s.specializations = familyOf(s.family).specializations.map((x) => x.id);
      renderSearches();
    });
    const remove = el("button", { class: "danger", type: "button", text: "Ukloni", onclick: () => {
      if (state.config.searches.length === 1) return status("Mora postojati bar jedna pretraga.", "err");
      state.config.searches.splice(idx, 1);
      renderSearches();
    } });
    root.append(el("div", { class: "search" }, [
      el("div", { class: "row-between" }, [el("h3", { text: s.name || `Pretraga ${idx + 1}` }), remove]),
      el("div", { class: "grid" }, [el("label", {}, ["Naziv", name]), el("label", {}, ["Oblast", family])]),
      checkGroup("Specijalizacija", fam.specializations, s.specializations, (id, on) => toggle(s.specializations, id, on)),
      checkGroup("Nivo", tax.seniority, s.seniority, (id, on) => toggle(s.seniority, id, on)),
      checkGroup("Tip angažmana", tax.employment_types, s.employment_types, (id, on) => toggle(s.employment_types, id, on)),
      checkGroup("Lokacija", tax.locations, s.locations, (id, on) => toggle(s.locations, id, on)),
      el("div", { class: "grid" }, [
        keywordInput("Mora da sadrži (bar jednu reč)", s.include_keywords),
        keywordInput("Isključi ako sadrži", s.exclude_keywords),
      ]),
    ]));
  });
}
function renderSettings() {
  const cfg = state.config;
  state.configDirty = false;
  renderSearches();
  const interval = $("#interval");
  interval.replaceChildren(...INTERVALS.map((h) => el("option", { value: String(h), text: h === 1 ? "svakih sat" : `svaka ${h}h` })));
  interval.value = String(cfg.schedule.interval_hours);
  $("#active-from").value = cfg.schedule.active_from;
  $("#active-to").value = cfg.schedule.active_to;
  $("#max-messages").value = cfg.max_messages_per_run;
  $("#max-age").value = cfg.max_age_days;
  $("#tz-note").textContent = `Vremenska zona: ${cfg.schedule.timezone}. Provera se pokreće jednom na sat, a svaki izvor kad dođe na red.`;
  const box = $("#sources");
  box.replaceChildren();
  cfg.sources_enabled = cfg.sources_enabled || {};
  state.sources.sources.forEach((src) => {
    const input = el("input", { type: "checkbox" });
    input.checked = cfg.sources_enabled[src.id] ?? src.enabled;
    input.addEventListener("change", () => { cfg.sources_enabled[src.id] = input.checked; renderIntervalWarning(); renderFullScanNote(); });
    box.append(el("label", { class: "check", title: src.reason || "" }, [
      input, src.name, el("small", { text: `min. ${src.min_interval_hours}h` }),
    ]));
  });
  document.getElementById("source-reasons")?.remove();
  const reasons = el("details", { id: "source-reasons" }, [el("summary", { class: "muted", text: "Zašto ovi minimumi?" }),
    ...state.sources.sources.map((src) => el("p", { class: "muted" }, [
      el("strong", { text: `${src.name} (${src.min_interval_hours}h): ` }), src.reason || "",
    ]))]);
  box.after(reasons);
  $("#source-warnings").replaceChildren(...state.sources.sources.filter((src) => src.warning).map((src) =>
    el("p", { class: "source-warning" }, [el("strong", { text: `⚠️ ${src.name}: ` }), src.warning])));
  interval.onchange = renderIntervalWarning;
  renderIntervalWarning();
  renderFullScanNote();
  if (state.profile) renderRules();
}
// Not every site can be searched deeper than its newest postings; say which ones can.
function renderFullScanNote() {
  const on = state.sources.sources.filter((src) => state.config.sources_enabled[src.id] ?? src.enabled);
  const deep = on.filter((src) => src.full_scan).map((src) => src.name);
  const newest = on.filter((src) => !src.full_scan).map((src) => src.name);
  $("#full-scan-sources").textContent = (deep.length ? `Svi oglasi: ${deep.join(", ")}.` : "Nijedan izabrani izvor ne podržava pretragu svih oglasa.")
    + (newest.length ? ` Samo najnoviji (sajt ne nudi više): ${newest.join(", ")}.` : "");
}
// A site is never asked more often than its minimum; tell the user which ones will run slower.
function renderIntervalWarning() {
  const chosen = Number($("#interval").value);
  const slower = state.sources.sources.filter((src) =>
    (state.config.sources_enabled[src.id] ?? src.enabled) && src.min_interval_hours > chosen);
  const note = $("#interval-warning");
  note.textContent = slower.length
    ? `⚠️ Izabrani interval (${chosen}h) je kraći od minimuma za: ${slower.map((s) => `${s.name} (${s.min_interval_hours}h)`).join(", ")}. Oni će se proveravati po svom minimumu.`
    : "";
}
function status(text, kind = "") {
  const s = $("#save-status");
  s.textContent = text;
  s.className = kind;
}
$("#add-search").addEventListener("click", () => {
  state.config.searches.push(newSearch());
  renderSearches();
});
$("#save").addEventListener("click", async () => {
  const cfg = state.config;
  cfg.schedule.interval_hours = Number($("#interval").value);
  cfg.schedule.active_from = $("#active-from").value || "08:00";
  cfg.schedule.active_to = $("#active-to").value || "22:00";
  cfg.max_messages_per_run = Math.max(1, Math.min(30, Number($("#max-messages").value) || 8));
  cfg.max_age_days = Math.max(1, Math.min(60, Number($("#max-age").value) || 3));
  // show what is actually saved, so a value outside the limits is never silently replaced
  $("#max-messages").value = cfg.max_messages_per_run;
  $("#max-age").value = cfg.max_age_days;
  const empty = cfg.searches.find((s) => !s.specializations.length || !s.seniority.length || !s.locations.length);
  if (empty) return status(`„${empty.name}": izaberi bar jednu specijalizaciju, nivo i lokaciju.`, "err");
  status("Čuvam…");
  if (state.companiesDirty && !(await saveCompanies())) return;
  if (state.profileDirty && !(await saveProfile())) return;
  try {
    const res = await api(PATHS.config, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: "Podešavanja izmenjena preko dashboard-a",
        content: textToB64(JSON.stringify(cfg, null, 2) + "\n"),
        sha: state.sha,
      }),
    });
    state.sha = (await res.json()).content.sha;
    state.configDirty = false;
    status("✅ Sačuvano. Važi od sledeće provere.", "ok");
  } catch (e) {
    if (e.status === 409) {
      status("Podešavanja su u međuvremenu izmenjena. Učitavam najnovija – proveri i sačuvaj ponovo.", "err");
      const fresh = await readJson(PATHS.config);
      state.config = fresh.data; state.sha = fresh.sha;
      renderSettings();
    } else if (e.status === 403 || e.status === 404) {
      status("Ključ nema dozvolu za upis (potrebno: Contents – Read and write).", "err");
    } else {
      status("Čuvanje nije uspelo. Pokušaj ponovo.", "err");
    }
  }
});

// ---------- languages & dealbreaker rules ----------
async function loadProfile() {
  try {
    const [prof, langs] = await Promise.all([readJson(PATHS.profile), readJson(PATHS.languages)]);
    state.profile = prof.data; state.profileSha = prof.sha; state.languages = langs.data; state.profileDirty = false;
  } catch (_) {
    state.profile = null;
  }
  renderRules();
}
function renderRules() {
  const card = $("#rules-card");
  card.classList.toggle("hidden", !state.profile);
  if (!state.profile) return;
  const known = state.profile.languages = state.profile.languages || [];
  const catalog = state.languages.languages;
  const levels = state.languages.levels;
  const label = (name) => (catalog.find((l) => l.name === name) || {}).label || name;
  $("#languages").replaceChildren(...known.map((lang, i) => {
    const level = el("select");
    levels.forEach((lv) => level.append(el("option", { value: lv.id, text: lv.name })));
    level.value = lang.level;
    level.addEventListener("change", () => { lang.level = level.value; state.profileDirty = true; });
    const remove = el("button", { type: "button", class: "danger", text: "Ukloni", onclick: () => {
      known.splice(i, 1); state.profileDirty = true; renderRules();
    } });
    return el("div", { class: "company" }, [el("span", { text: label(lang.name) }), el("span", { class: "meta" }, [level]), remove]);
  }));
  const add = $("#language-add");
  add.replaceChildren(...catalog.filter((l) => !known.some((k) => k.name === l.name))
    .map((l) => el("option", { value: l.name, text: l.label })));
  $("#language-level").replaceChildren(...levels.map((lv) => el("option", { value: lv.id, text: lv.name })));
  $("#language-level").value = "intermediate";
  const policy = state.config.dealbreakers = state.config.dealbreakers || {};
  $("#rules").replaceChildren(...RULES.map(([kind, text]) => {
    const select = el("select");
    select.append(el("option", { value: "drop", text: "izbaci oglas" }), el("option", { value: "warn", text: "samo upozori" }));
    select.value = policy[kind] || "drop";
    select.addEventListener("change", () => { policy[kind] = select.value; });
    return el("label", { class: "rule" }, [text, select]);
  }));
}
$("#language-add-btn").addEventListener("click", () => {
  const name = $("#language-add").value;
  if (!name) return;
  state.profile.languages.push({ name, level: $("#language-level").value });
  state.profileDirty = true;
  renderRules();
});
async function saveProfile() {
  try {
    const res = await api(PATHS.profile, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: "Jezici izmenjeni preko dashboard-a",
        content: textToB64(JSON.stringify(state.profile, null, 2) + "\n"),
        sha: state.profileSha,
      }),
    });
    state.profileSha = (await res.json()).content.sha;
    state.profileDirty = false;
    return true;
  } catch (e) {
    status(e.status === 409 ? "Profil je u međuvremenu izmenjen – osveži stranicu." : "Čuvanje jezika nije uspelo.", "err");
    return false;
  }
}

// ---------- tracked companies ----------
async function loadCompanies() {
  try {
    const res = await readJson(PATHS.companies);
    state.companies = res.data; state.companiesSha = res.sha; state.companiesDirty = false;
  } catch (_) {
    state.companies = null;
  }
  renderCompanies();
}
function renderCompanies() {
  const card = $("#companies-card");
  const reg = state.companies;
  card.classList.toggle("hidden", !reg);
  if (!reg) return;
  const source = state.sources.sources.find((s) => s.id === "ats");
  $("#companies-title").textContent = source ? source.name : "Firme";
  const perRun = $("#companies-per-run");
  perRun.value = reg.max_per_run || 15;
  perRun.onchange = () => { reg.max_per_run = Math.max(1, Math.min(50, Number(perRun.value) || 15)); state.companiesDirty = true; };
  const sorted = [...reg.companies].sort((a, b) =>
    (b.enabled !== false) - (a.enabled !== false) || String(a.name).localeCompare(String(b.name)));
  $("#companies").replaceChildren(...sorted.map((c) => {
    const input = el("input", { type: "checkbox" });
    input.checked = c.enabled !== false;
    input.addEventListener("change", () => { c.enabled = input.checked; state.companiesDirty = true; });
    const meta = el("span", { class: "meta", text: `${c.ats}/${c.slug}${c.region === "eu" ? " (eu)" : ""}` });
    if (c.last_error || c.note) meta.append(el("br"), el("span", { class: "err", text: c.note || c.last_error }));
    return el("label", { class: "company", title: c.discovered_from || "" }, [input, c.name || c.slug, meta]);
  }));
  const ats = $("#company-ats");
  ats.replaceChildren(...(reg.ats_types || []).map((t) => el("option", { value: t, text: t })));
}
$("#company-form").addEventListener("submit", (ev) => {
  ev.preventDefault();
  const reg = state.companies;
  const slug = $("#company-slug").value.trim().toLowerCase().replace(/^https?:\/\/[^/]+\//, "").split("/")[0];
  const ats = $("#company-ats").value;
  if (!slug) return;
  if (reg.companies.some((c) => c.ats === ats && c.slug === slug)) return status("Ta firma je već na listi.", "err");
  reg.companies.push({ name: $("#company-name").value.trim() || slug, ats, slug, region: $("#company-region").value,
    enabled: true, discovered_from: "dodato ručno", added_at: new Date().toISOString().slice(0, 10) });
  state.companiesDirty = true;
  ev.target.reset();
  renderCompanies();
  status("Firma dodata – klikni Sačuvaj.");
});
async function saveCompanies() {
  try {
    const res = await api(PATHS.companies, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: "Lista firmi izmenjena preko dashboard-a",
        content: textToB64(JSON.stringify(state.companies, null, 2) + "\n"),
        sha: state.companiesSha,
      }),
    });
    state.companiesSha = (await res.json()).content.sha;
    state.companiesDirty = false;
    return true;
  } catch (e) {
    if (e.status === 409) {
      status("Lista firmi je u međuvremenu dopunjena. Učitao sam najnoviju – ponovi izmene firmi i sačuvaj.", "err");
      await loadCompanies();
    await loadProfile();
    } else {
      status("Čuvanje liste firmi nije uspelo.", "err");
    }
    return false;
  }
}

// ---------- sync (runs the workflow on demand) ----------
const WORKFLOW = "actions/workflows/run.yml";
const RUN_STATE = { queued: "⏳ čeka", in_progress: "⏳ u toku", waiting: "⏳ čeka", pending: "⏳ čeka", requested: "⏳ čeka" };
const RUN_RESULT = { success: "✅ uspešno", failure: "❌ greška", cancelled: "⏹ otkazano", skipped: "⏭ preskočeno" };
const ACTIONS_HELP = "Ključ nema dozvolu za pokretanje. Na GitHub-u: Settings → Developer settings → Fine-grained tokens → " +
  "tvoj ključ → Edit → Add permissions → Actions: Read and write → Update. Ključ ostaje isti.";
function syncStatus(text, kind = "") {
  const s = $("#sync-status");
  s.textContent = text;
  s.className = kind;
}
function when(iso) {
  const d = new Date(iso);
  const mins = Math.round((Date.now() - d) / 60000);
  const ago = mins < 1 ? "upravo" : mins < 60 ? `pre ${mins} min` : mins < 1440 ? `pre ${Math.round(mins / 60)} h` : `pre ${Math.round(mins / 1440)} d`;
  return `${d.toLocaleString("sr-Latn-RS", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })} (${ago})`;
}
function runLabel(run) {
  return run.status === "completed" ? (RUN_RESULT[run.conclusion] || run.conclusion) : (RUN_STATE[run.status] || run.status);
}
async function fetchRuns() {
  return (await (await gh(`${WORKFLOW}/runs?per_page=6`)).json()).workflow_runs || [];
}
async function loadRuns() {
  let runs;
  try {
    runs = await fetchRuns();
  } catch (e) {
    $("#sync-last").textContent = e.status === 403 || e.status === 404 ? ACTIONS_HELP : "Istorija pokretanja nije dostupna.";
    return [];
  }
  const done = runs.find((r) => r.status === "completed" && r.conclusion === "success");
  $("#sync-last").textContent = done ? `Poslednja uspešna sinhronizacija: ${when(done.updated_at)}` : "Još nema uspešne sinhronizacije.";
  $("#sync-runs").replaceChildren(...runs.map((r) => el("tr", {}, [
    el("td", { text: when(r.created_at) }),
    el("td", { text: { dashboard: "ručno (ovde)", "dashboard-sve": "pretraga svih (ovde)" }[r.display_title] || "automatski" }),
    el("td", { text: runLabel(r) }),
  ])));
  return runs;
}
// starts the workflow and follows that run until it finishes (it shows up a few seconds after the dispatch)
async function runWorkflow({ btn, statusEl, inputs, trigger, doneText, maxMinutes = 6 }) {
  const say = (text, kind = "") => { statusEl.textContent = text; statusEl.className = kind; };
  btn.disabled = true;
  const started = Date.now() - 10000;
  say("Pokrećem…");
  try {
    await gh(`${WORKFLOW}/dispatches`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ref: "main", inputs: { ...inputs, trigger } }),
    });
  } catch (e) {
    say(e.status === 403 || e.status === 404 ? ACTIONS_HELP : "Pokretanje nije uspelo. Pokušaj ponovo.", "err");
    btn.disabled = false;
    return;
  }
  for (let i = 0; i < maxMinutes * 7.5; i++) {
    await new Promise((r) => setTimeout(r, 8000));
    let runs;
    try { runs = await loadRuns(); } catch (_) { continue; }
    const run = runs.find((r) => r.display_title === trigger && new Date(r.created_at) >= started);
    if (!run) { say("Pokrećem… (GitHub priprema pokretanje)"); continue; }
    if (run.status !== "completed") { say(`${runLabel(run)}…`); continue; }
    btn.disabled = false;
    if (run.conclusion !== "success") return say(`Nije uspelo (${runLabel(run)}).`, "err");
    await loadRecords();
    return say(doneText, "ok");
  }
  btn.disabled = false;
  say("Traje duže nego obično – proveri malo kasnije.", "err");
}
$("#sync-now").addEventListener("click", () => runWorkflow({
  btn: $("#sync-now"), statusEl: $("#sync-status"), trigger: "dashboard",
  inputs: { force_search: $("#sync-force").checked ? "true" : "false" },
  doneText: "✅ Gotovo. Telegram i tabela prijava su ažurirani.",
}));
// the last successful "search all" is looked up among recent runs (it is rarer than the hourly ones)
async function loadLastFullScan() {
  try {
    const runs = (await (await gh(`${WORKFLOW}/runs?per_page=100&event=workflow_dispatch`)).json()).workflow_runs || [];
    const last = runs.find((r) => r.display_title === "dashboard-sve" && r.status === "completed" && r.conclusion === "success");
    $("#full-scan-last").textContent = last ? `Poslednja pretraga svih oglasa: ${when(last.updated_at)}` : "Pretraga svih oglasa još nije pokretana.";
    return last;
  } catch (_) {
    $("#full-scan-last").textContent = "";
  }
}
$("#full-scan").addEventListener("click", async () => {
  await runWorkflow({
    btn: $("#full-scan"), statusEl: $("#full-scan-status"), trigger: "dashboard-sve", maxMinutes: 15,
    inputs: { full_scan: "true" },
    doneText: "✅ Gotovo. Izveštaj po sajtovima je stigao na Telegram.",
  });
  const last = await loadLastFullScan();
  if (last && $("#full-scan-status").className === "ok") {
    $("#full-scan-status").textContent = `✅ Gotovo ${when(last.updated_at)}. Izveštaj po sajtovima je stigao na Telegram.`;
  }
});

// ---------- live updates ----------
// While the page is visible: every 15 seconds ask GitHub whether anything changed (an unchanged answer is a 304,
// which doesn't count against the API limit) and reload only what changed; every 30 seconds check whether
// a newer dashboard version was published.
const POLL_MS = 15000, VERSION_MS = 30000;
const etags = {};
async function changed(path) {
  const res = await fetch(`https://api.github.com/repos/${load(STORE.repo)}/${path}`, {
    headers: { Authorization: `Bearer ${load(STORE.token)}`, Accept: "application/vnd.github+json",
      ...(etags[path] ? { "If-None-Match": etags[path] } : {}) },
    cache: "no-store",
  });
  if (res.status === 304 || !res.ok) return false;
  const first = !(path in etags);
  etags[path] = res.headers.get("ETag") || "";
  return !first;
}
function editing() {
  return state.configDirty || state.profileDirty || state.companiesDirty || hhFormFilled() || !!state.hhEditing || $("#preview").open;
}
async function refreshData() {
  if (document.visibilityState !== "visible") return;
  try {
    if (await changed(`${WORKFLOW}/runs?per_page=6`)) { loadRuns(); loadLastFullScan(); }
    if (!(await changed("commits?per_page=1"))) return;
    // a status menu that is open must not be rebuilt under the cursor; it is picked up on the next round
    if (!document.activeElement?.matches?.("select.status")) { loadRecords(); loadHeadhunters(); }
    const cfg = await readJson(PATHS.config);
    if (cfg.sha === state.sha) return;
    if (editing()) {
      status("Podešavanja su izmenjena negde drugde – sačuvaj ili osveži stranicu da vidiš najnovija.", "err");
    } else {
      state.config = cfg.data; state.sha = cfg.sha;
      renderSettings();
      status("↻ Podešavanja su osvežena.", "ok");
    }
  } catch (_) { /* offline or rate limited: try again next round */ }
}
function currentVersion() {
  return (document.querySelector('script[src*="app.js"]')?.getAttribute("src").match(/v=([\w-]+)/) || [])[1] || "";
}
async function checkVersion() {
  if (document.visibilityState !== "visible") return;
  try {
    const html = await (await fetch(`index.html?check=${Date.now()}`, { cache: "no-store" })).text();
    const latest = (html.match(/app\.js\?v=([\w-]+)/) || [])[1];
    if (!latest || latest === currentVersion()) return;
    const busy = editing() || [...document.querySelectorAll("#sync-now, #full-scan")].some((b) => b.disabled);
    // a plain reload may get the browser's cached page (GitHub Pages lets it keep one for 10 minutes)
    if (!busy) { saveView(); return location.replace(`${location.pathname}?v=${latest}`); }
    $("#update-banner").classList.remove("hidden");
  } catch (_) { /* try again later */ }
}
// "20261103e" -> "v 03.11.2026 e", shown in the corner so the user can tell which version is open
function showVersion() {
  const v = currentVersion();
  const m = v.match(/^(\d{4})(\d{2})(\d{2})(\w*)$/);
  $("#version").textContent = m ? `v ${m[3]}.${m[2]}.${m[1]} ${m[4]}`.trim() : v ? `v ${v}` : "";
}
// a reload for a new version comes back to the same tab, filter, sort and scroll position
const VIEW_KEY = "dash.view";
function saveView() {
  const tab = document.querySelector(".tab.active")?.dataset.tab || "settings";
  try {
    sessionStorage.setItem(VIEW_KEY, JSON.stringify({ tab, filter: $("#status-filter").value, sort: state.sort, scroll: scrollY }));
  } catch (_) { /* private mode: the page just opens on the first tab */ }
}
function savedView() {
  try { return JSON.parse(sessionStorage.getItem(VIEW_KEY) || "null"); } catch (_) { return null; }
}
function restoreView() {
  const view = savedView();
  try { sessionStorage.removeItem(VIEW_KEY); } catch (_) { /* nothing saved */ }
  if (!view) return;
  if (view.sort) state.sort = view.sort;
  document.querySelector(`.tab[data-tab="${view.tab}"]`)?.click();
  if (view.filter) {
    const filter = $("#status-filter");
    filter.append(el("option", { value: view.filter, text: view.filter }));
    filter.value = view.filter;
    renderRecords();
  }
  requestAnimationFrame(() => scrollTo(0, view.scroll || 0));
}
function startLiveUpdates() {
  showVersion();
  // the sync checkbox is not a setting, so it doesn't count as an unsaved change
  const touched = (e) => { if (e.target.id !== "sync-force") state.configDirty = true; };
  $("#tab-settings").addEventListener("input", touched);
  $("#tab-settings").addEventListener("change", touched);
  $("#update-reload").addEventListener("click", () => { saveView(); location.replace(`${location.pathname}?v=${Date.now()}`); });
  changed("commits?per_page=1"); changed(`${WORKFLOW}/runs?per_page=6`);  // remember the starting point
  setInterval(refreshData, POLL_MS);
  setInterval(checkVersion, VERSION_MS);
  document.addEventListener("visibilitychange", () => { refreshData(); checkVersion(); });
}

// ---------- headhunters ----------
// Agencies live in data/headhunters.json; "Kreiraj mail" marks one as waiting and Claude (on the Mac) writes the
// tailored CV and email with `python -m jobhunter.headhunters ready`, which this tab then shows with copy buttons.
const HH_WAITING = "Čeka Claude";
const HH_STATUSES = ["Novo", HH_WAITING, "Spremno", "Poslato", "Odgovorili", "Intervju", "Bez odgovora", "Odbijeno"];
const HH_GROUP = { Novo: "wait", [HH_WAITING]: "todo", Spremno: "todo", Poslato: "sent", Odgovorili: "review",
  Intervju: "interview", "Bez odgovora": "closed", Odbijeno: "rejected" };
// a confirmation fades after a few seconds so it never outlives what it talks about; errors stay
let hhStatusTimer;
function hhStatus(text, kind = "") {
  const s = $("#hh-status");
  s.textContent = text;
  s.className = kind;
  clearTimeout(hhStatusTimer);
  if (kind === "ok") hhStatusTimer = setTimeout(() => { s.textContent = ""; s.className = ""; }, 8000);
}
function hhFormFilled() {
  return ["#hh-firma", "#hh-kontakt", "#hh-email", "#hh-sajt", "#hh-napomena", "#hh-fajl"].some((id) => $(id)?.value);
}
async function loadHeadhunters() {
  try {
    const res = await readJson(PATHS.headhunters);
    state.hh = res.data; state.hhSha = res.sha;
  } catch (e) {
    if (e.status !== 404) return;  // keep what is shown; a missing file just means no agencies yet
    state.hh = { agencies: [] }; state.hhSha = null;
  }
  // a mail text being selected or a status menu that is open must not be rebuilt under the cursor
  if (!state.hhEditing && !document.activeElement?.closest?.("#hh-list")) renderHeadhunters();
}
// writes the change; if something else saved meanwhile, takes that version and applies the change again
async function hhSave(change, message) {
  change(state.hh);
  renderHeadhunters();
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await api(PATHS.headhunters, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message, content: textToB64(JSON.stringify(state.hh, null, 2) + "\n"),
          ...(state.hhSha ? { sha: state.hhSha } : {}) }),
      });
      state.hhSha = (await res.json()).content.sha;
      return true;
    } catch (e) {
      if ((e.status !== 409 && e.status !== 422) || attempt) {
        hhStatus(e.status === 403 || e.status === 404
          ? "Ključ nema dozvolu za upis (potrebno: Contents – Read and write)." : "Čuvanje nije uspelo. Pokušaj ponovo.", "err");
        await loadHeadhunters();
        return false;
      }
      const fresh = await readJson(PATHS.headhunters);
      state.hh = fresh.data; state.hhSha = fresh.sha;
      change(state.hh);
      renderHeadhunters();
    }
  }
  return false;
}
const hhFind = (reg, id) => reg.agencies.find((a) => a.id === id);
async function copyText(text, btn) {
  try {
    await navigator.clipboard.writeText(text);
  } catch (_) {
    const area = el("textarea", { class: "offscreen" });
    area.value = text;
    document.body.append(area);
    area.select();
    document.execCommand("copy");
    area.remove();
  }
  const label = btn.textContent;
  btn.textContent = "✅ Kopirano";
  setTimeout(() => { btn.textContent = label; }, 1500);
}
function copyRow(label, text, multiline = false) {
  const value = multiline ? el("pre", { class: "hh-body", text }) : el("span", { class: "hh-value", text });
  const btn = el("button", { type: "button", class: "ghost copy", text: "📋 Copy" });
  btn.addEventListener("click", () => copyText(text, btn));
  return el("div", { class: `hh-row${multiline ? " multi" : ""}` }, [el("span", { class: "hh-label", text: label }), value, btn]);
}
const FOLLOWUP_DAYS = 10;
const HH_SECTIONS = [
  ["U pripremi", ["Novo", HH_WAITING, "Spremno"]],
  ["Poslato", ["Poslato", "Odgovorili", "Intervju"]],
  ["Završeno", ["Bez odgovora", "Odbijeno"]],
];
// local date, so an agency added after midnight is not dated the day before
const today = () => new Date().toLocaleDateString("sv-SE");
function daysSince(date) {
  return Math.floor((new Date(today()) - new Date(date.slice(0, 10))) / 86400000);
}
function sinceText(date) {
  const d = daysSince(date);
  const [y, m, day] = date.slice(0, 10).split("-");
  return `${day}.${m}.${y}. (${d === 0 ? "danas" : d === 1 ? "juče" : `pre ${d} dana`})`;
}
// sent, no answer, no follow-up yet and the waiting time is up
const followupDue = (a) => a.status === "Poslato" && a.poslato && !a.followup_poslato && !a.followup_mail &&
  !a.followup_zatrazeno && daysSince(a.poslato) >= FOLLOWUP_DAYS;
function hhUpdate(a, change, message, done) {
  return hhSave((reg) => { const x = hhFind(reg, a.id); if (x) change(x); }, message).then((ok) => ok && done && hhStatus(done, "ok"));
}
function hhCard(a) {
  const status = el("select", { class: "status", "data-group": HH_GROUP[a.status] || "", "aria-label": "Status" },
    HH_STATUSES.map((n) => el("option", { value: n, text: n })));
  status.value = a.status || "Novo";
  status.addEventListener("change", () => hhUpdate(a, (x) => {
    x.status = status.value;
    if (status.value === "Poslato") x.poslato = x.poslato || today();
  }, `Headhunter ${a.firma}: ${status.value}`, `✅ ${a.firma}: ${status.value}.`));
  const contact = [a.kontakt, a.email].filter(Boolean).join(" · ");
  const site = a.sajt ? el("a", { href: a.sajt, target: "_blank", rel: "noopener noreferrer", text: "sajt" }) : null;
  const head = el("div", { class: "row-between" }, [el("h3", { text: a.firma }), status]);
  const meta = el("p", { class: "muted" }, [contact, ...(site ? [" · ", site] : []),
    ` · ${a.jezik === "en" ? "engleski" : "srpski"}`]);
  const parts = [head, meta];
  if (a.poslato) {
    parts.push(el("p", { class: "hh-sent", text: `📨 Poslato ${sinceText(a.poslato)}` +
      (a.followup_poslato ? ` · follow-up ${sinceText(a.followup_poslato)}` : "") }));
  }
  if (a.napomena) parts.push(el("p", { class: "hh-note", text: a.napomena }));
  const sent = !HH_SECTIONS[0][1].includes(a.status);

  // follow-up: reminder, request, the email itself, then "sent"
  if (followupDue(a)) {
    const ask = el("button", { type: "button", text: "✍️ Zatraži follow-up mejl" });
    ask.addEventListener("click", () => hhUpdate(a, (x) => { x.followup_zatrazeno = new Date().toISOString(); },
      `Headhunter ${a.firma}: zatražen follow-up`, `✅ Zatražen follow-up za ${a.firma}. Napiši Claude-u „obradi headhuntere“.`));
    parts.push(el("div", { class: "hh-alert" }, [
      el("span", { text: `⏰ Prošlo je ${daysSince(a.poslato)} dana bez odgovora – vreme za follow-up.` }), ask]));
  } else if (a.followup_zatrazeno && !a.followup_mail) {
    parts.push(el("p", { class: "hh-waiting", text: "⏳ Čeka da Claude napiše follow-up – napiši mu „obradi headhuntere“." }));
  } else if (a.status === "Poslato" && a.followup_poslato && daysSince(a.followup_poslato) >= FOLLOWUP_DAYS) {
    parts.push(el("p", { class: "hh-waiting", text: `Ni ${daysSince(a.followup_poslato)} dana posle follow-up-a nema odgovora – ` +
      "možeš da prebaciš status na „Bez odgovora“." }));
  }
  if (a.followup_mail && !a.followup_poslato) {
    const done = el("button", { type: "button", text: "✅ Poslao sam follow-up" });
    done.addEventListener("click", () => hhUpdate(a, (x) => { x.followup_poslato = today(); },
      `Headhunter ${a.firma}: follow-up poslat`, `✅ Follow-up za ${a.firma} je zabeležen.`));
    parts.push(el("h4", { text: "Follow-up mejl" }), ...mailBlock(a, "followup_mail", false, [done]));
  }

  if (a.status === HH_WAITING) {
    parts.push(el("p", { class: "hh-waiting", text: a.izmena
      ? "⏳ Čeka da Claude ispravi CV i mejl po tvojoj zameri – napiši mu „obradi headhuntere“."
      : "⏳ Čeka da Claude napravi CV i mejl – napiši mu „obradi headhuntere“." }));
  }
  if (a.izmena) parts.push(el("p", { class: "hh-note", text: `💬 Tvoja zamerka: ${a.izmena}` }));
  const actions = el("div", { class: "hh-actions" });
  if (!sent) {
    const create = el("button", { type: "button", text: a.mail ? "↻ Napravi ponovo" : "✉️ Kreiraj mail" });
    create.addEventListener("click", () => hhUpdate(a, (x) => { x.status = HH_WAITING; x.zatrazeno = new Date().toISOString(); },
      `Headhunter ${a.firma}: zatražen CV i mejl`, `✅ Zatraženo za ${a.firma}. Napiši Claude-u „obradi headhuntere“.`));
    actions.append(create);
  }
  if (a.prilog && !a.cv_fajl) actions.append(fileButton(a.prilog, "📎 Prilog"));  // only until the CV is made from it
  if (a.cv_fajl) {
    const look = el("button", { type: "button", class: "ghost", text: "👁 Pregledaj CV" });
    look.addEventListener("click", () => previewCv(a));
    actions.append(look, fileButton(a.cv_fajl, "📄 CV"));
  }
  const remove = el("button", { type: "button", class: "danger", text: "Ukloni" });
  remove.addEventListener("click", () => {
    if (!confirm(`Ukloniti ${a.firma} sa liste?`)) return;
    hhSave((reg) => { reg.agencies = reg.agencies.filter((x) => x.id !== a.id); }, `Headhunter uklonjen: ${a.firma}`)
      .then((ok) => { if (ok) { hhStatus(`🗑 ${a.firma} je uklonjen sa liste.`, "ok"); deleteFiles([a.cv_fajl, a.prilog]); } });
  });
  if (a.mail && sent && state.hhEditing !== `${a.id}:mail`) {
    // once sent, the first email is kept for reference but folded away
    parts.push(el("details", { class: "hh-sent-mail" }, [el("summary", { text: "📨 Poslati mejl" }), ...mailBlock(a, "mail", true, [])]));
  } else if (a.mail) {
    parts.push(...mailBlock(a, "mail", true, []));
  }
  actions.append(remove);
  parts.push(actions);
  return el("div", { class: `hh-card${followupDue(a) ? " due" : ""}` }, parts);
}
// the email (or its editor) with copy buttons, plus its own row of buttons
function mailBlock(a, key, withCv, extra) {
  const m = a[key];
  if (state.hhEditing === `${a.id}:${key}`) return [hhEditor(a, key)];
  const edit = el("button", { type: "button", class: "ghost", text: "✏️ Izmeni tekst" });
  edit.addEventListener("click", () => { state.hhEditing = `${a.id}:${key}`; renderHeadhunters(); });
  return [
    el("div", { class: "hh-mail" }, [
      copyRow("Za", m.to || a.email || ""), copyRow("Naslov", m.subject || ""), copyRow("Tekst", m.body || "", true),
      ...(m.izmenjeno ? [el("p", { class: "muted", text: `✏️ Tvoja izmena od ${m.izmenjeno}.` })] : []),
    ]),
    el("div", { class: "hh-actions mail-actions" }, [...extra, mailMenu(a, m, withCv && a.cv_fajl), edit]),
  ];
}
// where to write the email: web mail opens in a new tab, "Mejl aplikacija" opens the computer's default mail program;
// none of them can attach a file, so the CV is downloaded with the same click, ready to drag in
const MAIL_APPS = [
  ["Gmail", (to, su, body) => `https://mail.google.com/mail/?view=cm&fs=1&to=${to}&su=${su}&body=${body}`],
  ["Outlook (lični: outlook.com, hotmail)", (to, su, body) => `https://outlook.live.com/mail/0/deeplink/compose?to=${to}&subject=${su}&body=${body}`],
  ["Outlook (poslovni: Microsoft 365)", (to, su, body) => `https://outlook.office.com/mail/deeplink/compose?to=${to}&subject=${su}&body=${body}`],
  ["Yahoo Mail", (to, su, body) => `https://compose.mail.yahoo.com/?to=${to}&subject=${su}&body=${body}`],
  ["Mejl aplikacija na računaru (Apple Mail, Outlook…)", (to, su, body) => `mailto:${to}?subject=${su}&body=${body}`],
];
function mailMenu(a, m, cv) {
  const enc = (t) => encodeURIComponent(t || "");
  const items = MAIL_APPS.map(([name, url]) => {
    const link = el("a", { href: url(enc(m.to || a.email), enc(m.subject), enc(m.body)), text: name,
      ...(url("", "", "").startsWith("mailto:") ? {} : { target: "_blank", rel: "noopener noreferrer" }) });
    link.addEventListener("click", () => {
      link.closest("details").open = false;
      if (cv) downloadFile(cv).catch(() => hhStatus("CV nije preuzet – preuzmi ga dugmetom 📄 CV.", "err"));
    });
    return link;
  });
  return el("details", { class: "mail-menu" }, [
    el("summary", { class: "button ghost", text: cv ? "📧 Otvori mejl + preuzmi CV ▾" : "📧 Otvori mejl ▾" }),
    el("div", { class: "mail-menu-list" }, [...items, ...(cv ? [el("p", { class: "muted",
      text: "Link ne može sam da priloži fajl: CV se preuzme u Downloads, pa ga prevuci u mejl (ili spajalica 📎)." })] : [])]),
  ]);
}
// the CV opens on the page (the browser's own PDF viewer), with a box to tell Claude what to change
let previewUrl = "";
let previewAgency = null;
async function previewCv(a) {
  const dlg = $("#preview");
  previewAgency = a;
  $("#preview-title").textContent = `CV – ${a.firma}`;
  $("#preview-text").value = "";
  $("#preview-form").classList.toggle("hidden", HH_SECTIONS[1][1].concat(HH_SECTIONS[2][1]).includes(a.status));
  try {
    const res = await api(a.cv_fajl, { headers: { Accept: "application/vnd.github.raw+json" } });
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    previewUrl = URL.createObjectURL(new Blob([await res.arrayBuffer()], { type: "application/pdf" }));
  } catch (_) {
    return hhStatus("CV nije mogao da se učita. Pokušaj ponovo.", "err");
  }
  $("#preview-frame").src = previewUrl;
  $("#preview-open").href = previewUrl;
  dlg.showModal();
}
$("#preview-close").addEventListener("click", () => $("#preview").close());
$("#preview").addEventListener("click", (ev) => { if (ev.target.id === "preview") ev.target.close(); });  // click outside
$("#preview-form").addEventListener("submit", (ev) => {
  ev.preventDefault();
  const a = previewAgency;
  const text = $("#preview-text").value.trim();
  if (!a || !text) return;
  $("#preview").close();
  hhUpdate(a, (x) => { x.izmena = text; x.status = HH_WAITING; x.zatrazeno = new Date().toISOString(); },
    `Headhunter ${a.firma}: zatražena izmena`, `✅ Zamerka za ${a.firma} je zapisana. Napiši Claude-u „obradi headhuntere“.`);
});
// a click anywhere else closes an open mail menu
document.addEventListener("click", (ev) => {
  document.querySelectorAll(".mail-menu[open]").forEach((d) => { if (!d.contains(ev.target)) d.open = false; });
});
// the agency's CV and attachment go with it (best effort: a file left behind does no harm)
async function deleteFiles(paths) {
  for (const path of paths.filter(Boolean)) {
    try {
      const { sha } = await (await api(path)).json();
      await api(path, { method: "DELETE", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: `Headhunter: obrisan ${path.split("/").pop()}`, sha }) });
    } catch (_) { /* already gone */ }
  }
}
function hhEditor(a, key) {
  const m = a[key];
  const to = el("input", { type: "email" }); to.value = m.to || a.email || "";
  const subject = el("input", { type: "text" }); subject.value = m.subject || "";
  const body = el("textarea", { rows: "16" }); body.value = m.body || "";
  const save = el("button", { type: "button", text: "💾 Sačuvaj" });
  const cancel = el("button", { type: "button", class: "ghost", text: "Otkaži" });
  cancel.addEventListener("click", () => { state.hhEditing = null; renderHeadhunters(); });
  save.addEventListener("click", () => {
    const mail = { to: to.value.trim(), subject: subject.value.trim(), body: body.value.replace(/\s+$/, "") + "\n",
      izmenjeno: new Date().toLocaleDateString("sr-Latn-RS") };
    state.hhEditing = null;
    hhUpdate(a, (x) => { x[key] = mail; }, `Headhunter ${a.firma}: mejl izmenjen`, `✅ Mejl za ${a.firma} je sačuvan.`);
  });
  return el("div", { class: "hh-edit" }, [
    el("label", {}, ["Za", to]), el("label", {}, ["Naslov", subject]), el("label", {}, ["Tekst", body]),
    el("div", { class: "hh-actions" }, [save, cancel]),
  ]);
}
function renderHeadhunters() {
  const list = $("#hh-list");
  const agencies = state.hh.agencies || [];
  // in each section: what needs doing first, then the oldest sent, then by name
  const rank = (a) => (followupDue(a) ? 0 : a.followup_mail && !a.followup_poslato ? 1 : 2);
  const order = (a, b) => rank(a) - rank(b) || String(a.poslato || "~").localeCompare(String(b.poslato || "~")) ||
    String(a.firma).localeCompare(String(b.firma));
  const known = HH_SECTIONS.flatMap(([, s]) => s);
  const sections = HH_SECTIONS.map(([title, statuses], i) => {
    const items = agencies.filter((a) => statuses.includes(a.status) || (i === 0 && !known.includes(a.status))).sort(order);
    if (!items.length) return null;
    const due = items.filter(followupDue).length;
    const label = `${title} (${items.length})${due ? ` · ⏰ ${due} za follow-up` : ""}`;
    if (i < 2) return el("div", { class: "hh-section" }, [el("h3", { class: "hh-section-title", text: label }), ...items.map(hhCard)]);
    const box = el("details", { class: "hh-section" }, [el("summary", { class: "hh-section-title", text: label }), ...items.map(hhCard)]);
    box.open = !!state.hhDoneOpen;
    box.addEventListener("toggle", () => { state.hhDoneOpen = box.open; });
    return box;
  }).filter(Boolean);
  list.replaceChildren(...sections);
  if (!agencies.length) list.append(el("p", { class: "muted", text: "Još nema agencija – dodaj prvu ispod." }));
}
function safeName(name) {
  return name.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^A-Za-z0-9.]+/g, "_").replace(/^_+|_+$/g, "") || "prilog";
}
function fileToB64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1]);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}
$("#hh-form").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const form = ev.target;
  const btn = form.querySelector("button[type=submit]");
  const firma = $("#hh-firma").value.trim();
  const id = `hh-${Date.now().toString(36)}`;
  const file = $("#hh-fajl").files[0];
  if (file && file.size > 10 * 1024 * 1024) return hhStatus("Fajl je veći od 10 MB.", "err");
  btn.disabled = true;
  hhStatus("Čuvam…");
  let prilog = "";
  try {
    if (file) {
      prilog = `data/headhunters/${id}/prilog_${safeName(file.name)}`;  // never the name of the CV Claude makes
      await api(prilog, { method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: `Headhunter ${firma}: prilog`, content: await fileToB64(file) }) });
    }
  } catch (e) {
    btn.disabled = false;
    return hhStatus("Otpremanje fajla nije uspelo. Pokušaj ponovo.", "err");
  }
  const agency = { id, firma, kontakt: $("#hh-kontakt").value.trim(), email: $("#hh-email").value.trim(),
    sajt: $("#hh-sajt").value.trim(), jezik: $("#hh-jezik").value, napomena: $("#hh-napomena").value.trim(),
    ...(prilog ? { prilog } : {}), status: "Novo", dodato: today() };
  const ok = await hhSave((reg) => { reg.agencies = reg.agencies || []; reg.agencies.push(agency); }, `Headhunter dodat: ${firma}`);
  btn.disabled = false;
  if (ok) { form.reset(); hhStatus(`✅ ${firma} je dodat. Klikni ✉️ Kreiraj mail kad budeš spreman.`, "ok"); }
});

// ---------- records table ----------
async function loadRecords() {
  try {
    const res = await readJson(PATHS.records);
    state.records = res.data; state.recordsSha = res.sha;
  } catch (_) {
    state.records = [];
  }
  renderRecords();
}
function recordDate(r) {
  return (r.datum_prijave || r.created_at || "").slice(0, 10);
}
function recordsStatus(text, kind = "") {
  const s = $("#records-status");
  s.textContent = text;
  s.className = kind;
}
function statusSelect(r) {
  const names = STATUSES.map(([name]) => name);
  if (r.status && !names.includes(r.status)) names.push(r.status);
  const sel = el("select", { class: "status", "data-group": STATUS_GROUP[r.status] || "", "aria-label": "Status" },
    names.map((n) => el("option", { value: n, text: n })));
  sel.value = r.status || "";
  sel.addEventListener("change", () => setStatus(r.id, sel.value));
  return sel;
}
async function setStatus(id, value) {
  const today = new Date().toISOString().slice(0, 10);
  const apply = (records) => {
    const r = records.find((x) => x.id === id);
    if (r) { r.status = value; r.datum_poslednjeg_kontakta = today; }
    return r;
  };
  apply(state.records);
  renderRecords();
  recordsStatus("Čuvam…");
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await api(PATHS.records, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: `Status izmenjen preko dashboard-a: ${value}`,
          content: textToB64(JSON.stringify(state.records, null, 2) + "\n"),
          sha: state.recordsSha,
        }),
      });
      state.recordsSha = (await res.json()).content.sha;
      const where = ARCHIVED.has(STATUS_GROUP[value]) ? " Prijava je premeštena u Arhivu." : "";
      return recordsStatus(`✅ Sačuvano: ${value}.${where}`, "ok");
    } catch (e) {
      if (e.status !== 409 || attempt) {
        recordsStatus(e.status === 403 || e.status === 404
          ? "Ključ nema dozvolu za upis (potrebno: Contents – Read and write)." : "Čuvanje nije uspelo. Pokušaj ponovo.", "err");
        return loadRecords();
      }
      // the bot saved meanwhile: take its version and re-apply this change
      const fresh = await readJson(PATHS.records);
      state.records = fresh.data; state.recordsSha = fresh.sha;
      apply(state.records);
      renderRecords();
    }
  }
}
async function downloadFile(path) {
  const res = await api(path, { headers: { Accept: "application/vnd.github.raw+json" } });
  const url = URL.createObjectURL(await res.blob());
  const a = el("a", { href: url, download: path.split("/").pop() });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}
// files live in the private repo, so they are fetched with the token and handed to the browser as a download
function fileButton(path, label) {
  const btn = el("button", { class: "ghost file", type: "button", text: label, title: path.split("/").pop() });
  btn.addEventListener("click", async () => {
    btn.disabled = true;
    try {
      await downloadFile(path);
    } catch (e) {
      recordsStatus(e.status === 404 ? "Fajl više ne postoji (prijava je možda arhivirana)." : "Preuzimanje nije uspelo.", "err");
    } finally {
      btn.disabled = false;
    }
  });
  return btn;
}
function renderRecords() {
  const archive = state.view === "archive";
  $("#records-title").textContent = archive ? "Arhiva" : "Prijave";
  $("#records-hint").textContent = archive
    ? "Odbijene, preskočene i prijave bez odgovora. Njihovi CV-i i pisma se brišu pri sledećoj sinhronizaciji. Promeni status da vratiš prijavu među aktivne."
    : "Status menjaš direktno u tabeli. Odbijene i završene prijave same prelaze u Arhivu.";
  const inView = state.records.filter((r) => isArchived(r) === archive);
  const filter = $("#status-filter");
  const wanted = filter.value;
  const statuses = [...new Set(inView.map((r) => r.status).filter(Boolean))].sort();
  filter.replaceChildren(el("option", { value: "", text: "Svi statusi" }), ...statuses.map((s) => el("option", { value: s, text: s })));
  filter.value = statuses.includes(wanted) ? wanted : "";
  const { key, asc } = state.sort;
  const val = (r) => (key === "date" ? recordDate(r) : key === "ocena" ? Number(r.ocena) || 0 : String(r[key] || "").toLowerCase());
  const rows = inView.filter((r) => !filter.value || r.status === filter.value)
    .sort((a, b) => (val(a) < val(b) ? -1 : val(a) > val(b) ? 1 : 0) * (asc ? 1 : -1));
  const body = $("#records tbody");
  body.replaceChildren(...rows.map((r) => {
    const title = r.link ? el("a", { href: r.link, target: "_blank", rel: "noopener noreferrer", text: r.pozicija || "—" }) : (r.pozicija || "—");
    return el("tr", {}, [
      el("td", { text: recordDate(r) }), el("td", { text: r.firma || "" }), el("td", {}, [title]),
      el("td", { text: r.izvor || "" }), el("td", { text: r.ocena ? `${r.ocena}/10` : "" }),
      el("td", {}, [statusSelect(r)]),
      el("td", { class: "files" }, (r.cv_fajlovi || []).map((f, i) => fileButton(f, i ? "📄 career-ops" : "📄 CV"))),
      el("td", { class: "files" }, r.pismo_fajl ? [fileButton(r.pismo_fajl, "✉️ Pismo")] : []),
      el("td", { class: "note", text: (r.napomena || "").split(" | ").join("\n") }),
    ]);
  }));
  if (!rows.length) body.append(el("tr", {}, [el("td", { colspan: "9", class: "muted", text: "Nema zapisa." })]));
  document.querySelectorAll("#records th").forEach((th) => {
    th.classList.toggle("sorted", th.dataset.key === key);
    th.classList.toggle("asc", th.dataset.key === key && asc);
  });
}
document.querySelectorAll("#records th").forEach((th) => th.addEventListener("click", () => {
  state.sort = { key: th.dataset.key, asc: state.sort.key === th.dataset.key ? !state.sort.asc : false };
  renderRecords();
}));
$("#status-filter").addEventListener("change", renderRecords);

start();
