#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
publicar_storage.py
===================
Publica en Supabase Storage (bucket público de solo lectura "alertas-analyzer") los DATOS y PDF que
muestran los módulos. Así las páginas no dependen de GitHub Pages ni de raw.githubusercontent.com
(el repo puede ser privado): ConkoSafe IA las sirve y su "puente" redirige estas cargas a Storage.

  pdfs/**           -> pdfs/**            (PDF de alertas DIGEMID)
  ema_prac/pdfs/**  -> ema_prac/pdfs/**
  ema_prac/md/**    -> ema_prac/md/**     ("Ver texto extraído")
  cima/data/*.json  -> cima/data/*.json   (índice, último, acumulado y los diarios de los últimos 45 días;
                                           el index.json publicado lista solo los diarios conservados)

Incremental: solo sube lo nuevo o lo que cambió de tamaño. Variables: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.
"""
from __future__ import annotations

import json
import mimetypes
import os
import re
import sys
import unicodedata
from datetime import date, timedelta
from pathlib import Path
from urllib.parse import quote

import requests

ROOT = Path(__file__).resolve().parent
BUCKET = "alertas-analyzer"
RETENCION_CIMA_DIAS = 45
CARPETAS = ["pdfs", "ema_prac/pdfs", "ema_prac/md"]
TIPOS = {".pdf": "application/pdf", ".json": "application/json", ".md": "text/markdown"}

URL = os.environ.get("SUPABASE_URL", "").rstrip("/")
KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")
H = {"apikey": KEY, "Authorization": f"Bearer {KEY}"}


def clave(ruta: str) -> str:
    """Nombre válido en Supabase Storage: sin tildes ni símbolos ("Nº" -> "No"; otros -> "_").
    El puente de ConkoSafe (scripts/sync_alertas.py) aplica EXACTAMENTE la misma regla."""
    t = unicodedata.normalize("NFKD", ruta)
    t = "".join(c for c in t if not unicodedata.combining(c))
    return re.sub(r"[^A-Za-z0-9/._-]", "_", t)


def remotos(prefijo: str) -> dict[str, int]:
    """{ruta: tamaño} de los objetos bajo `prefijo` (recorre subcarpetas)."""
    salida, pendientes = {}, [prefijo.strip("/")]
    while pendientes:
        p = pendientes.pop()
        offset = 0
        while True:
            r = requests.post(f"{URL}/storage/v1/object/list/{BUCKET}", headers=H, timeout=60,
                              json={"prefix": p, "limit": 1000, "offset": offset})
            r.raise_for_status()
            lote = r.json()
            for o in lote:
                ruta = f"{p}/{o['name']}" if p else o["name"]
                if o.get("id") is None:          # es una carpeta
                    pendientes.append(ruta)
                else:
                    salida[ruta] = int((o.get("metadata") or {}).get("size") or -1)
            if len(lote) < 1000:
                break
            offset += 1000
    return salida


def subir(ruta: str, contenido: bytes) -> None:
    tipo = TIPOS.get(Path(ruta).suffix.lower()) or mimetypes.guess_type(ruta)[0] or "application/octet-stream"
    r = requests.post(f"{URL}/storage/v1/object/{BUCKET}/{quote(ruta)}", timeout=300, data=contenido,
                      headers={**H, "Content-Type": tipo, "x-upsert": "true", "cache-control": "300"})
    if r.status_code >= 300:
        raise RuntimeError(f"{ruta}: HTTP {r.status_code} {r.text[:200]}")


def borrar(rutas: list[str]) -> None:
    for i in range(0, len(rutas), 100):
        requests.delete(f"{URL}/storage/v1/object/{BUCKET}", headers=H, timeout=60,
                        json={"prefixes": rutas[i:i + 100]}).raise_for_status()


def archivos_cima() -> dict[str, bytes]:
    """Archivos de cima/data a publicar (con retención) y el index.json ajustado."""
    carpeta = ROOT / "cima" / "data"
    if not (carpeta / "index.json").exists():
        return {}
    indice = json.loads((carpeta / "index.json").read_text(encoding="utf-8"))
    limite = (date.today() - timedelta(days=RETENCION_CIMA_DIAS)).strftime("%Y%m%d")
    fechas = [f for f in indice.get("fechas", []) if str(f.get("codigo", "")) >= limite
              and (carpeta / f.get("archivo", "")).exists()]
    indice["fechas"] = fechas
    salida = {"cima/data/index.json": json.dumps(indice, ensure_ascii=False, indent=2).encode("utf-8")}
    for nombre in {f["archivo"] for f in fechas} | {"cima_latest.json", "cima_acumulado.json", indice.get("latest") or ""}:
        if nombre and (carpeta / nombre).exists():
            salida[clave(f"cima/data/{nombre}")] = (carpeta / nombre).read_bytes()
    return salida


def main() -> None:
    if not URL or not KEY:
        sys.exit("Faltan SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY")
    subidos = iguales = 0
    for carpeta in CARPETAS:
        base = ROOT / carpeta
        if not base.exists():
            continue
        ya = remotos(carpeta)
        for f in sorted(p for p in base.rglob("*") if p.is_file()):
            ruta = clave(f.relative_to(ROOT).as_posix())
            if ya.get(ruta) == f.stat().st_size:
                iguales += 1
                continue
            subir(ruta, f.read_bytes())
            subidos += 1
        print(f"  {carpeta}: listo")
    # CIMA: retención y limpieza
    cima = archivos_cima()
    if cima:
        ya = remotos("cima/data")
        for ruta, contenido in cima.items():
            if ruta.endswith("index.json") or ya.get(ruta) != len(contenido):
                subir(ruta, contenido)
                subidos += 1
            else:
                iguales += 1
        viejos = [r for r in ya if r not in cima]
        if viejos:
            borrar(viejos)
            print(f"  cima/data: {len(viejos)} archivo(s) fuera de la retención eliminados de Storage")
    print(f"✔ Storage '{BUCKET}': {subidos} subido(s) · {iguales} sin cambios")


if __name__ == "__main__":
    main()
