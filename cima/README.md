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

## Generar documento (pestaña ✍, estilo Scribe)

El visor tiene dos pestañas: **✍ Generar documento** y **📋 Cambios CIMA (monitor)**,
que se mantiene igual. El generador sigue cuatro pasos:

1. **País**: Perú (DIGEMID). Colombia y México aparecen como *Próximamente*.
2. **Idioma**: Español o Português. En portugués se traducen títulos y etiquetas;
   el contenido queda en español porque CIMA solo publica en español.
3. **Tipo**: Ficha técnica, Inserto o Etiqueta.
4. **Producto**: búsqueda en el catálogo completo de CIMA (nombre, principio
   activo o Nº de registro), documento subido (PDF / DOCX / HTML) o el botón
   **✍ Generar** de una fila del monitor.

**Generar** muestra las secciones numeradas y desplegables, con marcas
*CRÍTICA*, *PENDIENTE* (sin contenido en el origen) y *COMPLETAR* (datos que no
están en la FT, como el Nº de Registro Sanitario). Cada sección es **editable**
antes de **Exportar Word** (.docx real, con tablas y superíndices) o **Imprimir**.

| Documento | Estructura | Fuente preferida |
|---|---|---|
| Ficha técnica (PE) | "Contenido de la Ficha Técnica" (a … e.6, f, g.x) | FT, si no hay: prospecto |
| Inserto (PE) | **Provisional**, basada en el DS 016-2011-SA, pendiente de validar | Prospecto, si no hay: FT |
| Etiqueta (PE) | **Provisional**, basada en el DS 016-2011-SA, pendiente de validar | FT, si no hay: prospecto |

Las estructuras viven en `cima/plantillas.js`. Para agregar Colombia o México
se completa su entrada en `PAISES` (`activo: true`) y su bloque en `PLANTILLAS`.
La lógica está en `cima/generador.js`, y reutiliza el segmentador y la caché en Supabase.

## Control de versiones y control de cambios

Todo documento generado (FT, inserto o etiqueta) puede guardarse como **documento
controlado** con **💾 Guardar versión**, junto a "Exportar Word".

| Elemento | Formato | Lo asigna |
|---|---|---|
| Documento controlado | `CKS-FT-PE-00001` (`FT` / `IN` / `ET`, país, correlativo) | servidor |
| Versión | `CKS-FT-PE-00001-V02` | servidor (correlativo, sin saltos ni duplicados) |
| Control de cambio | `CC-2026-00002`: motivo, versión base y secciones +agregadas ~modificadas −eliminadas | servidor |
| Fecha y hora | `now()` del servidor (se muestra en hora de Lima) | servidor |
| Integridad | SHA-256 por sección, SHA-256 del contenido y cadena de hash con la versión anterior | servidor |

**Flujo de actualización:** en **📚 Segmentados → 🕘 Historial → 🔄 Nueva versión**:
1. Se elige la versión anterior (base).
2. Se sube la nueva versión de referencia o se toma la vigente en CIMA.
3. Se ejecuta la separación y cada sección queda marcada **MODIFICADA / NUEVA**, con "⇄ Ver cambios" palabra a palabra.
4. Se edita lo necesario y se guarda la nueva versión, con motivo y confirmación obligatorios.

Si se genera un producto que ya tiene documento controlado, el visor ofrece **🔗 Vincular como nueva versión** para no duplicarlo.

**Historial:** muestra versiones, usuario, fecha y hora, control de cambio, motivo, secciones afectadas y hash, con
**⇄ Comparar** entre cualquier par de versiones y **🛡 Verificar integridad**, que recalcula los hashes y la cadena.
La columna *Versión controlada* y el buscador de "📚 Segmentados" responden cuántas versiones y cambios tiene cada documento.

**Criterios de auditoría (ALCOA+ · 21 CFR Part 11 · EU GMP Anexo 11):**
- Los registros son **inmutables**: triggers bloquean UPDATE, DELETE y TRUNCATE incluso para el rol `postgres`, y
  los usuarios no tienen permisos de escritura directa. Solo se escribe por la función `guardar_version_documento`, que es atómica
  y serializa versiones concurrentes.
- Cada registro es **atribuible** (id, email y nombre del usuario al momento) y **contemporáneo** (hora del servidor).
- El **motivo** es obligatorio (mínimo 10 caracteres) y se exige declarar que se revisó el contenido. Una versión sin cambios se rechaza.
- Las copias **exportadas o impresas** llevan el código, la versión, la fecha y el hash, y el código también en el pie de cada página. Si no
  están guardadas, salen como **"BORRADOR — COPIA NO CONTROLADA"**. Las exportaciones e impresiones de versiones controladas
  quedan en la bitácora `documento_eventos`.
- El documento segmentado que respalda una versión **no puede eliminarse** (FK `on delete restrict`).

Esquema, funciones y políticas: `cima/sql/control_versiones.sql`.

### Paso 5 · Registro sanitario (DIGEMID)

El generador permite asociar el documento a un producto del **portafolio de
registros sanitarios** (`medicamentos` + titulares). El buscador filtra por
producto, principio activo o Nº de RS, sugiere según el principio activo del
producto de CIMA y marca los registros **VENCIDOS** o próximos a vencer.

- **Acceso:** solo **admin o usuarios con acceso a Titulares**, la misma regla del portafolio.
  Quien no tiene ese acceso no ve el paso 5 y no puede asociar ni cambiar el RS; el servidor lo
  rechaza aunque se intente por la API. Sí puede editar el contenido de un documento que ya tiene RS, y la versión
  nueva conserva el mismo RS.
- **Trazabilidad:** la versión guarda el id del medicamento y un **snapshot** (Nº RS, producto,
  titular(es), vencimiento) con su hash, encadenado en `hash_cadena`. Así el registro sigue siendo
  fiel aunque el portafolio se recargue.
- **Cambio de RS = cambio controlado:** genera una nueva versión aunque no cambie ninguna sección,
  con el detalle *"Registro sanitario asociado: EN-… → EN-…"*.
- El RS aparece en el documento, en el Word y la impresión, y en el historial. En la pestaña Segmentados se puede
  buscar por Nº de RS.

SQL: `cima/sql/registro_sanitario.sql` y `cima/sql/registro_sanitario_principio_activo.sql`, que agrega el principio activo al snapshot. Ambos son compatibles con las versiones ya guardadas, que siguen verificando igual.

En la pestaña **📚 Segmentados**, la columna *Medicamento referencia* es el documento de CIMA o subido. Las columnas **RS DIGEMID**, **Producto (RS)** y **Principio activo (RS)** muestran lo elegido en el paso 5 en la versión controlada más reciente de esa referencia. Las versiones guardadas antes de incluir el principio activo lo muestran desde el portafolio actual, marcado *(portafolio)*.

**Límites conocidos:**
- No hay firma electrónica con re-autenticación. Part 11 la exige para *aprobaciones*, y hoy se registra quién guarda pero no hay flujo de revisión y aprobación.
- Un superusuario de la base podría desactivar los triggers y recalcular toda la cadena. Para mitigarlo, conviene anclar periódicamente
  el último `hash_cadena` fuera de la base, por ejemplo exportándolo al repositorio.

## Segmentación FT / Prospecto → campos de la Ficha Técnica

Desde el visor, cada fila tiene botones **✂ FT** y **✂ Prosp** que separan el
documento en los campos del esquema "Contenido de la Ficha Técnica":
`a`, `b`, `c.1`–`c.9`, `d.1`–`d.3`, `e.1`–`e.6`, `f` (fecha de revisión) y
`g.1`/`g.2` (radiofármacos). Lo que no tiene equivalente se guarda aparte como
`x.titular`, `x.autorizacion`, `x.fecha_autorizacion` o `x.otros`.

| Entrada | Cómo se separa |
|---|---|
| FT de CIMA | API oficial `docSegmentado` (secciones 1–12): 4.x → c.x, 5.x → d.x, 6.x → e.x, 10 → f |
| Prospecto de CIMA | Secciones 1–6 del prospecto + reglas por subtítulo ("No tome…" → c.3, "Embarazo…" → c.6, "Si toma más… del que debe" → c.9, "Composición" → b…) |
| Documento subido (**⬆ Subir FT / Prospecto**: PDF, DOCX, HTML) | Reglas: numeración (`4.3`, `c.3`) + palabras clave del título. Sin IA |

- El proceso corre **en el navegador** (`cima/segmentador.js`); no hay servidor ni API key.
- Cada resultado se guarda en Supabase: `documentos_segmentados` (cabecera) y
  `documento_secciones` (un registro por campo). Las subidas guardan además el
  archivo original en el bucket privado `documentos-segmentados`.
- Una versión de un documento CIMA se segmenta **una sola vez**: si ya está
  guardada (misma fecha de versión), se muestra la guardada. Cuando CIMA publica
  una versión nueva, se guarda otra fila y la anterior queda como histórico.
- **📚 Segmentados** lista lo guardado; **⬇ Excel** exporta los campos del documento abierto.
- Esquema y permisos: `cima/sql/documentos_segmentados.sql` (acceso: admin o `perfiles.acceso_cima`).

Limitaciones: CIMA no publica segmentados algunos documentos (p. ej. importaciones
paralelas); en ese caso el visor enlaza el PDF para subirlo. Los PDF escaneados
(imagen) no tienen texto y no se pueden separar. Un `.doc` antiguo debe guardarse
como `.docx` o PDF.

## Limitación conocida

La API de CIMA indica que el documento completo (FT o Prospecto) fue modificado,
**no la sección específica** (p. ej. 4.1, 4.8). Detectar el apartado exacto exigiría
comparar (diff) contra una versión previa guardada, fuera del alcance de este módulo.

## Fuente

- API: https://cima.aemps.es/cima/rest/registroCambios
- Documentación: https://www.aemps.gob.es/apps/cima/docs/CIMA_REST_API.pdf
