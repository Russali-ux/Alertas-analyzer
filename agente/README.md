# Agente ConkoSafe IA

Agente de vigilancia independiente de los scrapers. Le envías una instrucción desde
`agente/index.html` y ves en un tablero isométrico qué fuente está consultando, qué encontró
y el informe final.

```
agente/index.html ──insert──▶ agente_tareas ──▶ Edge Function agente-despachar
        ▲                                              │ repository_dispatch
        │ tiempo real                                  ▼
  agente_eventos ◀── cada paso ── agente/agente.py (GitHub Actions + Claude)
                                      │ lee: alertas_digemid, modificatorias_digemid, cima_cambios,
                                      │      pavs_alertas, fda_aems_senales, ema_prac_senales,
                                      │      ema_arbitrajes, alertas_cdsco, pvpi_senales, medicamentos
                                      └ puede disparar: digemid_monitor, cima_monitor, ema_prac_monitor,
                                                       fda_aems_monthly, Alertas India
```

## Archivos

| Archivo | Dónde va |
|---|---|
| `agente/index.html` | Página del tablero (GitHub Pages: `/Alertas-analyzer/agente/`) |
| `agente/agente.py` | El agente (Claude + herramientas sobre Supabase) |
| `agente/migracion_agente.sql` | Tablas `agente_tareas` y `agente_eventos`, RLS y tiempo real |
| `agente/edge-function/agente-despachar/index.ts` | Edge Function que despierta al agente |
| `agente/agente.yml` | Copiar a `.github/workflows/agente.yml` |

## Puesta en marcha

1. **Supabase → SQL Editor:** ejecutar `migracion_agente.sql`.
2. **Edge Function:** crear `agente-despachar` con el contenido de `index.ts` y los secretos
   `GH_DISPATCH_TOKEN` (PAT fine-grained del repo, permiso *Contents: Read and write*) y
   `GH_REPO = Russali-ux/Alertas-analyzer`.
3. **GitHub → Settings → Secrets → Actions:** confirmar `SUPABASE_URL`,
   `SUPABASE_SERVICE_ROLE_KEY` y `ANTHROPIC_API_KEY` (ya existen para los otros workflows).
   Opcional: variable `AGENTE_MODELO` para cambiar el modelo.
4. **Workflow:** crear `.github/workflows/agente.yml` a mano con el contenido de `agente.yml`.
5. **Navegación:** agregar en `moduleNav` del `index.html` principal un enlace a `agente/index.html`.

Sin `ANTHROPIC_API_KEY` el agente usa un motor heurístico (busca el término en todas las fuentes y
arma una tabla). Sin la Edge Function las tareas no se pierden: el workflow revisa pendientes cada
15 minutos.

## Probar en local

```bash
pip install requests anthropic
export SUPABASE_SERVICE_ROLE_KEY=...   # y ANTHROPIC_API_KEY si quieres Claude
python agente/agente.py --pendientes
```

`agente/index.html#demo` reproduce una corrida de ejemplo sin sesión.
