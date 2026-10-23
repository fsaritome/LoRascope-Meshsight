/* LoRascope Meshsight — © 2026 Ferit Sari Tomé.
   line of sight, Fresnel clearance and coverage for LoRa mesh nodes.
   Terrain: AWS Terrain Tiles (terrarium), loaded live around the chosen antenna. */
"use strict";

// ---------- constants ----------
const R = 6371e3, K = 4 / 3;            // earth radius, standard refraction
const TZ = 12;                          // terrain tile zoom (~25-30 m per pixel in mid latitudes)
const TERRAIN_URL = (z, x, y) => `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`;
const SNR_LIMIT = { 7: -7.5, 8: -10, 9: -12.5, 10: -15, 11: -17.5, 12: -20 };
const COV_STEP = 50, COV_NR = 1440, COV_N = 800;
const SCALES = {
  loss: [[1, [26, 152, 80], "0–1 dB, clear"], [6, [145, 207, 96], "1–6 dB"], [12, [254, 224, 139], "6–12 dB"], [20, [252, 141, 89], "12–20 dB"], [30, [215, 48, 39], "20–30 dB"]],
  margin: [[-25, [26, 152, 80], "> 25 dB, solid"], [-15, [145, 207, 96], "15–25 dB"], [-8, [254, 224, 139], "8–15 dB"], [-3, [252, 141, 89], "3–8 dB, flaky"], [0, [215, 48, 39], "0–3 dB, edge"]]
};
const STATUS_TXT = { ok: "Line of sight", warn: "Fresnel partly blocked", bad: "No line of sight" };
const $ = id => document.getElementById(id);

// ---------- state ----------
const DEFAULTS = { a: [48.6030, 11.6250], b: null, hA: 6, hB: 10, sel: null, obs: true, cov: false, covMode: "loss", extra: 30,
  range: 15000, freq: 869.618, tx: 22, gain: 2, sf: 8, bw: 62.5, clickMode: "A", base: "Map", zoom: 13, center: null };
let st = Object.assign({}, DEFAULTS);
try { const s = JSON.parse(localStorage.getItem("meshsight") || "null"); if (s) Object.assign(st, s); } catch (e) {}
(function readHash() {
  const h = new URLSearchParams(location.hash.slice(1));
  const ll = v => { const m = (v || "").split(",").map(Number); return m.length === 2 && m.every(isFinite) ? m : null; };
  if (ll(h.get("a"))) { st.a = ll(h.get("a")); st.center = null; }
  if (h.has("b")) st.b = ll(h.get("b"));
  for (const k of ["hA", "hB", "freq", "tx", "gain", "sf", "bw", "range"]) if (h.has(k) && isFinite(+h.get(k))) st[k] = +h.get(k);
  if (h.get("sel")) st.sel = h.get("sel");
})();
function save() { try { localStorage.setItem("meshsight", JSON.stringify(st)); } catch (e) {} }
function shareURL() {
  const f = v => v.toFixed(5);
  const p = new URLSearchParams({ a: f(st.a[0]) + "," + f(st.a[1]), hA: st.hA, hB: st.hB });
  if (st.b) p.set("b", f(st.b[0]) + "," + f(st.b[1]));
  if (st.sel) p.set("sel", st.sel);
  if (st.freq !== DEFAULTS.freq) p.set("freq", st.freq);
  if (st.sf !== DEFAULTS.sf) p.set("sf", st.sf);
  if (st.bw !== DEFAULTS.bw) p.set("bw", st.bw);
  return location.origin + location.pathname + "#" + p.toString();
}
const lam = () => 299792458 / (st.freq * 1e6);
const sens = () => -174 + 10 * Math.log10(st.bw * 1000) + 6 + SNR_LIMIT[st.sf] + 3;
const budget = () => st.tx + 2 * st.gain - sens();

// ---------- geometry ----------
function dist(a, b) {
  const p1 = a[0] * Math.PI / 180, p2 = b[0] * Math.PI / 180, dl = p2 - p1, dn = (b[1] - a[1]) * Math.PI / 180;
  const h = Math.sin(dl / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dn / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
function knife(v) { return v <= -0.78 ? 0 : 6.9 + 20 * Math.log10(Math.sqrt((v - 0.1) ** 2 + 1) + v - 0.1); }
function fspl(d) { return 20 * Math.log10(4 * Math.PI * Math.max(d, 1) / lam()); }

// ---------- terrain tiles ----------
const tiles = new Map();                // key -> Float32Array(65536) | null (failed)
const pending = new Map();              // key -> Promise
const N2 = 2 ** TZ;
const tkey = (x, y) => x * 65536 + y;
function gx(lon) { return (lon + 180) / 360 * N2 * 256; }
function gy(lat) { const r = lat * Math.PI / 180; return (1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * N2 * 256; }
const decodeCanvas = document.createElement("canvas"); decodeCanvas.width = decodeCanvas.height = 256;
const dctx = decodeCanvas.getContext("2d", { willReadFrequently: true });
function loadTile(x, y) {
  const k = tkey(x, y);
  if (tiles.has(k)) return Promise.resolve();
  if (pending.has(k)) return pending.get(k);
  const p = new Promise(res => {
    const img = new Image(); img.crossOrigin = "anonymous";
    img.onload = () => {
      dctx.drawImage(img, 0, 0); const d = dctx.getImageData(0, 0, 256, 256).data, a = new Float32Array(65536);
      for (let i = 0; i < 65536; i++) a[i] = d[i * 4] * 256 + d[i * 4 + 1] + d[i * 4 + 2] / 256 - 32768;
      tiles.set(k, a); pending.delete(k); res();
    };
    img.onerror = () => { tiles.set(k, null); pending.delete(k); res(); };
    img.src = TERRAIN_URL(TZ, x, y);
  });
  pending.set(k, p); return p;
}
function pix(X, Y) {
  const tx = Math.floor(X / 256), ty = Math.floor(Y / 256), t = tiles.get(tkey(tx, ty));
  if (!t) return NaN;
  return t[(Y - ty * 256) * 256 + (X - tx * 256)];
}
function elev(lat, lon) {
  const X = gx(lon) - 0.5, Y = gy(lat) - 0.5, x0 = Math.floor(X), y0 = Math.floor(Y), fx = X - x0, fy = Y - y0;
  const a = pix(x0, y0), b = pix(x0 + 1, y0), c = pix(x0, y0 + 1), d = pix(x0 + 1, y0 + 1);
  if (isNaN(a + b + c + d)) { const v = [a, b, c, d].filter(isFinite); return v.length ? v[0] : 0; }
  return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
}
async function ensureBox(s, w, n, e, onProgress) {
  const x0 = Math.floor(gx(w) / 256), x1 = Math.floor(gx(e) / 256), y0 = Math.floor(gy(n) / 256), y1 = Math.floor(gy(s) / 256);
  const list = [];
  for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) if (!tiles.has(tkey(x, y))) list.push([x, y]);
  let done = 0; const total = list.length;
  if (!total) return;
  // limited parallelism, nearest first
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2; list.sort((p, q) => Math.hypot(p[0] - cx, p[1] - cy) - Math.hypot(q[0] - cx, q[1] - cy));
  let i = 0;
  async function worker() { while (i < list.length) { const [x, y] = list[i++]; await loadTile(x, y); done++; onProgress && onProgress(done, total); } }
  await Promise.all(Array.from({ length: 8 }, worker));
}
function boxAround(c, r) {
  const dLat = r / R * 180 / Math.PI, dLon = r / (R * Math.cos(c[0] * Math.PI / 180)) * 180 / Math.PI;
  return [c[0] - dLat, c[1] - dLon, c[0] + dLat, c[1] + dLon];
}
async function ensurePath(A, B) {
  await ensureBox(Math.min(A[0], B[0]) - 0.002, Math.min(A[1], B[1]) - 0.003, Math.max(A[0], B[0]) + 0.002, Math.max(A[1], B[1]) + 0.003, (d, t) => setStatus(`Loading terrain ${d}/${t}`));
}

// ---------- path profile ----------
function profile(A, B, hA, hB, n = 300) {
  const D = dist(A, B), L = lam(), za = elev(A[0], A[1]) + hA, zb = elev(B[0], B[1]) + hB;
  const pts = []; let worst = { f: Infinity, clr: Infinity, d1: D / 2, d2: D / 2, i: 1 };
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1), d1 = D * t, d2 = D - d1, la = A[0] + (B[0] - A[0]) * t, lo = A[1] + (B[1] - A[1]) * t;
    const ground = elev(la, lo), e = ground + d1 * d2 / (2 * K * R), l = za + (zb - za) * t, F = Math.sqrt(L * d1 * d2 / Math.max(D, 1));
    pts.push({ d: d1, ground, e, l, F, la, lo });
    if (i > 0 && i < n - 1) { const f = (l - e) / F; if (f < worst.f) worst = { f, clr: l - e, d1, d2, F, i }; }
  }
  const v = -worst.clr * Math.sqrt(2 / L * (worst.d1 + worst.d2) / (worst.d1 * worst.d2));
  const J = D > 1 ? knife(v) : 0, fs = fspl(D);
  return { D, pts, worst, J, fspl: fs, margin: budget() - st.extra - fs - J, za, zb };
}
const status = p => p.worst.f >= 0.6 ? "ok" : p.worst.f >= 0 ? "warn" : "bad";

// ---------- nodes ----------
let NODES = [];        // {name, lat, lon, type, updated, pk, freq, sf, bw}
let near = [];         // indices into NODES within range
let results = new Map(); // pk -> profile
fetch("data/nodes.json").then(r => r.json()).then(j => {
  NODES = j.nodes.map(n => ({ name: n[0], lat: n[1], lon: n[2], type: n[3], updated: n[4], pk: n[5], freq: n[6], sf: n[7], bw: n[8] }));
  $("gen").textContent = j.generated ? ` (last refresh ${j.generated.replace("T", " ")})` : "";
  refreshAll();
}).catch(() => setStatus("Could not load the repeater list."));

// ---------- map ----------
const map = L.map("map", { preferCanvas: true, zoomControl: true, worldCopyJump: true });
const bases = {
  "Map": L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: "© OpenStreetMap contributors" }),
  "Satellite": L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", { maxZoom: 19, attribution: "Imagery © Esri, Maxar, Earthstar Geographics" }),
  "Topo": L.tileLayer("https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png", { maxZoom: 17, attribution: "© OpenTopoMap (CC-BY-SA), © OpenStreetMap contributors" }),
  "Bavaria aerial (sharp)": L.tileLayer.wms("https://geoservices.bayern.de/od/wms/dop/v1/dop40", { layers: "by_dop40c", format: "image/jpeg", maxZoom: 20, attribution: "© Bayerische Vermessungsverwaltung, CC BY 4.0" })
};
(bases[st.base] || bases.Map).addTo(map);
L.control.layers(bases, null, { position: "topright" }).addTo(map);
map.on("baselayerchange", e => { st.base = e.name; save(); });
map.setView(st.center || st.a, st.zoom || 13);
map.on("moveend", () => { st.center = [map.getCenter().lat, map.getCenter().lng]; st.zoom = map.getZoom(); save(); drawNodes(); });

const covLayer = L.imageOverlay("data:image/gif;base64,R0lGODlhAQABAAAAACw=", [[0, 0], [0, 0]], { opacity: 0.62, interactive: false }).addTo(map);
const nodeLayer = L.layerGroup().addTo(map);
const pathLayer = L.layerGroup().addTo(map);
const hoverMarker = L.circleMarker([0, 0], { radius: 11, color: "#fff", weight: 3, fillOpacity: .3, interactive: false });
const markA = L.marker(st.a, { draggable: true, icon: L.divIcon({ className: "", html: '<div class="mk-a"></div>', iconSize: [18, 18], iconAnchor: [9, 9] }), zIndexOffset: 1000, title: "Antenna A" }).addTo(map);
const markB = L.marker([0, 0], { draggable: true, icon: L.divIcon({ className: "", html: '<div class="mk-b"></div>', iconSize: [18, 18], iconAnchor: [9, 9] }), zIndexOffset: 900, title: "Point B" });
if (st.b) markB.setLatLng(st.b).addTo(map);
markA.on("dragend", () => setA([markA.getLatLng().lat, markA.getLatLng().lng]));
markB.on("dragend", () => setB([markB.getLatLng().lat, markB.getLatLng().lng]));
map.on("click", e => { const ll = [e.latlng.lat, e.latlng.lng]; if (st.clickMode === "B") setB(ll); else setA(ll); });

function colorFor(pk) { const p = results.get(pk); if (!p) return "#8a8f8c"; return { ok: "#2e9d5f", warn: "#e0a028", bad: "#d63028" }[status(p)]; }
function drawNodes() {
  nodeLayer.clearLayers();
  if (map.getZoom() < 7) return;
  const b = map.getBounds().pad(0.1);
  for (const n of NODES) {
    if (!b.contains([n.lat, n.lon])) continue;
    const sel = st.sel === n.pk;
    const m = L.circleMarker([n.lat, n.lon], { radius: sel ? 8 : 6, color: "#fff", weight: sel ? 3 : 1.5, fillColor: colorFor(n.pk), fillOpacity: 1, bubblingMouseEvents: false });
    m.bindTooltip(n.name + (n.type === 3 ? " (room)" : ""), { direction: "top", offset: [0, -6] });
    m.on("click", () => select(n.pk));
    m.addTo(nodeLayer);
  }
}

// ---------- selection & path drawing ----------
function selectedTarget() {
  if (st.sel === "B" && st.b) return { name: "Point B", lat: st.b[0], lon: st.b[1], pk: "B" };
  return NODES.find(n => n.pk === st.sel) || null;
}
function drawPath() {
  pathLayer.clearLayers(); hoverMarker.remove();
  const t = selectedTarget(), p = t && results.get(t.pk);
  if (!t || !p) return;
  L.polyline([st.a, [t.lat, t.lon]], { color: "#fff", weight: 5, opacity: .9, interactive: false }).addTo(pathLayer);
  L.polyline([st.a, [t.lat, t.lon]], { color: { ok: "#2e9d5f", warn: "#e0a028", bad: "#d63028" }[status(p)], weight: 2.5, dashArray: "8 6", interactive: false }).addTo(pathLayer);
  if (st.obs) {
    const segs = (test, color, w) => { let cur = [];
      const flush = () => { if (cur.length > 1) L.polyline(cur, { color, weight: w, opacity: .9, lineCap: "round", interactive: false }).addTo(pathLayer); else if (cur.length === 1) L.circleMarker(cur[0], { radius: w / 2, color, fillColor: color, fillOpacity: 1, weight: 0, interactive: false }).addTo(pathLayer); cur = []; };
      for (const q of p.pts) { if (test(q)) cur.push([q.la, q.lo]); else flush(); } flush(); };
    segs(q => q.F > 0 && q.l - q.e >= 0 && q.l - q.e < 0.6 * q.F, "#e0a028", 8);
    segs(q => q.F > 0 && q.l - q.e < 0, "#d63028", 11);
    const w = p.pts[p.worst.i];
    L.circleMarker([w.la, w.lo], { radius: 7, color: p.worst.clr < 0 ? "#d63028" : "#e0a028", weight: 3, fillColor: "#fff", fillOpacity: 1, interactive: false })
      .bindTooltip("worst " + (p.worst.clr >= 0 ? "+" : "") + p.worst.clr.toFixed(1) + " m", { permanent: true, direction: "right", className: "worst", offset: [8, 0] }).addTo(pathLayer);
  }
}

// ---------- profile chart ----------
const pc = $("prof"), pctx = pc.getContext("2d");
let hoverI = -1, profGeom = null;
function css(n) { return getComputedStyle(document.documentElement).getPropertyValue(n).trim(); }
function drawProfile() {
  const dpr = window.devicePixelRatio || 1, w = pc.clientWidth, h = pc.clientHeight;
  pc.width = w * dpr; pc.height = h * dpr; pctx.setTransform(dpr, 0, 0, dpr, 0, 0); pctx.clearRect(0, 0, w, h);
  const t = selectedTarget(), p = t && results.get(t.pk); if (!p) { profGeom = null; return; }
  const pts = p.pts, Lm = 44, Rm = 10, T = 10, B = 26;
  let ymin = Infinity, ymax = -Infinity;
  for (const q of pts) { ymin = Math.min(ymin, q.ground, q.l - q.F); ymax = Math.max(ymax, q.e, q.l + q.F); }
  ymin = Math.floor((ymin - 5) / 10) * 10; ymax = Math.ceil((ymax + 5) / 10) * 10;
  const X = d => Lm + d / p.D * (w - Lm - Rm), Y = v => T + (ymax - v) / (ymax - ymin) * (h - T - B);
  profGeom = { Lm, Rm, w, n: pts.length };
  pctx.font = `11px ${css("--mono")}`; pctx.fillStyle = css("--muted"); pctx.strokeStyle = css("--line"); pctx.lineWidth = 1;
  const span = ymax - ymin, step = span > 400 ? 100 : span > 160 ? 50 : span > 80 ? 20 : 10;
  pctx.textAlign = "right"; for (let v = Math.ceil(ymin / step) * step; v <= ymax; v += step) { pctx.beginPath(); pctx.moveTo(Lm, Y(v)); pctx.lineTo(w - Rm, Y(v)); pctx.stroke(); pctx.fillText(v + " m", Lm - 4, Y(v) + 4); }
  pctx.textAlign = "center"; const km = p.D / 1000, ks = km > 30 ? 10 : km > 15 ? 5 : km > 6 ? 2 : km > 2 ? 1 : 0.5;
  for (let d = 0; d <= km + 1e-6; d += ks) pctx.fillText((+d.toFixed(1)) + " km", X(d * 1000), h - 8);
  pctx.beginPath(); pts.forEach((q, i) => { const y = Y(q.l + q.F); i ? pctx.lineTo(X(q.d), y) : pctx.moveTo(X(q.d), y); });
  for (let i = pts.length - 1; i >= 0; i--) pctx.lineTo(X(pts[i].d), Y(pts[i].l - pts[i].F));
  pctx.closePath(); pctx.fillStyle = css("--fresnel"); pctx.fill();
  pctx.beginPath(); pctx.moveTo(X(0), h - B); pts.forEach(q => pctx.lineTo(X(q.d), Y(q.e))); pctx.lineTo(X(p.D), h - B); pctx.closePath(); pctx.fillStyle = css("--terrain-fill"); pctx.fill();
  pctx.beginPath(); pts.forEach((q, i) => i ? pctx.lineTo(X(q.d), Y(q.e)) : pctx.moveTo(X(q.d), Y(q.e))); pctx.strokeStyle = css("--terrain"); pctx.lineWidth = 1.5; pctx.stroke();
  if (st.obs) { pctx.lineWidth = Math.max(1.5, (w - Lm - Rm) / pts.length + 0.6); for (const q of pts) if (q.F > 0 && q.e > q.l) { pctx.strokeStyle = "rgba(214,48,40,.75)"; pctx.beginPath(); pctx.moveTo(X(q.d), Y(q.l)); pctx.lineTo(X(q.d), Y(q.e)); pctx.stroke(); } }
  if (hoverI >= 0 && pts[hoverI]) { const q = pts[hoverI]; pctx.strokeStyle = css("--fg"); pctx.lineWidth = 1; pctx.setLineDash([3, 3]); pctx.beginPath(); pctx.moveTo(X(q.d), T); pctx.lineTo(X(q.d), h - B); pctx.stroke(); pctx.setLineDash([]);
    pctx.fillStyle = css("--los"); pctx.beginPath(); pctx.arc(X(q.d), Y(q.l), 3.5, 0, 7); pctx.fill(); pctx.fillStyle = css("--terrain"); pctx.beginPath(); pctx.arc(X(q.d), Y(q.e), 3.5, 0, 7); pctx.fill(); }
  pctx.strokeStyle = css("--fg"); pctx.lineWidth = 2; pctx.beginPath();
  pctx.moveTo(X(0), Y(pts[0].ground)); pctx.lineTo(X(0), Y(p.za)); pctx.moveTo(X(p.D), Y(pts[pts.length - 1].ground)); pctx.lineTo(X(p.D), Y(p.zb)); pctx.stroke();
  pctx.beginPath(); pctx.moveTo(X(0), Y(p.za)); pctx.lineTo(X(p.D), Y(p.zb)); pctx.strokeStyle = css("--los"); pctx.lineWidth = 2; pctx.stroke();
  const wq = pts[p.worst.i], c = css(status(p) === "ok" ? "--ok" : status(p) === "warn" ? "--warn" : "--bad");
  pctx.beginPath(); pctx.arc(X(wq.d), Y(wq.e), 4.5, 0, 7); pctx.fillStyle = c; pctx.fill();
}
function readout() {
  const t = selectedTarget(), p = t && results.get(t.pk);
  if (hoverI < 0 || !p) { $("readout").textContent = "Slide over the profile to find each point on the map."; return; }
  const q = p.pts[hoverI], c = q.l - q.e;
  $("readout").textContent = `${(q.d / 1000).toFixed(2)} km · terrain ${Math.round(q.ground)} m · line ${Math.round(q.l)} m · clearance ${c >= 0 ? "+" : ""}${c.toFixed(1)} m` + (q.F > 0 ? ` (${Math.round(c / q.F * 100)} % F1)` : "");
}
function profHover(e) {
  if (!profGeom) return; const r = pc.getBoundingClientRect(), x = e.clientX - r.left, g = profGeom, tt = (x - g.Lm) / (g.w - g.Lm - g.Rm);
  const ni = tt < 0 || tt > 1 ? -1 : Math.round(tt * (g.n - 1)); if (ni === hoverI) return; hoverI = ni;
  drawProfile(); readout();
  const t = selectedTarget(), p = t && results.get(t.pk);
  if (hoverI >= 0 && p) { const q = p.pts[hoverI], c = q.l - q.e; hoverMarker.setLatLng([q.la, q.lo]).setStyle({ fillColor: c < 0 ? "#d63028" : c < 0.6 * q.F ? "#e0a028" : "#2e9d5f", color: c < 0 ? "#d63028" : "#fff" }).addTo(map); }
  else hoverMarker.remove();
}
pc.addEventListener("pointermove", profHover); pc.addEventListener("pointerdown", profHover);
pc.addEventListener("pointerleave", () => { hoverI = -1; drawProfile(); readout(); hoverMarker.remove(); });

// ---------- panel ----------
function setStatus(s) { $("status").textContent = s; }
function fmt(n, d = 1) { return (n > 0 ? "+" : "") + n.toFixed(d); }
function renderPanel() {
  $("coords").value = st.a[0].toFixed(5) + ", " + st.a[1].toFixed(5);
  $("bcoords").value = st.b ? st.b[0].toFixed(5) + ", " + st.b[1].toFixed(5) : "";
  for (const k of ["hA", "hB", "freq", "tx", "gain", "extra"]) $(k).value = st[k];
  $("sf").value = String(st.sf); $("bw").value = String(st.bw); $("range").value = String(st.range);
  $("sens").value = sens().toFixed(0) + " dBm";
  $("obs").checked = st.obs;
  $("cA").setAttribute("aria-pressed", st.clickMode !== "B"); $("cB").setAttribute("aria-pressed", st.clickMode === "B");
  const m = st.cov ? st.covMode : "off";
  $("vOff").setAttribute("aria-pressed", m === "off"); $("vLoss").setAttribute("aria-pressed", m === "loss"); $("vMargin").setAttribute("aria-pressed", m === "margin");
  $("covlegend").innerHTML = st.cov ? SCALES[st.covMode].map(([, c, l]) => `<span><i style="background:rgb(${c})"></i>${l}</span>`).join("") + `<span><i style="background:rgb(40,40,46)"></i>${st.covMode === "margin" ? "no link" : "over 30 dB"}</span>` : "";
  const t = selectedTarget(), p = t && results.get(t.pk);
  $("tname").textContent = t ? t.name : "Pick a repeater or point B";
  const pill = $("tpill");
  if (p) { const s = status(p); pill.hidden = false; pill.className = "pill " + s; pill.textContent = STATUS_TXT[s];
    $("sDist").textContent = (p.D / 1000).toFixed(2) + " km"; $("sClr").textContent = fmt(p.worst.clr) + " m"; $("sF1").textContent = Math.round(p.worst.f * 100) + " %";
    $("sDiff").textContent = p.J.toFixed(1) + " dB"; $("sPL").textContent = (p.fspl + p.J).toFixed(0) + " dB"; $("sMargin").textContent = fmt(p.margin, 0) + " dB";
  } else { pill.hidden = true; for (const k of ["sDist", "sClr", "sF1", "sDiff", "sPL", "sMargin"]) $(k).textContent = "–"; }
  readout();
}
function renderTable() {
  const rows = near.map(n => ({ n, p: results.get(n.pk) })).filter(r => r.p).sort((a, b) => (a.p.fspl + a.p.J) - (b.p.fspl + b.p.J));
  if (st.b && results.get("B")) rows.unshift({ n: { name: "Point B (your pick)", pk: "B", updated: "–" }, p: results.get("B") });
  $("rows").innerHTML = rows.map(({ n, p }) => { const s = status(p);
    return `<tr data-pk="${n.pk}" tabindex="0" class="${n.pk === st.sel ? "sel" : ""}"><td></td><td class="n">${(p.D / 1000).toFixed(1)} km</td><td class="n">${fmt(p.worst.clr)} m</td><td class="n">${Math.round(p.worst.f * 100)} %</td><td class="n">${p.J.toFixed(1)} dB</td><td class="n">${(p.fspl + p.J).toFixed(0)} dB</td><td class="n">${fmt(p.margin, 0)} dB</td><td><span class="pill ${s}">${STATUS_TXT[s]}</span></td><td>${n.updated || ""}</td></tr>`; }).join("");
  [...$("rows").children].forEach((tr, i) => { const n = rows[i].n; tr.firstChild.textContent = n.name + (n.type === 3 ? " (room)" : "") + (n.freq && Math.abs(n.freq - st.freq) > 0.01 ? ` · ${n.freq} MHz` : ""); });
  $("tablenote").textContent = rows.length ? `${near.length} within ${st.range / 1000} km. Sorted by path loss. Click a row to show its profile.` : (NODES.length ? `No known repeaters within ${st.range / 1000} km.` : "Loading repeaters…");
}
$("rows").addEventListener("click", e => { const tr = e.target.closest("tr"); if (tr) select(tr.dataset.pk, true); });
$("rows").addEventListener("keydown", e => { if (e.key === "Enter") { const tr = e.target.closest("tr"); if (tr) select(tr.dataset.pk, true); } });

// ---------- actions ----------
function select(pk, pan) {
  st.sel = pk; save(); hoverI = -1; renderPanel(); renderTable(); drawPath(); drawProfile(); drawNodes();
  const t = selectedTarget(); if (pan && t) map.fitBounds(L.latLngBounds([st.a, [t.lat, t.lon]]).pad(0.25), { maxZoom: 15 });
}
function setA(ll) { st.a = ll; markA.setLatLng(ll); COV = null; save(); refreshAll(); }
function setB(ll) { st.b = ll; markB.setLatLng(ll).addTo(map); st.sel = "B"; save(); refreshAll(); }

let refreshJob = 0;
async function refreshAll() {
  const job = ++refreshJob; renderPanel();
  if (NODES.length) near = NODES.filter(n => dist(st.a, [n.lat, n.lon]) <= st.range);
  const bx = boxAround(st.a, st.range);
  await ensureBox(bx[0], bx[1], bx[2], bx[3], (d, t) => { if (job === refreshJob) setStatus(`Loading terrain ${d}/${t}`); });
  if (st.b) await ensurePath(st.a, st.b);
  const t0 = selectedTarget(); if (t0 && t0.pk !== "B") await ensurePath(st.a, [t0.lat, t0.lon]);
  if (job !== refreshJob) return;
  setStatus("");
  results = new Map();
  for (const n of near) results.set(n.pk, profile(st.a, [n.lat, n.lon], st.hA, st.hB));
  if (st.b) results.set("B", profile(st.a, st.b, st.hA, st.hB));
  const t = selectedTarget(); if (t && !results.has(t.pk)) results.set(t.pk, profile(st.a, [t.lat, t.lon], st.hA, st.hB));
  if (!st.sel && near.length) { const best = near.map(n => [n.pk, results.get(n.pk)]).sort((a, b) => (a[1].fspl + a[1].J) - (b[1].fspl + b[1].J))[0]; st.sel = best[0]; }
  hoverI = -1; renderPanel(); renderTable(); drawNodes(); drawPath(); drawProfile();
  history.replaceState(null, "", shareURL());
  if (st.cov) runCoverage();
}
// recolour only (radio/extra changes) without new terrain
function recalc() { for (const [pk] of results) { const t = pk === "B" ? { lat: st.b[0], lon: st.b[1] } : NODES.find(n => n.pk === pk); if (t) results.set(pk, profile(st.a, [t.lat, t.lon], st.hA, st.hB)); }
  renderPanel(); renderTable(); drawNodes(); drawPath(); drawProfile(); if (st.cov) buildCovImage(); history.replaceState(null, "", shareURL()); }

// ---------- coverage ----------
let COV = null, covJob = 0;
const covCanvas = document.createElement("canvas");
function covKey() { return [st.a[0].toFixed(6), st.a[1].toFixed(6), st.hA, st.hB, st.range, st.freq].join("|"); }
function runCoverage() {
  if (!st.cov) return; const key = covKey(); if (COV && COV.key === key) { buildCovImage(); return; }
  const job = ++covJob, A = st.a.slice(), RANGE = st.range, NS = Math.round(RANGE / COV_STEP), NR = COV_NR, L = lam();
  const za = elev(A[0], A[1]) + st.hA, hB = st.hB, cosA = Math.cos(A[0] * Math.PI / 180);
  const J = new Float32Array(NR * NS).fill(NaN), zs = new Float32Array(NS + 1);
  let r = 0; setStatus("Calculating coverage… 0 %");
  (function chunk() {
    if (job !== covJob) return; const t0 = performance.now();
    while (r < NR && performance.now() - t0 < 40) {
      const th = r / NR * 2 * Math.PI, sn = Math.sin(th), cs = Math.cos(th);
      for (let j = 1; j <= NS; j++) { const d = j * COV_STEP; zs[j] = elev(A[0] + d * cs / R * 180 / Math.PI, A[1] + d * sn / (R * cosA) * 180 / Math.PI); }
      J[r * NS] = 0;
      for (let j = 2; j <= NS; j++) {
        const dj = j * COV_STEP, slope = (zs[j] + hB - za) / dj; let vmax = -1e9;
        for (let i = 1; i < j; i++) { const di = i * COV_STEP, d2 = dj - di, h = zs[i] + di * d2 / (2 * K * R) - (za + slope * di), v = h * Math.sqrt(2 * dj / (L * di * d2)); if (v > vmax) vmax = v; }
        J[r * NS + j - 1] = knife(vmax);
      }
      r++;
    }
    if (r < NR) { setStatus(`Calculating coverage… ${Math.round(r / NR * 100)} %`); setTimeout(chunk, 0); }
    else { COV = { key, A, J, RANGE, NS }; setStatus(""); buildCovImage(); }
  })();
}
function covColor(Lo, d) {
  const sc = SCALES[st.covMode];
  if (st.covMode === "margin") { const m = budget() - st.extra - (fspl(Math.max(d, COV_STEP)) + Lo); for (const [lim, c] of sc) if (-m <= lim) return c; return null; }
  for (const [lim, c] of sc) if (Lo <= lim) return c; return null;
}
function buildCovImage() {
  if (!COV || !st.cov) return; const N = COV_N, NR = COV_NR, { NS, J, A, RANGE } = COV;
  covCanvas.width = covCanvas.height = N; const g = covCanvas.getContext("2d"), im = g.createImageData(N, N);
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const dy = (1 - 2 * (y + 0.5) / N) * RANGE, dx = (2 * (x + 0.5) / N - 1) * RANGE, d = Math.hypot(dx, dy); if (d > RANGE) continue;
    let th = Math.atan2(dx, dy); if (th < 0) th += 2 * Math.PI;
    const rr = Math.round(th / (2 * Math.PI) * NR) % NR, j = Math.min(NS - 1, Math.max(0, Math.round(d / COV_STEP) - 1)), Lo = J[rr * NS + j];
    if (isNaN(Lo)) continue; const c0 = covColor(Lo, d), c = c0 || [40, 40, 46], k = (y * N + x) * 4;
    im.data[k] = c[0]; im.data[k + 1] = c[1]; im.data[k + 2] = c[2]; im.data[k + 3] = c0 ? 255 : 200;
  }
  g.putImageData(im, 0, 0);
  const b = boxAround(A, RANGE);
  covLayer.setUrl(covCanvas.toDataURL("image/png")); covLayer.setBounds([[b[0], b[1]], [b[2], b[3]]]);
}
function setCov(m) {
  if (m === "off") { st.cov = false; covJob++; setStatus(""); covLayer.setUrl("data:image/gif;base64,R0lGODlhAQABAAAAACw="); }
  else { st.cov = true; st.covMode = m; }
  save(); renderPanel(); if (st.cov) runCoverage();
}

// ---------- inputs ----------
function parseLL(v) { const m = (v || "").match(/(-?\d+(?:[.,]\d+)?)\s*[,;\s]\s*(-?\d+(?:[.,]\d+)?)/); if (!m) return null; const la = parseFloat(m[1].replace(",", ".")), lo = parseFloat(m[2].replace(",", ".")); return Math.abs(la) <= 85 && Math.abs(lo) <= 180 ? [la, lo] : null; }
$("coords").addEventListener("change", () => { const ll = parseLL($("coords").value); if (ll) { setA(ll); map.setView(ll, Math.max(map.getZoom(), 12)); } else renderPanel(); });
$("bcoords").addEventListener("change", () => { const ll = parseLL($("bcoords").value); if (ll) setB(ll); else if (!$("bcoords").value.trim()) { st.b = null; markB.remove(); if (st.sel === "B") st.sel = null; save(); refreshAll(); } else renderPanel(); });
for (const k of ["hA", "hB"]) $(k).addEventListener("change", () => { const v = parseFloat($(k).value); if (isFinite(v) && v > 0) { st[k] = v; COV = null; save(); recalc(); if (st.cov) runCoverage(); } });
for (const k of ["freq", "tx", "gain", "extra"]) $(k).addEventListener("change", () => { const v = parseFloat($(k).value); if (isFinite(v)) { st[k] = v; if (k === "freq") COV = null; save(); recalc(); if (st.cov && k === "freq") runCoverage(); } });
$("sf").addEventListener("change", () => { st.sf = +$("sf").value; save(); recalc(); });
$("bw").addEventListener("change", () => { st.bw = +$("bw").value; save(); recalc(); });
$("range").addEventListener("change", () => { st.range = +$("range").value; COV = null; save(); refreshAll(); });
$("obs").addEventListener("change", () => { st.obs = $("obs").checked; save(); drawPath(); drawProfile(); });
$("cA").addEventListener("click", () => { st.clickMode = "A"; save(); renderPanel(); });
$("cB").addEventListener("click", () => { st.clickMode = "B"; save(); renderPanel(); });
$("vOff").addEventListener("click", () => setCov("off"));
$("vLoss").addEventListener("click", () => setCov("loss"));
$("vMargin").addEventListener("click", () => setCov("margin"));
$("share").addEventListener("click", () => { const u = shareURL(); navigator.clipboard.writeText(u).then(() => $("shareNote").textContent = "Link copied.", () => $("shareNote").textContent = u); });
$("searchForm").addEventListener("submit", e => {
  e.preventDefault(); const q = $("q").value.trim(); if (!q) return;
  const ll = parseLL(q); if (ll) { map.setView(ll, 14); return; }
  setStatus("Searching…");
  fetch("https://nominatim.openstreetmap.org/search?format=json&limit=1&q=" + encodeURIComponent(q), { headers: { "Accept-Language": navigator.language || "en" } })
    .then(r => r.json()).then(j => { setStatus(""); if (j[0]) map.setView([+j[0].lat, +j[0].lon], 14); else setStatus("Place not found."); }).catch(() => setStatus("Search failed."));
});
window.addEventListener("resize", () => drawProfile());
window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => drawProfile());

renderPanel();
refreshAll();
