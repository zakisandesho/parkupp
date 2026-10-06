(function () {
  const K = window.KOMMUN;
  const OPS = window.OPERATORS;
  const WALK_FACTOR = 1.25; // straight line -> rough walking distance
  const WALK_M_PER_MIN = 80;
  const KR_PER_WALK_MIN = 2; // used for "best balance"
  const MAX_RESULTS = 10;

  const TYPES = {
    street: { label: "Kommun street parking", color: "var(--street)", hex: "#1f6feb" },
    kommunlot: { label: "Kommun car park", color: "var(--kommunlot)", hex: "#8250df" },
    private: { label: "Private car park", color: "var(--private)", hex: "#d1242f" },
    free: { label: "Free street parking", color: "var(--free)", hex: "#1a7f37" },
  };

  // Opening hours for kommun garages (from uppsalaparkering.se), keyed by area code
  const KOMMUN_OPEN = {
    18111: [{ days: ["wd", "sat", "sun"], from: 5, to: 1 }],
    18112: [{ days: ["wd", "sat", "sun"], from: 6.5, to: 23.5 }],
  };

  // ---------- build the list of all parking places once ----------
  const places = [];
  K.streets.forEach((s) => {
    const zone = K.zones[s.code];
    places.push({
      type: "street", name: s.street, sub: zone.name + " · area code " + s.code, lines: s.lines,
      tariff: zone, priceText: zone.text, limit: s.limit, note: s.note, spaces: s.spaces, operator: "kommun",
      assumed: zone.assumedAllDays,
    });
  });
  K.lots.forEach((l) => {
    const zone = K.zones[l.code];
    places.push({
      type: "kommunlot", name: l.street.replace(/^Besök(sparkering|are) - /, ""), sub: "Area code " + l.code,
      point: l.point, tariff: zone, priceText: zone.text, operator: "kommun", open: KOMMUN_OPEN[l.code],
      assumed: zone.assumedAllDays,
    });
  });
  K.free.forEach((f) => {
    places.push({
      type: "free", name: f.street, sub: "Free street parking", lines: f.lines, tariff: { rules: [] },
      priceText: "Free", limit: f.limit, note: f.note, spaces: f.spaces, operator: null,
    });
  });
  window.CARPARKS.forEach((c) => {
    places.push({
      type: "private", name: c.name, sub: c.address + " · " + OPS[c.operator].name, point: [c.lat, c.lon],
      tariff: c.tariff, priceText: c.priceText, note: c.note, operator: c.operator, open: c.open,
      source: c.source, checked: c.checked, approx: c.approx,
    });
  });

  // ---------- helpers ----------
  function distM(a, b) {
    const dy = (a[0] - b[0]) * 111320;
    const dx = (a[1] - b[1]) * 111320 * Math.cos((a[0] * Math.PI) / 180);
    return Math.hypot(dx, dy);
  }

  function nearestPoint(place, dest) {
    if (place.point) return { point: place.point, d: distM(place.point, dest) };
    let best = null;
    place.lines.forEach((line) => line.forEach((p) => {
      const d = distM(p, dest);
      if (!best || d < best.d) best = { point: p, d };
    }));
    return best;
  }

  function esc(s) {
    return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  }

  function pad(n) { return String(n).padStart(2, "0"); }

  // ---------- map ----------
  const map = L.map("map").setView([59.8586, 17.6389], 14);
  // OSM's tile policy needs a real web origin (Referer), so serve the site over http, not file://
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19, referrerPolicy: "strict-origin-when-cross-origin",
    attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  }).addTo(map);
  const layer = L.layerGroup().addTo(map);
  const markers = [];

  map.on("click", (e) => setDest(e.latlng.lat, e.latlng.lng, "Point on map"));

  // ---------- form ----------
  const $ = (id) => document.getElementById(id);
  const now = new Date(Date.now() + 15 * 60000);
  now.setMinutes(Math.ceil(now.getMinutes() / 15) * 15, 0, 0);
  $("date").value = now.getFullYear() + "-" + pad(now.getMonth() + 1) + "-" + pad(now.getDate());
  $("time").value = pad(now.getHours()) + ":" + pad(now.getMinutes());
  $("fetched").textContent = K.fetched;

  let dest = null;
  let sortMode = "balance";

  ["date", "time", "duration", "walk"].forEach((id) => $(id).addEventListener("change", render));
  $("form").addEventListener("submit", (e) => { e.preventDefault(); search(); });
  $("searchBtn").addEventListener("click", search);

  // Photon (komoot) handles typos and business names well; Nominatim is the fallback.
  async function photon(q) {
    const url = "https://photon.komoot.io/api/?limit=6&bbox=17.45,59.72,17.85,59.95&lat=59.858&lon=17.639&q=" +
      encodeURIComponent(q);
    const res = await fetch(url);
    const data = await res.json();
    return data.features.map((f) => {
      const p = f.properties;
      const street = [p.street, p.housenumber].filter(Boolean).join(" ");
      const label = [p.name, street, p.district || p.city].filter(Boolean)
        .filter((v, i, a) => a.indexOf(v) === i).join(", ");
      return { lat: f.geometry.coordinates[1], lon: f.geometry.coordinates[0], label };
    });
  }

  async function nominatim(q) {
    const url = "https://nominatim.openstreetmap.org/search?format=json&limit=6&countrycodes=se&bounded=1" +
      "&viewbox=17.45,59.95,17.85,59.72&q=" + encodeURIComponent(q);
    const res = await fetch(url, { headers: { "Accept-Language": "sv,en" } });
    return (await res.json()).map((h) => ({ lat: +h.lat, lon: +h.lon, label: h.display_name.split(",").slice(0, 3).join(",") }));
  }

  let searchSeq = 0;
  async function search() {
    const q = $("q").value.trim();
    const ul = $("suggestions");
    if (q.length < 3) { ul.style.display = "none"; return; }
    const seq = ++searchSeq;
    let hits = [];
    try { hits = await photon(q); } catch (err) { /* fall through to Nominatim */ }
    if (!hits.length) { try { hits = await nominatim(q); } catch (err) { /* handled below */ } }
    if (seq !== searchSeq) return; // a newer search has started
    ul.style.display = "block";
    if (!hits.length) { ul.innerHTML = "<li>No matches in Uppsala. Try another name, or click the map.</li>"; return; }
    ul.innerHTML = "";
    hits.forEach((h) => {
      const li = document.createElement("li");
      li.textContent = h.label;
      li.onclick = () => { ul.style.display = "none"; $("q").value = h.label; setDest(h.lat, h.lon, h.label); };
      ul.appendChild(li);
    });
  }

  let typingTimer;
  $("q").addEventListener("input", () => { clearTimeout(typingTimer); typingTimer = setTimeout(search, 350); });

  function setDest(lat, lon, label) {
    dest = { lat, lon, label };
    $("dest").hidden = false;
    $("dest").textContent = "📍 " + label;
    render();
    map.setView([lat, lon], 16);
  }

  // ---------- results ----------
  function evaluate() {
    const start = new Date($("date").value + "T" + $("time").value);
    const minutes = +$("duration").value;
    const maxWalk = +$("walk").value;
    const here = [dest.lat, dest.lon];
    const ok = [];
    let excluded = 0;
    places.forEach((p) => {
      const near = nearestPoint(p, here);
      const walkM = near.d * WALK_FACTOR;
      if (walkM > maxWalk) return;
      const r = Tariff.calculate(p.tariff, start, minutes, p.limit);
      if (!r.allowed) { excluded++; return; }
      const warnings = [];
      if (p.open && Tariff.overlaps(invert(p.open), start, minutes)) warnings.push("Closed during part of your stay. Check opening hours");
      if (p.assumed) warnings.push("Sign text has no days; price assumes every day");
      if (p.approx) warnings.push("Map position is approximate");
      ok.push({ ...p, near, walkM, walkMin: Math.max(1, Math.round(walkM / WALK_M_PER_MIN)), cost: r.cost, warnings });
    });
    return { ok, excluded, start, minutes };
  }

  // Opening hours -> closed hours
  function invert(open) {
    return open.map((w) => ({ days: w.days, from: w.to, to: w.from }));
  }

  function sortResults(list) {
    const by = {
      balance: (a, b) => a.cost + a.walkMin * KR_PER_WALK_MIN - (b.cost + b.walkMin * KR_PER_WALK_MIN) || a.walkM - b.walkM,
      cheapest: (a, b) => a.cost - b.cost || a.walkM - b.walkM,
      nearest: (a, b) => a.walkM - b.walkM || a.cost - b.cost,
    }[sortMode];
    return list.slice().sort(by).slice(0, MAX_RESULTS);
  }

  function render() {
    if (!dest) return;
    const { ok, excluded, start, minutes } = evaluate();
    const list = sortResults(ok);
    const el = $("results");
    const dayName = start.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "short" });
    const end = new Date(start.getTime() + minutes * 60000);
    const dayNote = { sun: " (Sunday/holiday rules)", sat: " (Saturday rules)", wd: "" }[Tariff.dayType(start)];

    let html = `<p class="muted">${esc(dayName)} ${pad(start.getHours())}:${pad(start.getMinutes())}–${pad(end.getHours())}:${pad(end.getMinutes())}${dayNote}</p>`;
    html += `<div class="tabs">
      <button data-sort="balance" title="Price + ${KR_PER_WALK_MIN} kr per walking minute">Best balance</button>
      <button data-sort="cheapest">Cheapest</button>
      <button data-sort="nearest">Nearest</button></div>`;
    if (!list.length) {
      html += `<p class="muted">Nothing found within this walking distance. Try a longer max walk.</p>`;
    }
    list.forEach((p, i) => {
      const t = TYPES[p.type];
      const apps = p.operator ? OPS[p.operator].pay : [];
      html += `<div class="card" data-i="${i}">
        <div class="num" style="background:${t.color}">${i + 1}</div>
        <div><div class="name">${esc(p.name)}<span class="badge" style="background:${t.color}">${t.label}</span></div>
          <div class="sub">${esc(p.sub)}</div></div>
        <div><div class="cost ${p.cost === 0 ? "free" : ""}">${p.cost === 0 ? "Free" : p.cost + " kr"}</div>
          <div class="walk">🚶 ${Math.round(p.walkM / 10) * 10} m · ${p.walkMin} min</div></div>
        ${apps.length ? `<div class="apps">${apps.map((a) => `<span class="app-tag">${esc(a)}</span>`).join("")}</div>` : ""}
        ${p.warnings.map((w) => `<div class="warn">⚠ ${esc(w)}</div>`).join("")}
        <div class="details">
          <p><b>Price:</b> ${esc(p.priceText)}</p>
          ${p.limit ? `<p><b>Time limit:</b> ${esc(p.limit.text)}</p>` : ""}
          ${p.note ? `<p><b>Note:</b> ${esc(p.note)}</p>` : ""}
          ${p.spaces ? `<p><b>Spaces:</b> about ${p.spaces}</p>` : ""}
          ${p.source ? `<p><a href="${esc(p.source)}" target="_blank" rel="noopener">Operator page</a> · checked ${esc(p.checked)}</p>` : ""}
          <p><a href="https://www.google.com/maps/dir/?api=1&destination=${p.near.point[0]},${p.near.point[1]}" target="_blank" rel="noopener">Directions</a></p>
        </div>
      </div>`;
    });
    if (excluded) {
      html += `<p class="muted">${excluded} nearby option${excluded > 1 ? "s" : ""} hidden because your stay is longer than the time limit.</p>`;
    }
    el.innerHTML = html;
    el.querySelectorAll(".tabs button").forEach((b) => {
      b.classList.toggle("active", b.dataset.sort === sortMode);
      b.onclick = () => { sortMode = b.dataset.sort; render(); };
    });
    el.querySelectorAll(".card").forEach((c) => {
      c.onclick = (e) => {
        if (e.target.tagName === "A") return;
        c.classList.toggle("open");
        const m = markers[+c.dataset.i];
        map.panTo(m.getLatLng());
        m.openPopup();
      };
    });
    drawMap(list);
  }

  function drawMap(list) {
    layer.clearLayers();
    markers.length = 0;
    L.circle([dest.lat, dest.lon], { radius: +$("walk").value / WALK_FACTOR, color: "#888", weight: 1, fill: false, dashArray: "4 4" }).addTo(layer);
    L.marker([dest.lat, dest.lon], { title: dest.label }).addTo(layer).bindPopup(esc(dest.label));
    list.forEach((p, i) => {
      const hex = TYPES[p.type].hex;
      (p.lines || []).forEach((line) => L.polyline(line, { color: hex, weight: 5, opacity: 0.7 }).addTo(layer));
      const icon = L.divIcon({
        className: "",
        html: `<div class="num" style="background:${hex};border:2px solid #fff;box-shadow:0 1px 3px rgba(0,0,0,.4)">${i + 1}</div>`,
        iconSize: [28, 28], iconAnchor: [14, 14],
      });
      const m = L.marker(p.near.point, { icon }).addTo(layer)
        .bindPopup(`<b>${esc(p.name)}</b><br>${p.cost === 0 ? "Free" : p.cost + " kr"} · ${p.walkMin} min walk`);
      markers.push(m);
    });
  }
})();
