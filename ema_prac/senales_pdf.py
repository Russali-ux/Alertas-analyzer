#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
senales_pdf.py
==============
Extrae las señales de un PDF "PRAC recommendations on signals adopted at the ... PRAC meeting" (EMA).
Se usa como RESPALDO de la lista de HALMED: HALMED publica la lista acumulada con días o semanas de
retraso, así que las reuniones recientes quedaban "Sin señales asociadas" aunque el PDF de EMA sí las trae.

Estructura del PDF:
  1. Recommendations for update of the product information  -> encabezados "1.n. INN – Señal"
     (Acción para el titular = "Sí": deben presentar una variación)
  2. Recommendations for submission of supplementary information -> tabla INN | Signal (EPITT) | ... | Action for MAH
  3. Other recommendations                                     -> misma tabla
     (Acción para el titular = "No")

La tabla se reconstruye con las coordenadas de las palabras (pdfplumber): las celdas de varias líneas
se agrupan por columna y cada fila termina en la línea del número EPITT "(12345)".

Uso:  python3 ema_prac/senales_pdf.py <archivo.pdf | URL>
"""
from __future__ import annotations

import io
import re
import sys

import pdfplumber

RE_EPITT = re.compile(r"\((\d{4,6})\)\s*$")
RE_SECCION = re.compile(r"^\s*([123])\.\s+(Recommendations for update|Recommendations for submission|Other recommendations)", re.I)
RE_SUB1 = re.compile(r"^\s*1\.(\d+)\.\s+(.+)$")
GUION = re.compile(r"\s+[–—-]\s+")


def _limpiar(t: str) -> str:
    t = re.sub(r"\s+", " ", t or "").strip()
    t = re.sub(r"(?<=[A-Za-z\)])\d{1,2}$", "", t)  # nota al pie pegada: "Progestogens4"
    return t.strip(" ;,")


def _seccion_1(texto: str) -> list[dict]:
    """Encabezados 1.n. INN – Señal (pueden ocupar dos líneas) + EPITT de su ficha."""
    salida, lineas = [], texto.splitlines()
    for i, linea in enumerate(lineas):
        m = RE_SUB1.match(linea)
        if not m:
            continue
        titulo = m.group(2).strip()
        j = i + 1
        while j < len(lineas) and not re.match(r"^\s*(Authorisation procedure|EPITT)", lineas[j]) and j - i < 4:
            titulo += " " + lineas[j].strip()
            j += 1
        titulo = re.sub(r"\s+", " ", titulo).strip()
        partes = GUION.split(titulo, maxsplit=1)
        if len(partes) != 2:
            continue
        bloque = "\n".join(lineas[i:i + 25])
        e = re.search(r"EPITT No\s*\n?\s*(\d{4,6})", bloque)
        salida.append({"seccion": 1, "inn": _limpiar(partes[0]), "senal": _limpiar(partes[1]),
                       "epitt": e.group(1) if e else None,
                       "accion_titular": "Sí", "accion_raw": "Update of the product information"})
    return salida


def _palabras_columna(pagina, top_min):
    ws = pagina.extract_words(keep_blank_chars=False, use_text_flow=False)
    # texto repetido de cada página ("PRAC recommendations on signals / EMA/PRAC/… / Page n/m"),
    # arriba o abajo según la plantilla del documento
    techo, piso = top_min, pagina.height - 40
    for w in ws:
        if w["text"] == "Page":
            if w["top"] < pagina.height / 2:
                techo = max(techo, w["bottom"] + 4)
            else:
                piso = min(piso, w["top"] - 12)   # el bloque del pie empieza ~1 línea encima de "Page"
    return [w for w in ws if w["top"] > techo and w["bottom"] < piso]


def _tablas(pdf) -> list[dict]:
    """Filas de las tablas de las secciones 2 y 3."""
    filas, seccion, columnas = [], None, None
    for pagina in pdf.pages:
        texto = pagina.extract_text() or ""
        palabras = pagina.extract_words()
        # sección vigente (por posición vertical de los títulos de sección en la página)
        titulos = []
        for w in palabras:
            pass
        for linea in pagina.extract_text_lines() if hasattr(pagina, "extract_text_lines") else []:
            m = RE_SECCION.match(linea["text"])
            if m:
                titulos.append((linea["top"], int(m.group(1))))
        # encabezado de tabla: palabra "INN" y "Signal" en la misma línea
        encabezados = []
        for w in palabras:
            if w["text"] == "INN":
                misma = [x for x in palabras if abs(x["top"] - w["top"]) < 3]
                textos = [x["text"] for x in misma]
                if "Signal" in textos:
                    def x0(nombre, despues=0):
                        c = [x["x0"] for x in misma if x["text"] == nombre and x["x0"] > despues]
                        return min(c) if c else None
                    sig = x0("Signal")
                    rap = x0("PRAC", sig)
                    acc = x0("Action", sig)
                    mahs = [x["x0"] for x in misma if x["text"] == "MAH"]
                    mah = max(mahs) if len(mahs) > 1 else None  # el último "MAH" es la columna; el otro es "Action for MAH"
                    encabezados.append((w["top"], [w["x0"], sig, rap or acc, acc, mah or pagina.width]))
        # tramos de la página: desde cada encabezado (o desde arriba si la tabla continúa)
        inicios = [(t, cols) for t, cols in encabezados]
        if not inicios and columnas and seccion in (2, 3):
            inicios = [(70, columnas)]  # continuación de la tabla en la página siguiente
        for k, (top, cols) in enumerate(inicios):
            columnas = cols
            fin = inicios[k + 1][0] if k + 1 < len(inicios) else pagina.height
            previos = [s for t, s in titulos if t < top]
            if previos:
                seccion = previos[-1]
            if seccion not in (2, 3):
                continue
            ws = [w for w in _palabras_columna(pagina, top + 12) if w["top"] < fin]
            # cortar si aparece un título de sección dentro del tramo
            corte = min([t for t, s in titulos if t > top] or [fin])
            ws = [w for w in ws if w["top"] < corte - 2]

            def col(w):
                for c in range(len(columnas) - 1, -1, -1):
                    if columnas[c] is not None and w["x0"] >= columnas[c] - 3:
                        return c
                return 0
            por_col = {c: [] for c in range(5)}
            for w in ws:
                por_col[col(w)].append(w)
            # líneas de la columna Señal
            lineas, actual = [], None
            for w in sorted(por_col[1], key=lambda w: (round(w["top"]), w["x0"])):
                if actual and abs(w["top"] - actual["top"]) < 3:
                    actual["texto"] += " " + w["text"]
                    actual["bottom"] = max(actual["bottom"], w["bottom"])
                else:
                    actual = {"top": w["top"], "bottom": w["bottom"], "texto": w["text"]}
                    lineas.append(actual)
            # filas: cada señal termina en la línea con "(EPITT)"
            filas_pag, acum = [], []
            for ln in lineas:
                acum.append(ln)
                m = RE_EPITT.search(ln["texto"])
                if m:
                    filas_pag.append({"top": acum[0]["top"], "texto": " ".join(x["texto"] for x in acum), "epitt": m.group(1)})
                    acum = []
            for i, f in enumerate(filas_pag):
                desde = f["top"] - 3
                hasta = filas_pag[i + 1]["top"] - 3 if i + 1 < len(filas_pag) else corte
                # la última fila de la página no debe absorber notas al pie ni el encabezado repetido
                hasta = min(hasta, f["top"] + 110)
                notas = [w["top"] for w in por_col[0] if w["top"] > f["top"] + 5 and re.match(r"^\d{1,2}$", w["text"])]
                if notas:
                    hasta = min(hasta, min(notas) - 2)

                def texto_col(c):
                    sel = sorted([w for w in por_col[c] if desde <= w["top"] < hasta], key=lambda w: (round(w["top"]), w["x0"]))
                    return _limpiar(" ".join(w["text"] for w in sel))
                senal = _limpiar(RE_EPITT.sub("", f["texto"]))
                inn = texto_col(0)
                if not inn or not senal:
                    continue
                filas.append({"seccion": seccion, "inn": inn, "senal": senal, "epitt": f["epitt"],
                              "accion_titular": "No", "accion_raw": texto_col(3) or None})
    return filas


def extraer_senales(pdf_bytes: bytes) -> list[dict]:
    """Señales del PDF, una por EPITT (si aparece en la sección 1 y en otra, gana la 1 = "Sí", como HALMED)."""
    with pdfplumber.open(io.BytesIO(pdf_bytes)) as pdf:
        texto = "\n".join((p.extract_text() or "") for p in pdf.pages)
        todas = _seccion_1(texto) + _tablas(pdf)
    vistas, salida = set(), []
    for s in sorted(todas, key=lambda x: x["seccion"]):
        clave = s["epitt"] or (s["inn"].lower(), s["senal"].lower())
        if clave in vistas:
            continue
        vistas.add(clave)
        salida.append(s)
    return salida


if __name__ == "__main__":
    import requests
    origen = sys.argv[1]
    datos = (requests.get(origen, timeout=60, headers={"User-Agent": "Mozilla/5.0"}).content
             if origen.startswith("http") else open(origen, "rb").read())
    for s in extraer_senales(datos):
        print(f"[{s['seccion']}] {s['accion_titular']:2} {s['inn'][:45]:45} | {s['senal'][:45]:45} | EPITT {s['epitt']} | {(s['accion_raw'] or '')[:40]}")
