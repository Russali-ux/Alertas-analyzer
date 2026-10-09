-- =====================================================================
-- Agente ConkoSafe IA — tablas de tareas y bitácora de actividad
-- Proyecto Supabase: ggbnfdaxtsngsjssrwrl
--
--  agente_tareas  : lo que TÚ le envías al agente (una fila por instrucción)
--  agente_eventos : lo que el agente VA HACIENDO (una fila por paso), es lo
--                   que dibuja el tablero isométrico de agente/index.html
--
-- Escritura de eventos y cambio de estado: solo service_role (el agente en
-- GitHub Actions). Lectura: el dueño de la tarea o un admin (perfiles.rol).
-- =====================================================================

create table if not exists public.agente_tareas (
  id            uuid primary key default gen_random_uuid(),
  instruccion   text not null check (char_length(instruccion) between 3 and 4000),
  -- pendiente -> en_curso -> completada | error | cancelada
  estado        text not null default 'pendiente'
                check (estado in ('pendiente','en_curso','completada','error','cancelada')),
  creado_por    uuid not null default auth.uid() references auth.users(id) on delete cascade,
  creado_en     timestamptz not null default now(),
  iniciado_en   timestamptz,
  terminado_en  timestamptz,
  informe_md    text,          -- informe final en Markdown
  resumen       text,          -- 1-2 frases para la lista de tareas
  modelo        text,
  tokens_in     integer,
  tokens_out    integer,
  run_url       text           -- enlace a la corrida de GitHub Actions
);
comment on table public.agente_tareas is
  'Instrucciones enviadas al Agente ConkoSafe IA desde agente/index.html; el agente (GitHub Actions) las toma y escribe su avance en agente_eventos.';

create table if not exists public.agente_eventos (
  id         bigint generated always as identity primary key,
  tarea_id   uuid not null references public.agente_tareas(id) on delete cascade,
  ts         timestamptz not null default now(),
  -- baldosa del tablero: agente | digemid | modificatorias | cima | pavs |
  --                      fda_aems | ema | india | portafolio | informe
  estacion   text not null,
  -- inicio | progreso | ok | aviso | error | pensamiento
  tipo       text not null default 'progreso',
  mensaje    text not null,
  metricas   jsonb not null default '{}'::jsonb
);
comment on table public.agente_eventos is
  'Bitácora paso a paso del Agente ConkoSafe IA (una fila por acción). La lee el tablero isométrico en tiempo real.';

create index if not exists agente_eventos_tarea_ts on public.agente_eventos (tarea_id, ts);
create index if not exists agente_tareas_estado on public.agente_tareas (estado, creado_en);

-- ---------- RLS ----------
alter table public.agente_tareas  enable row level security;
alter table public.agente_eventos enable row level security;

create or replace function public.agente_es_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.perfiles p where p.id = auth.uid() and p.rol = 'admin');
$$;

drop policy if exists agente_tareas_select on public.agente_tareas;
create policy agente_tareas_select on public.agente_tareas
  for select to authenticated
  using (creado_por = auth.uid() or public.agente_es_admin());

drop policy if exists agente_tareas_insert on public.agente_tareas;
create policy agente_tareas_insert on public.agente_tareas
  for insert to authenticated
  with check (creado_por = auth.uid() and estado = 'pendiente'
              and informe_md is null and iniciado_en is null);

-- El usuario solo puede CANCELAR su propia tarea pendiente/en curso.
drop policy if exists agente_tareas_cancelar on public.agente_tareas;
create policy agente_tareas_cancelar on public.agente_tareas
  for update to authenticated
  using (creado_por = auth.uid() and estado in ('pendiente','en_curso'))
  with check (creado_por = auth.uid() and estado = 'cancelada');

drop policy if exists agente_eventos_select on public.agente_eventos;
create policy agente_eventos_select on public.agente_eventos
  for select to authenticated
  using (exists (select 1 from public.agente_tareas t
                 where t.id = tarea_id
                   and (t.creado_por = auth.uid() or public.agente_es_admin())));

-- (sin políticas de insert/update para eventos: solo service_role escribe)

-- ---------- Tiempo real ----------
do $$ begin
  alter publication supabase_realtime add table public.agente_tareas;
exception when duplicate_object then null; end $$;
do $$ begin
  alter publication supabase_realtime add table public.agente_eventos;
exception when duplicate_object then null; end $$;
