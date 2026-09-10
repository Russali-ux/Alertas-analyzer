#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
scraper_pvpi.py
===============
Descarga y parsea las Drug Safety Alerts del PvPI (Pharmacovigilance
Programme of India), publicadas por la Indian Pharmacopoeia Commission (IPC).

Son SEÑALES de seguridad (fármaco + reacción adversa) — el paralelo indio de
las señales FDA AEMS. La IPC publica un PDF consolidado:
  "List of Drugs Safety Alerts issued by PvPI from March 2016 to till date"
El nombre del PDF lleva la fecha de actualización, así que NO lo hardcodeamos:
lo descubrimos desde la página de alertas.

Página índice: https://www.ipc.gov.in/mandates/pvpi/pvpi-outcome/8-category-en/416-drug-safety-alerts.html

Salida: data/pvpi_data.json (lista de dicts para el sync a Supabase)

IMPORTANTE — verificación de primer run:
El layout de columnas del PDF puede variar entre versiones. Este parser
detecta las columnas "medicamento" y "reacción adversa" por encabezado y,
si no las encuentra, usa las dos primeras columnas de texto. Tras el primer
run revisa data/pvpi_data.json: si el mapeo de columnas salió cambiado,
ajusta COLS_MEDICAMENTO / COLS_REACCION abajo.
"""

import json
import re
import sys
import time
from pathlib import Path
from urllib.parse import urljoin

import requests
from bs4 import BeautifulSoup

try:
    import pdfplumber
except ImportError:
    print("Falta pdfplumber. Instala con: pip install pdfplumber", file=sys.stderr)
    raise

# --------------------------------------------------------------------------- #
# Configuración
# --------------------------------------------------------------------------- #
BASE = "https://www.ipc.gov.in"
PAGINA_INDICE = (
    f"{BASE}/mandates/pvpi/pvpi-outcome/8-category-en/416-drug-safety-alerts.html"
)
SALIDA = Path(__file__).resolve().parent / "data" / "pvpi_data.json"
PDF_TMP = Path(__file__).resolve().parent / "data" / "_pvpi_consolidado.pdf"

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
    ),
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9,es;q=0.8",
    "Referer": PAGINA_INDICE,
    "Connection": "keep-alive",
}
TIMEOUT = 90
REINTENTOS = 3

# Palabras clave para detectar columnas por encabezado
COLS_MEDICAMENTO = ["drug", "medicin", "name of the drug", "medicine", "suspected"]
COLS_REACCION = ["adverse", "reaction", "adr", "event", "signal", "adverse drug reaction"]


# --------------------------------------------------------------------------- #
# Descarga
# --------------------------------------------------------------------------- #
def _get(url, **kw):
    ultimo = None
    for intento in range(1, REINTENTOS + 1):
        try:
            r = requests.get(url, headers=HEADERS, timeout=TIMEOUT, **kw)
            r.raise_for_status()
            return r
        except requests.RequestException as e:
            ultimo = e
            print(f"  [intento {intento}/{REINTENTOS}] {e}", file=sys.stderr)
            time.sleep(3 * intento)
    raise RuntimeError(f"No se pudo descargar {url}: {ultimo}")


def encontrar_pdf_consolidado() -> str:
    """Devuelve la URL absoluta del PDF consolidado más reciente."""
    print(f"→ Buscando PDF consolidado en {PAGINA_INDICE}")
    html = _get(PAGINA_INDICE).text
    soup = BeautifulSoup(html, "lxml")

    candidatos = []
    for a in soup.find_all("a", href=True):
        href = a["href"]
        texto = a.get_text(" ", strip=True).lower()
        if ".pdf" not in href.lower():
            continue
        if ("list-of-drugs-safety-alerts" in href.lower()
                or ("list of drugs safety alerts" in texto)
                or ("safety alerts" in texto and "till date" in texto)):
            candidatos.append(urljoin(BASE + "/", href))

    if not candidatos:
        raise RuntimeError(
            "No se encontró el enlace al PDF consolidado. Revisa el layout de la "
            "página o el patrón 'List-of-Drugs-Safety-Alerts'."
        )
    # El más reciente suele ser el que trae la fecha más alta en el nombre.
    candidatos.sort()
    url = candidatos[-1]
    print(f"  PDF: {url}")
    return url


def descargar_pdf(url: str) -> Path:
    PDF_TMP.parent.mkdir(parents=True, exist_ok=True)
    r = _get(url, stream=True)
    with open(PDF_TMP, "wb") as f:
        for chunk in r.iter_content(chunk_size=8192):
            f.write(chunk)
    print(f"  descargado ({PDF_TMP.stat().st_size // 1024} KB)")
    return PDF_TMP


# --------------------------------------------------------------------------- #
# Parseo del PDF
# --------------------------------------------------------------------------- #
RE_ANIO = re.compile(r"\b(19|20)\d{2}\b")


def _idx_columna(encabezados, claves):
    for i, h in enumerate(encabezados):
        hl = (h or "").lower()
        if any(k in hl for k in claves):
            return i
    return None


def parsear_pdf(ruta: Path, url_pdf: str):
    registros = []
    idx_med = idx_reac = idx_anio = None

    with pdfplumber.open(ruta) as pdf:
        for pagina in pdf.pages:
            tablas = pagina.extract_tables() or []
            for tabla in tablas:
                if not tabla or len(tabla) < 2:
                    continue

                # ¿La primera fila es encabezado? Detectamos columnas una vez.
                encabezados = [(_ or "").strip() for _ in tabla[0]]
                m = _idx_columna(encabezados, COLS_MEDICAMENTO)
                r = _idx_columna(encabezados, COLS_REACCION)
                if m is not None and r is not None:
                    idx_med, idx_reac = m, r
                    idx_anio = _idx_columna(encabezados, ["year", "date"])
                    filas = tabla[1:]
                else:
                    # Sin encabezado reconocible: asumimos [S.No?, Medicamento, Reacción]
                    # Tomamos las dos últimas columnas con texto largo.
                    filas = tabla
                    if idx_med is None or idx_reac is None:
                        ncols = max(len(f) for f in tabla)
                        # heurística: si hay >=3 cols, col 1 y 2; si hay 2, col 0 y 1
                        if ncols >= 3:
                            idx_med, idx_reac = 1, 2
                        else:
                            idx_med, idx_reac = 0, 1

                for fila in filas:
                    if not fila:
                        continue
                    cel = [(c or "").strip().replace("\n", " ") for c in fila]
                    if idx_med >= len(cel) or idx_reac >= len(cel):
                        continue
                    med = cel[idx_med].strip()
                    reac = cel[idx_reac].strip()
                    # descartar filas de encabezado repetido / vacías / S.No
                    if not med or not reac:
                        continue
                    if med.lower() in ("drug", "name of the drug", "medicine", "s.no", "sr.no"):
                        continue
                    if len(med) < 2 or len(reac) < 2:
                        continue

                    anio = None
                    if idx_anio is not None and idx_anio < len(cel):
                        mm = RE_ANIO.search(cel[idx_anio])
                        anio = int(mm.group()) if mm else None
                    if anio is None:
                        mm = RE_ANIO.search(" ".join(cel))
                        anio = int(mm.group()) if mm else None

                    registros.append({
                        "medicamento": med,
                        "reaccion_adversa": reac,
                        "anio": anio,
                        "fecha_alerta": None,
                        "url_pdf": url_pdf,
                        "info": None,
                        "fuente": "PvPI",
                    })
    return registros


# --------------------------------------------------------------------------- #
# Main
# --------------------------------------------------------------------------- #
def main():
    try:
        url_pdf = encontrar_pdf_consolidado()
        ruta = descargar_pdf(url_pdf)
    except RuntimeError as e:
        print(f"  ✗ {e}", file=sys.stderr)
        sys.exit(2)

    registros = parsear_pdf(ruta, url_pdf)

    # dedup local por (medicamento, reaccion, anio)
    vistos, limpios = set(), []
    for reg in registros:
        clave = (reg["medicamento"].lower(), reg["reaccion_adversa"].lower(),
                 reg["anio"])
        if clave in vistos:
            continue
        vistos.add(clave)
        limpios.append(reg)

    SALIDA.parent.mkdir(parents=True, exist_ok=True)
    SALIDA.write_text(
        json.dumps(limpios, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    print(f"\n✓ {len(limpios)} señales PvPI → {SALIDA}")

    if not limpios:
        print("⚠ No se extrajo ninguna señal. Revisa el mapeo de columnas del PDF.",
              file=sys.stderr)
        sys.exit(2)


if __name__ == "__main__":
    main()
