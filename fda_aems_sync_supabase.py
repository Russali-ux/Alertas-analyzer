#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
FDA AEMS -> Supabase sync
==========================
Corre el scraper de fda_aems_monitor.py (mismo parser, sin duplicar lógica),
mantiene el JSON acumulado local (data/fda_aems_data.json, se commitea al
repo) y hace upsert de todas las señales conocidas a la tabla
`fda_aems_senales` en Supabase vía PostgREST (REST API), usando la
service_role key (nunca la anon key) para poder saltarse RLS en escritura.

La tabla ya existe en Supabase con este esquema (ver migración
create_fda_aems_senales):
    periodo, anio, producto, principio, senal, info, url, fuente_archivo
    + dedupe_key (generated, unique) = md5(periodo|producto|senal)

El upsert usa `on_conflict=dedupe_key` con `Prefer: resolution=merge-duplicates`,
así que correr esto muchas veces (o con overlap de datos) es idempotente.

Uso:
    python3 scripts/fda_aems_sync_supabase.py \
        --db data/fda_aems_data.json \
        --no-archived      # opcional: solo reportes vigentes (corridas mensuales)

Variables de entorno requeridas:
    SUPABASE_URL              -> https://<project-ref>.supabase.co
    SUPABASE_SERVICE_ROLE_KEY -> service_role key (Settings -> API en Supabase)
"""

import argparse
import json
import os
import sys
import time
from pathlib import Path

import requests

# Reutiliza el parser/scraper existente sin duplicar código.
sys.path.insert(0, str(Path(__file__).resolve().parent))
from fda_aems_monitor import (  # noqa: E402
    INDEX_URL, ARCHIVED_URL, get, log,
    discover_quarterly_links, parse_quarterly_report,
    load_db, save_db, period_sort_key,
)

BATCH_SIZE = 200  # filas por request de upsert a PostgREST


def scrape_all(no_archived: bool, sleep: float) -> list[dict]:
    """Descubre y parsea todos los reportes trimestrales (vigentes + archivados)."""
    log("Descubriendo reportes vigentes...")
    entries = discover_quarterly_links(get(INDEX_URL).text)

    if not no_archived:
        log("Descubriendo reportes archivados...")
        entries += discover_quarterly_links(get(ARCHIVED_URL).text)

    # Dedup por slug
    by_slug = {e["slug"]: e for e in entries}
    entries = sorted(by_slug.values(), key=period_sort_key, reverse=True)
    log(f"{len(entries)} reportes trimestrales encontrados.")

    reportes = []
    for i, e in enumerate(entries, 1):
        log(f"  [{i}/{len(entries)}] {e['slug']}")
        try:
            html = get(e["url"]).text
        except Exception as exc:  # noqa: BLE001
            log(f"    ERROR descargando {e['url']}: {exc}")
            continue
        rep = parse_quarterly_report(html, e)
        reportes.append(rep)
        time.sleep(sleep)
    return reportes


def reportes_to_rows(reportes: list[dict]) -> list[dict]:
    """Aplana los reportes a filas listas para la tabla fda_aems_senales."""
    rows = []
    for rep in reportes:
        for f in rep["filas"]:
            rows.append({
                "periodo": rep["periodo"],
                "anio": rep["anio"],
                "producto": f["producto"],
                # principio activo: se recalcula con la misma heurística
                # que usa el Excel/HTML de la skill fda-aems-monitor.
                "principio": None,  # se completa abajo con extract_active_ingredients
                "senal": f["senal_riesgo"],
                "info": f["informacion_adicional"] or "FDA no reporta información adicional para esta señal.",
                "url": rep["url"],
                "fuente_archivo": "fda_aems_monitor.py (scraper automatico)",
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
    ap.add_argument("--no-archived", action="store_true",
                     help="Solo reportes vigentes (corrida mensual rápida). "
                          "Omitir en la primera corrida para cargar el histórico completo.")
    ap.add_argument("--sleep", type=float, default=0.6)
    ap.add_argument("--dry-run", action="store_true",
                     help="No escribe a Supabase, solo actualiza el JSON local.")
    args = ap.parse_args()

    supabase_url = os.environ.get("SUPABASE_URL")
    service_key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
    if not args.dry_run and (not supabase_url or not service_key):
        log("ERROR: faltan SUPABASE_URL y/o SUPABASE_SERVICE_ROLE_KEY en el entorno.")
        sys.exit(1)

    db_path = Path(args.db)
    db_path.parent.mkdir(parents=True, exist_ok=True)
    db = load_db(db_path)

    reportes = scrape_all(no_archived=args.no_archived, sleep=args.sleep)
    if not reportes:
        log("No se obtuvo ningun reporte; abortando sin tocar la base de datos.")
        sys.exit(1)

    # Actualiza el JSON acumulado (fuente de verdad del repo).
    for rep in reportes:
        db["reportes"][rep["slug"]] = rep
    from datetime import datetime, timezone
    db["last_run"] = datetime.now(timezone.utc).isoformat()
    save_db(db, db_path)
    log(f"JSON acumulado actualizado: {db_path} ({len(db['reportes'])} reportes totales)")

    # Sincroniza TODO lo acumulado (no solo la corrida actual) para que
    # una corrida --no-archived nunca "pierda" trimestres viejos en Supabase.
    from fda_aems_monitor import extract_active_ingredients  # noqa: E402
    all_reportes = list(db["reportes"].values())
    rows = reportes_to_rows(all_reportes)
    for row in rows:
        row["principio"] = extract_active_ingredients(row["producto"])

    log(f"{len(rows)} filas listas para upsert.")

    if args.dry_run:
        log("--dry-run: se omite la escritura a Supabase.")
        return

    upsert_to_supabase(rows, supabase_url, service_key)
    log("Sincronizacion con Supabase completada.")


if __name__ == "__main__":
    main()
