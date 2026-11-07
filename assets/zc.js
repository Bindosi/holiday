/*
  Zenji Cards engine. Every card page loads this file, then calls ZC.card({...}).

  One page, three modes, picked from the address:
    /birthday/            maker: form + live preview, then pay and share
    /birthday/?c=ID       viewer: the finished card, full screen
    /birthday/?c=ID&status=successful&tx_ref=...   back from Flutterwave: confirm, then share

  Card content and payment live on the Zenjishoppazz server (/api/cards).
  Everything people type is shown with textContent, never as HTML.
*/
(function () {
  "use strict";

  // ---------------------------------------------------------------- setup
  const PROD_API = "https://admin.zenjishoppazz.com/api/cards";
  const params = new URLSearchParams(location.search);
  const isLocal = /^(localhost|127\.0\.0\.1)$/.test(location.hostname);
  // Only a local copy may point at another server (for testing).
  if (isLocal && params.get("api")) sessionSet("zc:api", params.get("api"));
  const API = (isLocal && sessionGet("zc:api")) || window.ZC_API || PROD_API;
  const SITE_ROOT = new URL("../", document.currentScript.src).href; // folder that holds /assets
  const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;

  function sessionGet(k) { try { return sessionStorage.getItem(k); } catch (_) { return null; } }
  function sessionSet(k, v) { try { sessionStorage.setItem(k, v); } catch (_) {} }
  const store = {
    get(k, fallback) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : fallback; } catch (_) { return fallback; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (_) {} },
    del(k) { try { localStorage.removeItem(k); } catch (_) {} },
  };

  // ---------------------------------------------------------------- small DOM helper
  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === "class") el.className = v;
      else if (k === "text") el.textContent = v;
      else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
      else if (k === "style" && typeof v === "object") Object.assign(el.style, v);
      else el.setAttribute(k, v === true ? "" : v);
    }
    for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    return el;
  }

  // ---------------------------------------------------------------- API
  async function api(method, path, body, token, isForm) {
    const headers = { Accept: "application/json" };
    if (token) headers["X-Card-Token"] = token;
    if (body && !isForm) headers["Content-Type"] = "application/json";
    let res;
    try {
      res = await fetch(API + path, { method, headers, body: body ? (isForm ? body : JSON.stringify(body)) : undefined });
    } catch (_) {
      return { ok: false, status: 0, message: "No internet connection. Check your data or Wi-Fi and try again.", data: null };
    }
    let json = {};
    try { json = await res.json(); } catch (_) {}
    let message = json.message || "";
    if (json.errors) { const first = Object.values(json.errors)[0]; if (first && first[0]) message = first[0]; }
    if (!message && !res.ok) message = res.status === 429 ? "Too many tries. Wait a minute and try again." : "Something went wrong. Please try again.";
    return { ok: res.ok && json.success !== false, status: res.status, message, data: json.data };
  }

  let catalog = null;
  async function getCatalog() {
    if (catalog) return catalog;
    const r = await api("GET", "/catalog");
    catalog = r.ok ? r.data : { card: { TZS: 2000, USD: 0.99 }, no_branding: { TZS: 2000, USD: 0.99 }, pack: { credits: 5, TZS: 8000, USD: 3.99 }, payments_ready: true };
    return catalog;
  }
  function money(cur, amount) {
    if (cur === "TZS") return "TSh " + Math.round(amount).toLocaleString("en-US");
    return "$" + Number(amount).toFixed(2);
  }
  function guessCurrency() {
    try {
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "";
      if (/Dar_es_Salaam/.test(tz)) return "TZS";
    } catch (_) {}
    return (navigator.language || "").toLowerCase().startsWith("sw") ? "TZS" : "USD";
  }

  // ---------------------------------------------------------------- my cards and packs (this phone)
  const mine = {
    all() { return store.get("zc:mine", []); },
    get(id) { return mine.all().find((c) => c.id === id); },
    put(card) { const list = mine.all().filter((c) => c.id !== card.id); list.unshift(card); store.set("zc:mine", list.slice(0, 50)); },
  };
  const packs = {
    all() { return store.get("zc:packs", []); },
    put(p) { const list = packs.all().filter((x) => x.code !== p.code); list.unshift(p); store.set("zc:packs", list); },
  };

  // ---------------------------------------------------------------- sound
  let audioCtx = null;
  function unlockAudio() {
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      if (audioCtx.state === "suspended") audioCtx.resume();
    } catch (_) { audioCtx = null; }
    return audioCtx;
  }
  function tone(freq, when, dur, vol = 0.15, type = "triangle") {
    if (!audioCtx) return;
    const t = audioCtx.currentTime + (when || 0);
    const o = audioCtx.createOscillator(), g = audioCtx.createGain();
    o.type = type; o.frequency.value = freq;
    g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(vol, t + 0.02); g.gain.exponentialRampToValueAtTime(0.0008, t + dur);
    o.connect(g).connect(audioCtx.destination); o.start(t); o.stop(t + dur + 0.05);
  }
  function chime() { [523.3, 659.3, 784, 1046.5].forEach((f, i) => tone(f, i * 0.09, 1.4, 0.11)); }
  function pop() { tone(880, 0, 0.12, 0.18, "square"); tone(1320, 0.03, 0.1, 0.08, "sine"); }

  // ---------------------------------------------------------------- shake
  const shakeListeners = new Set();
  let motionOn = false, motionSeen = false, lastAcc = null, lastShake = 0;
  function onMotion(e) {
    const a = e.accelerationIncludingGravity || e.acceleration;
    if (!a || a.x == null) return;
    motionSeen = true;
    if (lastAcc) {
      const d = Math.abs(a.x - lastAcc.x) + Math.abs(a.y - lastAcc.y) + Math.abs(a.z - lastAcc.z);
      const now = performance.now();
      shakeListeners.forEach((fn) => fn({ strength: Math.min(1, d / 60), sway: d, big: d > 22 && now - lastShake > 380 }));
      if (d > 22 && now - lastShake > 380) lastShake = now;
    }
    lastAcc = { x: a.x, y: a.y, z: a.z };
  }
  async function enableMotion() {
    if (motionOn || typeof DeviceMotionEvent === "undefined") return false;
    try {
      if (typeof DeviceMotionEvent.requestPermission === "function") {
        if ((await DeviceMotionEvent.requestPermission()) !== "granted") return false;
      }
    } catch (_) { return false; }
    window.addEventListener("devicemotion", onMotion);
    motionOn = true;
    return true;
  }

  // ---------------------------------------------------------------- confetti
  function confetti(root, opts = {}) {
    const c = h("canvas", { style: { position: "absolute", inset: "0", width: "100%", height: "100%", pointerEvents: "none", zIndex: 12 } });
    root.append(c);
    const ctx = c.getContext("2d");
    const dpr = Math.min(devicePixelRatio || 1, 2);
    const W = (c.width = root.clientWidth * dpr), H = (c.height = root.clientHeight * dpr);
    const colors = opts.colors || ["#ffb000", "#e8457c", "#7fd1ff", "#9ff0c1", "#c7a6ff", "#fff4e6"];
    const shapes = opts.shapes || "rect";
    const n = reduceMotion ? 40 : opts.count || 150;
    const ps = Array.from({ length: n }, (_, i) => ({
      x: W / 2 + (Math.random() - 0.5) * 60 * dpr, y: H * (opts.y ?? 0.45),
      vx: (Math.random() - 0.5) * 11 * dpr, vy: (-6 - Math.random() * 8) * dpr,
      s: (4 + Math.random() * 6) * dpr, r: Math.random() * 6, vr: (Math.random() - 0.5) * 0.3, color: colors[i % colors.length],
    }));
    let alive = true;
    (function loop() {
      if (!alive) return;
      ctx.clearRect(0, 0, W, H);
      let any = false;
      for (const p of ps) {
        p.vy += 0.24 * dpr; p.vx *= 0.99; p.x += p.vx; p.y += p.vy; p.r += p.vr;
        if (p.y < H + 30) any = true;
        ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.r); ctx.fillStyle = p.color;
        if (shapes === "heart") { heart(ctx, p.s * 1.4); } else { ctx.fillRect(-p.s / 2, -p.s / 4, p.s, p.s / 2); }
        ctx.restore();
      }
      if (any) requestAnimationFrame(loop); else { alive = false; c.remove(); }
    })();
  }
  function heart(ctx, s) {
    ctx.beginPath(); ctx.moveTo(0, s * 0.3);
    ctx.bezierCurveTo(-s, -s * 0.4, -s * 0.4, -s, 0, -s * 0.45);
    ctx.bezierCurveTo(s * 0.4, -s, s, -s * 0.4, 0, s * 0.3); ctx.fill();
  }

  // ---------------------------------------------------------------- card definition and boot
  let def = null;

  function card(definition) {
    def = Object.assign({ photos: 0, fields: [], defaults: {}, cover: true, footDark: false, noBranding: false }, definition);
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot); else boot();
  }

  function boot() {
    // Back from Flutterwave: ?status=successful&tx_ref=zc_<cardId>_xxxx (the card id is inside the reference).
    const txRef = params.get("tx_ref");
    const status = params.get("status");
    if (txRef && /^zc_[a-z0-9]+_[a-z0-9]+$/.test(txRef)) {
      const id = params.get("c") || txRef.split("_")[1];
      const owned = mine.get(id);
      if (owned) return returnFromPayment(id, owned, status);
      return confirmByRef(txRef, status);
    }
    const id = params.get("c");
    if (id && /^[a-z0-9]{6,16}$/.test(id)) return viewer(id);
    // Old free links like /birthday/#Mkali-5 keep working.
    if (def.legacy && location.hash.length > 1) {
      const data = def.legacy(location.hash.slice(1));
      if (data) return showCard(Object.assign({}, def.defaults, data), { photos: [], noBranding: false, legacy: true });
    }
    maker();
  }

  // ---------------------------------------------------------------- viewer
  let current = null; // { destroy }
  function showCard(data, opts) {
    document.body.innerHTML = "";
    document.body.style.overflow = "hidden";
    const view = h("div", { class: "zc-view" });
    const stage = h("div", { class: "zc-stage" });
    view.append(stage);
    document.body.append(view);
    const ctx = makeCtx(stage, data, Object.assign({ preview: false }, opts));
    current = def.render(stage, data, ctx) || {};
    if (!opts.noBranding) {
      const foot = h("div", { class: "zc-foot" + (def.footDark ? " dark" : "") },
        h("a", { href: SITE_ROOT, text: "Made with Zenji Cards · Make your own" }),
        opts.cardId ? h("button", { type: "button", text: "Report", onclick: () => report(opts.cardId) }) : null);
      view.append(foot);
    }
    const title = def.title ? def.title(data) : document.title;
    if (title) document.title = title;

    const start = async () => {
      unlockAudio();
      await enableMotion();
      setTimeout(() => { ctx.motionWorks = motionSeen; current.motionChecked && current.motionChecked(motionSeen); }, 1600);
      current.start && current.start();
    };
    if (def.cover) {
      const cover = h("div", { class: "zc-cover" },
        h("div", { class: "box" },
          h("h2", { text: def.coverTitle ? def.coverTitle(data) : "Someone made you something" }),
          h("p", { text: def.coverText ? def.coverText(data) : "Turn your sound on, then open it." }),
          h("button", { class: "zc-btn", type: "button", text: def.coverButton || "Open", onclick: () => { cover.remove(); start(); } })));
      stage.append(cover);
    } else {
      start();
    }
  }

  function makeCtx(stage, data, opts) {
    return {
      preview: !!opts.preview,
      photos: opts.photos || [],
      cardId: opts.cardId || null,
      legacy: !!opts.legacy,
      reduceMotion,
      motionWorks: false,
      onShake(fn) { shakeListeners.add(fn); return () => shakeListeners.delete(fn); },
      sound: { tone, chime, pop, get on() { return !!audioCtx && !opts.preview; } },
      confetti: (o) => confetti(stage, o),
      api,
      h,
      money,
    };
  }

  async function viewer(id) {
    document.body.innerHTML = "";
    const wait = h("div", { class: "zc-msg" }, h("div", { class: "box" }, h("div", { class: "zc-spinner" })));
    document.body.append(wait);
    const owned = mine.get(id);
    const r = await api("GET", "/" + id, null, owned && owned.token);
    if (!r.ok) {
      wait.replaceChildren(h("div", { class: "box" },
        h("h2", { text: r.status === 410 ? "This card has ended" : r.status === 402 ? "Almost ready" : "Card not found" }),
        h("p", { text: r.status === 402 ? "The person who made this card has not finished it yet. Ask them to send the link again." : r.message }),
        h("a", { class: "zc-btn", href: SITE_ROOT, text: "Make your own card", style: { background: "#ffb000", color: "#1e1530" } })));
      return;
    }
    const c = r.data;
    if (owned && c.status === "draft") return finishPaymentPrompt(id, owned);
    showCard(Object.assign({}, def.defaults, c.data), { photos: c.photos, noBranding: c.no_branding, cardId: c.id });
  }

  function report(cardId) {
    const back = sheet([
      h("h2", { text: "Report this card" }),
      h("p", { text: "Tell us if this card is hurtful, a scam, or not meant for you." }),
      h("label", { class: "zc-field" }, h("span", { text: "What is wrong? (optional)" }), h("textarea", { id: "zc-report", maxlength: "300" })),
      h("button", { class: "zc-btn primary block", type: "button", text: "Send report", onclick: async () => {
        await api("POST", "/" + cardId + "/report", { reason: document.getElementById("zc-report").value });
        back.querySelector(".zc-sheet").replaceChildren(h("h2", { text: "Thank you" }), h("p", { text: "We will look at this card." }),
          h("button", { class: "zc-btn block", type: "button", text: "Close", onclick: () => back.remove() }));
      } }),
    ]);
  }

  // ---------------------------------------------------------------- sheets
  function sheet(children, opts = {}) {
    const box = h("div", { class: "zc-sheet", role: "dialog", "aria-modal": "true" },
      opts.noClose ? null : h("button", { class: "zc-close", type: "button", text: "Close", onclick: () => back.remove() }),
      ...children);
    const back = h("div", { class: "zc-sheet-back", onclick: (e) => { if (e.target === back && !opts.noClose) back.remove(); } }, box);
    document.body.append(back);
    return back;
  }

  // ---------------------------------------------------------------- maker
  let state = null;           // { id, token, data, photos: [] }
  let previewTimer = 0;
  let previewStage = null;

  function draftKey() { return "zc:draft:" + def.type; }
  function saveDraft() { store.set(draftKey(), state); }

  async function maker() {
    state = store.get(draftKey(), null) || { id: null, token: null, data: JSON.parse(JSON.stringify(def.defaults)), photos: [] };
    // A draft that was already paid for starts fresh.
    if (state.id && mine.get(state.id) && mine.get(state.id).status === "active") {
      state = { id: null, token: null, data: JSON.parse(JSON.stringify(def.defaults)), photos: [] };
    }
    state.data = Object.assign(JSON.parse(JSON.stringify(def.defaults)), state.data || {});
    document.body.innerHTML = "";
    document.body.style.overflow = "";

    const top = h("header", { class: "zc-top" },
      h("a", { class: "zc-logo", href: SITE_ROOT }, h("b", { text: "Zenji Cards" }), h("span", { text: "by Zenjishoppazz" })),
      h("nav", {}, h("a", { class: "zc-btn ghost small", href: SITE_ROOT + "#mine", text: "My cards" })));

    const form = h("form", { class: "zc-form", onsubmit: (e) => e.preventDefault(), novalidate: true });
    def.fields.forEach((f) => form.append(field(f)));
    if (def.photos) form.append(photoPicker());
    if (def.extraForm) form.append(def.extraForm(state.data, changed, h));

    previewStage = h("div", { class: "zc-stage" });
    const priceText = h("span", { class: "price" });
    const main = h("main", { class: "zc-maker" },
      h("section", { style: { minWidth: 0 } },
        h("h1", { text: def.name }),
        h("p", { class: "lead", text: def.lead }),
        form),
      h("aside", { class: "zc-preview-wrap" },
        h("div", { class: "zc-phone" }, previewStage),
        h("div", { class: "zc-preview-note", text: "Live preview. The person you send it to sees it full screen." })));
    const bar = h("div", { class: "zc-paybar" }, priceText,
      h("button", { class: "zc-btn primary", type: "button", text: "Get my link", onclick: openPay }));

    document.body.append(top, main, bar);
    renderPreview();
    getCatalog().then((cat) => { priceText.textContent = money("TZS", cat.card.TZS) + " · " + money("USD", cat.card.USD); });
  }

  function changed() {
    saveDraft();
    clearTimeout(previewTimer);
    previewTimer = setTimeout(renderPreview, 250);
  }

  function renderPreview() {
    if (!previewStage) return;
    if (current && current.destroy) current.destroy();
    previewStage.replaceChildren();
    const ctx = makeCtx(previewStage, state.data, { preview: true, photos: state.photos.filter(Boolean) });
    current = def.render(previewStage, Object.assign({}, def.defaults, state.data), ctx) || {};
    current.start && current.start();
  }

  function getPath(obj, key) { return key.split(".").reduce((o, k) => (o == null ? undefined : o[k]), obj); }
  function setPath(obj, key, value) {
    const parts = key.split("."); let o = obj;
    parts.slice(0, -1).forEach((k) => { if (o[k] == null) o[k] = {}; o = o[k]; });
    o[parts[parts.length - 1]] = value;
  }

  function field(f) {
    if (f.type === "custom") return f.build(state.data, changed, h);
    if (f.type === "list") return listField(f);
    if (f.type === "row") return h("div", { class: "zc-row" }, f.fields.map(field));
    const id = "f-" + f.key.replace(/\./g, "-");
    const value = getPath(state.data, f.key);
    let input;
    if (f.type === "textarea") {
      input = h("textarea", { id, maxlength: f.max || 500, placeholder: f.placeholder || "", rows: f.rows || 3 });
      input.value = value ?? "";
    } else if (f.type === "select") {
      input = h("select", { id }, f.options.map(([v, label]) => h("option", { value: v, text: label })));
      input.value = value ?? f.options[0][0];
    } else {
      input = h("input", { id, type: f.type || "text", maxlength: f.max || 80, placeholder: f.placeholder || "",
        min: f.min, max: f.maxValue, inputmode: f.type === "number" ? "numeric" : null, autocomplete: "off" });
      input.value = value ?? "";
    }
    input.addEventListener("input", () => {
      let v = input.value;
      if (f.type === "number") v = v === "" ? "" : Number(v);
      setPath(state.data, f.key, v);
      input.removeAttribute("aria-invalid");
      changed();
    });
    return h("label", { class: "zc-field", for: id }, h("span", { text: f.label + (f.required ? "" : " (optional)") }), input,
      f.help ? h("small", { text: f.help }) : null);
  }

  // A short list of lines (reasons, memories...), add and remove.
  function listField(f) {
    const box = h("fieldset", {}, h("legend", { text: f.label }));
    const rows = h("div", { style: { display: "grid", gap: "8px" } });
    const add = h("button", { class: "zc-btn ghost small", type: "button", text: "+ Add another" });
    function list() { const v = getPath(state.data, f.key); return Array.isArray(v) ? v : []; }
    function draw() {
      rows.replaceChildren();
      list().forEach((text, i) => {
        const input = h("input", { type: "text", maxlength: f.max || 120, placeholder: f.placeholder || "", value: text, "aria-label": f.label + " " + (i + 1),
          style: { flex: "1", minWidth: "0", padding: "12px 14px", borderRadius: "12px", border: "1.5px solid var(--line)", background: "var(--panel)" } });
        input.addEventListener("input", () => { const l = list().slice(); l[i] = input.value; setPath(state.data, f.key, l); changed(); });
        const del = h("button", { class: "zc-btn ghost small", type: "button", "aria-label": "Remove", text: "✕", onclick: () => {
          const l = list().slice(); l.splice(i, 1); setPath(state.data, f.key, l); changed(); draw();
        } });
        rows.append(h("div", { style: { display: "flex", gap: "8px" } }, input, list().length > (f.minItems || 1) ? del : null));
      });
      add.hidden = list().length >= (f.maxItems || 6);
    }
    add.addEventListener("click", () => { setPath(state.data, f.key, list().concat([""])); changed(); draw(); rows.lastChild && rows.lastChild.querySelector("input").focus(); });
    draw();
    box.append(rows, add, f.help ? h("small", { class: "zc-note", text: f.help }) : null);
    return box;
  }

  function photoPicker() {
    const wrap = h("fieldset", {}, h("legend", { text: def.photoLabel || "Photos (optional)" }));
    const row = h("div", { class: "zc-photos" });
    for (let i = 0; i < def.photos; i++) {
      const tile = h("label", { class: "zc-photo", text: state.photos[i] ? "" : "+ Photo" });
      if (state.photos[i]) tile.style.backgroundImage = `url("${state.photos[i]}")`;
      const input = h("input", { type: "file", accept: "image/jpeg,image/png,image/webp", "aria-label": "Photo " + (i + 1) });
      input.addEventListener("change", async () => {
        const file = input.files && input.files[0];
        if (!file) return;
        tile.classList.add("busy");
        const ok = await ensureDraft();
        if (!ok.ok) { tile.classList.remove("busy"); return alertSheet(ok.message); }
        const fd = new FormData(); fd.append("photo", file); fd.append("slot", String(i));
        const r = await api("POST", "/" + state.id + "/photo", fd, state.token, true);
        tile.classList.remove("busy");
        if (!r.ok) return alertSheet(r.message);
        state.photos[i] = r.data.url;
        tile.textContent = ""; tile.append(input); tile.style.backgroundImage = `url("${r.data.url}")`;
        changed();
      });
      tile.append(input);
      row.append(tile);
    }
    wrap.append(row, h("small", { class: "zc-note", text: "JPG or PNG. They are shown on the card exactly as you add them." }));
    return wrap;
  }

  function alertSheet(message) {
    const back = sheet([h("h2", { text: "Something went wrong" }), h("p", { text: message }),
      h("button", { class: "zc-btn block", type: "button", text: "OK", onclick: () => back.remove() })]);
  }

  async function ensureDraft() {
    if (state.id && state.token) {
      const r = await api("POST", "/" + state.id, { data: state.data }, state.token);
      if (r.ok) return r;
      if (r.status !== 404 && r.status !== 403) return r;
      if (r.status === 409) return r;
      state.id = null; state.token = null; // gone: start a new one
    }
    const r = await api("POST", "", { type: def.type, data: state.data });
    if (r.ok) {
      state.id = r.data.id; state.token = r.data.token; saveDraft();
      mine.put({ id: state.id, token: state.token, type: def.type, title: def.title ? def.title(state.data) : def.name, status: "draft", created: Date.now() });
    }
    return r;
  }

  function validate() {
    for (const f of flatFields(def.fields)) {
      if (!f.required) continue;
      const v = getPath(state.data, f.key);
      if (v === undefined || v === null || String(v).trim() === "") {
        const el = document.getElementById("f-" + f.key.replace(/\./g, "-"));
        if (el) { el.setAttribute("aria-invalid", "true"); el.focus(); el.scrollIntoView({ block: "center", behavior: "smooth" }); }
        return f.label + " is needed.";
      }
    }
    return def.validate ? def.validate(state.data) : null;
  }
  function flatFields(list) { return list.flatMap((f) => (f.type === "row" ? flatFields(f.fields) : [f])); }

  // ---------------------------------------------------------------- pay sheet
  async function openPay() {
    const problem = validate();
    if (problem) return alertSheet(problem);
    const cat = await getCatalog();
    const savedPacks = packs.all();
    const cur0 = store.get("zc:currency", guessCurrency());

    const err = h("p", { class: "zc-error", role: "alert", hidden: true });
    const option = (cur, title, methods) => h("label", { class: "zc-option" },
      h("input", { type: "radio", name: "zc-cur", value: cur, checked: cur === cur0 }),
      h("div", {}, h("b", { text: title }), h("div", { class: "zc-paylogos" }, methods.map((m) => h("span", { text: m })))),
      h("span", { class: "amt", "data-cur": cur }));
    const email = h("input", { type: "email", id: "zc-email", placeholder: "you@example.com", autocomplete: "email", value: store.get("zc:email", "") });
    const phone = h("input", { type: "tel", id: "zc-phone", placeholder: "07xx xxx xxx", autocomplete: "tel", value: store.get("zc:phone", "") });
    const phoneField = h("label", { class: "zc-field" }, h("span", { text: "Mobile money number (optional)" }), phone,
      h("small", { text: "Saves typing it again on the payment page." }));
    const noBrand = def.noBranding ? h("input", { type: "checkbox", id: "zc-nobrand" }) : null;
    const payBtn = h("button", { class: "zc-btn primary block", type: "button" });
    const code = h("input", { id: "zc-code", placeholder: "ZC-XXXX-XXXX", autocomplete: "off", value: savedPacks.find((p) => p.left > 0)?.code || "" });

    const options = h("div", { class: "zc-options" },
      option("TZS", "Pay in Tanzania (TSh)", ["M-Pesa", "Mixx by Yas", "Airtel Money", "Card"]),
      option("USD", "Pay from anywhere (USD)", ["Card", "Apple Pay", "Google Pay"]));

    function update() {
      const cur = options.querySelector("input:checked")?.value || "TZS";
      const extra = noBrand && noBrand.checked ? cat.no_branding[cur] : 0;
      options.querySelectorAll(".amt").forEach((el) => {
        const c = el.dataset.cur; el.textContent = money(c, cat.card[c] + (noBrand && noBrand.checked ? cat.no_branding[c] : 0));
      });
      phoneField.hidden = cur !== "TZS";
      payBtn.textContent = "Pay " + money(cur, cat.card[cur] + extra);
    }
    options.addEventListener("change", update);
    noBrand && noBrand.addEventListener("change", update);

    payBtn.addEventListener("click", async () => {
      err.hidden = true;
      const cur = options.querySelector("input:checked").value;
      store.set("zc:currency", cur); store.set("zc:email", email.value.trim()); store.set("zc:phone", phone.value.trim());
      payBtn.disabled = true; payBtn.textContent = "Opening payment…";
      const d = await ensureDraft();
      if (!d.ok) { payBtn.disabled = false; update(); err.textContent = d.message; err.hidden = false; return; }
      const r = await api("POST", "/" + state.id + "/checkout", {
        currency: cur, return_url: pageUrl(),
        email: email.value.trim() || null, phone: cur === "TZS" ? phone.value.trim() || null : null,
        no_branding: !!(noBrand && noBrand.checked),
      }, state.token);
      if (!r.ok || !r.data.checkout_url) { payBtn.disabled = false; update(); err.textContent = r.message; err.hidden = false; return; }
      location.href = r.data.checkout_url;
    });

    const useCode = h("button", { class: "zc-btn ghost", type: "button", text: "Use code", onclick: async () => {
      err.hidden = true;
      if (!code.value.trim()) { code.focus(); return; }
      useCode.disabled = true;
      const d = await ensureDraft();
      const r = d.ok ? await api("POST", "/" + state.id + "/redeem", { code: code.value.trim() }, state.token) : d;
      useCode.disabled = false;
      if (!r.ok) { err.textContent = r.message; err.hidden = false; return; }
      const p = packs.all().find((x) => x.code.replace(/\W/g, "") === code.value.replace(/\W/g, "").toUpperCase());
      packs.put({ code: (p && p.code) || code.value.trim().toUpperCase(), left: r.data.credits_left });
      back.remove();
      done(r.data);
    } });

    const back = sheet([
      h("h2", { text: "Get your link" }),
      h("p", { text: "Pay once and the card stays online for a year. You can share it as many times as you like." }),
      cat.test_mode ? h("p", { class: "zc-note", text: "Test mode: no money is taken." }) : null,
      options,
      h("label", { class: "zc-field" }, h("span", { text: "Email for your receipt (optional)" }), email),
      phoneField,
      noBrand ? h("label", { class: "zc-check" }, noBrand, h("span", {}, "Remove “Made with Zenji Cards” ",
        h("small", { class: "zc-note", text: "(+" + money("TZS", cat.no_branding.TZS) + " / " + money("USD", cat.no_branding.USD) + ")" }))) : null,
      err,
      payBtn,
      h("p", { class: "zc-note", text: "Secure payment by Flutterwave. You come back here when it is done." }),
      h("div", { class: "zc-divider", text: "or" }),
      h("label", { class: "zc-field" }, h("span", { text: "Have a pack code?" }), h("div", { class: "zc-linkbox" }, code, useCode)),
      h("a", { class: "zc-note", href: SITE_ROOT + "packs/?back=" + encodeURIComponent(def.type),
        text: "Making several? Get " + cat.pack.credits + " cards for " + money("TZS", cat.pack.TZS) + " / " + money("USD", cat.pack.USD) + "." }),
    ]);
    update();
  }

  function pageUrl() { return location.origin + location.pathname; }

  // ---------------------------------------------------------------- after payment
  async function returnFromPayment(id, owned, status) {
    history.replaceState(null, "", pageUrl() + "?c=" + id);
    state = { id, token: owned.token, data: {}, photos: [] };
    document.body.innerHTML = "";
    const box = h("div", { class: "box" }, h("div", { class: "zc-spinner" }), h("h2", { text: "Checking your payment" }),
      h("p", { text: "This can take a few seconds for mobile money." }));
    document.body.append(h("div", { class: "zc-msg" }, box));
    if (status === "cancelled") {
      box.replaceChildren(h("h2", { text: "Payment cancelled" }), h("p", { text: "No money was taken. Your card is saved; you can pay when you are ready." }),
        h("a", { class: "zc-btn", href: pageUrl(), text: "Back to my card", style: { background: "#ffb000", color: "#1e1530" } }));
      return;
    }
    for (let i = 0; i < 10; i++) {
      const r = await api("POST", "/" + id + "/confirm", {}, owned.token);
      if (r.ok && r.data.status === "active") { store.del(draftKey()); return done(r.data); }
      if (r.ok && /did not go through/.test(r.message)) break;
      await new Promise((res) => setTimeout(res, 3000));
    }
    box.replaceChildren(h("h2", { text: "Payment not received yet" }),
      h("p", { text: "If money left your account, wait a minute and tap Check again. If not, go back and try paying again." }),
      h("button", { class: "zc-btn", type: "button", text: "Check again", style: { background: "#ffb000", color: "#1e1530" },
        onclick: () => returnFromPayment(id, owned, "successful") }),
      h("a", { class: "zc-btn ghost", href: pageUrl(), text: "Back to my card", style: { color: "#fff" } }));
  }

  // Paid in a browser that does not know this card (e.g. the payment opened elsewhere).
  async function confirmByRef(txRef, status) {
    history.replaceState(null, "", pageUrl());
    document.body.innerHTML = "";
    const box = h("div", { class: "box" }, h("div", { class: "zc-spinner" }), h("h2", { text: "Checking your payment" }));
    document.body.append(h("div", { class: "zc-msg" }, box));
    if (status === "cancelled") {
      box.replaceChildren(h("h2", { text: "Payment cancelled" }), h("p", { text: "No money was taken." }),
        h("a", { class: "zc-btn", href: pageUrl(), text: "Back", style: { background: "#ffb000", color: "#1e1530" } }));
      return;
    }
    for (let i = 0; i < 10; i++) {
      const r = await api("POST", "/confirm", { tx_ref: txRef });
      if (r.ok) return done(r.data);
      if (/did not go through/.test(r.message) || r.status === 404) {
        box.replaceChildren(h("h2", { text: "Payment not completed" }), h("p", { text: r.message }),
          h("a", { class: "zc-btn", href: pageUrl(), text: "Back", style: { background: "#ffb000", color: "#1e1530" } }));
        return;
      }
      await new Promise((res) => setTimeout(res, 3000));
    }
    box.replaceChildren(h("h2", { text: "Payment not received yet" }), h("p", { text: "If money left your account, wait a minute and check again." }),
      h("button", { class: "zc-btn", type: "button", text: "Check again", style: { background: "#ffb000", color: "#1e1530" }, onclick: () => confirmByRef(txRef, status) }));
  }

  function finishPaymentPrompt(id, owned) {
    document.body.innerHTML = "";
    document.body.append(h("div", { class: "zc-msg" }, h("div", { class: "box" },
      h("h2", { text: "Not paid yet" }),
      h("p", { text: "This card is saved but not live. Finish paying to get the link." }),
      h("a", { class: "zc-btn", href: pageUrl(), text: "Finish my card", style: { background: "#ffb000", color: "#1e1530" } }),
      h("button", { class: "zc-btn ghost", type: "button", text: "I already paid, check again", style: { color: "#fff" },
        onclick: () => returnFromPayment(id, owned, "successful") }))));
  }

  // ---------------------------------------------------------------- share
  function done(cardData) {
    const link = cardData.link || pageUrl() + "?c=" + cardData.id;
    const owned = mine.get(cardData.id) || {};
    mine.put(Object.assign(owned, { id: cardData.id, type: def.type, status: "active", link, title: def.title ? def.title(cardData.data || {}) : def.name, created: owned.created || Date.now() }));
    store.del(draftKey());
    const text = (def.shareText ? def.shareText(cardData.data || {}) : "I made something for you 🎁") + " " + link;
    const input = h("input", { readonly: true, value: link, "aria-label": "Your card link", onfocus: (e) => e.target.select() });
    const copyBtn = h("button", { class: "zc-btn", type: "button", text: "Copy", onclick: async () => {
      try { await navigator.clipboard.writeText(link); copyBtn.textContent = "Copied"; } catch (_) { input.select(); document.execCommand && document.execCommand("copy"); copyBtn.textContent = "Copied"; }
      setTimeout(() => (copyBtn.textContent = "Copy"), 1800);
    } });
    if (location.search.includes("c=")) { document.body.innerHTML = ""; }
    sheet([
      h("h2", { text: "Your card is ready 🎉" }),
      h("p", { text: "Send this link. It opens on any phone, no app needed." }),
      h("div", { class: "zc-linkbox" }, input, copyBtn),
      h("div", { class: "zc-share" },
        h("a", { class: "zc-btn zc-wa", href: "https://wa.me/?text=" + encodeURIComponent(text), target: "_blank", rel: "noopener", text: "WhatsApp" }),
        navigator.share ? h("button", { class: "zc-btn ghost", type: "button", text: "More apps", onclick: () => navigator.share({ text, url: link }).catch(() => {}) }) : null,
        h("a", { class: "zc-btn ghost", href: link, text: "Open card" })),
      h("p", { class: "zc-note", text: "Saved under My cards on this phone." }),
      h("a", { class: "zc-btn ghost block", href: SITE_ROOT, text: "Make another card" }),
    ], { noClose: false });
  }

  // ---------------------------------------------------------------- public
  window.ZC = { card, h, api, money, store, mine, packs, getCatalog, guessCurrency, unlockAudio, tone, chime, pop, confetti, SITE_ROOT, API, sheet };
})();
