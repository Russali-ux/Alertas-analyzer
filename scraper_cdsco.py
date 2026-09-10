#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
scraper_cdsco.py
================
Raspa la sección de Alertas de CDSCO (Central Drugs Standard Control
Organization, India) y genera data/cdsco_data.json.

CDSCO es el regulador de medicamentos de India (paralelo a DIGEMID).
La página de Alertas publica productos de calidad no estándar (NSQ),
espurios, adulterados, mal etiquetados, retiros y avisos públicos.

Fuente: https://cdsco.gov.in/opencms/opencms/en/Notifications/Alerts/
Estructura: tabla HTML sencilla (S.no | Título | Fecha | Descargar PDF | Tamaño).
Los PDF cuelgan de:
  https://cdsco.gov.in/opencms/opencms/system/modules/CDSCO.WEB/elements/download_file_division.jsp?num_id=<base64>

Salida: data/cdsco_data.json  (lista de dicts, listos para el sync a Supabase)

NOTA IP: como pasó con DIGEMID (Cloudflare) y FDA (Akamai), es posible que
el portal bloquee IPs de datacenter/nube. Este scraper manda headers de
navegador completos para reducir ese riesgo. Si aun así CDSCO bloquea el
runner de GitHub Actions, córrelo localmente (mismo comando) y sube solo
el JSON para que Actions haga únicamente el sync — igual que el pipeline FDA.
"""

import json
import os
import re
import sys
import time
from datetime import datetime
from pathlib import Path

import requests
from bs4 import BeautifulSoup
from dateutil import parser as dateparser

# --------------------------------------------------------------------------- #
# Configuración
# --------------------------------------------------------------------------- #
BASE = "https://cdsco.gov.in"
# Páginas que queremos raspar (todas comparten la misma estructura de tabla).
PAGINAS = {
    "Alertas": f"{BASE}/opencms/opencms/en/Notifications/Alerts/",
    "NSQ": f"{BASE}/opencms/opencms/en/Notifications/nsq-drugs/",
}

SALIDA = Path(__file__).resolve().parent / "data" / "cdsco_data.json"

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
    ),
    "Accept": (
        "text/html,application/xhtml+xml,application/xml;q=0.9,"
        "image/avif,image/webp,*/*;q=0.8"
    ),
    "Accept-Language": "en-US,en;q=0.9,es;q=0.8",
    "Accept-Encoding": "gzip, deflate, br",
    "Referer": f"{BASE}/opencms/opencms/en/Home/",
    "Connection": "keep-alive",
    "Upgrade-Insecure-Requests": "1",
}

TIMEOUT = 60
REINTENTOS = 3

# --------------------------------------------------------------------------- #
# Heurísticas de clasificación
# --------------------------------------------------------------------------- #
def clasificar_categoria(titulo: str) -> str:
    t = titulo.lower()
    if any(k in t for k in ["not of standard quality", "nsq", "sub standard",
                             "substandard", "declared as nsq"]):
        return "NSQ"
    if any(k in t for k in ["spurious", "adulterated", "misbranded", "counterfeit",
                            "falsified", "fake"]):
        return "Espurio-Adulterado"
    if any(k in t for k in ["recall", "withdraw", "withdrawal"]):
        return "Retiro"
    if any(k in t for k in ["adverse", "pharmacovigilance", "adr", "safety alert",
                            "drug safety"]):
        return "RAM"
    if any(k in t for k in ["public notice", "circular", "notification", "guidance",
                            "advisory"]):
        return "Aviso"
    return "Otro"


def clasificar_producto(titulo: str) -> str:
    t = titulo.lower()
    if any(k in t for k in ["medical device", "device", "implant", "catheter",
                            "syringe", "ivd", "in vitro"]):
        return "Dispositivo médico"
    if "vaccine" in t or "vaccin" in t:
        return "Vacuna"
    if "cosmetic" in t:
        return "Cosmético"
    return "Medicamento"


# --------------------------------------------------------------------------- #
# Utilidades
# --------------------------------------------------------------------------- #
def parse_fecha(texto: str):
    """Devuelve 'YYYY-MM-DD' o None. Tolera '2025-Oct-08', '08.10.2025', etc."""
    if not texto:
        return None
    texto = texto.strip()
    # CDSCO suele usar 'YYYY-Mon-DD' (ej. 2025-Oct-08)
    formatos = ["%Y-%b-%d", "%Y-%m-%d", "%d.%m.%Y", "%d-%m-%Y", "%d/%m/%Y",
                "%d-%b-%Y", "%b %d, %Y"]
    for fmt in formatos:
        try:
            return datetime.strptime(texto, fmt).strftime("%Y-%m-%d")
        except ValueError:
            continue
    # último recurso: dateutil (dayfirst para formatos indios)
    try:
        return dateparser.parse(texto, dayfirst=True).strftime("%Y-%m-%d")
    except (ValueError, OverflowError, TypeError):
        return None


def descargar(url: str) -> str:
    ultimo_error = None
    for intento in range(1, REINTENTOS + 1):
        try:
            r = requests.get(url, headers=HEADERS, timeout=TIMEOUT)
            r.raise_for_status()
            return r.text
        except requests.RequestException as e:
            ultimo_error = e
            print(f"  [intento {intento}/{REINTENTOS}] error: {e}", file=sys.stderr)
            time.sleep(3 * intento)
    raise RuntimeError(f"No se pudo descargar {url}: {ultimo_error}")


# --------------------------------------------------------------------------- #
# Parseo de una tabla CDSCO
# --------------------------------------------------------------------------- #
RE_TAM = re.compile(r"\d[\d.,]*\s*(kb|mb|bytes?)", re.I)


def extraer_filas(html: str, seccion: str):
    """
    Estrategia robusta: por cada enlace de descarga (download_file_division.jsp)
    subimos a su <tr> y leemos las celdas. Así no dependemos del orden exacto
    de columnas si CDSCO cambia el layout.
    """
    soup = BeautifulSoup(html, "lxml")
    filas = []
    anchors = soup.select('a[href*="download_file_division"]')

    if not anchors:
        # Fallback: recorrer filas de todas las tablas que tengan una fecha
        for tr in soup.select("table tr"):
            celdas = [c.get_text(" ", strip=True) for c in tr.find_all("td")]
            if len(celdas) < 2:
                continue
            reg = _fila_desde_celdas(celdas, None, seccion)
            if reg:
                filas.append(reg)
        return filas

    for a in anchors:
        tr = a.find_parent("tr")
        if tr is None:
            continue
        celdas = [c.get_text(" ", strip=True) for c in tr.find_all("td")]
        href = a.get("href", "")
        url_pdf = href if href.startswith("http") else BASE + href
        reg = _fila_desde_celdas(celdas, url_pdf, seccion)
        if reg:
            filas.append(reg)
    return filas


def _fila_desde_celdas(celdas, url_pdf, seccion):
    """A partir de las celdas de texto de un <tr>, arma el registro."""
    # Identificamos fecha, tamaño y título por su forma (no por su índice).
    fecha_txt = None
    tam_txt = None
    candidatos_titulo = []

    for c in celdas:
        cs = c.strip()
        if not cs:
            continue
        if RE_TAM.fullmatch(cs) or RE_TAM.search(cs) and len(cs) <= 15:
            tam_txt = cs
            continue
        f = parse_fecha(cs)
        if f and len(cs) <= 20:      # una celda corta que parsea como fecha
            fecha_txt = f
            continue
        if cs.isdigit() and len(cs) <= 4:   # el S.no
            continue
        if cs.lower() in ("download", "pdf", "download pdf", "view"):
            continue
        candidatos_titulo.append(cs)

    titulo = max(candidatos_titulo, key=len) if candidatos_titulo else None
    if not titulo:
        return None

    return {
        "titulo": titulo,
        "fecha_publicacion": fecha_txt,
        "categoria": clasificar_categoria(titulo),
        "tipo_producto": clasificar_producto(titulo),
        "tamano_pdf": tam_txt,
        "url_pdf": url_pdf,
        "fuente": "CDSCO",
        "seccion_origen": seccion,
    }


# --------------------------------------------------------------------------- #
# Main
# --------------------------------------------------------------------------- #
def main():
    todas = []
    vistos = set()   # dedup local por (titulo, fecha)

    for seccion, url in PAGINAS.items():
        print(f"→ Raspando {seccion}: {url}")
        try:
            html = descargar(url)
        except RuntimeError as e:
            print(f"  ✗ {e}", file=sys.stderr)
            continue
        filas = extraer_filas(html, seccion)
        print(f"  {len(filas)} filas extraídas")
        for reg in filas:
            clave = (reg["titulo"].strip().lower(), reg["fecha_publicacion"] or "")
            if clave in vistos:
                continue
            vistos.add(clave)
            todas.append(reg)

    SALIDA.parent.mkdir(parents=True, exist_ok=True)
    SALIDA.write_text(
        json.dumps(todas, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    print(f"\n✓ {len(todas)} alertas CDSCO → {SALIDA}")

    if not todas:
        # Salir con código != 0 ayuda a que el workflow marque el run como fallido
        # (probable bloqueo por IP). No sobrescribimos con lista vacía útil.
        print("⚠ No se extrajo ninguna alerta. ¿Bloqueo por IP o cambio de layout?",
              file=sys.stderr)
        sys.exit(2)


if __name__ == "__main__":
    main()
