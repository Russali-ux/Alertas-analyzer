#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
scraper_ema_prac.py
====================
Scraper del Pharmacovigilance Risk Assessment Committee (PRAC) de la EMA.

Dos fuentes oficiales:
  1. Agendas y Minutas de las reuniones plenarias del PRAC
     https://www.ema.europa.eu/en/committees/pharmacovigilance-risk-assessment-committee-prac
  2. PRAC recommendations on safety signals
     https://www.ema.europa.eu/en/human-regulatory-overview/post-authorisation/
     pharmacovigilance-post-authorisation/signal-management/prac-recommendations-safety-signals

Por cada PDF nuevo (que no exista ya en ema_prac/pdfs/):
  - Se descarga a ema_prac/pdfs/
  - Se extrae el texto con PyMuPDF y se guarda como Markdown en ema_prac/md/
  - Se arma un registro para Supabase (dedupe_key = md5(referencia|titulo))

Salidas (consumidas luego por ema_prac_sync_supabase.py):
  ema_prac/data/ema_prac_minutas.json          (agendas + minutas)
  ema_prac/data/ema_prac_recomendaciones.json  (PRAC recommendations on signals)

NOTA sobre el HTML de EMA: las clases CSS "reference-number", "first-published"
y "last-updated" vienen concatenadas sin espacio con "fw-normal" (bug de su
plantilla Drupal), por lo que NO se puede seleccionar por esas clases. Este
scraper localiza los datos por el texto del <span class="label">/<strong
class="label"> en su lugar (ver `_valor_por_label`).

Uso local:
  pip install requests beautifulsoup4 pymupdf --break-system-packages
  python3 ema_prac/scraper_ema_prac.py
"""

from __future__ import annotations

import hashlib
import json
import re
import sys
import time
from pathlib import Path
from urllib.parse import urljoin

import fitz  # pymupdf
import requests
from bs4 import BeautifulSoup

BASE_URL = "https://www.ema.europa.eu"
PRAC_PAGE = f"{BASE_URL}/en/committees/pharmacovigilance-risk-assessment-committee-prac"
SIGNALS_PAGE = (
    f"{BASE_URL}/en/human-regulatory-overview/post-authorisation/"
    "pharmacovigilance-post-authorisation/signal-management/"
    "prac-recommendations-safety-signals"
)

ROOT = Path(__file__).resolve().parent
PDF_DIR = ROOT / "pdfs"
MD_DIR = ROOT / "md"
DATA_DIR = ROOT / "data"
for _d in (PDF_DIR, MD_DIR, DATA_DIR):
    _d.mkdir(exist_ok=True)

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
    ),
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-GB,en;q=0.9",
}

# Nº de páginas a recorrer por corrida. El PRAC se reúne 1 vez al mes y cada
# página del listado trae ~3 documentos, así que 3 páginas (~9 documentos)
# es más que suficiente para no perder nada entre corridas mensuales; al ser
# upsert idempotente por dedupe_key, repasar páginas ya vistas no duplica nada.
MAX_PAGINAS_AGENDA = 3
MAX_PAGINAS_MINUTA = 3
REQUEST_DELAY = 2  # segundos entre requests, cortesía con el servidor de EMA

session = requests.Session()
session.headers.update(HEADERS)


# ─────────────────────────────────────────────────────────────────
# Utilidades
# ─────────────────────────────────────────────────────────────────
def md5(*partes: str) -> str:
    return hashlib.md5("|".join(p or "" for p in partes).encode("utf-8")).hexdigest()


def slug(texto: str) -> str:
    texto = re.sub(r"[^\w\s-]", "", texto.lower())
    return re.sub(r"[\s_-]+", "-", texto).strip("-")[:120]


def get_soup(url: str, params: dict | None = None) -> BeautifulSoup:
    r = session.get(url, params=params, timeout=30)
    r.raise_for_status()
    return BeautifulSoup(r.text, "html.parser")


def _valor_por_label(bloque, contenedor_selector: str, texto_label: str) -> str | None:
    """Busca dentro de `contenedor_selector` el <small> cuyo .label/.strong.label
    contenga `texto_label`, y devuelve el texto de su .value (o None)."""
    for small in bloque.select(f"{contenedor_selector} small"):
        label = small.select_one(".label")
        if label and texto_label.lower() in label.get_text(strip=True).lower():
            valor = small.select_one(".value")
            return valor.get_text(strip=True) if valor else None
    return None


def _fecha_por_label(bloque, contenedor_selector: str, texto_label: str) -> str | None:
    for small in bloque.select(f"{contenedor_selector} small"):
        label = small.select_one(".label")
        if label and texto_label.lower() in label.get_text(strip=True).lower():
            t = small.select_one("time")
            if t and t.has_attr("datetime"):
                return t["datetime"][:10]
    return None


def parsear_items(soup: BeautifulSoup, doc_type: str) -> list[dict]:
    """Extrae los <div data-ema-document-type="doc_type"> de una página ya cargada."""
    items = []
    for bloque in soup.select(f'div[data-ema-document-type="{doc_type}"]'):
        titulo_tag = bloque.select_one(".file-title")
        if not titulo_tag:
            continue
        titulo = titulo_tag.get_text(strip=True)

        referencia = _valor_por_label(bloque, ".file-metadata", "Reference Number")
        fecha_publicacion = _fecha_por_label(bloque, ".dates-metadata", "First published")

        link_tag = None
        for a in bloque.select('a[href$=".pdf"]'):
            if a["href"].startswith("/en/"):  # solo versión en inglés
                link_tag = a
                break
        if not link_tag:
            continue

        items.append({
            "titulo": titulo,
            "referencia": referencia,
            "fecha_publicacion": fecha_publicacion,
            "url_pdf": urljoin(BASE_URL, link_tag["href"]),
        })
    return items


def extraer_fecha_reunion(titulo: str, prefijo: str, sufijo: str = "") -> str | None:
    """'Agenda of the PRAC meeting 31 August - 3 September 2026' + prefijo
    'Agenda of the PRAC meeting ' -> '31 August - 3 September 2026'."""
    texto = titulo
    if texto.lower().startswith(prefijo.lower()):
        texto = texto[len(prefijo):]
    if sufijo and texto.lower().endswith(sufijo.lower()):
        texto = texto[: -len(sufijo)]
    texto = texto.strip()
    return texto or None


# ─────────────────────────────────────────────────────────────────
# Descarga de PDF + conversión a Markdown
# ─────────────────────────────────────────────────────────────────
def normalizar_texto(texto: str) -> str:
    texto = texto.replace("\x00", " ")
    texto = re.sub(r"[ \t]+", " ", texto)
    texto = re.sub(r"\n{3,}", "\n\n", texto)
    return texto.strip()


def extraer_texto_pdf(path: Path) -> str:
    with fitz.open(path) as doc:
        return normalizar_texto("\n".join(p.get_text("text") for p in doc))


def descargar_y_convertir(url_pdf: str, titulo: str) -> tuple[Path, Path, bool]:
    """Descarga el PDF (si no existe ya) y genera su .md. Devuelve
    (ruta_pdf, ruta_md, es_nuevo)."""
    nombre = slug(titulo) + ".pdf"
    ruta_pdf = PDF_DIR / nombre
    ruta_md = MD_DIR / (slug(titulo) + ".md")

    if ruta_pdf.exists() and ruta_md.exists():
        return ruta_pdf, ruta_md, False  # ya procesado en una corrida anterior

    r = session.get(url_pdf, timeout=60)
    r.raise_for_status()
    ruta_pdf.write_bytes(r.content)

    try:
        texto = extraer_texto_pdf(ruta_pdf)
    except Exception as exc:  # PDF corrupto o escaneado sin texto
        texto = f"(No se pudo extraer texto del PDF: {exc})"

    ruta_md.write_text(f"# {titulo}\n\nFuente: {url_pdf}\n\n---\n\n{texto}\n", encoding="utf-8")
    return ruta_pdf, ruta_md, True


# ─────────────────────────────────────────────────────────────────
# Fuente 1: agendas + minutas
# ─────────────────────────────────────────────────────────────────
def raspar_agendas_y_minutas() -> tuple[list[dict], list[dict]]:
    agendas: list[dict] = []
    for pagina in range(MAX_PAGINAS_AGENDA):
        params = {"page": f",{pagina},0"} if pagina else None
        soup = get_soup(PRAC_PAGE, params=params)
        items = parsear_items(soup, "agenda")
        if not items:
            break
        agendas.extend(items)
        time.sleep(REQUEST_DELAY)

    minutas: list[dict] = []
    for pagina in range(MAX_PAGINAS_MINUTA):
        params = {"page": f",0,{pagina}"} if pagina else None
        soup = get_soup(PRAC_PAGE, params=params)
        items = parsear_items(soup, "minutes")
        if not items:
            break
        minutas.extend(items)
        time.sleep(REQUEST_DELAY)

    return agendas, minutas


def procesar_minutas(agendas: list[dict], minutas: list[dict]) -> list[dict]:
    registros = []
    for item in agendas:
        fecha_reunion = extraer_fecha_reunion(item["titulo"], "Agenda of the PRAC meeting ")
        _, ruta_md, _ = descargar_y_convertir(item["url_pdf"], item["titulo"])
        registros.append({
            "tipo_documento": "agenda",
            "titulo": item["titulo"],
            "fecha_reunion": fecha_reunion,
            "referencia": item["referencia"],
            "fecha_publicacion": item["fecha_publicacion"],
            "url_pdf": item["url_pdf"],
            "contenido_md": ruta_md.read_text(encoding="utf-8")[:500_000],
            "dedupe_key": md5(item["referencia"], item["titulo"]),
        })
    for item in minutas:
        fecha_reunion = extraer_fecha_reunion(item["titulo"], "Minutes of PRAC meeting on ")
        _, ruta_md, _ = descargar_y_convertir(item["url_pdf"], item["titulo"])
        registros.append({
            "tipo_documento": "minuta",
            "titulo": item["titulo"],
            "fecha_reunion": fecha_reunion,
            "referencia": item["referencia"],
            "fecha_publicacion": item["fecha_publicacion"],
            "url_pdf": item["url_pdf"],
            "contenido_md": ruta_md.read_text(encoding="utf-8")[:500_000],
            "dedupe_key": md5(item["referencia"], item["titulo"]),
        })
    return registros


# ─────────────────────────────────────────────────────────────────
# Fuente 2: PRAC recommendations on safety signals
# ─────────────────────────────────────────────────────────────────
def raspar_recomendaciones() -> list[dict]:
    """La página de recomendaciones no tiene paginación (todo el histórico
    está en una sola vista), así que se trae completa en una sola request."""
    soup = get_soup(SIGNALS_PAGE)
    items = parsear_items(soup, "prac-recommendation")
    # Solo el documento principal de recomendaciones, no el anexo
    # "New product information wording: extracts from ..."
    return [i for i in items if i["titulo"].lower().startswith("prac recommendations on signals")]


def procesar_recomendaciones(items: list[dict]) -> list[dict]:
    registros = []
    for item in items:
        fecha_reunion = extraer_fecha_reunion(
            item["titulo"], "PRAC recommendations on signals adopted at the ", " PRAC meeting"
        )
        _, ruta_md, _ = descargar_y_convertir(item["url_pdf"], item["titulo"])
        registros.append({
            "titulo": item["titulo"],
            "fecha_reunion": fecha_reunion,
            "referencia": item["referencia"],
            "fecha_publicacion": item["fecha_publicacion"],
            "url_pdf": item["url_pdf"],
            "contenido_md": ruta_md.read_text(encoding="utf-8")[:500_000],
            "dedupe_key": md5(item["referencia"], item["titulo"]),
        })
    return registros


# ─────────────────────────────────────────────────────────────────
def main() -> None:
    print("→ Raspando agendas y minutas del PRAC ...")
    agendas, minutas = raspar_agendas_y_minutas()
    print(f"  {len(agendas)} agenda(s), {len(minutas)} minuta(s) encontradas en las últimas páginas")
    registros_minutas = procesar_minutas(agendas, minutas)

    print("→ Raspando PRAC recommendations on safety signals ...")
    recomendaciones = raspar_recomendaciones()
    print(f"  {len(recomendaciones)} documento(s) de recomendaciones encontrados")
    registros_recomendaciones = procesar_recomendaciones(recomendaciones)

    (DATA_DIR / "ema_prac_minutas.json").write_text(
        json.dumps(registros_minutas, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    (DATA_DIR / "ema_prac_recomendaciones.json").write_text(
        json.dumps(registros_recomendaciones, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    print(f"✓ Listo — {len(registros_minutas)} agendas/minutas, "
          f"{len(registros_recomendaciones)} recomendaciones")


if __name__ == "__main__":
    try:
        main()
    except requests.HTTPError as exc:
        print(f"✗ Error HTTP: {exc}", file=sys.stderr)
        sys.exit(1)
