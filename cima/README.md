# 💊 Módulo CIMA — Ficha Técnica y Prospecto (AEMPS)

Monitor **independiente** dentro del repositorio `Russali-ux/Alertas-analyzer`.
No comparte código ni datos con el monitor DIGEMID: todo vive bajo `cima/` y su
propio workflow `.github/workflows/cima_monitor.yml`.

## Qué hace

Cada corrida consulta la API REST oficial y pública de **CIMA (AEMPS, España)**,
filtra los medicamentos cuya **Ficha Técnica** y/o **Prospecto** cambiaron en los
últimos 30 días y genera, codificado por fecha:

| Salida | Ruta | Descripción |
|---|---|---|
| Excel | `cima/data/ConkosafeIA_Regulatorio_YYYYMMDD.xlsx` | 5 hojas con hipervínculos a FT/Prospecto |
| JSON del día | `cima/data/cima_YYYYMMDD.json` | Datos que consume el visor web |
| JSON último | `cima/data/cima_latest.json` | Copia del último run |
| Índice | `cima/data/index.json` | Lista de todas las fechas disponibles |
| Markdown | `cima/summaries/cima_YYYY-MM-DD.md` | Resumen legible del Excel |

El visor **`cima/index.html`** (publicado en GitHub Pages, ruta
`/Alertas-analyzer/cima/`) lee esos JSON y muestra la tabla con selector de fecha,
buscador, filtro por categoría y enlaces directos a los documentos de CIMA.

## Estructura

```
cima/
├── cima_monitor.py     ← runner (API CIMA → Excel/JSON/MD)
├── requirements.txt
├── index.html          ← visor GitHub Pages
├── data/               ← auto-generado por el workflow
└── summaries/          ← auto-generado por el workflow
```

## Ejecución local

```bash
pip install -r cima/requirements.txt
python cima/cima_monitor.py --dias 30 --data-dir cima/data --summary-dir cima/summaries
```

Opciones:

```bash
python cima/cima_monitor.py --dias 60
python cima/cima_monitor.py --desde 01/05/2026 --hasta 31/05/2026
```

## Automatización

`.github/workflows/cima_monitor.yml` corre todos los días a las **08:30 (Lima)**
y hace commit de `cima/data/` y `cima/summaries/`. También se puede lanzar a mano
desde la pestaña **Actions → Monitor CIMA → Run workflow** (permite elegir la
ventana de días).

No requiere ningún secreto ni API key: la API de CIMA es pública.

## Limitación conocida

La API de CIMA indica que el documento completo (FT o Prospecto) fue modificado,
**no la sección específica** (p. ej. 4.1, 4.8). Detectar el apartado exacto exigiría
comparar (diff) contra una versión previa guardada, fuera del alcance de este módulo.

## Fuente

- API: https://cima.aemps.es/cima/rest/registroCambios
- Documentación: https://www.aemps.gob.es/apps/cima/docs/CIMA_REST_API.pdf
