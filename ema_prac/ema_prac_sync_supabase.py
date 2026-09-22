#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
ema_prac_sync_supabase.py
==========================
Sube (upsert) los JSON generados por scraper_ema_prac.py a Supabase.

- Lee ema_prac/data/ema_prac_minutas.json          -> tabla public.ema_prac_minutas
- Lee ema_prac/data/ema_prac_recomendaciones.json  -> tabla public.ema_prac_recomendaciones

Usa la SERVICE_ROLE key (bypassa RLS) y hace upsert idempotente con
on_conflict=dedupe_key + Prefer: resolution=merge-duplicates (mismo patrón
que india_sync_supabase.py y fda_aems_sync_from_json.py), así que se puede
correr cuantas veces quieras sin duplicar filas.

Variables de entorno requeridas (GitHub Secrets):
  SUPABASE_URL                 ej. https://ggbnfdaxtsngsjssrwrl.supabase.co
  SUPABASE_SERVICE_ROLE_KEY    service_role key (secreta, NUNCA en el cliente)

Uso local:
  python3 ema_prac/ema_prac_sync_supabase.py
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parent
LOTE = 100  # los contenido_md pueden pesar varios KB cada uno; lotes chicos son más seguros

SUPABASE_URL = os.environ.get("SUPABASE_URL", "").rstrip("/")
SERVICE_KEY = (
    os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
    or os.environ.get("SUPABASE_SERVICE_KEY")  # nombre alterno por compatibilidad
)

if not SUPABASE_URL or not SERVICE_KEY:
    print("✗ Falta SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY en el entorno.", file=sys.stderr)
    sys.exit(1)


def cargar(nombre: str) -> list[dict]:
    ruta = ROOT / "data" / nombre
    if not ruta.exists():
        print(f"  (sin {nombre}, se omite)")
        return []
    return json.loads(ruta.read_text(encoding="utf-8"))


def deduplicar(filas: list[dict]) -> list[dict]:
    """Postgres rechaza un INSERT...ON CONFLICT si dos filas del MISMO lote
    comparten la clave de conflicto ('ON CONFLICT DO UPDATE command cannot
    affect row a second time', código 21000). Nos quedamos con la última
    aparición de cada dedupe_key (la más reciente en el JSON) antes de subir."""
    por_key: dict[str, dict] = {}
    for fila in filas:
        por_key[fila["dedupe_key"]] = fila
    descartadas = len(filas) - len(por_key)
    if descartadas:
        print(f"  ⚠️  {descartadas} fila(s) duplicada(s) por dedupe_key, se conserva solo la última")
    return list(por_key.values())


def upsert(tabla: str, filas: list[dict]) -> int:
    filas = deduplicar(filas)
    if not filas:
        print(f"  {tabla}: nada que subir")
        return 0
    url = f"{SUPABASE_URL}/rest/v1/{tabla}?on_conflict=dedupe_key"
    headers = {
        "apikey": SERVICE_KEY,
        "Authorization": f"Bearer {SERVICE_KEY}",
        "Content-Type": "application/json",
        "Prefer": "resolution=merge-duplicates,return=minimal",
    }
    total = 0
    for i in range(0, len(filas), LOTE):
        chunk = filas[i:i + LOTE]
        r = requests.post(url, headers=headers, data=json.dumps(chunk), timeout=120)
        if r.status_code not in (200, 201, 204):
            print(f"  ✗ {tabla} lote {i // LOTE + 1}: {r.status_code} {r.text[:300]}", file=sys.stderr)
            r.raise_for_status()
        total += len(chunk)
        print(f"  {tabla}: {total}/{len(filas)} upsert")
    return total


def preparar_minutas(regs: list[dict]) -> list[dict]:
    out = []
    for r in regs:
        titulo = (r.get("titulo") or "").strip()
        if not titulo or not r.get("dedupe_key"):
            continue
        out.append({
            "tipo_documento": r.get("tipo_documento"),
            "titulo": titulo,
            "fecha_reunion": r.get("fecha_reunion"),
            "referencia": r.get("referencia"),
            "fecha_publicacion": r.get("fecha_publicacion"),
            "url_pdf": r.get("url_pdf"),
            "contenido_md": r.get("contenido_md"),
            "dedupe_key": r["dedupe_key"],
        })
    return out


def preparar_recomendaciones(regs: list[dict]) -> list[dict]:
    out = []
    for r in regs:
        titulo = (r.get("titulo") or "").strip()
        if not titulo or not r.get("dedupe_key"):
            continue
        out.append({
            "titulo": titulo,
            "fecha_reunion": r.get("fecha_reunion"),
            "referencia": r.get("referencia"),
            "fecha_publicacion": r.get("fecha_publicacion"),
            "url_pdf": r.get("url_pdf"),
            "contenido_md": r.get("contenido_md"),
            "dedupe_key": r["dedupe_key"],
        })
    return out


def preparar_senales(regs: list[dict]) -> list[dict]:
    out = []
    for r in regs:
        molecula = (r.get("molecula") or "").strip()
        senal = (r.get("senal") or "").strip()
        if not molecula or not senal or not r.get("dedupe_key"):
            continue
        out.append({
            "molecula": molecula,
            "senal": senal,
            "epitt_no": r.get("epitt_no"),
            "seccion": r.get("seccion"),
            "fecha_reunion": r.get("fecha_reunion"),
            "referencia": r.get("referencia"),
            "fecha_publicacion": r.get("fecha_publicacion"),
            "url_pdf": r.get("url_pdf"),
            "dedupe_key": r["dedupe_key"],
        })
    return out


def main() -> None:
    print("→ Sincronizando módulo EMA PRAC a Supabase")

    minutas = preparar_minutas(cargar("ema_prac_minutas.json"))
    recomendaciones = preparar_recomendaciones(cargar("ema_prac_recomendaciones.json"))
    senales = preparar_senales(cargar("ema_prac_senales.json"))

    n1 = upsert("ema_prac_minutas", minutas)
    n2 = upsert("ema_prac_recomendaciones", recomendaciones)
    n3 = upsert("ema_prac_senales", senales)

    print(f"\n✓ Listo — Minutas/Agendas: {n1} · Recomendaciones: {n2} · Señales molécula/reacción: {n3}")


if __name__ == "__main__":
    main()
