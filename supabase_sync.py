"""
supabase_sync.py
-----------------
Sube (upsert) las alertas DIGEMID ya procesadas por scraper_alertas_digemid.py
hacia la tabla `alertas_digemid` en Supabase.

Se asume que `df` es el DataFrame final que arma scrapear_alertas(), cuyas
columnas reales (snake_case, no las etiquetas bonitas del Excel) son:
    titulo, producto, titular_registro_sanitario, tipo_alerta,
    fecha_publicacion, accion_principal, urgencia, dirigido_a,
    acciones_detalladas, resumen_accion, motor_analisis,
    pdf_url, github_pdf_url, url

Requiere:
    pip install supabase --break-system-packages

Variables de entorno requeridas (agregar como Secrets en GitHub Actions):
    SUPABASE_URL              -> https://ggbnfdaxtsngsjssrwrl.supabase.co
    SUPABASE_SERVICE_ROLE_KEY -> Settings > API > service_role (NUNCA la anon key aquí)
"""

import os
import pandas as pd
from supabase import create_client, Client


def _get_client() -> Client:
    url = os.environ["SUPABASE_URL"]
    key = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
    return create_client(url, key)


def _limpio(valor):
    """Convierte NaN/NaT de pandas a None; deja el resto intacto."""
    if valor is None:
        return None
    try:
        if pd.isna(valor):
            return None
    except (TypeError, ValueError):
        pass
    return valor


def _fila_a_registro(fila: pd.Series) -> dict:
    """Convierte una fila del DataFrame (columnas reales del scraper) al formato de la tabla alertas_digemid."""
    fecha = _limpio(fila.get("fecha_publicacion"))
    if fecha is not None:
        fecha = pd.to_datetime(fecha).strftime("%Y-%m-%d")

    return {
        "titulo": _limpio(fila.get("titulo")),
        "producto": _limpio(fila.get("producto")),
        "titular_registro_sanitario": _limpio(fila.get("titular_registro_sanitario")),
        "tipo_alerta": _limpio(fila.get("tipo_alerta")),
        "fecha_publicacion": fecha,
        "accion_principal": _limpio(fila.get("accion_principal")),
        "urgencia": _limpio(fila.get("urgencia")),
        "dirigido_a": _limpio(fila.get("dirigido_a")),
        "acciones_requeridas": _limpio(fila.get("acciones_detalladas")),
        "resumen_ia": _limpio(fila.get("resumen_accion")),
        "motor_analisis": _limpio(fila.get("motor_analisis")),
        "url_pdf_github": _limpio(fila.get("github_pdf_url")),
        "url_pdf_digemid": _limpio(fila.get("pdf_url")),
        "url_pagina_digemid": _limpio(fila.get("url")),
    }


def subir_a_supabase(df: pd.DataFrame) -> None:
    """Sube todas las filas del DataFrame a Supabase con upsert por (titulo, fecha_publicacion)."""
    if df.empty:
        print("⚠️  DataFrame vacío, no hay nada que subir a Supabase.")
        return

    if "SUPABASE_URL" not in os.environ or "SUPABASE_SERVICE_ROLE_KEY" not in os.environ:
        print("⚠️  SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY no configuradas; se omite la sincronización.")
        return

    supabase = _get_client()
    registros = [_fila_a_registro(fila) for _, fila in df.iterrows()]

    # Evita mandar filas sin titulo/fecha (violarían el not-null / la clave de conflicto)
    registros_validos = [r for r in registros if r.get("titulo") and r.get("fecha_publicacion")]
    omitidos = len(registros) - len(registros_validos)
    if omitidos:
        print(f"⚠️  {omitidos} fila(s) sin título o fecha; se omiten de la subida a Supabase.")

    if not registros_validos:
        print("⚠️  No hay registros válidos para subir a Supabase.")
        return

    resultado = (
        supabase.table("alertas_digemid")
        .upsert(registros_validos, on_conflict="titulo,fecha_publicacion")
        .execute()
    )
    print(f"✅ Supabase: {len(resultado.data)} registros insertados/actualizados en alertas_digemid.")


if __name__ == "__main__":
    # Prueba manual: python supabase_sync.py data/alertas_latest.json
    import sys
    import json

    ruta = sys.argv[1] if len(sys.argv) > 1 else "data/alertas_latest.json"
    with open(ruta, encoding="utf-8") as f:
        datos = json.load(f)
    df_prueba = pd.DataFrame(datos)
    subir_a_supabase(df_prueba)
