# Monitor mensual FDA AEMS → Supabase → GitHub Pages

## Qué hace

1. **`.github/workflows/fda_aems_monthly.yml`** — corre el día 3 de cada mes
   (cron `0 9 3 * *`, ajustable) y también se puede lanzar a mano desde la
   pestaña *Actions* (`workflow_dispatch`, con opción de backfill completo).
2. **`scripts/fda_aems_sync_supabase.py`** — reutiliza el parser de
   `scripts/fda_aems_monitor.py` (ya en el repo si usaste la skill
   `fda-aems-monitor` antes) para scrapear fda.gov, actualiza
   `data/fda_aems_data.json` (se commitea al repo, es la base de datos
   acumulada) y hace **upsert** de todas las señales a la tabla Supabase
   `fda_aems_senales` (`on_conflict=dedupe_key`, idempotente).
3. **`aems/index.html`** — vista pública (mismo patrón que `cima/index.html`
   y `pavs/index.html`): lee directo de Supabase con la anon key, sin backend.

## Pasos para instalar

Tu repo `Alertas-analyzer` tiene los scripts sueltos en la raíz (como
`scraper_alertas_digemid.py`, `supabase_sync.py`), no en una carpeta
`scripts/` — estos archivos siguen esa misma convención:

1. Copia estos archivos al repo `Alertas-analyzer`:
   - `.github/workflows/fda_aems_monthly.yml` → dentro de tu `.github/workflows/`
     ya existente (archivo nuevo, no reemplaza nada)
   - `fda_aems_sync_supabase.py` → a la **raíz** del repo
   - `fda_aems_monitor.py` → a la **raíz** del repo
   - `aems/index.html` → crea la carpeta `aems/` (junto a `cima/` y `pavs/`)
     y pega ahí el `index.html`
   - `data/` ya existe en tu repo — no crees nada, el primer run genera
     `data/fda_aems_data.json` solo

2. En `aems/index.html`, reemplaza `SUPABASE_ANON_KEY` con la misma anon
   key que ya usan `cima/index.html` y `pavs/index.html` (Settings → API en
   el dashboard de Supabase, proyecto `ggbnfdaxtsngsjssrwrl`).

3. En GitHub → Settings → Secrets and variables → Actions, agrega:
   - `SUPABASE_URL` = `https://ggbnfdaxtsngsjssrwrl.supabase.co`
   - `SUPABASE_SERVICE_ROLE_KEY` = la service_role key (¡no la anon key!) —
     necesaria porque el upsert de escritura debe saltarse RLS.

4. Enlaza `aems/index.html` desde tu página índice de GitHub Pages
   (`index.html` del repo), igual que ya enlazas `cima/` y `pavs/`.

5. Corre el workflow manualmente una vez (*Actions → FDA AEMS... →
   Run workflow*, con `full_backfill: true`) para cargar el histórico
   completo (2015-actual, ~450 señales) en Supabase. Las corridas
   mensuales automáticas usan `--no-archived` (más rápidas, solo
   verifican los reportes vigentes — que es donde aparecen los nuevos).

## La tabla en Supabase ya existe

`public.fda_aems_senales` — columnas `periodo, anio, producto, principio,
senal, info, url, fuente_archivo, dedupe_key (generada, única), creado_en`.
RLS activo con política de **lectura pública** (igual que `cima_cambios`),
así que `aems/index.html` puede leer con la anon key sin autenticación.
Ahora mismo tiene una carga parcial (~270 de ~450 señales, cargadas a mano
en esta sesión) — el primer `full_backfill` del workflow completa el resto
automáticamente vía upsert, sin que tengas que hacer nada manual.
