# 🚨 DIGEMID Alertas — Monitor Automático

Sistema de monitoreo automático de alertas sanitarias de [DIGEMID](https://www.digemid.minsa.gob.pe/alertas) (Dirección General de Medicamentos, Insumos y Drogas del Perú).

Desarrollado por **[Conkomerco](https://conkomerco.com)** — Plataforma de Farmacovigilancia y Tecnovigilancia.

---

## 📁 Estructura del repositorio

```
├── scraper_alertas_digemid.py   ← Scraper principal (Python)
├── index.html                   ← Frontend web (abrir en navegador)
├── .github/
│   └── workflows/
│       └── digemid_monitor.yml  ← Automatización diaria (GitHub Actions)
├── pdfs/                        ← PDFs descargados de DIGEMID (auto-generado)
├── data/
│   ├── alertas_YYYYMMDD.json   ← Index diario de alertas (auto-generado)
│   └── alertas_latest.json     ← Último run siempre disponible (auto-generado)
└── summaries/
    └── resumen_YYYY-MM-DD.md   ← Resumen Markdown legible (auto-generado)
```

---

## 🚀 Configuración inicial (5 minutos)

### 1. Fork o clona este repo

```bash
git clone https://github.com/TU-USUARIO/digemid-alertas.git
cd digemid-alertas
```

### 2. Agrega los Secrets en GitHub

Ve a tu repo → **Settings → Secrets and variables → Actions → New repository secret**

| Secret | Valor | Requerido |
|--------|-------|-----------|
| `ANTHROPIC_API_KEY` | `sk-ant-api03-...` | Para análisis semántico con Claude |

> `GITHUB_TOKEN` se genera **automáticamente** — no necesitas crearlo.

### 3. Activa GitHub Actions

Ve a **Actions** → habilita workflows si está desactivado → clic en **"Run workflow"** para probar manualmente.

---

## ⚙️ Ejecución local

```bash
# Instalar dependencias
pip install requests beautifulsoup4 pandas openpyxl pymupdf anthropic

# Sin API key → motor heurístico automático
python scraper_alertas_digemid.py

# Con API key → análisis semántico con Claude
export ANTHROPIC_API_KEY=sk-ant-...
export GITHUB_TOKEN=ghp_...
export GITHUB_REPO=tu-usuario/digemid-alertas
python scraper_alertas_digemid.py
```

Por defecto procesa **1 página (10 alertas)**. Para cambiar, edita en el `__main__`:
```python
df = scrapear_alertas(
    max_paginas=1,    # ← None para histórico completo (~165 páginas)
    analizar_acciones=True,
)
```

---

## 🌐 Frontend web

Abre `index.html` directamente en tu navegador (no requiere servidor).

**Funcionalidades:**
- 🤖 Multi-IA: Claude, DeepSeek, ChatGPT, OpenRouter, Groq
- 📄 Visor de PDF embebido (desde GitHub o DIGEMID)
- ⚡ Consultas IA sobre el PDF activo (con historial de conversación)
- ⊞ Vista Tabla con filtro, sort y exportar CSV
- 🤖 Consulta IA sobre las alertas de la tabla

**Configurar GitHub PDF Store en el frontend:**
1. Ingresa tu `usuario/repo` en el campo "GitHub PDF Store"
2. Los PDFs subidos por el scraper se cargarán automáticamente en el visor
3. Claude puede leer los PDFs directamente desde la URL raw de GitHub

---

## 📊 Salidas generadas

| Archivo | Descripción |
|---------|-------------|
| `pdfs/*.pdf` | PDFs originales de DIGEMID, versionados en Git |
| `data/alertas_YYYYMMDD.json` | Index completo del día con todos los campos |
| `data/alertas_latest.json` | Siempre apunta al último run |
| `summaries/resumen_YYYY-MM-DD.md` | Resumen legible con tabla de urgencias y acciones |

---

## 🤖 Cadena de análisis por alerta

```
DIGEMID (sitio web)
    ↓ scraper
Descarga PDF
    ↓
Sube a GitHub pdfs/
    ↓
Claude lee PDF desde URL raw GitHub   ← Motor 1 (más preciso)
    ↓ (fallback si no hay API key o GitHub)
Claude analiza texto extraído         ← Motor 2
    ↓ (fallback si no hay API key)
Análisis heurístico por patrones      ← Motor 3 (siempre disponible)
```

---

## ⏰ Horario automático

El workflow se ejecuta todos los días a las **8:00 AM hora Lima** (UTC-5).

Para cambiar el horario, edita `.github/workflows/digemid_monitor.yml`:
```yaml
- cron: '0 13 * * *'   # UTC 13:00 = Lima 8:00 AM
```

---

## 📋 Columnas del Excel generado

| Columna | Descripción |
|---------|-------------|
| Título | Número y nombre oficial |
| Producto | Medicamento/dispositivo afectado |
| Tipo de Alerta | Falsificados / Control de Calidad / Seguridad |
| Fecha Publicación | Fecha oficial de DIGEMID |
| ⚡ Acción Principal | `RETIRO DEL MERCADO` / `NO COMERCIALIZAR` / etc. |
| Urgencia | `INMEDIATA` 🔴 / `PREVENTIVA` 🟡 / `INFORMATIVA` 🔵 |
| Dirigido a | Audiencia (profesionales de salud, titulares RS, etc.) |
| Acciones Requeridas | Bullets extraídos del PDF |
| Resumen IA | 1-2 oraciones del análisis |
| Motor Análisis | `Claude API (PDF→GitHub)` / `Claude API (texto)` / `Heurístico` |
| URL PDF GitHub | Link directo al PDF en este repo |
| URL PDF DIGEMID | Link al PDF original |

---

## 🔗 Links

- [DIGEMID Alertas](https://www.digemid.minsa.gob.pe/alertas)
- [Conkomerco](https://conkomerco.com)
- [ConkoSafe — Plataforma FV](https://conkomerco.com/conkosafe)

---

## 🧠 Base vectorial Pinecone (piloto)

El repositorio incluye una integración RAG segura con Pinecone:

- `pinecone_indexer.py` extrae el texto de `pdfs/*.pdf`, lo fragmenta y sincroniza únicamente documentos nuevos o modificados.
- `pinecone_store.py` crea o abre el índice con embeddings integrados de Pinecone.
- `rag_api.py` busca los fragmentos relevantes y usa OpenAI para generar una respuesta fundamentada.
- `data/pinecone_manifest.json` registra hashes e identificadores para evitar duplicados.

El modelo de embeddings predeterminado es `multilingual-e5-large`, apropiado para documentos y consultas en español. Pinecone genera los embeddings durante la carga y la búsqueda, por lo que el indexador no consume la API de embeddings de OpenAI.

### Secretos de GitHub

En **Settings → Secrets and variables → Actions**, agrega:

| Nombre | Tipo | Descripción |
|---|---|---|
| `PINECONE_API_KEY` | Secret | Clave del proyecto Pinecone |
| `PINECONE_INDEX_NAME` | Variable opcional | Nombre del índice; por defecto `alertas-analyzer` |

El workflow diario ejecuta la sincronización después del scraper. Si el secreto no existe, omite ese paso sin interrumpir el monitoreo.

### API RAG en Hostinger

Instala las dependencias y configura las variables usando `.env.example` como referencia:

```bash
pip install -r requirements-rag.txt
uvicorn rag_api:app --host 127.0.0.1 --port 8000
```

Para producción se recomienda ejecutar Uvicorn detrás del proxy HTTPS de Hostinger. Variables requeridas:

```text
PINECONE_API_KEY
PINECONE_INDEX_NAME=alertas-analyzer
PINECONE_NAMESPACE=digemid-alertas
OPENAI_API_KEY
RAG_ALLOWED_ORIGINS=https://ia.conkomercoplataforma.com
```

En la interfaz web, introduce la URL pública completa del endpoint en **Base documental Pinecone**, por ejemplo:

```text
https://api.tu-dominio.com/api/rag/query
```

Las claves de Pinecone y OpenAI permanecen en el servidor y nunca se envían al navegador.
