"use strict";

// Demo client for the Bouncer service.
//
// The two-stage pipeline now lives in the Node backend (classifier/server.js);
// this page just uploads images to it and renders the verdicts. By default it
// talks to the same origin that served it, but you can point it at a remote
// deployed container via the "Classifier API base" field in Settings.

const LS = {
  apiBase: "ic.apiBase",
  apiToken: "ic.apiToken",
  describerModel: "ic.describerModel",
  decisionModel: "ic.decisionModel",
  temp: "ic.temp",
  threshold: "ic.threshold",
  tab: "ic.tab",
  history: "ic.history",
};

// ---- State ----
const state = {
  images: [], // { id, name, dataUrl, result }
};

// ---- Elements ----
const $ = (id) => document.getElementById(id);
const els = {
  dropzone: $("dropzone"),
  fileInput: $("fileInput"),
  runBtn: $("runBtn"),
  clearBtn: $("clearBtn"),
  results: $("results"),
  modelChip: $("modelChip"),
  apiBase: $("apiBase"),
  apiToken: $("apiToken"),
  overridesNotice: $("overridesNotice"),
  describerSelect: $("describerSelect"),
  decisionSelect: $("decisionSelect"),
  threshold: $("threshold"),
  thrVal: $("thrVal"),
  describerPrompt: $("describerPrompt"),
  resetDescriberBtn: $("resetDescriberBtn"),
  systemPrompt: $("systemPrompt"),
  resetPromptBtn: $("resetPromptBtn"),
  temperature: $("temperature"),
  tempVal: $("tempVal"),
  refreshBtn: $("refreshBtn"),
  connDot: $("connDot"),
  connText: $("connText"),
};

// Base URL of the classifier API ("" = same origin as this page).
// Anything that isn't an absolute http(s) URL is ignored rather than prefixed onto
// every request — browsers like to autofill this field, and a stray value here
// would break every call with a confusing "no connection".
function apiBase() {
  const raw = (els.apiBase.value || "").trim();
  if (!raw) return "";
  if (!/^https?:\/\//i.test(raw)) {
    console.warn("Ignoring 'Classifier API base' — not an absolute http(s) URL:", raw);
    return "";
  }
  return raw.replace(/\/+$/, "");
}

// Every call goes through here so the token (if any) is always attached.
function api(pathname, init = {}) {
  const token = (els.apiToken.value || "").trim();
  const headers = { ...(init.headers || {}) };
  if (token) headers.Authorization = "Bearer " + token;
  return fetch(apiBase() + pathname, { ...init, headers });
}

// ---- Tabs ----
function activateTab(name) {
  const tab = document.querySelector('.tab[data-tab="' + name + '"]');
  const panel = $("tab-" + name);
  if (!tab || !panel) return;
  document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
  document.querySelectorAll(".panel").forEach((p) => p.classList.remove("active"));
  tab.classList.add("active");
  panel.classList.add("active");
  localStorage.setItem(LS.tab, name);
}
document.querySelectorAll(".tab").forEach((tab) => {
  tab.addEventListener("click", () => activateTab(tab.dataset.tab));
});

// ---- Settings persistence (models/threshold/temp/tab/apiBase — NOT prompts) ----
function loadSettings() {
  const savedBase = localStorage.getItem(LS.apiBase) || "";
  // Drop junk a browser autofill may have persisted here in an earlier session.
  els.apiBase.value = /^https?:\/\//i.test(savedBase) ? savedBase : "";
  if (savedBase && !els.apiBase.value) localStorage.removeItem(LS.apiBase);
  els.apiToken.value = localStorage.getItem(LS.apiToken) || "";
  els.temperature.value = localStorage.getItem(LS.temp) || "0";
  els.tempVal.textContent = Number(els.temperature.value).toFixed(1);
  els.threshold.value = localStorage.getItem(LS.threshold) || "0.8";
  els.thrVal.textContent = Number(els.threshold.value).toFixed(2);
}
function saveSettings() {
  localStorage.setItem(LS.apiBase, els.apiBase.value.trim());
  localStorage.setItem(LS.apiToken, els.apiToken.value.trim());
  localStorage.setItem(LS.temp, els.temperature.value);
  localStorage.setItem(LS.threshold, els.threshold.value);
  if (validSel(els.describerSelect.value)) localStorage.setItem(LS.describerModel, els.describerSelect.value);
  if (validSel(els.decisionSelect.value)) localStorage.setItem(LS.decisionModel, els.decisionSelect.value);
}

// Load defaults + prompts from the backend. Prompts are session-only in the UI;
// the files in prompts/ remain the source of truth (edit them + "Reload").
async function loadConfig() {
  try {
    const res = await api("/api/config", { cache: "no-store" });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const cfg = await res.json();
    // When the server ignores per-request overrides, say so instead of letting the
    // settings below look effective.
    els.overridesNotice.style.display = cfg.overridesAllowed === false ? "" : "none";
    if (cfg.prompts) {
      els.describerPrompt.value = cfg.prompts.describer || "";
      els.systemPrompt.value = cfg.prompts.decision || "";
    }
    // Seed threshold from backend default only if the user hasn't set one.
    if (cfg.defaults && localStorage.getItem(LS.threshold) == null) {
      els.threshold.value = String(cfg.defaults.threshold);
      els.thrVal.textContent = Number(els.threshold.value).toFixed(2);
    }
  } catch (err) {
    console.warn("Could not load /api/config:", err);
  }
}

const reconnect = () => {
  saveSettings();
  loadConfig();
  refreshModels();
};
els.apiBase.addEventListener("change", reconnect);
els.apiToken.addEventListener("change", reconnect);
els.describerSelect.addEventListener("change", () => { saveSettings(); updateModelChip(); updateRunBtn(); });
els.decisionSelect.addEventListener("change", () => { saveSettings(); updateModelChip(); updateRunBtn(); });
els.temperature.addEventListener("input", () => {
  els.tempVal.textContent = Number(els.temperature.value).toFixed(1);
  saveSettings();
});
els.threshold.addEventListener("input", () => {
  els.thrVal.textContent = Number(els.threshold.value).toFixed(2);
  saveSettings();
});
els.refreshBtn.addEventListener("click", () => { refreshModels(); loadConfig(); });
// Reset = re-fetch the prompt from the backend (discards session edits).
els.resetDescriberBtn.addEventListener("click", loadConfig);
els.resetPromptBtn.addEventListener("click", loadConfig);

function validSel(v) {
  return v && v !== "—" && !v.startsWith("—");
}

function updateModelChip() {
  const d = els.describerSelect.value;
  const c = els.decisionSelect.value;
  els.modelChip.textContent = validSel(d) && validSel(c) ? `${d} → ${c}` : "no models";
}

function setStatus(kind, text) {
  els.connDot.className = "dot" + (kind ? " " + kind : "");
  els.connText.textContent = text;
}

// ---- Load models from the backend ----
async function refreshModels() {
  setStatus("", "Connecting…");
  els.describerSelect.innerHTML = "<option>— loading… —</option>";
  els.decisionSelect.innerHTML = "<option>— loading… —</option>";
  try {
    const res = await api("/api/models");
    if (res.status === 401) throw new Error("401 — set the API token in Settings");
    if (!res.ok) throw new Error("HTTP " + res.status);
    const data = await res.json();
    const all = (data.models || []).map((m) => m.name);
    const vision = (data.models || []).filter((m) => m.vision).map((m) => m.name);

    if (!all.length) {
      els.describerSelect.innerHTML = "<option>— no models —</option>";
      els.decisionSelect.innerHTML = "<option>— no models —</option>";
      setStatus("bad", "Connected, but no models");
      updateModelChip();
      updateRunBtn();
      return;
    }

    const defD = (data.defaults && data.defaults.describer) || localStorage.getItem(LS.describerModel);
    const defC = (data.defaults && data.defaults.decision) || localStorage.getItem(LS.decisionModel);
    // Describer (stage 1) needs to see images → vision models only.
    fillSelect(els.describerSelect, vision, localStorage.getItem(LS.describerModel) || defD, "— no vision models —");
    // Decider (stage 2) only reads text → any installed model works.
    fillSelect(els.decisionSelect, all, localStorage.getItem(LS.decisionModel) || defC, "— no models —");
    setStatus("ok", `Connected · ${all.length} models (${vision.length} vision)`);
    updateModelChip();
    updateRunBtn();
  } catch (err) {
    els.describerSelect.innerHTML = "<option>— not connected —</option>";
    els.decisionSelect.innerHTML = "<option>— not connected —</option>";
    setStatus("bad", String(err.message || err).startsWith("401") ? "Unauthorized — check the API token" : "No connection to classifier");
    updateModelChip();
    updateRunBtn();
    console.error(err);
  }
}

function fillSelect(select, names, saved, emptyLabel) {
  select.innerHTML = "";
  if (!names.length) {
    select.innerHTML = `<option>${emptyLabel}</option>`;
    return;
  }
  for (const name of names) {
    const opt = document.createElement("option");
    opt.value = name;
    opt.textContent = name;
    select.appendChild(opt);
  }
  if (saved && names.includes(saved)) select.value = saved;
}

// ---- History persistence ----
function saveHistory() {
  try {
    localStorage.setItem(LS.history, JSON.stringify(state.images));
  } catch (err) {
    console.warn("Could not save history:", err);
  }
}
function loadHistory() {
  try {
    const raw = localStorage.getItem(LS.history);
    if (raw) state.images = JSON.parse(raw) || [];
  } catch (err) {
    state.images = [];
  }
}

// ---- File handling ----
const MAX_DIM = 1536; // downscale large images before upload (bandwidth + storage)

// Decode any browser-supported image (incl. WebP) and re-encode as JPEG so the
// payload is small and consistent. The server also normalises, this is belt-and-braces.
function fileToImage(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const el = new Image();
      el.onload = () => {
        let w = el.naturalWidth, h = el.naturalHeight;
        const scale = Math.min(1, MAX_DIM / Math.max(w, h));
        w = Math.max(1, Math.round(w * scale));
        h = Math.max(1, Math.round(h * scale));
        const canvas = document.createElement("canvas");
        canvas.width = w; canvas.height = h;
        const ctx = canvas.getContext("2d");
        ctx.fillStyle = "#ffffff"; // flatten transparency for JPEG
        ctx.fillRect(0, 0, w, h);
        ctx.drawImage(el, 0, 0, w, h);
        const dataUrl = canvas.toDataURL("image/jpeg", 0.9);
        resolve({ id: "img_" + Math.random().toString(36).slice(2), name: file.name, dataUrl });
      };
      el.onerror = () => reject(new Error("Could not decode image: " + file.name));
      el.src = reader.result;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

async function addFiles(fileList) {
  const files = Array.from(fileList).filter((f) => f.type.startsWith("image/"));
  for (const f of files) {
    try {
      const img = await fileToImage(f);
      img.result = null; // not yet classified
      state.images.push(img);
    } catch (err) {
      console.warn(err);
      alert(String(err.message || err));
    }
  }
  saveHistory();
  renderCards();
  updateRunBtn();
}

function updateRunBtn() {
  const hasModels = validSel(els.describerSelect.value) && validSel(els.decisionSelect.value);
  const pending = state.images.filter(isPending).length;
  els.runBtn.disabled = !(pending && hasModels);
  els.runBtn.textContent = pending ? `Analyze (${pending})` : "Analyze";
  els.clearBtn.disabled = !state.images.length;
}

// Dropzone events
els.dropzone.addEventListener("click", () => els.fileInput.click());
els.fileInput.addEventListener("change", (e) => addFiles(e.target.files));
["dragenter", "dragover"].forEach((ev) =>
  els.dropzone.addEventListener(ev, (e) => { e.preventDefault(); els.dropzone.classList.add("drag"); })
);
["dragleave", "drop"].forEach((ev) =>
  els.dropzone.addEventListener(ev, (e) => { e.preventDefault(); els.dropzone.classList.remove("drag"); })
);
els.dropzone.addEventListener("drop", (e) => addFiles(e.dataTransfer.files));
window.addEventListener("paste", (e) => {
  if (e.clipboardData && e.clipboardData.files.length) addFiles(e.clipboardData.files);
});

els.clearBtn.addEventListener("click", () => {
  state.images = [];
  saveHistory();
  renderCards();
  updateRunBtn();
});

// ---- Rendering ----
function renderCards() {
  els.results.innerHTML = "";
  for (const img of state.images) {
    const card = document.createElement("div");
    card.className = "card";
    card.id = "card_" + img.id;
    card.innerHTML = `
      <img class="thumb" src="${img.dataUrl}" alt="${escapeHtml(img.name)}" />
      <div class="card-body">
        <div class="verdict pending"><span class="spinner" style="display:none"></span><span class="v-text">Ready</span></div>
        <div class="reason">${escapeHtml(img.name)}</div>
        <div class="conf-bar"><div class="conf-fill" style="width:0%"></div></div>
        <div class="conf-label"><span>Confidence</span><span class="conf-num">–</span></div>
        <div class="note" style="display:none"></div>
      </div>`;
    els.results.appendChild(card);
    if (img.result) applyCardState(img, { ...img.result, loading: false });
  }
}

function setCardState(img, opts) {
  applyCardState(img, opts);
  if (!opts.loading) {
    img.result = { kind: opts.kind, label: opts.label, reason: opts.reason, confidence: opts.confidence, raw: opts.raw, note: opts.note };
    saveHistory();
  }
}

const FILL = {
  allowed: "linear-gradient(90deg,#37d67a,#6c8cff)",
  rejected: "linear-gradient(90deg,#ff5c72,#ffb64d)",
  uncertain: "linear-gradient(90deg,#ffb64d,#9d7bff)",
};

function applyCardState(img, opts) {
  const card = $("card_" + img.id);
  if (!card) return;
  const verdict = card.querySelector(".verdict");
  const vText = card.querySelector(".v-text");
  const spinner = card.querySelector(".spinner");
  const reason = card.querySelector(".reason");
  const fill = card.querySelector(".conf-fill");
  const confNum = card.querySelector(".conf-num");

  verdict.className = "verdict " + (opts.kind || "pending");
  spinner.style.display = opts.loading ? "inline-block" : "none";
  vText.textContent = opts.label;
  if (opts.reason != null) reason.textContent = opts.reason;
  if (opts.confidence != null) {
    const pct = Math.round(opts.confidence * 100);
    fill.style.width = pct + "%";
    fill.style.background = FILL[opts.kind] || FILL.allowed;
    confNum.textContent = pct + "%";
  }
  const note = card.querySelector(".note");
  if (opts.note) {
    note.textContent = opts.note;
    note.style.display = "";
  } else {
    note.textContent = "";
    note.style.display = "none";
  }
  if (opts.raw != null) {
    let d = card.querySelector("details.raw");
    if (!d) {
      d = document.createElement("details");
      d.className = "raw";
      d.innerHTML = "<summary>Description &amp; decision</summary><pre></pre>";
      card.querySelector(".card-body").appendChild(d);
    }
    d.querySelector("pre").textContent = opts.raw;
  }
}

// ---- Classification (delegated to the backend) ----
async function classifyOne(img, cfg) {
  try {
    setCardState(img, { kind: "pending", loading: true, label: "Analyzing…" });
    const res = await api("/classify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        image: img.dataUrl,
        name: img.name,
        describer: cfg.describer,
        decision: cfg.decision,
        threshold: cfg.threshold,
        temperature: cfg.temperature,
        describerPrompt: cfg.describerPrompt,
        decisionPrompt: cfg.decisionPrompt,
      }),
    });
    const data = await res.json().catch(() => null);
    if (!data) throw new Error("Bad response from classifier (HTTP " + res.status + ")");
    renderResult(img, data);
  } catch (err) {
    setCardState(img, { kind: "error", loading: false, label: "⚠ Error", reason: String(err.message || err) });
  }
}

// Map a backend verdict into a card state.
function renderResult(img, data) {
  const models = data.models || {};
  const base = models.describer && models.decision ? `🧠 ${models.describer} → ${models.decision}` : "";

  if (data.kind === "error" || data.ok === false) {
    const raw = data.description != null
      ? "DESCRIPTION:\n" + (data.description || "(empty)") + "\n\n———\n\nDECISION:\n" + (data.decisionRaw || "(empty)")
      : undefined;
    setCardState(img, {
      kind: "error", loading: false, label: "⚠ Error",
      reason: data.reason || "Classification failed.", raw,
    });
    return;
  }

  const rawDump =
    "DESCRIPTION (" + (models.describer || "?") + "):\n" + (data.description || "") +
    "\n\n———\n\nDECISION (" + (models.decision || "?") + "):\n" + (data.decisionRaw || "");

  const kind = data.kind; // allowed | rejected | uncertain
  const label = kind === "uncertain" ? "❓ Uncertain" : kind === "allowed" ? "✔ Allowed" : "✖ Rejected";
  const note = data.uncertain
    ? `${base} · ⚠ low confidence (${Number(data.confidence).toFixed(2)} < ${Number(data.threshold).toFixed(2)}) — review recommended (leaning ${data.allowed ? "allow" : "reject"})`
    : base;

  setCardState(img, {
    kind, loading: false, label,
    reason: data.reason, confidence: data.confidence, raw: rawDump, note,
  });
}

function isPending(img) {
  return !img.result || img.result.kind === "error";
}

async function runAll() {
  const cfg = {
    describer: els.describerSelect.value,
    decision: els.decisionSelect.value,
    describerPrompt: els.describerPrompt.value,
    decisionPrompt: els.systemPrompt.value,
    temperature: Number(els.temperature.value),
    threshold: Number(els.threshold.value),
  };
  els.runBtn.disabled = true;
  saveSettings();
  for (const img of state.images) {
    if (isPending(img)) await classifyOne(img, cfg);
  }
  updateRunBtn();
}

els.runBtn.addEventListener("click", runAll);

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}

// ---- Init ----
loadSettings();
loadConfig();
loadHistory();
renderCards();
activateTab(localStorage.getItem(LS.tab) || "classify");
updateModelChip();
updateRunBtn();
refreshModels();
