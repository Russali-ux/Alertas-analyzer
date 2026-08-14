#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
FDA AEMS -> Supabase sync (desde JSON ya scrapeado, sin tocar fda.gov)
=======================================================================
Variante de fda_aems_sync_supabase.py que NO scrapea nada: lee
data/fda_aems_data.json (ya traído de OneDrive por
scripts_fetch_aems_from_onedrive.py, generado localmente con la skill
fda-aems-monitor) y hace upsert de todas las señales conocidas a la tabla
`fda_aems_senales` en Supabase.

Se separa del scraping porque fda.gov bloquea IPs de datacenter/nube
(incluidas las de GitHub Actions) -- el scraping corre en la PC del usuario
vía la skill, y este script solo sincroniza el resultado.

Uso:
    python3 fda_aems_sync_from_json.py --db data/fda_aems_data.json

Variables de entorno requeridas:
    SUPABASE_URL              -> https://<project-ref>.supabase.co
    SUPABASE_SERVICE_ROLE_KEY -> service_role key (Settings -> API en Supabase)
"""

import argparse
import json
import os
import sys
from pathlib import Path

import requests

sys.path.insert(0, str(Path(__file__).resolve().parent))
from fda_aems_monitor import load_db, log, extract_active_ingredients  # noqa: E402

BATCH_SIZE = 200


def reportes_to_rows(reportes: list[dict]) -> list[dict]:
    rows = []
    for rep in reportes:
        for f in rep["filas"]:
            rows.append({
                "periodo": rep["periodo"],
                "anio": rep["anio"],
                "producto": f["producto"],
                "principio": extract_active_ingredients(f["producto"]),
                "senal": f["senal_riesgo"],
                "info": f["informacion_adicional"] or "FDA no reporta información adicional para esta señal.",
                "url": rep["url"],
                "fuente_archivo": "fda_aems_monitor.py (scraping local via skill + OneDrive)",
            })
    return rows


def upsert_to_supabase(rows: list[dict], supabase_url: str, service_key: str):
    endpoint = supabase_url.rstrip("/") + "/rest/v1/fda_aems_senales"
    headers = {
        "apikey": service_key,
        "Authorization": f"Bearer {service_key}",
        "Content-Type": "application/json",
        "Prefer": "resolution=merge-duplicates,return=minimal",
    }
    params = {"on_conflict": "dedupe_key"}

    total = len(rows)
    for i in range(0, total, BATCH_SIZE):
        batch = rows[i:i + BATCH_SIZE]
        r = requests.post(endpoint, headers=headers, params=params,
                           data=json.dumps(batch), timeout=60)
        if r.status_code >= 300:
            log(f"  ERROR upsert filas {i}-{i+len(batch)}: {r.status_code} {r.text[:500]}")
            r.raise_for_status()
        log(f"  Upsert OK: filas {i+1}-{i+len(batch)} de {total}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", default="data/fda_aems_data.json")
    ap.add_argument("--dry-run", action="store_true",
                     help="No escribe a Supabase, solo valida el JSON.")
    args = ap.parse_args()

    db_path = Path(args.db)
    if not db_path.exists():
        sys.exit(f"No existe {db_path}. Corre primero scripts_fetch_aems_from_onedrive.py")

    supabase_url = os.environ.get("SUPABASE_URL")
    service_key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
    if not args.dry_run and (not supabase_url or not service_key):
        log("ERROR: faltan SUPABASE_URL y/o SUPABASE_SERVICE_ROLE_KEY en el entorno.")
        sys.exit(1)

    db = load_db(db_path)
    reportes = list(db.get("reportes", {}).values())
    if not reportes:
        sys.exit(f"{db_path} no tiene reportes -- ¿se generó bien en OneDrive?")

    rows = reportes_to_rows(reportes)
    log(f"{len(rows)} filas listas para upsert (de {len(reportes)} reportes trimestrales).")

    if args.dry_run:
        log("--dry-run: se omite la escritura a Supabase.")
        return

    upsert_to_supabase(rows, supabase_url, service_key)
    log("Sincronizacion con Supabase completada.")


if __name__ == "__main__":
    main()
