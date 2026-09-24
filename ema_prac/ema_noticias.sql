-- Tabla de Noticias EMA (News JSON data file) para el módulo ema_prac
-- Proyecto Supabase: ggbnfdaxtsngsjssrwrl · ejecutar una sola vez en el SQL Editor
create table if not exists public.ema_noticias (
  id                  bigint generated always as identity primary key,
  titulo              text not null,
  nota_prensa         boolean not null default false,
  medicamentos        text,          -- lista separada por ';'
  categorias          text,          -- Human;Veterinary;Corporate;Herbal
  temas               text,          -- lista separada por ';'
  resumen             text,
  fecha_publicacion   date,
  fecha_actualizacion date,
  url                 text not null,
  primera_deteccion   date,          -- primera corrida del monitor que la vio
  fuente_timestamp    text,          -- meta.timestamp del JSON de EMA
  dedupe_key          text not null unique,   -- md5(url)
  updated_at          timestamptz not null default now()
);

create index if not exists ema_noticias_fecha_idx on public.ema_noticias (fecha_publicacion desc);

alter table public.ema_noticias enable row level security;

drop policy if exists "ema_noticias lectura anon" on public.ema_noticias;
create policy "ema_noticias lectura anon"
  on public.ema_noticias for select
  to anon, authenticated
  using (true);
