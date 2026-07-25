"""
supabase_sync.py
-----------------
Sube (upsert) las alertas DIGEMID ya procesadas por scraper_alertas_digemid.py
hacia la tabla `alertas_digemid` en Supabase.

Se asume que `df` es el DataFrame final que ya arma el scraper, con las
columnas descritas en el README ("Columnas del Excel generado"):
    Título, Producto, Tipo de Alerta, Fecha Publicación, Acción Principal,
    Urgencia, Dirigido a, Acciones Requeridas, Resumen IA, Motor Análisis,
    URL PDF GitHub, URL PDF DIGEMID

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


def _fila_a_registro(fila: pd.Series) -> dict:
    """Convierte una fila del DataFrame al formato de la tabla alertas_digemid."""
    fecha = fila.get("Fecha Publicación")
    if pd.notna(fecha):
        # Normaliza a YYYY-MM-DD si viene como datetime/Timestamp
        fecha = pd.to_datetime(fecha).strftime("%Y-%m-%d")
    else:
        fecha = None

    return {
        "titulo": fila.get("Título"),
        "producto": fila.get("Producto"),
        "titular_registro_sanitario": fila.get("Titular Registro Sanitario") or fila.get("titular_registro_sanitario"),
        "tipo_alerta": fila.get("Tipo de Alerta"),
        "fecha_publicacion": fecha,
        "accion_principal": fila.get("Acción Principal") or fila.get("⚡ Acción Principal"),
        "urgencia": fila.get("Urgencia"),
        "dirigido_a": fila.get("Dirigido a"),
        "acciones_requeridas": fila.get("Acciones Requeridas"),
        "resumen_ia": fila.get("Resumen IA"),
        "motor_analisis": fila.get("Motor Análisis"),
        "url_pdf_github": fila.get("URL PDF GitHub"),
        "url_pdf_digemid": fila.get("URL PDF DIGEMID"),
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

    resultado = (
        supabase.table("alertas_digemid")
        .upsert(registros, on_conflict="titulo,fecha_publicacion")
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
