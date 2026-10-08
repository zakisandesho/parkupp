"""Downloads Uppsala kommun parking data and writes kommun.js for the static site.

Usage:  python3 build_data.py           (download fresh data, then build)
        python3 build_data.py --offline (build from the .geojson files already here)

Source: Uppsala kommun's parking map (ArcGIS FeatureServer, public, no key).
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


# ---------- OpenStreetMap car parks (fallback for places the kommun data doesn't cover) ----------

OVERPASS_SERVERS = ["https://lz4.overpass-api.de/api/interpreter", "https://overpass-api.de/api/interpreter", "https://overpass.private.coffee/api/interpreter"]
OSM_QUERY = '[out:json][timeout:90];nwr["amenity"="parking"](59.72,17.45,59.95,17.85);out center tags;'
OSM_ACCESS_OK = {None, "yes", "public", "customers", "permissive", "destination"}
OSM_SKIP_TYPES = {"street_side", "lane", "on_kerb", "half_on_kerb", "layby"}  # mostly covered by kommun streets


def build_osm(offline=False):
    raw_file = HERE / "osm_raw.json"
    if not offline:
        data = urllib.parse.urlencode({"data": OSM_QUERY}).encode()
        for attempt, server in enumerate(OVERPASS_SERVERS * 2):
            try:
                req = urllib.request.Request(server, data=data, headers={"User-Agent": "ParkUpp data build"})
                with urllib.request.urlopen(req, timeout=120) as r:
                    raw_file.write_bytes(r.read())
                break
            except Exception as e:  # Overpass servers are often busy
                print(f"OSM download from {server} failed: {e}")
                time.sleep(10 * (attempt + 1))
        else:
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


if __name__ == "__main__":
    main()
