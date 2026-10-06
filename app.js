(function () {
  const K = window.KOMMUN;
  const OPS = window.OPERATORS;
  const WALK_FACTOR = 1.25; // straight line -> rough walking distance
  const WALK_M_PER_MIN = 80;
  const KR_PER_WALK_MIN = 2; // used for "best balance"
  const MAX_RESULTS = 10;

  const TYPES = {
    street: { label: "Gatuparkering", color: "var(--street)", hex: "#1f6feb" },
    kommunlot: { label: "Kommunal parkering", color: "var(--kommunlot)", hex: "#8250df" },
    private: { label: "Privat parkering", color: "var(--private)", hex: "#d1242f" },
    free: { label: "Gratis gatuparkering", color: "var(--free)", hex: "#1a7f37" },
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
      type: "street", name: s.street, sub: zone.name + " · områdeskod " + s.code, lines: s.lines,
      tariff: zone, priceText: zone.text, limit: s.limit, note: s.note, spaces: s.spaces, operator: "kommun",
      assumed: zone.assumedAllDays,
    });
  });
  K.lots.forEach((l) => {
    const zone = K.zones[l.code];
    places.push({
      type: "kommunlot", name: l.street.replace(/^Besök(sparkering|are) - /, ""), sub: "Områdeskod " + l.code,
      point: l.point, tariff: zone, priceText: zone.text, operator: "kommun", open: KOMMUN_OPEN[l.code],
      assumed: zone.assumedAllDays,
    });
  });
  K.free.forEach((f) => {
    places.push({
      type: "free", name: f.street, sub: "Gratis gatuparkering", lines: f.lines, tariff: { rules: [] },
      priceText: "Gratis", limit: f.limit, note: f.note, spaces: f.spaces, operator: null,
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
    attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>-bidragsgivare',
  }).addTo(map);
  const layer = L.layerGroup().addTo(map);
  const isPhone = () => window.matchMedia("(max-width: 800px)").matches;
  const markers = [];

  map.on("click", (e) => setDest(e.latlng.lat, e.latlng.lng, "Punkt på kartan"));

  // ---------- form ----------
  const $ = (id) => document.getElementById(id);
  // A plain dropdown instead of <input type="time">: the native time picker doesn't open on some Android phones
  for (let m = 0; m < 1440; m += 15) {
    const v = pad(Math.floor(m / 60)) + ":" + pad(m % 60);
    $("time").add(new Option(v, v));
  }

  function setNow() {
    const now = new Date();
    now.setMinutes(Math.ceil(now.getMinutes() / 15) * 15, 0, 0); // next quarter hour (may roll to tomorrow)
    $("date").value = now.getFullYear() + "-" + pad(now.getMonth() + 1) + "-" + pad(now.getDate());
    $("time").value = pad(now.getHours()) + ":" + pad(now.getMinutes());
  }
  setNow();
  $("nowBtn").addEventListener("click", () => { setNow(); render(); });
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
    if (!hits.length) { ul.innerHTML = "<li>Inga träffar i Uppsala. Prova ett annat namn, eller tryck på kartan.</li>"; return; }
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

  function setDest(lat, lon, label, shareName) {
    dest = { lat, lon, label };
    $("dest").hidden = false;
    $("dest").textContent = "📍 " + label;
    render();
    map.setView([lat, lon], 16);
    // Put the destination in the address bar so the link can be shared
    const params = new URLSearchParams({ lat: lat.toFixed(5), lon: lon.toFixed(5), name: shareName || label });
    history.replaceState(null, "", "?" + params);
    if (isPhone()) {
      $("q").blur(); // close the keyboard
      $("map").scrollIntoView({ behavior: "smooth", block: "start" });
    }
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
      if (p.open && Tariff.overlaps(invert(p.open), start, minutes)) warnings.push("Stängt under en del av din vistelse – kolla öppettiderna");
      if (p.assumed) warnings.push("Skylten anger inga dagar; priset räknar med alla dagar");
      if (p.approx) warnings.push("Positionen på kartan är ungefärlig");
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
    const dayName = start.toLocaleDateString("sv-SE", { weekday: "long", day: "numeric", month: "short" });
    const end = new Date(start.getTime() + minutes * 60000);
    const dayNote = { sun: " (sön- och helgdagsregler)", sat: " (lördagsregler)", wd: "" }[Tariff.dayType(start)];

    let html = `<p class="muted">${esc(dayName)} ${pad(start.getHours())}:${pad(start.getMinutes())}–${pad(end.getHours())}:${pad(end.getMinutes())}${dayNote}</p>`;
    html += `<div class="tabs">
      <button data-sort="balance" title="Pris + ${KR_PER_WALK_MIN} kr per gångminut">Bäst totalt</button>
      <button data-sort="cheapest">Billigast</button>
      <button data-sort="nearest">Närmast</button></div>`;
    if (!list.length) {
      html += `<p class="muted">Inget hittades inom det här gångavståndet. Prova ett längre maxavstånd.</p>`;
    }
    list.forEach((p, i) => {
      const t = TYPES[p.type];
      const apps = p.operator ? OPS[p.operator].pay : [];
      html += `<div class="card" data-i="${i}">
        <div class="num" style="background:${t.color}">${i + 1}</div>
        <div><div class="name">${esc(p.name)}<span class="badge" style="background:${t.color}">${t.label}</span></div>
          <div class="sub">${esc(p.sub)}</div></div>
        <div><div class="cost ${p.cost === 0 ? "free" : ""}">${p.cost === 0 ? "Gratis" : p.cost + " kr"}</div>
          <div class="walk">🚶 ${Math.round(p.walkM / 10) * 10} m · ${p.walkMin} min</div></div>
        ${apps.length ? `<div class="apps">${apps.map((a) => `<span class="app-tag">${esc(a)}</span>`).join("")}</div>` : ""}
        ${p.warnings.map((w) => `<div class="warn">⚠ ${esc(w)}</div>`).join("")}
        <div class="details">
          <p><b>Pris:</b> ${esc(p.priceText)}</p>
          ${p.limit ? `<p><b>Tidsbegränsning:</b> ${esc(p.limit.text)}</p>` : ""}
          ${p.note ? `<p><b>Obs:</b> ${esc(p.note)}</p>` : ""}
          ${p.spaces ? `<p><b>Platser:</b> ca ${p.spaces}</p>` : ""}
          ${p.source ? `<p><a href="${esc(p.source)}" target="_blank" rel="noopener">Operatörens sida</a> · kontrollerad ${esc(p.checked)}</p>` : ""}
          <p><a href="https://www.google.com/maps/dir/?api=1&destination=${p.near.point[0]},${p.near.point[1]}" target="_blank" rel="noopener">Vägbeskrivning</a></p>
          <button type="button" class="map-btn primary">Visa på kartan</button>
        </div>
      </div>`;
    });
    if (excluded) {
      html += `<p class="muted">${excluded} alternativ i närheten dolda eftersom din vistelse är längre än tidsbegränsningen.</p>`;
    }
    el.innerHTML = html;
    el.querySelectorAll(".tabs button").forEach((b) => {
      b.classList.toggle("active", b.dataset.sort === sortMode);
      b.onclick = () => { sortMode = b.dataset.sort; render(); };
    });
    el.querySelectorAll(".card").forEach((c) => {
      const m = () => markers[+c.dataset.i];
      c.onclick = (e) => {
        if (e.target.tagName === "A") return;
        if (e.target.classList.contains("map-btn")) {
          $("map").scrollIntoView({ behavior: "smooth", block: "start" });
          map.panTo(m().getLatLng());
          m().openPopup();
          return;
        }
        c.classList.toggle("open");
        if (!isPhone()) { map.panTo(m().getLatLng()); m().openPopup(); }
      };
    });
    drawMap(list);
  }

  // Map marker tapped -> open and highlight the matching card in the list
  function showCard(i) {
    const card = document.querySelector(`.card[data-i="${i}"]`);
    if (!card) return;
    card.classList.add("open", "flash");
    setTimeout(() => card.classList.remove("flash"), 1500);
    if (isPhone()) card.scrollIntoView({ behavior: "smooth", block: "center" });
    else card.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }

  // "Min position": use the phone's location as destination, arriving now.
  // The position never leaves the browser (except in the address bar, for sharing).
  const UPPSALA = [59.8586, 17.6389];
  $("locBtn").addEventListener("click", () => {
    const btn = $("locBtn");
    const msg = (text) => { $("locMsg").textContent = text; $("locMsg").hidden = !text; };
    if (!navigator.geolocation) { msg("Din webbläsare kan inte dela din position."); return; }
    msg("");
    btn.disabled = true;
    btn.textContent = "📍 Hämtar position…";
    const done = () => { btn.disabled = false; btn.textContent = "📍 Min position"; };
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        done();
        const { latitude: lat, longitude: lon, accuracy } = pos.coords;
        if (distM([lat, lon], UPPSALA) > 20000) {
          msg("Du verkar vara utanför Uppsala – ParkUpp täcker bara Uppsala än så länge.");
          return;
        }
        const label = "Min position" + (accuracy > 50 ? " (±" + Math.round(accuracy) + " m)" : "");
        setNow();
        setDest(lat, lon, label, "Delad position");
      },
      (err) => {
        done();
        msg({
          1: "Platsåtkomst nekad. Tillåt plats för den här sidan i webbläsarens inställningar och försök igen.",
          2: "Kunde inte hitta din position. Försök igen, eller sök på en adress.",
          3: "Det tog för lång tid att hitta din position. Försök igen.",
        }[err.code] || "Kunde inte hämta din position.");
      },
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 60000 }
    );
  });

  // Shared link: ?lat=..&lon=..&name=..
  function loadFromUrl() {
    const u = new URLSearchParams(location.search);
    const lat = parseFloat(u.get("lat")), lon = parseFloat(u.get("lon"));
    if (!isNaN(lat) && !isNaN(lon)) setDest(lat, lon, u.get("name") || "Delad plats");
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
        .bindPopup(`<b>${esc(p.name)}</b><br>${p.cost === 0 ? "Gratis" : p.cost + " kr"} · ${p.walkMin} min promenad`);
      m.on("click", () => showCard(i));
      markers.push(m);
    });
  }
  loadFromUrl();
})();
