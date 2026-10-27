#!/usr/bin/env python3
"""Download every restaurant/bar/bakery/... in a region from OpenStreetMap into app/regiao-osm.json.

The Rota de Vendas app uses this saved base whenever you are inside the region, so it does not depend
on the (often slow) public Overpass servers while you drive. Re-run it now and then to refresh the data.

    python scripts/osm_region.py                      # Grande Florianopolis (default)
    python scripts/osm_region.py --bbox -27.95,-48.85,-27.15,-48.35 --name "Grande Florianopolis"
"""
import argparse
import datetime
import json
import os
import sys
import time
import urllib.parse
import urllib.request

MIRRORS = [
    "https://overpass-api.de/api/interpreter",
    "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
]
# Base category per OSM tag; app/app.js refines it (pizzaria, japonês...) from cuisine and name.
TAGS = {
    "restaurante": [("amenity", "restaurant"), ("amenity", "food_court")],
    "lanchonete": [("amenity", "fast_food")],
    "bar": [("amenity", "bar"), ("amenity", "pub"), ("amenity", "biergarten")],
    "sorveteria": [("amenity", "ice_cream")],
    "padaria": [("shop", "bakery"), ("shop", "pastry")],
    "cafe": [("amenity", "cafe")],
    "acougue": [("shop", "butcher")],
}
DEFAULT_BBOX = "-27.95,-48.85,-27.15,-48.35"  # S,W,N,E: Floripa, Sao Jose, Palhoca, Biguacu, Tijucas, Santo Amaro...
OUT = os.path.join(os.path.dirname(__file__), "..", "app", "regiao-osm.json")
UA = "RotaVendas/1.0 (google-maps-scraper-kit; personal sales route planner)"


def overpass(query):
    body = urllib.parse.urlencode({"data": query}).encode()
    last = None
    for url in MIRRORS:
        for attempt in range(2):
            try:
                req = urllib.request.Request(url, data=body, headers={"User-Agent": UA})
                with urllib.request.urlopen(req, timeout=200) as r:
                    return json.load(r)
            except Exception as e:  # noqa: BLE001 - try the next mirror
                last = e
                print(f"  {url} failed ({e}), retrying...", file=sys.stderr)
                time.sleep(3)
    sys.exit(f"All Overpass mirrors failed: {last}")


def cat_of(tags):
    for cat, pairs in TAGS.items():
        if any(tags.get(k) == v for k, v in pairs):
            return cat
    return "restaurante"


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--bbox", default=DEFAULT_BBOX, help="south,west,north,east")
    ap.add_argument("--name", default="Grande Florianópolis")
    ap.add_argument("--out", default=OUT)
    a = ap.parse_args()

    s, w, n, e = (float(x) for x in a.bbox.split(","))
    bb = f"({s},{w},{n},{e})"
    parts = "".join(f'nwr["{k}"="{v}"]["name"]{bb};' for pairs in TAGS.values() for k, v in pairs)
    print(f"Downloading {a.name} from OpenStreetMap...")
    data = overpass(f"[out:json][timeout:180];({parts});out center tags;")

    places = []
    for el in data["elements"]:
        t = el.get("tags", {})
        lat = el.get("lat", el.get("center", {}).get("lat"))
        lon = el.get("lon", el.get("center", {}).get("lon"))
        if lat is None or not t.get("name"):
            continue
        addr = ", ".join(x for x in [t.get("addr:street"), t.get("addr:housenumber")] if x)
        if t.get("addr:suburb"):
            addr += " - " + t["addr:suburb"]
        if t.get("addr:city"):
            addr += " - " + t["addr:city"]
        places.append([
            f"osm:{el['type']}/{el['id']}", t["name"], cat_of(t), round(lat, 6), round(lon, 6),
            t.get("phone") or t.get("contact:phone") or "",
            t.get("website") or t.get("contact:website") or "",
            addr.strip(" -,"), (t.get("cuisine") or "").replace("_", " ").replace(";", ", "),
            t.get("opening_hours") or "",
        ])

    out = {
        "name": a.name, "bbox": [s, w, n, e], "updated": datetime.date.today().isoformat(),
        "fields": ["id", "name", "cat", "lat", "lon", "phone", "website", "address", "cuisine", "hours"],
        "places": places,
    }
    with open(a.out, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, separators=(",", ":"))
    counts = {}
    for p in places:
        counts[p[2]] = counts.get(p[2], 0) + 1
    print(f"{len(places)} places saved to {os.path.normpath(a.out)}: {counts}")


if __name__ == "__main__":
    main()
