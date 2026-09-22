-- ═══════════════════════════════════════════════════════════════
-- ema_prac: Agendas/Minutas del PRAC + PRAC recommendations on
-- safety signals (European Medicines Agency)
--
-- Sigue el mismo patrón que alertas_cdsco / pvpi_senales:
--   - dedupe_key único calculado en Python (md5) -> upsert idempotente
--     vía PostgREST con ?on_conflict=dedupe_key
--   - RLS habilitado con lectura pública (mismo patrón que las demás
--     tablas del proyecto Alertas-analyzer)
--
-- Ejecutar en el SQL Editor de Supabase (proyecto ggbnfdaxtsngsjssrwrl).
-- ═══════════════════════════════════════════════════════════════

-- 1) Agendas y minutas de las reuniones plenarias del PRAC
create table if not exists public.ema_prac_minutas (
  id                 bigint generated always as identity primary key,
  tipo_documento     text not null check (tipo_documento in ('agenda', 'minuta')),
  titulo             text not null,
  fecha_reunion      text,                 -- ej. "8-11 June 2026"
  referencia         text,                 -- ej. "EMA/PRAC/186037/2026"
  fecha_publicacion  date,
  url_pdf            text not null,
  url_pdf_github     text,                 -- link al PDF versionado en el repo (opcional)
  contenido_md       text,                 -- PDF convertido a Markdown (extracción PyMuPDF)
  resumen_ia         text,                 -- reservado para un resumen IA futuro
  dedupe_key         text unique not null,
  created_at         timestamptz default now()
);

create index if not exists idx_ema_prac_minutas_fecha
  on public.ema_prac_minutas (fecha_publicacion desc);
create index if not exists idx_ema_prac_minutas_tipo
  on public.ema_prac_minutas (tipo_documento);

alter table public.ema_prac_minutas enable row level security;

create policy "Lectura pública ema_prac_minutas"
  on public.ema_prac_minutas for select
  to anon, authenticated
  using (true);


-- 2) PRAC recommendations on safety signals
create table if not exists public.ema_prac_recomendaciones (
  id                 bigint generated always as identity primary key,
  titulo             text not null,
  fecha_reunion      text,                 -- ej. "6-9 July 2026"
  referencia         text,                 -- ej. "EMA/PRAC/155652/2026"
  fecha_publicacion  date,
  url_pdf            text not null,
  url_pdf_github     text,
  contenido_md       text,
  resumen_ia         text,
  dedupe_key         text unique not null,
  created_at         timestamptz default now()
);

create index if not exists idx_ema_prac_recom_fecha
  on public.ema_prac_recomendaciones (fecha_publicacion desc);

alter table public.ema_prac_recomendaciones enable row level security;

create policy "Lectura pública ema_prac_recomendaciones"
  on public.ema_prac_recomendaciones for select
  to anon, authenticated
  using (true);


-- 3) Detalle molécula / señal extraído de cada documento de recomendaciones
--    (una fila por cada par INN–reacción encontrado en el PDF: sección 1
--    "Recommendations for update of the product information" y las tablas
--    de las secciones 2 y 3). Extracción automática best-effort vía PyMuPDF.
create table if not exists public.ema_prac_senales (
  id                 bigint generated always as identity primary key,
  molecula           text not null,
  senal              text not null,
  epitt_no           text,
  seccion            text,               -- 'actualizacion_producto' | 'tabla'
  fecha_reunion      text,
  referencia         text,
  fecha_publicacion  date,
  url_pdf            text not null,
  dedupe_key         text unique not null,
  created_at         timestamptz default now()
);

create index if not exists idx_ema_prac_senales_molecula on public.ema_prac_senales (lower(molecula));
create index if not exists idx_ema_prac_senales_senal on public.ema_prac_senales (lower(senal));
create index if not exists idx_ema_prac_senales_fecha on public.ema_prac_senales (fecha_publicacion desc);

alter table public.ema_prac_senales enable row level security;

create policy "Lectura pública ema_prac_senales"
  on public.ema_prac_senales for select
  to anon, authenticated
  using (true);


-- 4) (Opcional, mismo patrón que perfiles.acceso_cima / acceso_pavs /
--    acceso_india) columna de control de acceso por perfil, si en el
--    futuro se quiere granular la visibilidad del módulo EMA PRAC en
--    el dashboard.
-- alter table public.perfiles add column if not exists acceso_ema_prac boolean default true;
