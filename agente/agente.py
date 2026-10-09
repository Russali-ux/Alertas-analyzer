#!/usr/bin/env python3
"""
Agente ConkoSafe IA — vigilancia multifuente con bitácora en vivo
==================================================================

Toma una instrucción de `public.agente_tareas` (la que envías desde
agente/index.html), la resuelve consultando las fuentes ya cargadas en
Supabase por los scrapers de este repo, y escribe CADA paso que da en
`public.agente_eventos`. El tablero isométrico lee esos eventos en vivo.

Es independiente de los scrapers: no los modifica; como mucho los dispara
(workflow_dispatch) cuando la instrucción pide datos frescos.

Uso
---
  python agente/agente.py --tarea <uuid>      # una tarea concreta
  python agente/agente.py --pendientes        # todas las pendientes (cron)
  python agente/agente.py --tarea <uuid> --simular   # sin Claude (motor heurístico)

Variables de entorno
--------------------
  SUPABASE_URL                 https://ggbnfdaxtsngsjssrwrl.supabase.co
  SUPABASE_SERVICE_ROLE_KEY    service_role (solo en GitHub Secrets)
  ANTHROPIC_API_KEY            si falta, se usa el motor heurístico
  AGENTE_MODELO                opcional, por defecto claude-haiku-5-5
  GITHUB_TOKEN, GITHUB_REPOSITORY   para disparar scrapers (los pone Actions)
  GITHUB_RUN_URL               opcional, enlace a la corrida actual
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import re
import sys
import time
import unicodedata
from urllib.parse import quote

import requests

# ---------------------------------------------------------------------------
# Configuración
# ---------------------------------------------------------------------------
SUPABASE_URL = (os.environ.get("SUPABASE_URL") or "https://ggbnfdaxtsngsjssrwrl.supabase.co").rstrip("/")
SERVICE_KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")
MODELO = os.environ.get("AGENTE_MODELO") or "claude-haiku-5-5"
MAX_PASOS = int(os.environ.get("AGENTE_MAX_PASOS") or "14")
HOY = dt.date.today()

# Cada fuente = una baldosa del tablero. `texto` son las columnas donde se busca
# el término; `fecha` ordena y filtra; `mostrar` es lo que se devuelve al modelo.
FUENTES: dict[str, dict] = {
    "digemid": {
        "nombre": "Alertas DIGEMID", "tabla": "alertas_digemid", "fecha": "fecha_publicacion",
        "texto": ["titulo", "producto", "titular_registro_sanitario", "resumen_ia"],
        "mostrar": ["fecha_publicacion", "titulo", "producto", "tipo_alerta", "urgencia",
                    "accion_principal", "titular_registro_sanitario", "url_pdf_digemid"],
        "workflow": "digemid_monitor.yml",
    },
    "modificatorias": {
        "nombre": "Modificatorias RS", "tabla": "modificatorias_digemid", "fecha": "fecha_publicacion",
        "texto": ["producto", "principio_activo", "titular_rs", "resumen"],
        "mostrar": ["fecha_publicacion", "n_modificacion", "producto", "principio_activo",
                    "titular_rs", "tipo_modificacion", "urgencia", "url_pdf_digemid"],
        "workflow": None,  # vive en el repo Modificatorias_digemid
    },
    "cima": {
        "nombre": "CIMA · AEMPS", "tabla": "cima_cambios", "fecha": "fecha_cambio",
        "texto": ["nombre_medicamento", "laboratorio_titular"],
        "mostrar": ["fecha_cambio", "nombre_medicamento", "laboratorio_titular", "tipo_cambio",
                    "ficha_tecnica_url", "prospecto_url"],
        "workflow": "cima_monitor.yml",
    },
    "pavs": {
        "nombre": "PAVS", "tabla": "pavs_alertas", "fecha": "fecha_emision",
        "texto": ["titulo_alerta", "ifa", "reaccion_adversa", "agencia"],
        "mostrar": ["fecha_emision", "pais", "agencia", "tipo_alerta", "titulo_alerta", "ifa",
                    "reaccion_adversa", "enlace"],
        "workflow": None,  # tarea local / repo PAVS_Digemid
    },
    "fda_aems": {
        "nombre": "FDA AEMS", "tabla": "fda_aems_senales", "fecha": "creado_en",
        "texto": ["producto", "principio", "senal"],
        "mostrar": ["periodo", "anio", "producto", "principio", "senal", "info", "url"],
        "ultima": "periodo",  # creado_en es la fecha de carga; el periodo FDA es más útil
        "workflow": "fda_aems_monthly.yml",
    },
    "ema": {
        "nombre": "EMA PRAC", "tabla": "ema_prac_senales", "fecha": "fecha_publicacion",
        "texto": ["molecula", "senal"],
        "mostrar": ["fecha_publicacion", "molecula", "senal", "seccion", "epitt_no", "url_pdf"],
        "workflow": "ema_prac_monitor.yml",
        # tablas hermanas que también se revisan en la misma baldosa
        "extra": [
            {"tabla": "ema_arbitrajes", "fecha": "fecha_publicacion",
             "texto": ["nombre", "principios_activos"],
             "mostrar": ["fecha_publicacion", "nombre", "principios_activos", "tipo", "estado", "url"]},
        ],
    },
    "india": {
        "nombre": "India · CDSCO/PvPI", "tabla": "alertas_cdsco", "fecha": "fecha_publicacion",
        "texto": ["titulo", "resumen_ia"],
        "mostrar": ["fecha_publicacion", "titulo", "categoria", "tipo_producto", "url_pdf"],
        "workflow": "Alertas India (CDSCO + PvPI).yml",
        "extra": [
            {"tabla": "pvpi_senales", "fecha": "fecha_alerta",
             "texto": ["medicamento", "reaccion_adversa"],
             "mostrar": ["fecha_alerta", "medicamento", "reaccion_adversa", "url_pdf"]},
        ],
    },
}
ESTACIONES = ["agente", *FUENTES.keys(), "portafolio", "informe"]


# ---------------------------------------------------------------------------
# Supabase (PostgREST con service_role)
# ---------------------------------------------------------------------------
def _h(extra: dict | None = None) -> dict:
    h = {"apikey": SERVICE_KEY, "Authorization": f"Bearer {SERVICE_KEY}",
         "Content-Type": "application/json"}
    if extra:
        h.update(extra)
    return h


def sb_get(tabla: str, params: str, contar: bool = False) -> tuple[list, int | None]:
    url = f"{SUPABASE_URL}/rest/v1/{tabla}?{params}"
    r = requests.get(url, headers=_h({"Prefer": "count=exact"} if contar else None), timeout=30)
    r.raise_for_status()
    total = None
    if contar and "content-range" in r.headers:
        tot = r.headers["content-range"].split("/")[-1]
        total = int(tot) if tot.isdigit() else None
    return r.json(), total


def sb_patch(tabla: str, filtro: str, datos: dict) -> list:
    r = requests.patch(f"{SUPABASE_URL}/rest/v1/{tabla}?{filtro}", headers=_h({"Prefer": "return=representation"}),
                       data=json.dumps(datos, default=str), timeout=30)
    r.raise_for_status()
    return r.json()


def sb_insert(tabla: str, datos: dict) -> None:
    r = requests.post(f"{SUPABASE_URL}/rest/v1/{tabla}", headers=_h({"Prefer": "return=minimal"}),
                      data=json.dumps(datos, default=str), timeout=30)
    r.raise_for_status()


# ---------------------------------------------------------------------------
# Bitácora: cada llamada = una fila que el tablero dibuja
# ---------------------------------------------------------------------------
class Bitacora:
    def __init__(self, tarea_id: str):
        self.tarea_id = tarea_id

    def __call__(self, estacion: str, tipo: str, mensaje: str, **metricas) -> None:
        estacion = estacion if estacion in ESTACIONES else "agente"
        print(f"  [{estacion:>14}] {tipo:<11} {mensaje}", flush=True)
        try:
            sb_insert("agente_eventos", {"tarea_id": self.tarea_id, "estacion": estacion, "tipo": tipo,
                                         "mensaje": mensaje[:1500], "metricas": metricas})
        except requests.RequestException as e:  # la bitácora nunca debe tumbar al agente
            print(f"  ! no se pudo registrar el evento: {e}", file=sys.stderr)


# ---------------------------------------------------------------------------
# Herramientas del agente
# ---------------------------------------------------------------------------
def _ilike(term: str) -> str:
    # PostgREST: * es comodín en ilike; quitamos caracteres que rompen el filtro or=()
    t = re.sub(r"[(),*%]", " ", term).strip()
    return quote(f"*{t}*", safe="*")


def _filtro_texto(cols: list[str], termino: str) -> str:
    partes = [f"{c}.ilike.{_ilike(termino)}" for c in cols]
    return f"or=({','.join(partes)})"


def _consultar_tabla(cfg: dict, termino: str | None, desde: str | None, limite: int) -> tuple[list, int]:
    q = [f"select={','.join(cfg['mostrar'])}", f"order={cfg['fecha']}.desc.nullslast", f"limit={limite}"]
    if termino:
        q.append(_filtro_texto(cfg["texto"], termino))
    if desde:
        q.append(f"{cfg['fecha']}=gte.{desde}")
    filas, total = sb_get(cfg["tabla"], "&".join(q), contar=True)
    return filas, total if total is not None else len(filas)


def buscar_en_fuente(fuente: str, termino: str | None = None, desde: str | None = None,
                     limite: int = 8, *, log: Bitacora) -> dict:
    if fuente not in FUENTES:
        return {"error": f"Fuente desconocida. Usa una de: {', '.join(FUENTES)}"}
    cfg = FUENTES[fuente]
    limite = max(1, min(int(limite or 8), 25))
    desc = f"«{termino}»" if termino else "todo"
    log(fuente, "inicio", f"Buscando {desc} en {cfg['nombre']}" + (f" desde {desde}" if desde else ""))
    try:
        filas, total = _consultar_tabla(cfg, termino, desde, limite)
        resultado = {"fuente": cfg["nombre"], "tabla": cfg["tabla"], "total": total, "muestra": filas}
        for extra in cfg.get("extra", []):
            f2, t2 = _consultar_tabla(extra, termino, desde, limite)
            resultado.setdefault("relacionadas", []).append(
                {"tabla": extra["tabla"], "total": t2, "muestra": f2})
            total += t2
        col_u = cfg.get("ultima", cfg["fecha"])
        ultima = next((f.get(col_u) for f in filas if f.get(col_u)), None)
        log(fuente, "ok" if total else "aviso",
            f"{total} registro(s) en {cfg['nombre']}" if total else f"Sin coincidencias en {cfg['nombre']}",
            encontrados=total, ultima=str(ultima)[:24] if ultima else None, termino=termino)
        return resultado
    except requests.RequestException as e:
        log(fuente, "error", f"Error consultando {cfg['nombre']}: {e}")
        return {"error": str(e)}


def estado_fuentes(*, log: Bitacora) -> dict:
    """Total de registros y fecha del último por fuente (salud del sistema)."""
    log("agente", "inicio", "Revisando el estado de todas las fuentes")
    out = {}
    for k, cfg in FUENTES.items():
        try:
            filas, total = sb_get(cfg["tabla"], f"select={cfg['fecha']}&order={cfg['fecha']}.desc.nullslast&limit=1",
                                  contar=True)
            ultima = filas[0][cfg["fecha"]] if filas else None
            out[k] = {"nombre": cfg["nombre"], "total": total, "ultima": ultima}
            dias = (HOY - dt.date.fromisoformat(str(ultima)[:10])).days if ultima else None
            tipo = "aviso" if dias is not None and dias > 45 else "ok"
            log(k, tipo, f"{cfg['nombre']}: {total} registros, último {str(ultima)[:10] if ultima else '—'}",
                total=total, ultima=str(ultima)[:10] if ultima else None, dias_sin_datos=dias)
        except requests.RequestException as e:
            out[k] = {"error": str(e)}
            log(k, "error", f"No se pudo leer {cfg['nombre']}: {e}")
    return out


def cruzar_portafolio(termino: str, *, log: Bitacora) -> dict:
    """Busca el término en el portafolio registrado (tabla medicamentos)."""
    log("portafolio", "inicio", f"Cruzando «{termino}» con el portafolio registrado")
    try:
        cols = ["descripcion_producto", "principio_activo", "fabricante", "nro_registro_sanitario"]
        q = ("select=descripcion_producto,principio_activo,fabricante,nro_registro_sanitario,"
             "vcto_registro_sanitario,pais&limit=25&" + _filtro_texto(cols, termino))
        filas, total = sb_get("medicamentos", q, contar=True)
        vencen = [f for f in filas if f.get("vcto_registro_sanitario")
                  and dt.date.fromisoformat(f["vcto_registro_sanitario"]) <= HOY + dt.timedelta(days=180)]
        log("portafolio", "ok" if total else "aviso",
            f"{total} producto(s) del portafolio coinciden" if total else "Ningún producto del portafolio coincide",
            encontrados=total, rs_por_vencer=len(vencen))
        return {"total": total, "productos": filas, "rs_vencen_180_dias": len(vencen)}
    except requests.RequestException as e:
        log("portafolio", "error", f"Error en portafolio: {e}")
        return {"error": str(e)}


def actualizar_fuente(fuente: str, *, log: Bitacora) -> dict:
    """Dispara el scraper de la fuente (workflow_dispatch). No espera a que termine."""
    cfg = FUENTES.get(fuente)
    if not cfg:
        return {"error": "Fuente desconocida"}
    wf = cfg.get("workflow")
    if not wf:
        log(fuente, "aviso", f"{cfg['nombre']} no se actualiza desde este repo; uso los datos cargados")
        return {"disparado": False, "motivo": "La fuente se carga desde otro repo o de forma local"}
    token, repo = os.environ.get("GITHUB_TOKEN"), os.environ.get("GITHUB_REPOSITORY")
    if not (token and repo):
        log(fuente, "aviso", "Sin GITHUB_TOKEN: no puedo disparar el scraper")
        return {"disparado": False, "motivo": "Sin credenciales de GitHub"}
    log(fuente, "inicio", f"Disparando el scraper de {cfg['nombre']} ({wf})")
    r = requests.post(f"https://api.github.com/repos/{repo}/actions/workflows/{quote(wf)}/dispatches",
                      headers={"Authorization": f"Bearer {token}", "Accept": "application/vnd.github+json"},
                      json={"ref": os.environ.get("GITHUB_REF_NAME", "main")}, timeout=30)
    if r.status_code == 204:
        log(fuente, "ok", f"Scraper de {cfg['nombre']} en cola; los datos nuevos llegan en unos minutos")
        return {"disparado": True, "workflow": wf}
    log(fuente, "error", f"GitHub rechazó el disparo ({r.status_code})")
    return {"disparado": False, "status": r.status_code, "detalle": r.text[:300]}


HERRAMIENTAS = [
    {
        "name": "buscar_en_fuente",
        "description": ("Busca un medicamento, principio activo, titular o tema en UNA fuente de vigilancia ya "
                        "cargada en Supabase. Devuelve el total y una muestra de los registros más recientes. "
                        "Llámala una vez por cada fuente relevante."),
        "input_schema": {
            "type": "object",
            "properties": {
                "fuente": {"type": "string", "enum": list(FUENTES),
                           "description": "digemid=alertas DIGEMID Perú; modificatorias=modificaciones al RS por "
                                          "seguridad; cima=cambios FT/prospecto AEMPS; pavs=países de alta "
                                          "vigilancia; fda_aems=señales FDA; ema=señales PRAC y arbitrajes; "
                                          "india=CDSCO y PvPI"},
                "termino": {"type": "string", "description": "Texto a buscar (vacío = todo)"},
                "desde": {"type": "string", "description": "Fecha mínima AAAA-MM-DD (opcional)"},
                "limite": {"type": "integer", "description": "Filas de muestra, 1-25 (por defecto 8)"},
            },
            "required": ["fuente"],
        },
    },
    {
        "name": "estado_fuentes",
        "description": "Total de registros y fecha del último dato de cada fuente. Úsala para preguntas de "
                       "salud del sistema o para saber si una fuente está desactualizada.",
        "input_schema": {"type": "object", "properties": {}},
    },
    {
        "name": "cruzar_portafolio",
        "description": "Busca el término en el portafolio registrado (medicamentos con registro sanitario) para "
                       "saber si una alerta afecta productos propios o de clientes.",
        "input_schema": {"type": "object", "properties": {"termino": {"type": "string"}}, "required": ["termino"]},
    },
    {
        "name": "actualizar_fuente",
        "description": "Dispara el scraper de una fuente para traer datos nuevos. Úsala SOLO si la instrucción "
                       "pide explícitamente actualizar o datos frescos. No espera el resultado.",
        "input_schema": {"type": "object", "properties": {"fuente": {"type": "string", "enum": list(FUENTES)}},
                         "required": ["fuente"]},
    },
    {
        "name": "entregar_informe",
        "description": "Entrega el resultado final. Llámala una sola vez, al terminar.",
        "input_schema": {
            "type": "object",
            "properties": {
                "resumen": {"type": "string", "description": "1-2 frases con el hallazgo principal"},
                "informe_md": {"type": "string", "description": "Informe en Markdown: hallazgos por fuente, "
                                                                "impacto en el portafolio, acciones sugeridas y "
                                                                "enlaces a las fuentes"},
            },
            "required": ["resumen", "informe_md"],
        },
    },
]

SISTEMA = f"""Eres el Agente de Vigilancia de ConkoSafe IA (Conkomerco, Lima). Ayudas a un químico \
farmacéutico responsable de farmacovigilancia a revisar alertas y señales de seguridad.

Hoy es {HOY.isoformat()}. Las fuentes ya están cargadas en Supabase por scrapers automáticos; tú las \
consultas con herramientas. Reglas:
- Planifica brevemente y luego consulta SOLO las fuentes relevantes para la instrucción (si es amplia, todas).
- Si la instrucción menciona un producto o principio activo, cruza también con el portafolio.
- Prueba sinónimos razonables (nombre en inglés/español, DCI) si una búsqueda sale vacía.
- No inventes registros, fechas ni enlaces: todo lo del informe debe venir de los resultados.
- Señala plazos regulatorios relevantes (p. ej. D.S. 016-2011-SA) solo cuando apliquen.
- Termina SIEMPRE con entregar_informe, en español, claro y accionable."""


# ---------------------------------------------------------------------------
# Motores
# ---------------------------------------------------------------------------
def _ejecutar(nombre: str, args: dict, log: Bitacora) -> dict:
    if nombre == "buscar_en_fuente":
        return buscar_en_fuente(args.get("fuente", ""), args.get("termino"), args.get("desde"),
                                args.get("limite", 8), log=log)
    if nombre == "estado_fuentes":
        return estado_fuentes(log=log)
    if nombre == "cruzar_portafolio":
        return cruzar_portafolio(args.get("termino", ""), log=log)
    if nombre == "actualizar_fuente":
        return actualizar_fuente(args.get("fuente", ""), log=log)
    return {"error": f"Herramienta desconocida: {nombre}"}


def _cancelada(tarea_id: str) -> bool:
    filas, _ = sb_get("agente_tareas", f"select=estado&id=eq.{tarea_id}")
    return bool(filas) and filas[0]["estado"] == "cancelada"


def motor_claude(tarea: dict, log: Bitacora) -> dict:
    import anthropic

    cliente = anthropic.Anthropic()
    mensajes = [{"role": "user", "content": tarea["instruccion"]}]
    tin = tout = 0
    log("agente", "inicio", f"Leyendo la instrucción con {MODELO}")
    for paso in range(1, MAX_PASOS + 1):
        if _cancelada(tarea["id"]):
            log("agente", "aviso", "Tarea cancelada por el usuario")
            return {"estado": "cancelada", "tokens_in": tin, "tokens_out": tout}
        resp = cliente.messages.create(model=MODELO, max_tokens=4000, system=SISTEMA,
                                       tools=HERRAMIENTAS, messages=mensajes)
        tin += resp.usage.input_tokens
        tout += resp.usage.output_tokens
        mensajes.append({"role": "assistant", "content": resp.content})

        resultados = []
        for bloque in resp.content:
            if bloque.type == "text" and bloque.text.strip():
                log("agente", "pensamiento", bloque.text.strip(), paso=paso)
            elif bloque.type == "tool_use":
                if bloque.name == "entregar_informe":
                    log("informe", "ok", "Informe listo: " + bloque.input.get("resumen", ""))
                    return {"estado": "completada", "resumen": bloque.input.get("resumen"),
                            "informe_md": bloque.input.get("informe_md"), "tokens_in": tin, "tokens_out": tout}
                res = _ejecutar(bloque.name, bloque.input, log)
                resultados.append({"type": "tool_result", "tool_use_id": bloque.id,
                                   "content": json.dumps(res, ensure_ascii=False, default=str)[:20000]})
        if not resultados:  # el modelo respondió solo con texto
            texto = "\n".join(b.text for b in resp.content if b.type == "text")
            log("informe", "ok", "Informe listo")
            return {"estado": "completada", "resumen": texto[:280], "informe_md": texto,
                    "tokens_in": tin, "tokens_out": tout}
        mensajes.append({"role": "user", "content": resultados})

    log("agente", "error", f"Se alcanzó el límite de {MAX_PASOS} pasos sin informe")
    return {"estado": "error", "resumen": "El agente no terminó dentro del límite de pasos",
            "tokens_in": tin, "tokens_out": tout}


_VACIAS = set("""a al alerta alertas analiza busca buscar cambios de del desde dime el en entre esta este
fuentes hay la las lo los me mes meses mi mis o para por que qué revisa revisar señal señales sobre
su sus todas todo todos un una ultimos últimos y ultimo último dias días semana semanas año hoy
monitor monitorea dame informe reporte actualiza actualizar actualizado actualizada actualizacion
puedes puede podrias indicarme indicame dime decirme saber quiero necesito favor ficha fichas tecnica
tecnicas prospecto prospectos sido esta estan ese esa este comprimido comprimidos tabletas capsulas
solucion inyectable jarabe suspension crema mg mcg ml cima digemid pavs agencia producto productos""".split())


def _sin_tildes(s: str) -> str:
    return "".join(c for c in unicodedata.normalize("NFD", s) if unicodedata.category(c) != "Mn")


def motor_heuristico(tarea: dict, log: Bitacora) -> dict:
    """Sin API key: extrae el término, recorre todas las fuentes y arma un informe tabular."""
    texto = tarea["instruccion"]
    log("agente", "inicio", "Motor heurístico (sin ANTHROPIC_API_KEY): recorro todas las fuentes")
    citado = re.findall(r"[«\"']([^»\"']{3,60})[»\"']", texto)
    if citado:
        termino = citado[0].strip()
    else:
        limpio = re.sub(r"https?://\S+", " ", texto)  # las URL no son términos de búsqueda
        vacias = {_sin_tildes(v) for v in _VACIAS}
        palabras = [w for w in re.findall(r"[\wáéíóúñÁÉÍÓÚÑ\-]{4,}", limpio)
                    if _sin_tildes(w.lower()) not in vacias and not any(c.isdigit() for c in w)]
        # Un nombre en MAYÚSCULAS (p. ej. NORMOSTOP) suele ser el producto: tiene prioridad
        mayus = [w for w in palabras if w.isupper()]
        termino = mayus[0] if mayus else (max(palabras, key=len) if palabras else None)
    # «metformina» → «metformin» encuentra también el nombre en inglés (ilike por subcadena)
    if termino and not termino.isupper() and len(termino) > 6 and termino[-1].lower() in "aoe":
        termino = termino[:-1]
    m = re.search(r"(\d+)\s*(d[ií]as|semanas?|mes(?:es)?|años?)", texto, re.I)
    desde = None
    if m:
        n, u = int(m.group(1)), _sin_tildes(m.group(2).lower())
        dias = n * (1 if u.startswith("dia") else 7 if u.startswith("seman") else 30 if u.startswith("mes") else 365)
        desde = (HOY - dt.timedelta(days=dias)).isoformat()
    log("agente", "pensamiento", f"Término: {termino or '(todo)'} · desde: {desde or 'siempre'}")

    filas_md, total_global = [], 0
    for k in FUENTES:
        r = buscar_en_fuente(k, termino, desde, 5, log=log)
        n = r.get("total", 0) or 0
        total_global += n
        filas_md.append(f"| {FUENTES[k]['nombre']} | {n} |")
    port = cruzar_portafolio(termino, log=log) if termino else {"total": 0}
    resumen = (f"{total_global} registro(s) sobre «{termino}» en las fuentes; "
               f"{port.get('total', 0)} producto(s) del portafolio coinciden.") if termino else \
              f"{total_global} registro(s) en el periodo."
    informe = "\n".join([f"## Resultado: {termino or 'todas las fuentes'}", "",
                         f"Periodo: desde {desde or 'el inicio'} hasta {HOY.isoformat()}", "",
                         "| Fuente | Registros |", "|---|---|", *filas_md, "",
                         f"Productos del portafolio que coinciden: **{port.get('total', 0)}**", "",
                         "_Informe generado por el motor heurístico; configura ANTHROPIC_API_KEY para el análisis "
                         "completo con Claude._"])
    log("informe", "ok", "Informe listo: " + resumen, encontrados=total_global)
    return {"estado": "completada", "resumen": resumen, "informe_md": informe}


# ---------------------------------------------------------------------------
# Ciclo de una tarea
# ---------------------------------------------------------------------------
def procesar(tarea_id: str, simular: bool = False) -> None:
    # Toma atómica: solo si sigue pendiente (evita que dos corridas la procesen)
    tomadas = sb_patch("agente_tareas", f"id=eq.{tarea_id}&estado=eq.pendiente",
                       {"estado": "en_curso", "iniciado_en": dt.datetime.now(dt.timezone.utc).isoformat(),
                        "run_url": os.environ.get("GITHUB_RUN_URL"),
                        "modelo": "heuristico" if simular or not os.environ.get("ANTHROPIC_API_KEY") else MODELO})
    if not tomadas:
        print(f"Tarea {tarea_id}: no está pendiente (ya tomada, cancelada o inexistente).")
        return
    tarea = tomadas[0]
    print(f"▶ Tarea {tarea_id}: {tarea['instruccion'][:120]}")
    log = Bitacora(tarea_id)
    t0 = time.time()
    try:
        if simular or not os.environ.get("ANTHROPIC_API_KEY"):
            res = motor_heuristico(tarea, log)
        else:
            try:
                res = motor_claude(tarea, log)
            except Exception as e:  # noqa: BLE001 — clave inválida, sin saldo, modelo inexistente…
                if type(e).__module__.split(".")[0] != "anthropic":
                    raise
                log("agente", "aviso", f"Claude no respondió ({type(e).__name__}: {str(e)[:160]}). "
                                       "Continúo con el motor heurístico.")
                sb_patch("agente_tareas", f"id=eq.{tarea_id}", {"modelo": f"heuristico (fallo {MODELO})"})
                res = motor_heuristico(tarea, log)
    except Exception as e:  # noqa: BLE001 — cualquier fallo debe quedar en la bitácora
        log("agente", "error", f"Fallo inesperado: {type(e).__name__}: {e}")
        res = {"estado": "error", "resumen": f"{type(e).__name__}: {e}"}
    res["terminado_en"] = dt.datetime.now(dt.timezone.utc).isoformat()
    log("agente", "ok" if res["estado"] == "completada" else res["estado"] if res["estado"] == "error" else "aviso",
        f"Fin de la tarea ({res['estado']}) en {time.time() - t0:.0f} s")
    sb_patch("agente_tareas", f"id=eq.{tarea_id}&estado=eq.en_curso", res)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument("--tarea", help="UUID de la tarea a procesar")
    g.add_argument("--pendientes", action="store_true", help="Procesar todas las tareas pendientes")
    ap.add_argument("--simular", action="store_true", help="Forzar el motor heurístico (sin Claude)")
    a = ap.parse_args()
    if not SERVICE_KEY:
        sys.exit("Falta SUPABASE_SERVICE_ROLE_KEY")
    if a.tarea:
        procesar(a.tarea, a.simular)
    else:
        filas, _ = sb_get("agente_tareas", "select=id&estado=eq.pendiente&order=creado_en.asc&limit=10")
        print(f"{len(filas)} tarea(s) pendiente(s)")
        for f in filas:
            procesar(f["id"], a.simular)


if __name__ == "__main__":
    main()
