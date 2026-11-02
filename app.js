"use strict";

// Everything shown here is read from the private repository after login; this file holds no data.
const PATHS = {
  taxonomy: "config/taxonomy.json",
  sources: "config/sources.json",
  config: "config/config.json",
  companies: "config/companies.json",
  records: "data/applications.json",
};
const INTERVALS = [1, 2, 3, 4, 6, 8, 12, 24];
const STORE = { token: "dash.token", repo: "dash.repo" };

const $ = (sel) => document.querySelector(sel);
const state = { taxonomy: null, sources: null, config: null, sha: null, records: [], sort: { key: "date", asc: false },
  companies: null, companiesSha: null, companiesDirty: false };

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
async function api(path, options = {}) {
  const res = await fetch(`https://api.github.com/repos/${load(STORE.repo)}/contents/${path}`, {
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
    $("#app").classList.remove("hidden");
    await loadCompanies();
    renderSettings();
    loadRecords();
  } catch (e) {
    showLogin(e.status === 401 ? "Ključ nije ispravan ili je istekao." :
      e.status === 404 ? "Repozitorijum nije pronađen ili ključ nema pristup." : "Greška pri učitavanju. Pokušaj ponovo.");
  }
}
function showLogin(message = "") {
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
document.querySelectorAll(".tab").forEach((btn) => btn.addEventListener("click", () => {
  document.querySelectorAll(".tab").forEach((b) => b.classList.toggle("active", b === btn));
  document.querySelectorAll(".tab-panel").forEach((p) => p.classList.toggle("hidden", p.id !== `tab-${btn.dataset.tab}`));
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
    input.addEventListener("change", () => { cfg.sources_enabled[src.id] = input.checked; renderIntervalWarning(); });
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
  cfg.max_age_days = Math.max(1, Math.min(14, Number($("#max-age").value) || 3));
  const empty = cfg.searches.find((s) => !s.specializations.length || !s.seniority.length || !s.locations.length);
  if (empty) return status(`„${empty.name}": izaberi bar jednu specijalizaciju, nivo i lokaciju.`, "err");
  status("Čuvam…");
  if (state.companiesDirty && !(await saveCompanies())) return;
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
    } else {
      status("Čuvanje liste firmi nije uspelo.", "err");
    }
    return false;
  }
}

// ---------- records table ----------
async function loadRecords() {
  try {
    state.records = (await readJson(PATHS.records)).data;
  } catch (_) {
    state.records = [];
  }
  const filter = $("#status-filter");
  const statuses = [...new Set(state.records.map((r) => r.status).filter(Boolean))].sort();
  filter.replaceChildren(el("option", { value: "", text: "Svi statusi" }), ...statuses.map((s) => el("option", { value: s, text: s })));
  renderRecords();
}
function recordDate(r) {
  return (r.datum_prijave || r.created_at || "").slice(0, 10);
}
function renderRecords() {
  const { key, asc } = state.sort;
  const wanted = $("#status-filter").value;
  const val = (r) => (key === "date" ? recordDate(r) : key === "ocena" ? Number(r.ocena) || 0 : String(r[key] || "").toLowerCase());
  const rows = state.records.filter((r) => !wanted || r.status === wanted)
    .sort((a, b) => (val(a) < val(b) ? -1 : val(a) > val(b) ? 1 : 0) * (asc ? 1 : -1));
  const body = $("#records tbody");
  body.replaceChildren(...rows.map((r) => {
    const title = r.link ? el("a", { href: r.link, target: "_blank", rel: "noopener noreferrer", text: r.pozicija || "—" }) : (r.pozicija || "—");
    return el("tr", {}, [
      el("td", { text: recordDate(r) }), el("td", { text: r.firma || "" }), el("td", {}, [title]),
      el("td", { text: r.izvor || "" }), el("td", { text: r.ocena ? `${r.ocena}/10` : "" }),
      el("td", {}, [el("span", { class: "status", text: r.status || "" })]),
    ]);
  }));
  if (!rows.length) body.append(el("tr", {}, [el("td", { colspan: "6", class: "muted", text: "Nema zapisa." })]));
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
