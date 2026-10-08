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
    osm: { label: "Övrig parkering", color: "var(--osm)", hex: "#6e7781" },
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

  // OpenStreetMap car parks fill the gaps (suburbs, shopping centres). Prices are mostly unknown,
  // so they're shown with a warning and sorted after places with a known price.
  const OSM_KINDS = { surface: "Markparkering", "multi-storey": "Parkeringshus", underground: "Garage", rooftop: "Takparkering" };
  const known = places.filter((p) => p.point).map((p) => p.point);
  (window.OSM_PARKING || []).forEach((o) => {
    const point = [o.lat, o.lon];
    if (known.some((k) => distM(k, point) < 60)) return; // already listed with better data
    const sub = [OSM_KINDS[o.t] || "Parkering", o.c && "ca " + o.c + " platser", o.o].filter(Boolean).join(" · ");
    const maxMin = parseMaxstay(o.m);
    places.push({
      type: "osm", name: o.n || "Parkering", sub, point, tariff: { rules: [] }, unknownPrice: o.f !== "no",
      priceText: o.f === "no" ? "Gratis enligt OpenStreetMap" : o.f === "yes" ? "Avgift – pris okänt" : "Okänt om det kostar",
      limit: maxMin ? { maxMin, text: "max " + Tariff.formatDuration(maxMin) } : null,
      note: o.a === "customers" ? "Endast för kunder (t.ex. butikens besökare)" : null,
      source: "https://www.openstreetmap.org/" + { n: "node", w: "way", r: "relation" }[o.id[0]] + "/" + o.id.slice(1),
      sourceLabel: "Se på OpenStreetMap", osm: true,
    });
  });

  // OSM maxstay like "2 hours", "90 min", "3h", "1 day" -> minutes
  function parseMaxstay(v) {
    const m = /^(\d+(?:[.,]\d+)?)\s*(h|hours?|tim\w*|min\w*|days?|dygn)?$/i.exec((v || "").trim());
    if (!m) return null;
    const n = parseFloat(m[1].replace(",", "."));
    const unit = (m[2] || "min").toLowerCase();
    return Math.round(unit.startsWith("h") || unit.startsWith("t") ? n * 60 : unit.startsWith("d") ? n * 1440 : n);
  }

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

  // ---------- destination search ----------
  // 1. Addresses: Uppsala kommun's address register (data/addresses.js), searched locally. Exact points for
  //    every house number, and it forgives typos ("Krukmarkgatan 7" -> Krukmakargatan 7).
  // 2. Places and businesses: Photon (komoot), with Nominatim as fallback. Both use OpenStreetMap.
  const fold = (s) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9 ]/g, "");

  let addressIndex = null;
  let addressesLoading = null;
  function loadAddresses() { // ~260 KB gzipped, so only fetched once someone starts searching
    addressesLoading = addressesLoading || new Promise((resolve) => {
      const s = document.createElement("script");
      s.src = "data/addresses.js";
      s.onload = () => {
        addressIndex = (window.ADDRESSES || []).map(([name, town, flat]) => ({ name, town, flat, key: fold(name) }));
        resolve();
      };
      s.onerror = () => { addressesLoading = null; resolve(); }; // search still works via Photon
      document.head.appendChild(s);
    });
    return addressesLoading;
  }
  $("q").addEventListener("focus", loadAddresses);

  // Edits needed to turn a into b; swapping two neighbouring letters counts as one edit
  function editDistance(a, b, max) {
    if (Math.abs(a.length - b.length) > max) return max + 1;
    let before = [], prev = Array.from({ length: b.length + 1 }, (_, j) => j);
    for (let i = 1; i <= a.length; i++) {
      const cur = [i];
      for (let j = 1; j <= b.length; j++) {
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
        if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) cur[j] = Math.min(cur[j], before[j - 2] + 1);
      }
      before = prev;
      prev = cur;
    }
    return prev[b.length];
  }

  function samePrefix(a, b) {
    let i = 0;
    while (i < a.length && a[i] === b[i]) i++;
    return i;
  }

  // "krukmarkgatan 7b" -> [{ label: "Krukmakargatan 7B", lat, lon, hint: "Menade du?" }, ...]
  function addressHits(q) {
    if (!addressIndex) return [];
    const m = q.replace(/,.*$/, "").match(/^(.*?)\s*(\d+\s*[a-zåäö]{0,2})?$/i);
    const text = fold(m[1]).trim(), number = (m[2] || "").replace(/\s+/g, "").toUpperCase();
    if (text.length < 3) return [];
    const max = Math.min(3, Math.floor(text.length / 4));
    const matches = [];
    addressIndex.forEach((s) => {
      // 0 = exact name, 1 = start of a name (still typing), 2+ = spelling mistakes
      let score = s.key === text ? 0 : s.key.startsWith(text) ? 1 : null;
      if (score === null && text.length >= 4) {
        const d = editDistance(text, s.key, max);
        if (d <= max) score = 1 + d;
      }
      if (score !== null) matches.push({ s, score, prefix: samePrefix(text, s.key) });
    });
    matches.sort((a, b) => a.score - b.score || b.prefix - a.prefix || (a.s.town !== "Uppsala") - (b.s.town !== "Uppsala"));
    const good = matches.length ? matches[0].score + 1 : 0; // skip far-fetched spellings when a closer one exists
    return matches.filter((x) => x.score <= good).slice(0, 4).map(({ s, score }) => {
      const at = (i) => ({ lat: 59.7 + s.flat[i + 1] / 1e5, lon: 17.4 + s.flat[i + 2] / 1e5 });
      let i = -1;
      if (number) {
        i = s.flat.findIndex((v, k) => k % 3 === 0 && v === number);
        if (i < 0) { // no such number: take the closest one, preferring the same side of the street (odd/even)
          let best = Infinity;
          const want = parseInt(number, 10);
          for (let k = 0; k < s.flat.length; k += 3) {
            const n = parseInt(s.flat[k], 10);
            const diff = Math.abs(n - want) + (n % 2 !== want % 2 ? 2.5 : 0);
            if (diff < best) { best = diff; i = k; }
          }
        }
      } else {
        i = Math.floor(s.flat.length / 6) * 3; // a house in the middle of the street
      }
      const town = s.town === "Uppsala" ? "" : ", " + s.town;
      const label = number ? s.name + " " + s.flat[i] + town : s.name + town;
      const nearest = number && s.flat[i] !== number;
      return { ...at(i), label, hint: score >= 2 ? "Menade du?" : nearest ? "närmaste adress" : "", exact: score === 0 };
    });
  }

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
      return {
        lat: f.geometry.coordinates[1], lon: f.geometry.coordinates[0], label, street: p.type === "street",
        address: !p.name && street ? fold(street) : null, // a bare address, no business or place name
      };
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
    const [places] = await Promise.all([
      photon(q).catch(() => []).then((h) => h.length ? h : nominatim(q).catch(() => [])),
      loadAddresses(),
    ]);
    if (seq !== searchSeq) return; // a newer search has started
    const addresses = addressHits(q);
    // Our address points are more precise than Photon's whole-street results, so drop those
    const ours = new Set(addresses.map((a) => fold(a.label)));
    const others = places.filter((p) => !(addresses.length && p.street) && !ours.has(p.address));
    // Looks like an address (or the name matches a street exactly) -> addresses first; otherwise places first
    const addressFirst = /\d/.test(q) || addresses.some((a) => a.exact);
    const hits = (addressFirst ? addresses.concat(others) : others.concat(addresses)).slice(0, 8);
    ul.style.display = "block";
    if (!hits.length) { ul.innerHTML = "<li>Inga träffar i Uppsala. Prova en gatuadress i närheten, eller tryck på kartan.</li>"; return; }
    ul.innerHTML = "";
    hits.forEach((h) => {
      const li = document.createElement("li");
      li.textContent = h.label;
      if (h.hint) {
        const hint = document.createElement("span");
        hint.className = "hint";
        hint.textContent = " · " + h.hint;
        li.appendChild(hint);
      }
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
    const excluded = [];
    places.forEach((p) => {
      const near = nearestPoint(p, here);
      const walkM = near.d * WALK_FACTOR;
      if (walkM > maxWalk) return;
      const r = Tariff.calculate(p.tariff, start, minutes, p.limit);
      if (!r.allowed) { excluded.push({ name: p.name, reason: r.reasons[0], walkM }); return; }
      const warnings = [];
      if (p.open && Tariff.overlaps(invert(p.open), start, minutes)) warnings.push("Stängt under en del av din vistelse – kolla öppettiderna");
      if (p.assumed) warnings.push("Skylten anger inga dagar; priset räknar med alla dagar");
      if (p.approx) warnings.push("Positionen på kartan är ungefärlig");
      if (p.osm) warnings.push("Uppgifter från OpenStreetMap – kontrollera skylten på plats");
      const cost = p.unknownPrice ? null : r.cost;
      ok.push({ ...p, near, walkM, walkMin: Math.max(1, Math.round(walkM / WALK_M_PER_MIN)), cost, warnings });
    });
    return { ok, excluded, start, minutes };
  }

  // Opening hours -> closed hours
  function invert(open) {
    return open.map((w) => ({ days: w.days, from: w.to, to: w.from }));
  }

  function costText(p) {
    return p.cost == null ? "Pris ?" : p.cost === 0 ? "Gratis" : p.cost + " kr";
  }

  function sortResults(list) {
    // Unknown prices sort after every known price
    const price = (p) => (p.cost == null ? 1e6 : p.cost);
    const by = {
      balance: (a, b) => price(a) + a.walkMin * KR_PER_WALK_MIN - (price(b) + b.walkMin * KR_PER_WALK_MIN) || a.walkM - b.walkM,
      cheapest: (a, b) => price(a) - price(b) || a.walkM - b.walkM,
      nearest: (a, b) => a.walkM - b.walkM || price(a) - price(b),
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
    // Explain hidden places (e.g. 30-minute streets when you stay 2 hours) instead of a bare "nothing found"
    const nearestHidden = excluded.slice().sort((a, b) => a.walkM - b.walkM)[0];
    const hiddenText = excluded.length
      ? `${excluded.length} ${excluded.length > 1 ? "platser" : "plats"} i närheten har kortare tidsgräns än din vistelse ` +
        `(t.ex. ${esc(nearestHidden.name)}: ${esc(nearestHidden.reason.replace(/^Tidsbegränsning: /, ""))}).`
      : "";
    if (!list.length) {
      html += `<p class="muted">Inget passar inom ${+$("walk").value} m. ` +
        (excluded.length ? hiddenText + " Välj kortare tid eller längre gångavstånd." : "Prova ett längre maxavstånd.") + "</p>";
    }
    list.forEach((p, i) => {
      const t = TYPES[p.type];
      const apps = p.operator ? OPS[p.operator].pay : [];
      html += `<div class="card" data-i="${i}">
        <div class="num" style="background:${t.color}">${i + 1}</div>
        <div><div class="name">${esc(p.name)}<span class="badge" style="background:${t.color}">${t.label}</span></div>
          <div class="sub">${esc(p.sub)}</div></div>
        <div><div class="cost ${p.cost === 0 ? "free" : p.cost == null ? "unknown" : ""}">${costText(p)}</div>
          <div class="walk">🚶 ${Math.round(p.walkM / 10) * 10} m · ${p.walkMin} min</div></div>
        ${apps.length ? `<div class="apps">${apps.map((a) => `<span class="app-tag">${esc(a)}</span>`).join("")}</div>` : ""}
        ${p.warnings.map((w) => `<div class="warn">⚠ ${esc(w)}</div>`).join("")}
        <div class="details">
          <p><b>Pris:</b> ${esc(p.priceText)}</p>
          ${p.limit ? `<p><b>Tidsbegränsning:</b> ${esc(p.limit.text)}</p>` : ""}
          ${p.note ? `<p><b>Obs:</b> ${esc(p.note)}</p>` : ""}
          ${p.spaces ? `<p><b>Platser:</b> ca ${p.spaces}</p>` : ""}
          ${p.source ? `<p><a href="${esc(p.source)}" target="_blank" rel="noopener">${esc(p.sourceLabel || "Operatörens sida")}</a>${p.checked ? " · kontrollerad " + esc(p.checked) : ""}</p>` : ""}
          <p><a href="https://www.google.com/maps/dir/?api=1&destination=${p.near.point[0]},${p.near.point[1]}" target="_blank" rel="noopener">Vägbeskrivning</a></p>
          <button type="button" class="map-btn primary">Visa på kartan</button>
        </div>
      </div>`;
    });
    if (list.length && excluded.length) html += `<p class="muted">Dolda: ${hiddenText}</p>`;
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
        .bindPopup(`<b>${esc(p.name)}</b><br>${costText(p)} · ${p.walkMin} min promenad`);
      m.on("click", () => showCard(i));
      markers.push(m);
    });
  }
  loadFromUrl();
})();
