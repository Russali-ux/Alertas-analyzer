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

Tercera fuente (independiente de los PDF):
  3. Noticias EMA — "News JSON data file" publicado en
     https://www.ema.europa.eu/en/about-us/about-website/download-website-data-json-data-format
     Se localiza el enlace en esa página (fallback a la URL conocida), se
     descarga el JSON completo (~3900 noticias) y se normaliza para Supabase
     (dedupe_key = md5(news_url)). Conserva la fecha "primera_deteccion" de
     cada noticia a partir del JSON previo commiteado, para saber cuáles son
     nuevas en cada corrida.

Cuarta fuente (independiente de los PDF):
  4. Arbitrajes EMA (referrals) — "Referrals JSON data file" de la misma página.
     ~600 procedimientos (Art. 31, 20, 107i, 29(4)...) con estado, principios
     activos y fechas de cada hito (inicio, recomendación PRAC, posición CMDh,
     opinión CHMP/CVMP, decisión de la Comisión). dedupe_key = md5(referral_url).
     Conserva "primera_deteccion" y registra el último cambio de estado.

Salidas (consumidas luego por ema_prac_sync_supabase.py):
  ema_prac/data/ema_prac_minutas.json          (agendas + minutas)
  ema_prac/data/ema_prac_recomendaciones.json  (PRAC recommendations on signals)
  ema_prac/data/ema_noticias.json              (News JSON data file de EMA)
  ema_prac/data/ema_arbitrajes.json            (Referrals JSON data file de EMA)

NOTA sobre el HTML de EMA: las clases CSS "reference-number", "first-published"
y "last-updated" vienen concatenadas sin espacio con "fw-normal" (bug de su
plantilla Drupal), por lo que NO se puede seleccionar por esas clases. Este
scraper localiza los datos por el texto del <span class="label">/<strong
class="label"> en su lugar (ver `_valor_por_label`).

Uso local:
  pip install requests beautifulsoup4 pymupdf --break-system-packages
  python3 ema_prac/scraper_ema_prac.py                     # todo (PRAC + noticias)
  python3 ema_prac/scraper_ema_prac.py --fuente prac       # solo agendas/minutas/recomendaciones
  python3 ema_prac/scraper_ema_prac.py --fuente noticias   # solo News JSON (workflow cada 5 días)
  python3 ema_prac/scraper_ema_prac.py --fuente arbitrajes # solo Referrals JSON (workflow diario)
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
import time
from datetime import datetime, timezone
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
# Noticias EMA: página "Download website data in JSON data format" y URL
# conocida del archivo (fallback si cambia el maquetado de la página).
JSON_DATA_PAGE = f"{BASE_URL}/en/about-us/about-website/download-website-data-json-data-format"
NEWS_JSON_FALLBACK = f"{BASE_URL}/en/documents/report/news-json-report_en.json"
REFERRALS_JSON_FALLBACK = f"{BASE_URL}/en/documents/report/referrals-output-json-report_en.json"

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

# Nº de páginas a recorrer por corrida. IMPORTANTE: el listado de agendas y
# minutas usa un pager de Drupal Views basado en AJAX; pedir la página N por
# querystring (?page=,N,0) solo funciona de forma fiable para N=0 (a veces
# N=1, mostrando comportamiento inconsistente en pruebas), y para N>=2 el
# sitio ignora el parámetro y devuelve otra vez la página 0 — sin ejecutar
# JavaScript no hay forma confiable de pedir páginas más profundas. Como el
# PRAC se reúne 1 vez al mes, la página 0 (los 3 documentos más recientes de
# cada listado) es suficiente para un monitor que corre semanalmente: cada
# agenda/minuta nueva pasa por la página 0 antes de quedar desplazada.
MAX_PAGINAS_AGENDA = 1
MAX_PAGINAS_MINUTA = 1
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


def extraer_senales(ruta_pdf: Path) -> list[dict]:
    """Extrae pares (molécula, señal) de un PDF de 'PRAC recommendations on
    signals'. Combina dos estrategias:

    1. Sección 1 ('Recommendations for update of the product information'):
       cada ítem tiene un encabezado con el formato
       'N.N.  <molécula(s)> – <señal>' seguido de 'Authorisation procedure'.
    2. Secciones 2 y 3 (tablas 'INN | Signal (EPITT No) | ...'): se usa la
       detección de tablas nativa de PyMuPDF (find_tables) y se separa el
       número EPITT del nombre de la señal con una regex.

    Best-effort: el formato de estos PDF ha cambiado ligeramente con los años
    (documentos anteriores a ~2023 pueden dar resultados más ruidosos); un
    fallo aislado en una tabla no debe interrumpir el resto de la extracción.
    """
    senales: list[dict] = []
    try:
        doc = fitz.open(ruta_pdf)
    except Exception:
        return senales

    texto = "\n".join(p.get_text("text") for p in doc)
    patron_seccion1 = re.compile(
        r"\d+\.\d+\.\s+(.+?)\s+[\u2013\u2014]\s+(.+?)\n\s*Authorisation procedure",
        re.DOTALL,
    )
    for m in patron_seccion1.finditer(texto):
        molecula = re.sub(r"\s+", " ", m.group(1)).strip()
        senal = re.sub(r"\s+", " ", m.group(2)).strip()
        senales.append({"molecula": molecula, "senal": senal, "epitt": None, "seccion": "actualizacion_producto"})

    for pagina in doc:
        try:
            tablas = pagina.find_tables()
        except Exception:
            continue
        for t in tablas.tables:
            try:
                filas = t.extract()
            except Exception:
                continue
            if not filas or not filas[0]:
                continue
            cabecera = [(c or "").lower() for c in filas[0]]
            if not any("inn" in c for c in cabecera):
                continue  # no es la tabla de señales
            for fila in filas[1:]:
                inn = (fila[0] or "").replace("\n", " ").strip()
                sig = (fila[1] or "").replace("\n", " ").strip()
                if not inn or not sig:
                    continue
                m = re.match(r"^(.*?)\s*\((\d{4,7})\)", sig)
                if m:
                    senales.append({"molecula": inn, "senal": m.group(1).strip(), "epitt": m.group(2), "seccion": "tabla"})
                else:
                    senales.append({"molecula": inn, "senal": sig, "epitt": None, "seccion": "tabla"})

    doc.close()

    # dedupe por (molécula, señal) — la sección 3 suele repetir ítems ya
    # listados en la sección 1
    vistos: set[tuple[str, str]] = set()
    unicos = []
    for s in senales:
        k = (s["molecula"].lower(), s["senal"].lower())
        if k in vistos:
            continue
        vistos.add(k)
        unicos.append(s)

    # Filtro de calidad: en documentos sin la etiqueta 'Authorisation
    # procedure' (frecuente antes de ~2022), el regex de la sección 1 puede
    # capturar un bloque de texto largo en vez de un nombre de molécula/señal
    # real; y algunas filas de tabla mal detectadas repiten el mismo texto en
    # molécula y señal. Se descartan aquí antes de devolver el resultado.
    limpio = [
        s for s in unicos
        if len(s["molecula"]) <= 150
        and len(s["senal"]) <= 250
        and s["molecula"].strip().lower() != s["senal"].strip().lower()
    ]
    return limpio


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


def procesar_recomendaciones(items: list[dict]) -> tuple[list[dict], list[dict]]:
    """Devuelve (registros_documentos, registros_senales)."""
    registros = []
    registros_senales = []
    for item in items:
        fecha_reunion = extraer_fecha_reunion(
            item["titulo"], "PRAC recommendations on signals adopted at the ", " PRAC meeting"
        )
        ruta_pdf, ruta_md, _ = descargar_y_convertir(item["url_pdf"], item["titulo"])
        dedupe_doc = md5(item["referencia"], item["titulo"])
        registros.append({
            "titulo": item["titulo"],
            "fecha_reunion": fecha_reunion,
            "referencia": item["referencia"],
            "fecha_publicacion": item["fecha_publicacion"],
            "url_pdf": item["url_pdf"],
            "contenido_md": ruta_md.read_text(encoding="utf-8")[:500_000],
            "dedupe_key": dedupe_doc,
        })

        for s in extraer_senales(ruta_pdf):
            registros_senales.append({
                "molecula": s["molecula"],
                "senal": s["senal"],
                "epitt_no": s["epitt"],
                "seccion": s["seccion"],
                "fecha_reunion": fecha_reunion,
                "referencia": item["referencia"],
                "fecha_publicacion": item["fecha_publicacion"],
                "url_pdf": item["url_pdf"],
                "dedupe_key": md5(item["referencia"], s["molecula"], s["senal"], s["epitt"] or ""),
            })
    return registros, registros_senales


# ─────────────────────────────────────────────────────────────────
# Noticias EMA (News JSON data file)
# ─────────────────────────────────────────────────────────────────
def localizar_news_json() -> str:
    """Busca en la página de descargas JSON el enlace del 'News JSON data file'.
    Si no lo encuentra (o la página falla), usa la URL conocida."""
    try:
        soup = get_soup(JSON_DATA_PAGE)
        for a in soup.select("a[href]"):
            href = a["href"]
            texto = a.get_text(" ", strip=True).lower()
            if "news-json" in href.lower() or ("news" in texto and "json" in texto):
                url = urljoin(BASE_URL, href)
                if url.lower().endswith(".json"):
                    return url
        print("  ⚠️  No se encontró el enlace 'News JSON' en la página; uso la URL conocida")
    except requests.RequestException as exc:
        print(f"  ⚠️  No se pudo leer {JSON_DATA_PAGE} ({exc}); uso la URL conocida")
    return NEWS_JSON_FALLBACK


def _fecha_iso(ddmmaaaa: str | None) -> str | None:
    """'18/09/2026' -> '2026-09-18' (None si viene vacío o con otro formato)."""
    m = re.fullmatch(r"(\d{1,2})/(\d{1,2})/(\d{4})", (ddmmaaaa or "").strip())
    return f"{m[3]}-{int(m[2]):02d}-{int(m[1]):02d}" if m else None


def _lista(texto: str | None) -> str:
    """Normaliza listas separadas por ';': quita vacíos, espacios y repetidos
    (el JSON de EMA trae casos como 'Human;Human'), respetando el orden."""
    return ";".join(dict.fromkeys(x.strip() for x in (texto or "").split(";") if x.strip()))


def raspar_noticias() -> list[dict]:
    url = localizar_news_json()
    print(f"  Descargando {url}")
    r = session.get(url, timeout=120, headers={"Accept": "application/json"})
    r.raise_for_status()
    payload = r.json()
    datos = payload.get("data", payload) if isinstance(payload, dict) else payload
    meta = payload.get("meta", {}) if isinstance(payload, dict) else {}
    if not isinstance(datos, list) or not datos:
        raise ValueError("El News JSON de EMA no trae una lista de noticias en 'data'")
    print(f"  {len(datos)} noticias en el archivo (meta: {meta})")

    # Fecha de primera detección: se conserva la del JSON previo (commiteado)
    ruta = DATA_DIR / "ema_noticias.json"
    previas: dict[str, str] = {}
    if ruta.exists():
        try:
            previas = {n["dedupe_key"]: n.get("primera_deteccion")
                       for n in json.loads(ruta.read_text(encoding="utf-8"))}
        except (ValueError, KeyError):
            previas = {}
    hoy = datetime.now(timezone.utc).date().isoformat()

    registros: list[dict] = []
    vistos: set[str] = set()
    for n in datos:
        url_noticia = (n.get("news_url") or "").strip()
        titulo = (n.get("title") or "").strip()
        if not url_noticia or not titulo:
            continue
        key = md5(url_noticia)
        if key in vistos:
            continue
        vistos.add(key)
        registros.append({
            "titulo": titulo,
            "nota_prensa": (n.get("press_release") or "").strip().lower() == "yes",
            "medicamentos": _lista(n.get("related_medicine_referral")) or None,
            "categorias": _lista(n.get("categories")) or None,
            "temas": _lista(n.get("topics")) or None,
            "resumen": (n.get("news_summary") or "").strip() or None,
            "fecha_publicacion": _fecha_iso(n.get("first_published_date")),
            "fecha_actualizacion": _fecha_iso(n.get("last_updated_date")),
            "url": url_noticia,
            "primera_deteccion": previas.get(key) or hoy,
            "fuente_timestamp": meta.get("timestamp"),
            "dedupe_key": key,
        })

    registros.sort(key=lambda x: x["fecha_publicacion"] or "", reverse=True)
    nuevas = [x for x in registros if x["dedupe_key"] not in previas]
    if previas:
        print(f"  {len(nuevas)} noticia(s) nueva(s) respecto a la corrida anterior")
        for x in nuevas[:20]:
            print(f"    + {x['fecha_publicacion']}  {x['titulo'][:110]}")
    else:
        print("  Primera carga: todas las noticias se marcan con la fecha de hoy")
    return registros


# ─────────────────────────────────────────────────────────────────
# Arbitrajes EMA (Referrals JSON data file)
# ─────────────────────────────────────────────────────────────────
# Estados en los que el procedimiento ya terminó (el resto se considera "en curso")
ESTADOS_FINALES = {"european commission final decision", "cmdh final position"}


def _en_curso(estado: str | None, a: dict) -> bool:
    """Sin estado final y con actividad en los últimos 3 años (el JSON trae algunos registros
    antiguos que quedaron en un estado intermedio, p. ej. una opinión CHMP de 2010)."""
    if (estado or "").lower() in ESTADOS_FINALES:
        return False
    fechas = [_fecha_iso(a.get(k)) for k in ("procedure_start_date", "prac_recommendation_date",
              "cmdh_position_date", "chmp_cvmp_opinion_date", "first_published_date", "last_updated_date")]
    ultima = max((f for f in fechas if f), default=None)
    limite = (datetime.now(timezone.utc).date().replace(day=1).isoformat())
    limite = f"{int(limite[:4]) - 3}{limite[4:]}"
    return bool(ultima and ultima >= limite)


def localizar_referrals_json() -> str:
    """Enlace del 'Referrals JSON data file' en la página de descargas JSON (fallback: URL conocida)."""
    try:
        soup = get_soup(JSON_DATA_PAGE)
        for a in soup.find_all("a", href=True):
            href = a["href"]
            if "referrals" in href.lower() and href.lower().endswith(".json"):
                return urljoin(BASE_URL, href)
        print("  ⚠️  No se encontró el enlace 'Referrals JSON' en la página; uso la URL conocida")
    except requests.RequestException as exc:
        print(f"  ⚠️  No se pudo leer {JSON_DATA_PAGE} ({exc}); uso la URL conocida")
    return REFERRALS_JSON_FALLBACK


def raspar_arbitrajes() -> list[dict]:
    url = localizar_referrals_json()
    print(f"  Descargando {url}")
    r = session.get(url, timeout=120, headers={"Accept": "application/json"})
    r.raise_for_status()
    payload = r.json()
    datos = payload.get("data", payload) if isinstance(payload, dict) else payload
    meta = payload.get("meta", {}) if isinstance(payload, dict) else {}
    if not isinstance(datos, list) or not datos:
        raise ValueError("El Referrals JSON de EMA no trae una lista de arbitrajes en 'data'")
    print(f"  {len(datos)} arbitrajes en el archivo (meta: {meta})")

    # Estado previo (JSON commiteado): primera detección y seguimiento de cambios de estado
    ruta = DATA_DIR / "ema_arbitrajes.json"
    previos: dict[str, dict] = {}
    if ruta.exists():
        try:
            previos = {a["dedupe_key"]: a for a in json.loads(ruta.read_text(encoding="utf-8"))}
        except (ValueError, KeyError):
            previos = {}
    hoy = datetime.now(timezone.utc).date().isoformat()
    txt = lambda v: (v or "").strip() or None

    registros: list[dict] = []
    vistos: set[str] = set()
    for a in datos:
        url_ref = (a.get("referral_url") or "").strip()
        nombre = (a.get("referral_name") or "").strip()
        if not url_ref or not nombre:
            continue
        key = md5(url_ref)
        if key in vistos:
            continue
        vistos.add(key)
        estado = txt(a.get("current_status"))
        prev = previos.get(key, {})
        estado_prev = prev.get("estado")
        cambio = bool(prev) and estado_prev != estado
        registros.append({
            "nombre": nombre,
            "principios_activos": _lista(a.get("international_non_proprietary_name_inn_common_name")) or None,
            "categoria": txt(a.get("category")),
            "tipo": txt(a.get("referral_type")),
            "estado": estado,
            "en_curso": _en_curso(estado, a),
            "arbitraje_seguridad": (a.get("safety_referral") or "").strip().lower() == "yes",
            "nombres_centralizados": _lista(a.get("associated_names_centrally_authorised_medicines")) or None,
            "nombres_nacionales": _lista(a.get("associated_names_non_centrally_authorised_medicines")) or None,
            "clase": txt(a.get("class")),
            "referencia": txt(a.get("reference_number")),
            "modelo_decision": txt(a.get("prac_decision_making_model")) or txt(a.get("non_prac_decision_making_model")),
            "evaluado_por_prac": bool(txt(a.get("prac_decision_making_model"))),
            "modelo_autorizacion": txt(a.get("authorisation_model")),
            "resultado_prac": txt(a.get("prac_recommendation")),
            "fecha_inicio": _fecha_iso(a.get("procedure_start_date")),
            "fecha_recomendacion_prac": _fecha_iso(a.get("prac_recommendation_date")),
            "fecha_posicion_cmdh": _fecha_iso(a.get("cmdh_position_date")),
            "fecha_opinion_comite": _fecha_iso(a.get("chmp_cvmp_opinion_date")),
            "fecha_decision_ce": _fecha_iso(a.get("european_commission_decision_date")),
            "fecha_publicacion": _fecha_iso(a.get("first_published_date")),
            "fecha_actualizacion": _fecha_iso(a.get("last_updated_date")),
            "url": url_ref,
            "primera_deteccion": prev.get("primera_deteccion") or hoy,
            "estado_anterior": estado_prev if cambio else prev.get("estado_anterior"),
            "fecha_cambio_estado": hoy if cambio else prev.get("fecha_cambio_estado"),
            "fuente_timestamp": meta.get("timestamp"),
            "dedupe_key": key,
        })

    registros.sort(key=lambda x: (x["fecha_inicio"] or x["fecha_publicacion"] or ""), reverse=True)
    if previos:
        nuevos = [x for x in registros if x["dedupe_key"] not in previos]
        cambios = [x for x in registros if x["fecha_cambio_estado"] == hoy and x["dedupe_key"] in previos]
        print(f"  {len(nuevos)} arbitraje(s) nuevo(s) y {len(cambios)} cambio(s) de estado")
        for x in nuevos[:20]:
            print(f"    + {x['fecha_inicio']}  {x['nombre'][:100]}  [{x['estado']}]")
        for x in cambios[:20]:
            print(f"    ~ {x['nombre'][:80]}: {x['estado_anterior']} → {x['estado']}")
    else:
        print("  Primera carga: todos los arbitrajes se marcan con la fecha de hoy")
    print(f"  En curso: {sum(1 for x in registros if x['en_curso'])}")
    return registros


# ─────────────────────────────────────────────────────────────────
def ejecutar_prac() -> None:
    print("→ Raspando agendas y minutas del PRAC ...")
    agendas, minutas = raspar_agendas_y_minutas()
    print(f"  {len(agendas)} agenda(s), {len(minutas)} minuta(s) encontradas en las últimas páginas")
    registros_minutas = procesar_minutas(agendas, minutas)

    print("→ Raspando PRAC recommendations on safety signals ...")
    recomendaciones = raspar_recomendaciones()
    print(f"  {len(recomendaciones)} documento(s) de recomendaciones encontrados")
    registros_recomendaciones, registros_senales = procesar_recomendaciones(recomendaciones)

    (DATA_DIR / "ema_prac_minutas.json").write_text(
        json.dumps(registros_minutas, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    (DATA_DIR / "ema_prac_recomendaciones.json").write_text(
        json.dumps(registros_recomendaciones, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    (DATA_DIR / "ema_prac_senales.json").write_text(
        json.dumps(registros_senales, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    print(f"✓ Listo — {len(registros_minutas)} agendas/minutas, "
          f"{len(registros_recomendaciones)} recomendaciones, "
          f"{len(registros_senales)} señales (molécula/reacción) detectadas")


def ejecutar_noticias() -> None:
    print("→ Descargando Noticias EMA (News JSON data file) ...")
    registros = raspar_noticias()
    (DATA_DIR / "ema_noticias.json").write_text(
        json.dumps(registros, ensure_ascii=False, indent=1), encoding="utf-8"
    )
    print(f"✓ Noticias EMA — {len(registros)} registros guardados en data/ema_noticias.json")


def ejecutar_arbitrajes() -> None:
    print("→ Descargando Arbitrajes EMA (Referrals JSON data file) ...")
    registros = raspar_arbitrajes()
    (DATA_DIR / "ema_arbitrajes.json").write_text(
        json.dumps(registros, ensure_ascii=False, indent=1), encoding="utf-8"
    )
    print(f"✓ Arbitrajes EMA — {len(registros)} registros guardados en data/ema_arbitrajes.json")


def main() -> None:
    ap = argparse.ArgumentParser(description="Scraper EMA: PRAC + Noticias + Arbitrajes")
    ap.add_argument("--fuente", choices=("todo", "prac", "noticias", "arbitrajes"), default="todo",
                    help="qué fuente raspar (por defecto: todo)")
    fuente = ap.parse_args().fuente
    if fuente in ("todo", "prac"):
        ejecutar_prac()
    if fuente in ("todo", "noticias"):
        ejecutar_noticias()
    if fuente in ("todo", "arbitrajes"):
        ejecutar_arbitrajes()


if __name__ == "__main__":
    try:
        main()
    except (requests.RequestException, ValueError) as exc:
        print(f"✗ Error: {exc}", file=sys.stderr)
        sys.exit(1)
