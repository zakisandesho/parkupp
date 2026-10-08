"""Downloads Uppsala kommun parking data and writes kommun.js for the static site.

Usage:  python3 build_data.py           (download fresh data, then build)
        python3 build_data.py --offline (build from the .geojson files already here)

Sources: Uppsala kommun's parking map and address register (ArcGIS FeatureServers, public, no key),
plus OpenStreetMap car parks via Overpass, and clinics from 1177 Hitta vård.
The server only allows browser requests from uppsala.se, so we snapshot it here.
"""
import json
import math
import re
import sys
import time
import urllib.parse
import urllib.request
from datetime import date
from pathlib import Path

HERE = Path(__file__).parent
BASE = "https://kartportal.uppsala.se/mapping/rest/services/iKommunkartan"
LAYERS = {
    "zones": "GOT_Omradeskoder/FeatureServer/415",
    "segments": "GOT_Avgiftsparkeringar/FeatureServer/0",
    "free": "GOT_Avgiftsfri_parkering/FeatureServer/1",
}


def download():
    for name, layer in LAYERS.items():
        for suffix, query in [
            (".geojson", "/query?where=1%3D1&outFields=*&outSR=4326&f=geojson"),
            ("_meta.json", "?f=json"),
        ]:
            if suffix == "_meta.json" and name == "zones":
                continue
            url = BASE + "/" + layer + query
            print("GET", url)
            with urllib.request.urlopen(url, timeout=60) as r:
                (HERE / (name + suffix)).write_bytes(r.read())


def coded_values(meta_file):
    meta = json.loads((HERE / meta_file).read_text())
    out = {}
    for f in meta["fields"]:
        d = f.get("domain") or {}
        if d.get("codedValues"):
            out[f["name"]] = {c["code"]: c["name"] for c in d["codedValues"]}
    return out


# ---------- tariff text parsing ----------

# 18581 "Danmästaren" (27/12 kr) is an unclear duplicate of Dansmästaren
SKIP_CODES = {18581}
SKIP_WORDS = ["tillstånd erfo", "skolverksamhet", "rörelsehindrad", "boendeparkering", "ladd", "omr e-"]

RANGE_RATE = re.compile(
    r"(\d{1,2})\s*-\s*(\d{1,2})\s*(?:\((\d{1,2})\s*-\s*(\d{1,2})\))?\s*"
    r"(\d+)\s*kr/tim(?:\s*i\s*(\d+)\s*tim\w*\s*därefter\s*(\d+)\s*kr/tim)?"
)


def normalise(text):
    t = " ".join(text.split())
    t = re.sub(r"kr\s*/\s*timm?e?", "kr/tim", t)
    t = re.sub(r"(\d)\s+kr", r"\1kr", t)
    # "5kr/tim 8-24 (8-24)" -> "8-24 (8-24) 5kr/tim"
    t = re.sub(r"^(\d+kr/tim)\s+(\d{1,2}-\d{1,2}(?:\s*\(\d{1,2}-\d{1,2}\))?)", r"\2 \1", t)
    return t


def parse_rules(text, days):
    rules = []
    for m in RANGE_RATE.finditer(text):
        a, b, pa, pb, rate, tier_h, after = m.groups()
        base = {"price": int(rate), "per": 60}
        if tier_h:
            base = {"price": int(rate), "per": 60, "firstHours": int(tier_h), "after": int(after)}
        if pa is not None:
            # Swedish sign convention: plain = weekdays, (parentheses) = Saturdays / day before holiday
            rules.append({"days": ["wd"], "from": int(a), "to": int(b), **base})
            rules.append({"days": ["sat"], "from": int(pa), "to": int(pb), **base})
        else:
            rules.append({"days": days, "from": int(a), "to": int(b), **base})
    return rules


def parse_tariff(name, raw):
    """Returns a structured tariff, or None if it isn't general visitor parking."""
    low = (name + " " + raw).lower()
    if any(w in low for w in SKIP_WORDS):
        return None
    t = normalise(raw)
    tariff = {"rules": []}
    has_parens = "(" in t
    if "Lördag-Söndag" in t:
        wd_part, we_part = t.split("Lördag-Söndag", 1)
        tariff["rules"] += parse_rules(wd_part, ["wd"])
        tariff["rules"] += parse_rules(we_part, ["sat", "sun"])
    elif re.search(r"alla dagar", t, re.I):
        tariff["rules"] = parse_rules(t, ["wd", "sat", "sun"])
    else:
        # No explicit days and no parentheses: assume every day (errs on the expensive side)
        tariff["rules"] = parse_rules(t, ["wd", "sat"] if has_parens else ["wd", "sat", "sun"])
        if not has_parens:
            tariff["assumedAllDays"] = True
    if not tariff["rules"]:
        return None
    cap = re.search(r"(\d+)kr/dygn", t)
    if cap:
        tariff["cap24h"] = int(cap.group(1))
    maxp = re.search(r"Max-P\s*(\d+)\s*(tim|dygn)", t)
    if maxp:
        tariff["maxStayMin"] = int(maxp.group(1)) * (60 if maxp.group(2) == "tim" else 1440)
    return tariff


# ---------- time limits / restrictions on street segments ----------

LIMIT = re.compile(r"(\d+)\s*(tim|min)(?:\s*(\d{1,2})-(\d{1,2}))?(?:\s*\((\d{1,2})-(\d{1,2})\))?")


def parse_limit(text):
    if not text or "övrig tid" in text:
        return None
    m = LIMIT.match(text)
    if not m:
        return None
    n, unit, a, b, pa, pb = m.groups()
    lim = {"maxMin": int(n) * (60 if unit == "tim" else 1), "text": text}
    if a is not None:
        windows = [{"days": ["wd"], "from": int(a), "to": int(b)}]
        if pa is not None:
            windows.append({"days": ["sat"], "from": int(pa), "to": int(pb)})
        lim["windows"] = windows
    return lim


EXCLUDE_RESTRICTION = re.compile(r"^(Endast|Förhyrd|Reserverad|Personal|Skoltaxi|Lastplats|Bilpool|Taxi)", re.I)


# ---------- geometry ----------

def lines_of(geom):
    if not geom:
        return []
    if geom["type"] == "LineString":
        return [geom["coordinates"]]
    if geom["type"] == "MultiLineString":
        return geom["coordinates"]
    return []


def thin(points, step_m=25):
    """Keep vertices roughly every step_m metres, plus the last one; [lat, lon] rounded."""
    out = []
    last = None
    for lon, lat in points:
        p = [round(lat, 5), round(lon, 5)]
        if last is None or dist_m(last, p) >= step_m:
            out.append(p)
            last = p
    end = [round(points[-1][1], 5), round(points[-1][0], 5)]
    if out[-1] != end:
        out.append(end)
    return out


def dist_m(a, b):
    dy = (a[0] - b[0]) * 111320
    dx = (a[1] - b[1]) * 111320 * math.cos(math.radians(a[0]))
    return math.hypot(dx, dy)


def centroid(geom):
    rings = [geom["coordinates"][0]] if geom["type"] == "Polygon" else [p[0] for p in geom["coordinates"]]
    pts = [p for r in rings for p in r]
    return [round(sum(p[1] for p in pts) / len(pts), 5), round(sum(p[0] for p in pts) / len(pts), 5)]


def group_segments(features, cv, code_key):
    groups = {}
    for f in features:
        p = f["properties"]
        restriction = cv.get("Restriktion", {}).get(p.get("Restriktion"))
        if restriction and EXCLUDE_RESTRICTION.match(restriction):
            continue
        street = (p.get("Adress") or "").strip() or "Okänd gata"
        limit = parse_limit(cv.get("Tidsbegransning", {}).get(p.get("Tidsbegransning")))
        key = (code_key(p), street, json.dumps(limit, sort_keys=True), restriction)
        g = groups.setdefault(key, {"code": code_key(p), "street": street, "spaces": 0, "lines": []})
        if limit:
            g["limit"] = limit
        if restriction:
            g["note"] = restriction
        g["spaces"] += p.get("AntalPlatser") or 0
        for line in lines_of(f["geometry"]):
            if line:
                g["lines"].append(thin(line))
    return list(groups.values())


def main():
    if "--offline" not in sys.argv:
        download()

    zones_fc = json.loads((HERE / "zones.geojson").read_text())
    zones = {}
    zone_points = {}
    for f in zones_fc["features"]:
        p = f["properties"]
        code = p.get("Omradeskod")
        name = " ".join((p.get("Omradesnamn") or "").split())
        name = re.sub(r"\s*\|\s*\d+\s*$", "", name)
        raw = " ".join((p.get("Avgiftstext") or "").split())
        tariff = parse_tariff(name, raw)
        if not code or not tariff or code in zones or code in SKIP_CODES:
            continue
        zones[code] = {"name": name, "text": raw, **tariff}
        if f["geometry"]:
            zone_points[code] = centroid(f["geometry"])

    seg_fc = json.loads((HERE / "segments.geojson").read_text())
    seg_cv = coded_values("segments_meta.json")
    paid = [f for f in seg_fc["features"] if f["properties"].get("Parkeringstyp") in (1, 13)]
    streets = [g for g in group_segments(paid, seg_cv, lambda p: p.get("Omradeskod")) if g["code"] in zones]

    # Paid lots/garages that have a zone polygon but no street segments -> one point at the centroid
    with_segments = {g["code"] for g in streets}
    lots = [
        {"code": c, "street": zones[c]["name"], "point": zone_points[c]}
        for c in zones
        if c not in with_segments and c in zone_points
    ]

    free_fc = json.loads((HERE / "free.geojson").read_text())
    free_cv = coded_values("free_meta.json")
    free = group_segments(free_fc["features"], free_cv, lambda p: None)
    for g in free:
        del g["code"]

    out = {
        "fetched": date.today().isoformat(),
        "zones": {str(k): v for k, v in zones.items()},
        "streets": streets,
        "lots": lots,
        "free": free,
    }
    js = "// Generated by build_data.py from Uppsala kommun's parking map. Do not edit by hand.\n"
    js += "window.KOMMUN = " + json.dumps(out, ensure_ascii=False, separators=(",", ":")) + ";\n"
    (HERE / "kommun.js").write_text(js)
    print(f"zones={len(zones)} streets={len(streets)} lots={len(lots)} free={len(free)} "
          f"size={len(js) // 1024} KB")

    build_osm(offline="--offline" in sys.argv)
    build_addresses(offline="--offline" in sys.argv)
    build_clinics(offline="--offline" in sys.argv)
    build_places(offline="--offline" in sys.argv)


# ---------- OpenStreetMap car parks (fallback for places the kommun data doesn't cover) ----------

OVERPASS_SERVERS = ["https://lz4.overpass-api.de/api/interpreter", "https://overpass-api.de/api/interpreter", "https://overpass.private.coffee/api/interpreter"]
OSM_QUERY = '[out:json][timeout:90];nwr["amenity"="parking"](59.72,17.45,59.95,17.85);out center tags;'
OSM_ACCESS_OK = {None, "yes", "public", "customers", "permissive", "destination"}
OSM_SKIP_TYPES = {"street_side", "lane", "on_kerb", "half_on_kerb", "layby"}  # mostly covered by kommun streets


def overpass(query, raw_file):
    """Download an Overpass query to raw_file. Returns False if every server failed."""
    data = urllib.parse.urlencode({"data": query}).encode()
    for attempt, server in enumerate(OVERPASS_SERVERS * 2):
        try:
            req = urllib.request.Request(server, data=data, headers={"User-Agent": "ParkUpp data build"})
            with urllib.request.urlopen(req, timeout=180) as r:
                body = r.read()
            json.loads(body)  # busy servers sometimes answer 200 with an HTML error page
            raw_file.write_bytes(body)
            return True
        except Exception as e:  # Overpass servers are often busy
            print(f"OSM download from {server} failed: {e}")
            time.sleep(10 * (attempt + 1))
    return False


def build_osm(offline=False):
    raw_file = HERE / "osm_raw.json"
    if not offline and not overpass(OSM_QUERY, raw_file):
        print("Giving up on OSM; keeping the previous osm.js")
        return
    elements = json.loads(raw_file.read_text())["elements"]
    out = []
    for e in elements:
        t = e.get("tags", {})
        c = e.get("center") or {"lat": e.get("lat"), "lon": e.get("lon")}
        if c["lat"] is None or t.get("access") not in OSM_ACCESS_OK or t.get("parking") in OSM_SKIP_TYPES:
            continue
        cap = t.get("capacity")
        if cap and cap.isdigit() and int(cap) < 5:
            continue
        p = {"lat": round(c["lat"], 5), "lon": round(c["lon"], 5)}
        for key, short in [("name", "n"), ("operator", "o"), ("fee", "f"), ("maxstay", "m"),
                           ("capacity", "c"), ("parking", "t"), ("access", "a")]:
            if t.get(key):
                p[short] = t[key]
        p["id"] = e["type"][0] + str(e["id"])
        out.append(p)
    js = "// Generated by build_data.py from OpenStreetMap (ODbL). Do not edit by hand.\n"
    js += "window.OSM_PARKING = " + json.dumps(out, ensure_ascii=False, separators=(",", ":")) + ";\n"
    (HERE / "osm.js").write_text(js)
    print(f"osm car parks={len(out)} size={len(js) // 1024} KB")


# ---------- Addresses (kommun's address register: exact points for search, and typo fixing) ----------

ADDRESS_LAYER = "https://kartportal.uppsala.se/mapping/rest/services/aGenerell/Adresser/FeatureServer/0/query"
ADDRESS_BBOX = (59.72, 17.45, 59.95, 17.85)  # same area as the OSM queries
HOUSE_NUMBER = re.compile(r"^(.*?)\s+(\d+(?:\s*[A-Za-zÅÄÖåäö]{1,2})?)$")


def build_addresses(offline=False):
    raw_file = HERE / "addresses.geojson"
    if not offline:
        features = []
        while True:  # the server returns at most 2000 per request
            url = (ADDRESS_LAYER + "?where=1%3D1&outFields=Name,PostCity&outSR=4326&orderByFields=OBJECTID"
                   f"&resultOffset={len(features)}&resultRecordCount=2000&f=geojson")
            with urllib.request.urlopen(url, timeout=60) as r:
                page = json.load(r)["features"]
            features += page
            if len(page) < 1000:
                break
        raw_file.write_text(json.dumps({"type": "FeatureCollection", "features": features}))
    s, w, n, e = ADDRESS_BBOX
    streets = {}
    for f in json.loads(raw_file.read_text())["features"]:
        lon, lat = f["geometry"]["coordinates"]
        if not (s <= lat <= n and w <= lon <= e):
            continue
        name = " ".join(f["properties"]["Name"].split())
        m = HOUSE_NUMBER.match(name)
        street, number = (m.group(1), m.group(2).replace(" ", "").upper()) if m else (name, "")
        streets.setdefault((street, f["properties"]["PostCity"]), []).append((number, lat, lon))
    # [street, post town, [number, lat, lon, number, lat, lon, ...]]; coordinates as 1e-5 degree offsets to save space
    out = []
    for (street, town), addrs in sorted(streets.items()):
        addrs.sort(key=lambda a: (int(re.match(r"\d*", a[0]).group() or 0), a[0]))
        flat = []
        for number, lat, lon in addrs:
            flat += [number, round((lat - 59.7) * 1e5), round((lon - 17.4) * 1e5)]
        out.append([street, town, flat])
    js = "// Generated by build_data.py from Uppsala kommun's address register. Do not edit by hand.\n"
    js += "// Coordinates: lat = 59.7 + y / 1e5, lon = 17.4 + x / 1e5\n"
    js += "window.ADDRESSES = " + json.dumps(out, ensure_ascii=False, separators=(",", ":")) + ";\n"
    (HERE / "addresses.js").write_text(js)
    print(f"addresses={sum(len(a) for a in streets.values())} streets={len(streets)} size={len(js) // 1024} KB")


# ---------- Clinics from 1177 (healthcare units are often missing from OpenStreetMap) ----------

# 1177's own "Hitta vård" search page, sorted by distance from central Uppsala; s=distance is what sorts it.
# Two pages of 500 reach well past the Uppsala area, so that's two requests a month.
CLINICS_URL = "https://www.1177.se/hitta-vard/?batchSize=500&p={page}&lat=59.8586&lng=17.6389&s=distance"


def build_clinics(offline=False):
    raw_file = HERE / "clinics_raw.json"
    s, w, n, e = ADDRESS_BBOX
    inside = lambda u: u.get("Latitude") and s <= u["Latitude"] <= n and w <= u["Longitude"] <= e
    if not offline:
        units = []
        try:
            for page in range(1, 6):
                req = urllib.request.Request(CLINICS_URL.format(page=page), headers={"User-Agent": "ParkUpp data build"})
                with urllib.request.urlopen(req, timeout=120) as r:
                    html = r.read().decode()
                start = html.index('"SearchHits":[') + len('"SearchHits":')
                hits = json.JSONDecoder().raw_decode(html[start:])[0]  # the results are JSON inside the page
                units += hits
                if not any(inside(u) for u in hits):
                    break
        except Exception as ex:  # page layout changed or 1177 is down
            print(f"1177 download failed: {ex}; keeping the previous clinics.js")
            return
        raw_file.write_text(json.dumps(units, ensure_ascii=False))
    out = []
    for u in json.loads(raw_file.read_text()):
        if inside(u):
            address = " ".join((u.get("Address") or "").split())
            out.append([u["Heading"], address, round((u["Latitude"] - 59.7) * 1e5), round((u["Longitude"] - 17.4) * 1e5)])
    out.sort()
    js = "// Generated by build_data.py from 1177 Hitta vård. Do not edit by hand.\n"
    js += "// [name, address, y, x, 1177 page]; lat = 59.7 + y / 1e5, lon = 17.4 + x / 1e5\n"
    js += "window.CLINICS = " + json.dumps(out, ensure_ascii=False, separators=(",", ":")) + ";\n"
    (HERE / "clinics.js").write_text(js)
    print(f"clinics={len(out)} size={len(js) // 1024} KB")


# ---------- Named places from OpenStreetMap (hotels, shops, schools...) so search doesn't wait for Photon ----------

_BB = "(59.72,17.45,59.95,17.85)"
PLACES_QUERY = ("[out:json][timeout:120];("
                + "".join(f'nwr["name"]["{k}"]{_BB};' for k in ("amenity", "shop", "tourism", "leisure", "office", "healthcare", "craft"))
                + f'nwr["name"]["place"~"^(suburb|neighbourhood|quarter|square|village|hamlet|locality)$"]{_BB};'
                + f'nwr["name"]["building"~"^(university|school|hospital|church|public|civic|commercial|retail|hotel|stadium|office)$"]{_BB};'
                + ");out center tags;")
PLACES_SKIP = {"charging_station", "parking", "parking_entrance", "bicycle_parking", "information", "artwork", "bench",
               "waste_basket", "recycling", "vending_machine", "atm", "post_box", "telephone", "toilets", "shelter",
               "picnic_table", "bbq", "drinking_water", "fire_station", "grit_bin", "hunting_stand", "letter_box",
               "motorcycle_parking", "taxi", "car_sharing", "bicycle_rental", "compressed_air", "loading_dock"}
# Shown next to the name when OSM has no street address
PLACE_KINDS = {
    "hotel": "Hotell", "hostel": "Vandrarhem", "guest_house": "Pensionat", "restaurant": "Restaurang", "cafe": "Kafé",
    "fast_food": "Snabbmat", "pub": "Pub", "bar": "Bar", "supermarket": "Livsmedel", "convenience": "Närbutik",
    "mall": "Köpcentrum", "school": "Skola", "kindergarten": "Förskola", "university": "Universitet",
    "college": "Skola", "library": "Bibliotek", "pharmacy": "Apotek", "hospital": "Sjukhus", "clinic": "Vård",
    "doctors": "Vård", "dentist": "Tandvård", "place_of_worship": "Kyrka", "church": "Kyrka", "museum": "Museum",
    "theatre": "Teater", "cinema": "Bio", "park": "Park", "playground": "Lekplats", "sports_centre": "Idrottshall",
    "stadium": "Arena", "swimming_pool": "Bad", "fitness_centre": "Gym", "nature_reserve": "Naturreservat",
    "fuel": "Bensinstation", "car_repair": "Bilverkstad", "hairdresser": "Frisör", "townhall": "Kommunhus",
    "suburb": "Stadsdel", "neighbourhood": "Område", "quarter": "Område", "village": "Ort", "hamlet": "By",
    "locality": "Plats", "square": "Torg",
}


def build_places(offline=False):
    raw_file = HERE / "places_raw.json"
    if not offline and not overpass(PLACES_QUERY, raw_file):
        print("Giving up on places; keeping the previous places.js")
        return
    out, seen = [], []
    for e in json.loads(raw_file.read_text())["elements"]:
        t = e.get("tags", {})
        c = e.get("center") or {"lat": e.get("lat"), "lon": e.get("lon")}
        kind = next((t[k] for k in ("amenity", "shop", "tourism", "leisure", "office", "healthcare", "place", "building", "craft")
                     if k in t), "")
        if c["lat"] is None or kind in PLACES_SKIP:
            continue
        name = " ".join(t["name"].split())
        # The same place is often mapped twice (a point and a building outline)
        if any(n == name and abs(la - c["lat"]) < 0.002 and abs(lo - c["lon"]) < 0.004 for n, la, lo in seen):
            continue
        seen.append((name, c["lat"], c["lon"]))
        street = " ".join(filter(None, [t.get("addr:street"), t.get("addr:housenumber")]))
        out.append([name, street or PLACE_KINDS.get(kind, ""), round((c["lat"] - 59.7) * 1e5), round((c["lon"] - 17.4) * 1e5)])
    out.sort()
    js = "// Generated by build_data.py from OpenStreetMap (ODbL). Do not edit by hand.\n"
    js += "// [name, address or kind, y, x]; lat = 59.7 + y / 1e5, lon = 17.4 + x / 1e5\n"
    js += "window.PLACES = " + json.dumps(out, ensure_ascii=False, separators=(",", ":")) + ";\n"
    (HERE / "places.js").write_text(js)
    print(f"places={len(out)} size={len(js) // 1024} KB")


if __name__ == "__main__":
    main()
