#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
india_sync_supabase.py
======================
Sube (upsert) los JSON de CDSCO y PvPI a Supabase vía PostgREST.

- Lee data/cdsco_data.json  → tabla public.alertas_cdsco
- Lee data/pvpi_data.json   → tabla public.pvpi_senales

Usa la SERVICE_ROLE key (bypassa RLS) y hace upsert idempotente con
on_conflict=dedupe_key + Prefer: resolution=merge-duplicates, así que se
puede correr cuantas veces quieras sin duplicar (mismo patrón que el sync FDA).

El dedupe_key se calcula AQUÍ (md5), igual que la definición de las tablas:
  alertas_cdsco : md5( titulo | fecha_publicacion )
  pvpi_senales  : md5( lower(medicamento) | lower(reaccion) | anio )

Variables de entorno requeridas (GitHub Secrets):
  SUPABASE_URL                 ej. https://ggbnfdaxtsngsjssrwrl.supabase.co
  SUPABASE_SERVICE_ROLE_KEY    service_role key (secreta, NUNCA en el cliente)
"""

import hashlib
import json
import os
import sys
from pathlib import Path

import requests

RAIZ = Path(__file__).resolve().parent
LOTE = 300  # 150–450 filas funciona bien en este proyecto

SUPABASE_URL = os.environ.get("SUPABASE_URL", "").rstrip("/")
SERVICE_KEY = (
    os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
    or os.environ.get("SUPABASE_SERVICE_KEY")   # nombre alterno por compatibilidad
)

if not SUPABASE_URL or not SERVICE_KEY:
    print("✗ Falta SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY en el entorno.",
          file=sys.stderr)
    sys.exit(1)


def md5(*partes) -> str:
    return hashlib.md5("|".join(partes).encode("utf-8")).hexdigest()


def cargar(nombre):
    ruta = RAIZ / "data" / nombre
    if not ruta.exists():
        print(f"  (sin {nombre}, se omite)")
        return []
    return json.loads(ruta.read_text(encoding="utf-8"))


def upsert(tabla, filas):
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
            print(f"  ✗ {tabla} lote {i // LOTE + 1}: {r.status_code} {r.text[:300]}",
                  file=sys.stderr)
            r.raise_for_status()
        total += len(chunk)
        print(f"  {tabla}: {total}/{len(filas)} upsert")
    return total


def preparar_cdsco(regs):
    out = []
    for r in regs:
        titulo = (r.get("titulo") or "").strip()
        if not titulo:
            continue
        fecha = r.get("fecha_publicacion")
        out.append({
            "titulo": titulo,
            "fecha_publicacion": fecha,
            "categoria": r.get("categoria"),
            "tipo_producto": r.get("tipo_producto"),
            "tamano_pdf": r.get("tamano_pdf"),
            "url_pdf": r.get("url_pdf"),
            "fuente": r.get("fuente", "CDSCO"),
            "dedupe_key": md5(titulo, fecha or ""),
        })
    return out


def preparar_pvpi(regs):
    out = []
    for r in regs:
        med = (r.get("medicamento") or "").strip()
        reac = (r.get("reaccion_adversa") or "").strip()
        if not med or not reac:
            continue
        anio = r.get("anio")
        out.append({
            "medicamento": med,
            "reaccion_adversa": reac,
            "anio": anio,
            "fecha_alerta": r.get("fecha_alerta"),
            "url_pdf": r.get("url_pdf"),
            "info": r.get("info"),
            "fuente": r.get("fuente", "PvPI"),
            "dedupe_key": md5(med.lower(), reac.lower(), str(anio) if anio else ""),
        })
    return out


def main():
    print("→ Sincronizando alertas de India a Supabase")

    cdsco = preparar_cdsco(cargar("cdsco_data.json"))
    pvpi = preparar_pvpi(cargar("pvpi_data.json"))

    n1 = upsert("alertas_cdsco", cdsco)
    n2 = upsert("pvpi_senales", pvpi)

    print(f"\n✓ Listo — CDSCO: {n1} · PvPI: {n2}")


if __name__ == "__main__":
    main()
