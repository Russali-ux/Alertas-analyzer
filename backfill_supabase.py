"""
backfill_supabase.py
---------------------
Relleno histórico (una sola vez): lee todos los índices data/alertas_*.json
que scraper_alertas_digemid.py ya subió a GitHub, junta y deduplica las
alertas, completa "titular_registro_sanitario" para las que lo tengan vacío
(descargando el PDF ya guardado en pdfs/ y aplicando la heurística corregida
de scraper_alertas_digemid.py), y sube TODO a Supabase con subir_a_supabase().

No vuelve a scrapear digemid.minsa.gob.pe — usa lo que ya está guardado en
el propio repositorio de GitHub.

VARIABLES DE ENTORNO REQUERIDAS:
    GITHUB_TOKEN                -> token con acceso de lectura al repo (el
                                    de Actions ya sirve; para correr local
                                    necesitas uno personal con scope 'repo'
                                    si el repositorio es privado)
    GITHUB_REPO                 -> "usuario/repo", ej: Russali-ux/Alertas-analyzer
    GITHUB_BRANCH                (opcional, default: main)
    SUPABASE_URL
    SUPABASE_SERVICE_ROLE_KEY
    ANTHROPIC_API_KEY            (opcional; si está, re-analiza con Claude
                                   en vez de heurístico — más preciso)

USO:
    python backfill_supabase.py            # backfill completo
    python backfill_supabase.py --dry-run  # solo muestra qué se subiría, no llama a Supabase
"""

import os
import re
import sys
import json
import base64
import requests
import pandas as pd
import fitz  # pymupdf

# Reutiliza la heurística YA CORREGIDA y los prompts del scraper principal
# (deben vivir en el mismo directorio / mismo repo).
from scraper_alertas_digemid import (
    _extraer_titular_heuristico,
    analizar_con_claude_texto,
)
from supabase_sync import subir_a_supabase

GITHUB_TOKEN  = os.environ["GITHUB_TOKEN"]
GITHUB_REPO   = os.environ["GITHUB_REPO"]
GITHUB_BRANCH = os.environ.get("GITHUB_BRANCH", "main")
GITHUB_API    = "https://api.github.com"

HEADERS = {
    "Authorization": f"token {GITHUB_TOKEN}",
    "Accept": "application/vnd.github.v3+json",
}
HEADERS_RAW = {
    "Authorization": f"token {GITHUB_TOKEN}",
    "Accept": "application/vnd.github.v3.raw",
}


def _listar_archivos_data() -> list[str]:
    """Devuelve los nombres de archivo dentro de data/ que matchean alertas_*.json."""
    url = f"{GITHUB_API}/repos/{GITHUB_REPO}/contents/data"
    r = requests.get(url, headers=HEADERS, params={"ref": GITHUB_BRANCH}, timeout=30)
    r.raise_for_status()
    nombres = [f["name"] for f in r.json() if re.match(r"^alertas_\d{8}\.json$", f["name"])]
    return sorted(nombres)


def _descargar_json(nombre: str) -> list[dict]:
    url = f"{GITHUB_API}/repos/{GITHUB_REPO}/contents/data/{nombre}"
    r = requests.get(url, headers=HEADERS_RAW, params={"ref": GITHUB_BRANCH}, timeout=30)
    r.raise_for_status()
    return json.loads(r.content)


def _descargar_pdf_por_path(path_repo: str) -> bytes | None:
    """Descarga un PDF ya guardado en el repo (pdfs/...) vía la Contents API,
    lo que funciona igual para repos públicos o privados."""
    url = f"{GITHUB_API}/repos/{GITHUB_REPO}/contents/{path_repo}"
    r = requests.get(url, headers=HEADERS_RAW, params={"ref": GITHUB_BRANCH}, timeout=30)
    if r.status_code != 200:
        print(f"    [WARN] No se pudo descargar {path_repo} (HTTP {r.status_code})")
        return None
    return r.content


def _path_desde_raw_url(github_pdf_url: str) -> str | None:
    """Convierte una URL raw.githubusercontent.com/.../pdfs/x.pdf al path
    relativo 'pdfs/x.pdf' dentro del repo."""
    if not github_pdf_url:
        return None
    m = re.search(r"raw\.githubusercontent\.com/[^/]+/[^/]+/[^/]+/(.+)$", github_pdf_url)
    return m.group(1) if m else None


def _vacio(v) -> bool:
    if v is None:
        return True
    if isinstance(v, float) and pd.isna(v):
        return True
    if isinstance(v, str) and not v.strip():
        return True
    return False


def main(dry_run: bool = False):
    print(f"Repo: {GITHUB_REPO}  (rama: {GITHUB_BRANCH})")
    archivos = _listar_archivos_data()
    print(f"Índices encontrados en data/: {len(archivos)}")

    todas = []
    for nombre in archivos:
        try:
            registros = _descargar_json(nombre)
            todas.extend(registros)
            print(f"  {nombre}: {len(registros)} alertas")
        except Exception as e:
            print(f"  [ERROR] {nombre}: {e}")

    # Deduplicar por título (cada alerta DIGEMID tiene un título único, ej.
    # "ALERTA DIGEMID N° 81-2026")
    por_titulo = {}
    for row in todas:
        titulo = row.get("titulo")
        if titulo and titulo not in por_titulo:
            por_titulo[titulo] = row
    filas = list(por_titulo.values())
    print(f"\nTotal alertas únicas históricas: {len(filas)}")

    faltantes = [f for f in filas if _vacio(f.get("titular_registro_sanitario"))]
    print(f"Sin titular_registro_sanitario: {len(faltantes)}")

    tiene_claude = bool(os.environ.get("ANTHROPIC_API_KEY"))
    print(f"Motor de re-análisis: {'Claude API' if tiene_claude else 'Heurístico'}\n")

    completadas = 0
    for i, fila in enumerate(faltantes, 1):
        titulo = fila.get("titulo", "?")
        path_repo = _path_desde_raw_url(fila.get("github_pdf_url"))
        print(f"  [{i}/{len(faltantes)}] {titulo[:55]}...", end=" ", flush=True)

        if not path_repo:
            print("sin PDF en GitHub, se omite.")
            continue

        pdf_bytes = _descargar_pdf_por_path(path_repo)
        if not pdf_bytes:
            continue

        try:
            doc = fitz.open(stream=pdf_bytes, filetype="pdf")
            texto = "\n".join(p.get_text() for p in doc).strip()
        except Exception as e:
            print(f"error leyendo PDF: {e}")
            continue

        if len(texto) < 50:
            print("PDF escaneado, sin texto.")
            continue

        titular = None
        if tiene_claude:
            resultado = analizar_con_claude_texto(texto)
            if resultado:
                titular = resultado.get("titular_registro_sanitario") or None
        if not titular:
            titular = _extraer_titular_heuristico(texto)

        if titular:
            fila["titular_registro_sanitario"] = titular
            completadas += 1
            print(f"-> {titular}")
        else:
            print("no se encontró titular en el documento.")

    print(f"\nCompletadas: {completadas}/{len(faltantes)}")

    df = pd.DataFrame(filas)

    if dry_run:
        print("\n[DRY RUN] No se sube a Supabase. Vista previa:")
        cols = [c for c in ["titulo", "titular_registro_sanitario"] if c in df.columns]
        print(df[cols].to_string())
        return

    subir_a_supabase(df)


if __name__ == "__main__":
    main(dry_run="--dry-run" in sys.argv)
