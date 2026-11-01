"""
obsidian_export.py — Alertas-analyzer → Vault de Obsidian (Markdown)
=====================================================================
Lee las tablas públicas de Supabase con la publishable/anon key (RLS impide
físicamente leer datos privados). Opcionalmente, con SUPABASE_PAVS_KEY, lee SOLO
pavs_alertas (columnas en lista blanca) y atc_codes (diccionario EN→ES).
Genera un vault de Obsidian:

  <SALIDA>/
    00 Inicio.md                 ← portada con conteos y enlaces
    Alertas/<Fuente>/<año>/*.md  ← una nota por alerta (frontmatter + resumen)
    Moleculas/*.md               ← una nota por principio activo, enlaza alertas
    Tableros/*.md                ← vistas Dataview + "Señales cruzadas"
  (La carpeta "Equipo/" NUNCA la toca este script: es para notas del equipo.)

USO
  SUPABASE_URL=https://ggbnfdaxtsngsjssrwrl.supabase.co \
  SUPABASE_ANON_KEY=sb_publishable_... \
  SUPABASE_PAVS_KEY=<service key, opcional> \
  python obsidian_export.py --salida vault_out --desde 2020-01-01

Requiere solo `requests`. Salida determinista: si un dato no cambió, el archivo
queda idéntico (rclone --checksum no lo vuelve a subir).
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import unicodedata
from collections import defaultdict
from datetime import date, datetime, timezone
from pathlib import Path

import requests

# ─────────────────────────────────────────────────────────────────
# FUENTES PÚBLICAS — lista blanca de tablas y columnas.
# Columnas internas (notas_admin, estado_gestion, editado_por...) NO se piden.
# ─────────────────────────────────────────────────────────────────
FUENTES = {
    "digemid": {
        "tabla": "alertas_digemid", "nombre": "DIGEMID Alertas", "pais": "Perú",
        "cols": "id,titulo,producto,tipo_alerta,fecha_publicacion,anio_publicacion,accion_principal,"
                "urgencia,dirigido_a,acciones_requeridas,resumen_ia,titular_registro_sanitario,"
                "numero_lote,url_pagina_digemid,url_pdf_digemid",
        "fecha": "fecha_publicacion", "filtro_fecha": "fecha_publicacion",
    },
    "modificatorias": {
        "tabla": "modificatorias_digemid", "nombre": "DIGEMID Modificatorias", "pais": "Perú",
        "cols": "id,n_modificacion,producto,principio_activo,titular_rs,fecha_publicacion,tipo_modificacion,"
                "urgencia,accion_requerida,indicador_tiempos,base_legal,resumen,url_pagina_digemid,url_pdf_digemid",
        "fecha": "fecha_publicacion", "filtro_fecha": "fecha_publicacion",
    },
    "fda_aems": {
        "tabla": "fda_aems_senales", "nombre": "FDA AEMS", "pais": "EE. UU.",
        "cols": "id,periodo,anio,producto,principio,senal,info,url",
        "fecha": None, "filtro_anio": "anio",
    },
    "ema_prac": {
        "tabla": "ema_prac_senales", "nombre": "EMA PRAC Señales", "pais": "UE",
        "cols": "id,molecula,senal,epitt_no,seccion,fecha_reunion,fecha_publicacion,url_pdf",
        "fecha": "fecha_publicacion", "filtro_fecha": "fecha_publicacion",
    },
    "ema_arbitrajes": {
        "tabla": "ema_arbitrajes", "nombre": "EMA Arbitrajes", "pais": "UE",
        "cols": "id,nombre,principios_activos,tipo,estado,en_curso,arbitraje_seguridad,resultado_prac,"
                "fecha_inicio,fecha_publicacion,fecha_actualizacion,url",
        "fecha": "fecha_publicacion", "filtro_fecha": "fecha_publicacion",
    },
    "cima": {
        "tabla": "cima_cambios", "nombre": "CIMA AEMPS", "pais": "España",
        "cols": "id,nregistro,nombre_medicamento,laboratorio_titular,fecha_cambio,tipo_cambio,"
                "ficha_tecnica_url,prospecto_url",
        "fecha": "fecha_cambio", "filtro_fecha": "fecha_cambio",
    },
    "cdsco": {
        "tabla": "alertas_cdsco", "nombre": "India CDSCO", "pais": "India",
        "cols": "id,titulo,fecha_publicacion,anio_publicacion,categoria,tipo_producto,url_pdf,resumen_ia",
        "fecha": "fecha_publicacion", "filtro_fecha": "fecha_publicacion",
    },
    "pvpi": {
        "tabla": "pvpi_senales", "nombre": "India PvPI", "pais": "India",
        "cols": "id,medicamento,reaccion_adversa,anio,fecha_alerta,url_pdf,info",
        "fecha": "fecha_alerta", "filtro_anio": "anio",
    },
    # Restringida: requiere SUPABASE_PAVS_KEY (solo lectura de columnas en lista blanca)
    "pavs": {
        "tabla": "pavs_alertas", "nombre": "PAVS", "pais": "Varios", "privada": True,
        "cols": "id,anio,fecha_emision,pais,agencia,tipo_alerta,titulo_alerta,tipo_producto,"
                "ifa,reaccion_adversa,enlace,atc_code",
        "fecha": "fecha_emision", "filtro_fecha": "fecha_emision",
    },
    # Opcional (3.900+ noticias): activar con --incluir-noticias
    "ema_noticias": {
        "tabla": "ema_noticias", "nombre": "EMA Noticias", "pais": "UE",
        "cols": "id,titulo,medicamentos,categorias,temas,resumen,fecha_publicacion,url",
        "fecha": "fecha_publicacion", "filtro_fecha": "fecha_publicacion", "opcional": True,
    },
}

# Única lista de tablas que puede leer la key privilegiada
TABLAS_PRIVILEGIADAS = {"pavs_alertas", "atc_codes"}

AVISO = ("> [!info] Nota generada automáticamente desde Alertas-analyzer. "
         "No la edites: se sobrescribe a diario. Comenta en la carpeta **Equipo/** "
         "enlazando esta nota.")

# Sales / palabras que no forman parte del principio activo (para unificar moléculas)
SALES = {
    "sodico", "sodica", "sodium", "potasico", "potasica", "potassium", "calcico", "calcica",
    "clorhidrato", "hydrochloride", "hcl", "succinato", "succinate", "maleato", "maleate",
    "fosfato", "phosphate", "sulfato", "sulphate", "sulfate", "acetato", "acetate",
    "citrato", "citrate", "tartrato", "tartrate", "besilato", "besylate", "mesilato", "mesylate",
    "bromhidrato", "hydrobromide", "monohidrato", "monohydrate", "dihidrato", "trihidrato",
    "magnesico", "magnesium", "base", "anhidro", "anhydrous", "disodico", "dipropionato",
    "propionato", "valerato", "hemisuccinato", "bitartrato",
    # formas farmacéuticas
    "injection", "injectable", "tablet", "tablets", "capsule", "capsules", "oral", "suspension",
    "solution", "cream", "inyectable", "tableta", "tabletas", "capsulas", "solucion", "crema",
}
COMBO_SPLIT = re.compile(r"\s*(?:\+|/|;|,|\by\b|\band\b)\s*", re.I)
NO_MOLECULA = re.compile(
    r"^\d|^(mg|ml|g|mcg|ui|%)\b|lote|registro|"
    # texto de indicaciones mal capturado (p. ej. PvPI): no es un principio activo
    r"\b(treatment|treat|indicated|indication|used|patients?|management|prophylaxis|disease|"
    r"infections?|therapy|adjunct|symptomatic|chronic|acute|tratamiento|indicado|pacientes)\b", re.I)
MAX_PALABRAS = 5


# ─────────────────────────────────────────────────────────────────
# UTILIDADES
# ─────────────────────────────────────────────────────────────────
def sin_acentos(s: str) -> str:
    return "".join(c for c in unicodedata.normalize("NFKD", s) if not unicodedata.combining(c))


def limpiar(s) -> str:
    if s is None:
        return ""
    return re.sub(r"\s+", " ", str(s)).strip()


def nombre_archivo(s: str, maximo: int = 90) -> str:
    s = re.sub(r'[\\/:*?"<>|#^\[\]]', " ", limpiar(s))
    s = re.sub(r"\s+", " ", s).strip(" .")
    return s[:maximo].rstrip(" .") or "sin-titulo"


def yaml_str(v) -> str:
    """Escalar YAML seguro (siempre entre comillas dobles)."""
    return json.dumps(limpiar(v), ensure_ascii=False)


def cargar_alias(ruta: Path) -> dict:
    if ruta.exists():
        data = json.loads(ruta.read_text(encoding="utf-8"))
        return {clave_molecula(k, {}): v for k, v in data.items() if not k.startswith("_")}
    return {}


def clave_molecula(nombre: str, alias: dict) -> str:
    k = sin_acentos(limpiar(nombre).lower())
    k = re.sub(r"[^a-z0-9\- ]", " ", k)
    palabras = [p for p in k.split() if p not in SALES]
    k = " ".join(palabras).strip()
    if alias and k in alias:
        k = clave_molecula(alias[k], {})
    return k


def extraer_moleculas(texto: str, fuente: str) -> list[str]:
    """Devuelve nombres de principio activo encontrados en el texto."""
    texto = limpiar(texto)
    if not texto:
        return []
    if fuente == "digemid":
        # DIGEMID: "DEVIALIN 500 mg (Metilprednisolona succinato sódico) Polvo..."
        candidatos = re.findall(r"\(([^()]{3,120})\)", texto)
    else:
        candidatos = [texto]
    salida = []
    for c in candidatos:
        for parte in COMBO_SPLIT.split(c):
            parte = re.sub(r"\d+([.,]\d+)?\s*(mg|g|mcg|µg|ml|ui|%)\b.*$", "", parte, flags=re.I)
            parte = limpiar(parte).strip(" .-")
            if (3 <= len(parte) <= 60 and len(parte.split()) <= MAX_PALABRAS
                    and not NO_MOLECULA.search(parte)):
                salida.append(parte)
    return salida


def titulo_molecula(clave: str) -> str:
    return " ".join(w.capitalize() if len(w) > 2 else w for w in clave.split())


# ─────────────────────────────────────────────────────────────────
# SUPABASE (PostgREST, solo lectura con la publishable key)
# ─────────────────────────────────────────────────────────────────
def leer_tabla(url: str, key: str, cfg: dict, desde: date | None, privilegiada: bool = False) -> list[dict]:
    if privilegiada and cfg["tabla"] not in TABLAS_PRIVILEGIADAS:
        raise RuntimeError(f"La key privilegiada no puede leer {cfg['tabla']}")
    headers = {"apikey": key, "Accept": "application/json"}
    if not key.startswith(("sb_publishable_", "sb_secret_")):
        headers["Authorization"] = f"Bearer {key}"   # anon key JWT antigua
    params = {"select": cfg["cols"], "order": f"{cfg.get('orden', 'id')}.asc"}
    if desde:
        if cfg.get("filtro_fecha"):
            params[cfg["filtro_fecha"]] = f"gte.{desde.isoformat()}"
        elif cfg.get("filtro_anio"):
            params[cfg["filtro_anio"]] = f"gte.{desde.year}"
    filas, offset, lote = [], 0, 1000
    while True:
        p = {**params, "limit": lote, "offset": offset}
        r = requests.get(f"{url}/rest/v1/{cfg['tabla']}", headers=headers, params=p, timeout=60)
        if r.status_code >= 400:
            raise RuntimeError(f"{cfg['tabla']}: HTTP {r.status_code} {r.text[:200]}")
        datos = r.json()
        filas.extend(datos)
        if len(datos) < lote:
            return filas
        offset += lote


# ─────────────────────────────────────────────────────────────────
# NORMALIZACIÓN: cada fila → registro común
# ─────────────────────────────────────────────────────────────────
def normalizar(fuente: str, f: dict) -> dict:
    g = f.get
    cfg = FUENTES[fuente]
    r = {"fuente": fuente, "fuente_nombre": cfg["nombre"], "pais": cfg["pais"], "atc": "",
         "id": str(g("id")), "fecha": "", "anio": None, "titulo": "",
         "producto": "", "tipo": "", "urgencia": "", "accion": "", "url": "", "url_pdf": "",
         "cuerpo": [], "moleculas_txt": []}

    def campo(etiqueta, valor):
        valor = limpiar(valor)
        if valor:
            r["cuerpo"].append(f"**{etiqueta}:** {valor}")

    if fuente == "digemid":
        r.update(fecha=g("fecha_publicacion") or "", titulo=g("titulo"), producto=g("producto"),
                 tipo=g("tipo_alerta"), urgencia=g("urgencia"), accion=g("accion_principal"),
                 url=g("url_pagina_digemid"), url_pdf=g("url_pdf_digemid"))
        campo("Producto", g("producto")); campo("Titular RS", g("titular_registro_sanitario"))
        campo("Lote(s)", g("numero_lote")); campo("Dirigido a", g("dirigido_a"))
        campo("Resumen", g("resumen_ia")); campo("Acciones requeridas", g("acciones_requeridas"))
        r["moleculas_txt"] = extraer_moleculas(g("producto"), "digemid")
    elif fuente == "modificatorias":
        r.update(fecha=g("fecha_publicacion") or "", titulo=f"Modificatoria {limpiar(g('n_modificacion'))}",
                 producto=g("producto"), tipo=g("tipo_modificacion"), urgencia=g("urgencia"),
                 accion=g("accion_requerida"), url=g("url_pagina_digemid"), url_pdf=g("url_pdf_digemid"))
        campo("Producto", g("producto")); campo("Titular RS", g("titular_rs"))
        campo("Resumen", g("resumen")); campo("Indicador de tiempos", g("indicador_tiempos"))
        campo("Base legal", g("base_legal"))
        r["moleculas_txt"] = extraer_moleculas(g("principio_activo"), fuente)
    elif fuente == "fda_aems":
        r.update(anio=g("anio"), titulo=f"{limpiar(g('senal'))} — {limpiar(g('principio') or g('producto'))[:60]}",
                 producto=g("producto"), tipo=f"Señal {limpiar(g('periodo'))}", url=g("url"))
        campo("Periodo", g("periodo")); campo("Principio activo", g("principio"))
        campo("Señal", g("senal")); campo("Información / acción FDA", g("info"))
        r["moleculas_txt"] = extraer_moleculas(g("principio"), fuente)
    elif fuente == "ema_prac":
        r.update(fecha=g("fecha_publicacion") or "", titulo=f"{limpiar(g('molecula'))} — {limpiar(g('senal'))}",
                 tipo=g("seccion"), url_pdf=g("url_pdf"))
        campo("Molécula", g("molecula")); campo("Señal", g("senal")); campo("EPITT", g("epitt_no"))
        campo("Reunión PRAC", g("fecha_reunion"))
        r["moleculas_txt"] = extraer_moleculas(g("molecula"), fuente)
    elif fuente == "ema_arbitrajes":
        r.update(fecha=g("fecha_publicacion") or g("fecha_inicio") or "", titulo=g("nombre"),
                 tipo=g("tipo"), url=g("url"),
                 urgencia="PREVENTIVA" if g("arbitraje_seguridad") else "")
        campo("Principios activos", g("principios_activos")); campo("Estado", g("estado"))
        campo("Arbitraje de seguridad", "Sí" if g("arbitraje_seguridad") else "No")
        campo("Resultado PRAC", g("resultado_prac")); campo("Inicio", g("fecha_inicio"))
        campo("Última actualización", g("fecha_actualizacion"))
        r["moleculas_txt"] = extraer_moleculas(g("principios_activos"), fuente)
    elif fuente == "cima":
        r.update(fecha=g("fecha_cambio") or "", titulo=g("nombre_medicamento"), producto=g("nombre_medicamento"),
                 tipo=g("tipo_cambio"), url=g("ficha_tecnica_url"), url_pdf=g("prospecto_url"))
        campo("N.º registro", g("nregistro")); campo("Titular", g("laboratorio_titular"))
        campo("Tipo de cambio", g("tipo_cambio"))
    elif fuente == "cdsco":
        r.update(fecha=g("fecha_publicacion") or "", titulo=g("titulo"), tipo=g("categoria"),
                 url_pdf=g("url_pdf"))
        campo("Tipo de producto", g("tipo_producto")); campo("Resumen", g("resumen_ia"))
    elif fuente == "pvpi":
        r.update(fecha=g("fecha_alerta") or "", anio=g("anio"),
                 titulo=f"{limpiar(g('medicamento'))} — {limpiar(g('reaccion_adversa'))}",
                 producto=g("medicamento"), tipo="Señal RAM", url_pdf=g("url_pdf"))
        campo("Medicamento", g("medicamento")); campo("Reacción adversa", g("reaccion_adversa"))
        campo("Información", g("info"))
        med = limpiar(g("medicamento"))
        # Algunas filas PvPI traen el texto de la indicación en vez del fármaco: no se enlazan
        if med and len(med.split()) <= 6 and med != limpiar(g("reaccion_adversa")):
            r["moleculas_txt"] = extraer_moleculas(med, fuente)
        else:
            r["cuerpo"].append("> [!warning] Registro PvPI con datos incompletos en origen; revisar el PDF.")
    elif fuente == "pavs":
        agencia = limpiar(g("agencia")) or "s/a"
        r.update(fecha=g("fecha_emision") or "", anio=g("anio"), titulo=g("titulo_alerta"),
                 producto=g("ifa"), tipo=f"{limpiar(g('tipo_alerta'))} · {limpiar(g('tipo_producto'))}",
                 url=g("enlace"), atc=limpiar(g("atc_code")),
                 fuente_nombre=f"PAVS · {agencia}", pais=limpiar(g("pais")) or "Varios")
        campo("Agencia", agencia); campo("País", g("pais")); campo("Tipo de producto", g("tipo_producto"))
        campo("IFA / producto", g("ifa")); campo("Código ATC", g("atc_code"))
        campo("Descripción", g("reaccion_adversa"))
        if limpiar(g("tipo_producto")).lower().startswith("farmaco"):
            # IFA libre: "Hioscina / metamizol sodico (Buscapina 10 mg...)" o
            # "Analogos de GLP-1 (liraglutida, semaglutida)". Se extraen candidatos de
            # dentro y fuera del paréntesis y en generar() se validan contra el diccionario ATC.
            ifa = limpiar(g("ifa"))
            fuera = re.sub(r"\(.*?\)", " ", ifa)
            dentro = " , ".join(re.findall(r"\(([^()]*)\)", ifa))
            r["moleculas_txt"] = extraer_moleculas(f"{fuera} , {dentro}", fuente)
            r["solo_atc"] = True
            r["fallback_mol"] = [m for m in extraer_moleculas(fuera, fuente) if len(m.split()) <= 3][:1]
    elif fuente == "ema_noticias":
        r.update(fecha=g("fecha_publicacion") or "", titulo=g("titulo"), tipo=g("categorias"), url=g("url"))
        campo("Medicamentos", g("medicamentos")); campo("Temas", g("temas")); campo("Resumen", g("resumen"))
        r["moleculas_txt"] = extraer_moleculas(g("medicamentos"), fuente)

    r["fecha"] = str(r["fecha"])[:10] if r["fecha"] else ""
    if not r["anio"] and r["fecha"]:
        r["anio"] = int(r["fecha"][:4])
    for k in ("titulo", "producto", "tipo", "urgencia", "accion", "url", "url_pdf", "fuente_nombre", "pais"):
        r[k] = limpiar(r[k])
    return r


# ─────────────────────────────────────────────────────────────────
# ESCRITURA DEL VAULT
# ─────────────────────────────────────────────────────────────────
def escribir(ruta: Path, texto: str):
    ruta.parent.mkdir(parents=True, exist_ok=True)
    if not ruta.exists() or ruta.read_text(encoding="utf-8") != texto:
        ruta.write_text(texto, encoding="utf-8", newline="\n")


def nota_alerta(r: dict, mols: list[str]) -> str:
    nombre_fuente, pais = r["fuente_nombre"], r["pais"]
    links = ", ".join(f'"[[{m}]]"' for m in mols)
    fm = [
        "---",
        f"fuente: {yaml_str(nombre_fuente)}",
        f"pais: {yaml_str(pais)}",
        f"titulo: {yaml_str(r['titulo'])}",
        f"fecha: {r['fecha'] or 'null'}",
        f"anio: {r['anio'] or 'null'}",
        f"tipo: {yaml_str(r['tipo'])}",
        f"urgencia: {yaml_str(r['urgencia'])}",
        f"accion: {yaml_str(r['accion'])}",
        f"producto: {yaml_str(r['producto'])}",
        f"moleculas: [{links}]",
        f"atc: {yaml_str(r['atc'])}",
        f"url: {yaml_str(r['url'])}",
        f"url_pdf: {yaml_str(r['url_pdf'])}",
        f"id_origen: {yaml_str(r['id'])}",
        f"tags: [alerta, {r['fuente'].replace('_', '-')}]",
        "---",
    ]
    cuerpo = [f"# {r['titulo'] or '(sin título)'}", "", AVISO, ""]
    meta = f"**Fuente:** {nombre_fuente} ({pais})"
    if r["fecha"]:
        meta += f" · **Fecha:** {r['fecha']}"
    elif r["anio"]:
        meta += f" · **Año:** {r['anio']}"
    cuerpo.append(meta)
    if r["urgencia"] or r["accion"]:
        cuerpo.append(f"**Urgencia:** {r['urgencia'] or '—'} · **Acción:** {r['accion'] or '—'}")
    cuerpo.append("")
    cuerpo += [f"{linea}  " for linea in r["cuerpo"]]
    if mols:
        cuerpo += ["", "**Moléculas:** " + " · ".join(f"[[{m}]]" for m in mols)]
    enlaces = []
    if r["url"]:
        enlaces.append(f"[Página oficial]({r['url']})")
    if r["url_pdf"]:
        enlaces.append(f"[PDF]({r['url_pdf']})")
    if enlaces:
        cuerpo += ["", " · ".join(enlaces)]
    return "\n".join(fm + cuerpo) + "\n"


def generar(registros: list[dict], salida: Path, alias: dict, conteos: dict,
            atc: dict | None = None, atc_por_codigo: dict | None = None):
    atc = atc or {}                 # clave (EN o ES) → (clave_es, codigo ATC)
    atc_por_codigo = atc_por_codigo or {}
    mol_atc: dict[str, str] = {}
    # 1) Moléculas: clave → nombre visible. El diccionario ATC unifica EN/ES.
    nombres_mol: dict[str, str] = {}
    for r in registros:
        claves = []
        if r.get("atc") and r["atc"] in atc_por_codigo:
            claves.append(atc_por_codigo[r["atc"]])
            mol_atc.setdefault(atc_por_codigo[r["atc"]], r["atc"])
        validadas = []
        for m in r["moleculas_txt"]:
            k = clave_molecula(m, alias)
            if k in atc:
                k, codigo = atc[k]
                mol_atc.setdefault(k, codigo)
                validadas.append(k)
            elif len(k) >= 3 and not (r.get("solo_atc") and atc):
                claves.append(k)
        claves += validadas
        # PAVS: si nada coincide con ATC ni trae código, usa el nombre corto fuera del paréntesis
        if r.get("solo_atc") and atc and not claves:
            claves += [k for k in (clave_molecula(m, alias) for m in r.get("fallback_mol", [])) if len(k) >= 3]
        for k in claves:
            nombres_mol.setdefault(k, titulo_molecula(k))
        r["mol_claves"] = sorted(set(claves))

    # 2) Notas de alertas
    usados = set()
    por_mol = defaultdict(list)
    for r in sorted(registros, key=lambda x: (x["fuente"], x["fecha"] or str(x["anio"] or ""), x["id"])):
        cfg = FUENTES[r["fuente"]]
        mols = [nombres_mol[k] for k in r["mol_claves"]]
        prefijo = r["fecha"] or (str(r["anio"]) if r["anio"] else "s-f")
        base = nombre_archivo(f"{prefijo} {r['titulo']}")
        nombre = base if base.lower() not in usados else f"{base} ({r['id'][:8]})"
        usados.add(nombre.lower())
        carpeta = Path("Alertas") / cfg["nombre"] / str(r["anio"] or "sin-fecha")
        r["nota"] = nombre
        escribir(salida / carpeta / f"{nombre}.md", nota_alerta(r, mols))
        for k in r["mol_claves"]:
            por_mol[k].append(r)

    # 3) Notas de moléculas (lista estática → funciona sin plugins)
    for k, regs in por_mol.items():
        fuentes = sorted({r["fuente_nombre"] for r in regs})
        lineas = [
            "---",
            "tipo_nota: molecula",
            f"atc: {yaml_str(mol_atc.get(k, ''))}",
            f"fuentes: [{', '.join(yaml_str(f) for f in fuentes)}]",
            f"n_alertas: {len(regs)}",
            "tags: [molecula]",
            "---",
            f"# {nombres_mol[k]}", "",
            AVISO, "",
            f"**{len(regs)} registros** en {len(fuentes)} fuente(s): {', '.join(fuentes)}"
            + (f" · **ATC:** {mol_atc[k]}" if k in mol_atc else ""), "",
        ]
        for fnombre in fuentes:
            lineas.append(f"## {fnombre}")
            sel = [r for r in regs if r["fuente_nombre"] == fnombre]
            for r in sorted(sel, key=lambda x: x["fecha"] or str(x["anio"] or ""), reverse=True):
                urg = f" — **{r['urgencia']}**" if r["urgencia"] else ""
                lineas.append(f"- [[{r['nota']}]]{urg}")
            lineas.append("")
        escribir(salida / "Moleculas" / f"{nombre_archivo(nombres_mol[k])}.md", "\n".join(lineas))

    # 4) Señales cruzadas: moléculas en ≥2 fuentes en los últimos 24 meses
    hoy = date.today()
    limite = date(hoy.year - 2, hoy.month, 1).isoformat()
    cruzadas = []
    for k, regs in por_mol.items():
        recientes = [r for r in regs if (r["fecha"] or f"{r['anio'] or 0}-12-31") >= limite]
        fs = sorted({r["fuente_nombre"] for r in recientes})
        if len(fs) >= 2:
            cruzadas.append((len(fs), len(recientes), nombres_mol[k], fs))
    cruzadas.sort(key=lambda x: (-x[0], -x[1], x[2]))
    lc = ["# Señales cruzadas", "", AVISO, "",
          f"Moléculas con registros en **2 o más fuentes** desde {limite}. "
          "Útil para triangular señales entre agencias.", "",
          "| Molécula | N.º fuentes | Registros | Fuentes |", "|---|---|---|---|"]
    lc += [f"| [[{n}]] | {nf} | {nr} | {', '.join(fs)} |" for nf, nr, n, fs in cruzadas]
    escribir(salida / "Tableros" / "Señales cruzadas.md", "\n".join(lc) + "\n")

    # 5) Tableros Dataview (requieren el plugin comunitario Dataview)
    tableros = {
        "Inmediatas últimos 30 días": '''TABLE fuente, fecha, accion, producto
FROM "Alertas"
WHERE urgencia = "INMEDIATA" AND fecha >= date(today) - dur(30 days)
SORT fecha DESC''',
        "Novedades últimos 7 días": '''TABLE fuente, urgencia, tipo, producto
FROM "Alertas"
WHERE fecha >= date(today) - dur(7 days)
SORT fecha DESC''',
        "Conteo por fuente y año": '''TABLE length(rows) AS "Registros"
FROM "Alertas"
GROUP BY fuente + " · " + string(anio) AS "Fuente · Año"
SORT key DESC''',
        "Moléculas con más registros": '''TABLE n_alertas AS "Registros", fuentes
FROM "Moleculas"
SORT n_alertas DESC
LIMIT 50''',
        "Comentarios del equipo": '''TABLE file.mtime AS "Editado", file.outlinks AS "Enlaza a"
FROM "Equipo"
SORT file.mtime DESC''',
    }
    for titulo, q in tableros.items():
        escribir(salida / "Tableros" / f"{titulo}.md",
                 f"# {titulo}\n\n{AVISO}\n\nRequiere el plugin **Dataview**.\n\n```dataview\n{q}\n```\n")

    # 6) Portada
    ahora = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    filas = [f"| {FUENTES[f]['nombre']} | {FUENTES[f]['pais']} | {n} |" for f, n in conteos.items()]
    inicio = [
        "# Alertas-analyzer · Vault del equipo", "",
        AVISO, "",
        f"Actualizado: **{ahora}** · {len(registros)} alertas · {len(por_mol)} moléculas", "",
        "| Fuente | País | Registros |", "|---|---|---|", *filas, "",
        "## Tableros",
        "- [[Señales cruzadas]] (sin plugins)",
        *[f"- [[{t}]]" for t in tableros], "",
        "## Cómo trabajar en equipo",
        "- Lo generado (Alertas/, Moleculas/, Tableros/) es **solo lectura**.",
        "- Tus análisis van en **Equipo/**: crea una nota y enlaza la alerta o molécula con `[[...]]`.",
        "- Vista de grafo: filtra `path:Moleculas OR path:Equipo` para ver conexiones.", "",
    ]
    escribir(salida / "00 Inicio.md", "\n".join(inicio))
    return len(por_mol), len(cruzadas)


# ─────────────────────────────────────────────────────────────────
def main():
    ap = argparse.ArgumentParser(description="Exporta alertas públicas de Supabase a un vault Obsidian")
    ap.add_argument("--salida", default="vault_out")
    ap.add_argument("--desde", default="2020-01-01", help="Fecha mínima (YYYY-MM-DD) o 'todo'")
    ap.add_argument("--incluir-noticias", action="store_true", help="Incluye EMA Noticias (3.900+)")
    ap.add_argument("--alias", default=str(Path(__file__).with_name("alias_moleculas.json")))
    a = ap.parse_args()

    url = os.environ.get("SUPABASE_URL", "https://ggbnfdaxtsngsjssrwrl.supabase.co").rstrip("/")
    key = os.environ.get("SUPABASE_ANON_KEY", "")
    if not key:
        sys.exit("Falta SUPABASE_ANON_KEY (usa la publishable/anon key, NUNCA la service_role).")
    if "service_role" in key or key.startswith("sb_secret_"):
        sys.exit("Por seguridad este script solo acepta la publishable/anon key (solo datos públicos).")

    key_priv = os.environ.get("SUPABASE_PAVS_KEY", "")
    desde = None if a.desde == "todo" else date.fromisoformat(a.desde)
    salida = Path(a.salida)
    alias = cargar_alias(Path(a.alias))

    registros, conteos = [], {}
    for fuente, cfg in FUENTES.items():
        if cfg.get("opcional") and not a.incluir_noticias:
            continue
        if cfg.get("privada"):
            if not key_priv:
                print(f"  {cfg['nombre']:<24}  omitida (sin SUPABASE_PAVS_KEY)")
                continue
            filas = leer_tabla(url, key_priv, cfg, desde, privilegiada=True)
        else:
            filas = leer_tabla(url, key, cfg, desde)
        conteos[fuente] = len(filas)
        registros += [normalizar(fuente, f) for f in filas]
        print(f"  {cfg['nombre']:<24} {len(filas):>5} registros")

    atc, atc_por_codigo = {}, {}
    if key_priv:
        cfg_atc = {"tabla": "atc_codes", "cols": "atc_code,atc_name,atc_name_es", "orden": "atc_code"}
        for f in leer_tabla(url, key_priv, cfg_atc, None, privilegiada=True):
            codigo = limpiar(f.get("atc_code"))
            if len(codigo) != 7 or not f.get("atc_name_es"):
                continue               # solo nivel 5 (principio activo)
            k_es = clave_molecula(f["atc_name_es"], alias)
            if len(k_es) < 3:
                continue
            atc_por_codigo[codigo] = k_es
            for nombre in (f["atc_name_es"], f.get("atc_name") or ""):
                k = clave_molecula(nombre, alias)
                if len(k) >= 3:
                    atc.setdefault(k, (k_es, codigo))
        print(f"  Diccionario ATC          {len(atc_por_codigo):>5} principios activos")

    n_mol, n_cruz = generar(registros, salida, alias, conteos, atc, atc_por_codigo)
    print(f"\nVault generado en {salida}/ → {len(registros)} alertas, {n_mol} moléculas, "
          f"{n_cruz} señales cruzadas")


if __name__ == "__main__":
    main()
