#!/usr/bin/env python3
"""Merge scraper CSVs into app/restaurantes.json for the Rota de Vendas web app.

The CSVs must have latitude/longitude, so scrape with --full, e.g.:
    python3 scripts/scrape.py "restaurantes em Campinas SP" --city "Campinas, SP" --full --out campinas.csv
    python3 scripts/csv_to_app.py campinas.csv outra-cidade.csv

Only business fields go into the JSON (no emails): the file is published on GitHub Pages.
"""
import argparse
import csv
import json
import os
import sys

KEEP = ["title", "category", "address", "phone", "website", "review_rating", "review_count",
        "latitude", "longitude", "place_id", "cid", "link", "open_hours"]
OUT = os.path.join(os.path.dirname(__file__), "..", "app", "restaurantes.json")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("csv", nargs="+", help="CSV files produced by scripts/scrape.py --full")
    ap.add_argument("--out", default=OUT, help="output JSON (default: app/restaurantes.json)")
    ap.add_argument("--replace", action="store_true", help="overwrite instead of merging with the existing JSON")
    a = ap.parse_args()

    rows = {}
    if not a.replace and os.path.exists(a.out):
        with open(a.out, encoding="utf-8") as f:
            for r in json.load(f):
                rows[r.get("place_id") or r.get("cid") or r["title"]] = r

    skipped = 0
    for path in a.csv:
        with open(path, encoding="utf-8-sig", newline="") as f:
            reader = csv.DictReader(f)
            if "latitude" not in (reader.fieldnames or []):
                sys.exit(f"{path}: no latitude/longitude columns. Re-run the scraper with --full.")
            for r in reader:
                try:
                    float(r["latitude"]), float(r["longitude"])
                except (TypeError, ValueError):
                    skipped += 1
                    continue
                if not r.get("title"):
                    skipped += 1
                    continue
                row = {k: r.get(k, "") for k in KEEP}
                rows[row["place_id"] or row["cid"] or row["title"]] = row

    with open(a.out, "w", encoding="utf-8") as f:
        json.dump(list(rows.values()), f, ensure_ascii=False, indent=0)
    print(f"{len(rows)} places in {os.path.normpath(a.out)} ({skipped} rows skipped without coordinates)")


if __name__ == "__main__":
    main()
