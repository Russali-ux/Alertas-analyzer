"""
scripts_fetch_aems_from_onedrive.py
------------------------------------
Trae fda_aems_data.json desde la carpeta OneDrive "Documentos/Claude/Projects/
fda_aems" (vía rclone, remote "onedrive") y lo copia a data/fda_aems_data.json
en el repo, sobrescribiendo la copia anterior.

El scraping en sí NO corre aquí (fda.gov bloquea IPs de datacenter/nube,
incluyendo las de GitHub Actions). El JSON se genera aparte, corriendo la
skill fda-aems-monitor desde la PC del usuario (o Cowork), que lo deja en esa
carpeta de OneDrive.

Mismo patrón que PAVS_Digemid/scripts/0_fetch_from_onedrive.py.

Uso:
    python3 scripts_fetch_aems_from_onedrive.py
    python3 scripts_fetch_aems_from_onedrive.py --remote-path "Documentos/Claude/Projects/fda_aems"
"""

import argparse
import os
import subprocess
import sys

LOCAL_PATH = os.path.join("data", "fda_aems_data.json")
DEFAULT_REMOTE_PATH = "Documentos/Claude/Projects/fda_aems"
REMOTE_NAME = "onedrive"
REMOTE_FILENAME = "fda_aems_data.json"


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--remote-path", default=DEFAULT_REMOTE_PATH,
                         help="Ruta dentro del remote 'onedrive:' donde está el JSON")
    parser.add_argument("--remote-filename", default=REMOTE_FILENAME,
                         help="Nombre del archivo JSON en esa carpeta de OneDrive")
    args = parser.parse_args()

    os.makedirs(os.path.dirname(LOCAL_PATH), exist_ok=True)

    remote_file = f"{REMOTE_NAME}:{args.remote_path}/{args.remote_filename}"
    print(f"Descargando {remote_file} -> {LOCAL_PATH}")
    try:
        subprocess.run(
            ["rclone", "copyto", remote_file, LOCAL_PATH],
            check=True,
        )
    except FileNotFoundError:
        sys.exit("rclone no está instalado en este runner/máquina.")
    except subprocess.CalledProcessError as e:
        sys.exit(
            f"rclone copyto falló. Verifica que el archivo exista en "
            f"onedrive:{args.remote_path}/{args.remote_filename} "
            f"(la skill fda-aems-monitor debe haberlo generado ahí). Detalle: {e}"
        )

    if not os.path.exists(LOCAL_PATH) or os.path.getsize(LOCAL_PATH) == 0:
        sys.exit(f"{LOCAL_PATH} no se descargó o quedó vacío.")

    print("OK -- descarga completa.")


if __name__ == "__main__":
    main()
