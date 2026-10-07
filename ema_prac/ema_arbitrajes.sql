-- Tabla de Arbitrajes EMA (Referrals JSON data file) para el módulo ema_prac
-- Proyecto Supabase: ggbnfdaxtsngsjssrwrl · ejecutar una sola vez en el SQL Editor
create table if not exists public.ema_arbitrajes (
  id                        bigint generated always as identity primary key,
  nombre                    text not null,          -- referral_name
  principios_activos        text,                   -- INN separados por ';'
  categoria                 text,                   -- Human / Veterinary
  tipo                      text,                   -- Article 31 referrals, Article 20 procedures...
  estado                    text,                   -- current_status
  en_curso                  boolean not null default false,
  arbitraje_seguridad       boolean not null default false,  -- safety_referral = Yes
  nombres_centralizados     text,
  nombres_nacionales        text,
  clase                     text,
  referencia                text,                   -- EMA/REF/...
  modelo_decision           text,                   -- PRAC-CMDh, PRAC-CHMP-EC, CHMP-EC...
  evaluado_por_prac         boolean not null default false,
  modelo_autorizacion       text,
  resultado_prac            text,                   -- Risk minimisation measures, Suspension...
  fecha_inicio              date,
  fecha_recomendacion_prac  date,
  fecha_posicion_cmdh       date,
  fecha_opinion_comite      date,                   -- CHMP / CVMP
  fecha_decision_ce         date,
  fecha_publicacion         date,
  fecha_actualizacion       date,
  url                       text not null,
  primera_deteccion         date,                   -- primera corrida del monitor que lo vio
  estado_anterior           text,                   -- estado antes del último cambio detectado
  fecha_cambio_estado       date,                   -- corrida en que se detectó ese cambio
  fuente_timestamp          text,                   -- meta.timestamp del JSON de EMA
  dedupe_key                text not null unique,   -- md5(url)
  updated_at                timestamptz not null default now()
);

create index if not exists ema_arbitrajes_inicio_idx on public.ema_arbitrajes (fecha_inicio desc);
create index if not exists ema_arbitrajes_en_curso_idx on public.ema_arbitrajes (en_curso) where en_curso;

alter table public.ema_arbitrajes enable row level security;

drop policy if exists "ema_arbitrajes lectura anon" on public.ema_arbitrajes;
create policy "ema_arbitrajes lectura anon"
  on public.ema_arbitrajes for select
  to anon, authenticated
  using (true);
