-- ════════════════════════════════════════════════════════════════════════════
-- Alertas por Producto & Titular · vincular Modificatorias DIGEMID (seguridad)
-- YA APLICADO en Supabase (ggbnfdaxtsngsjssrwrl) el 27/10/2026. Se deja como registro.
-- Cambio aditivo: los registros existentes no se modifican.
-- ════════════════════════════════════════════════════════════════════════════
alter table public.alertas_producto_titular
  add column if not exists alerta_modif_id uuid
  references public.modificatorias_digemid(id) on delete set null;
create index if not exists idx_apt_modif on public.alertas_producto_titular (alerta_modif_id);

alter table public.alertas_producto_titular drop constraint if exists alertas_producto_titular_origen_check;
alter table public.alertas_producto_titular add constraint alertas_producto_titular_origen_check
  check (origen = any (array['digemid_vinculada','pavs_vinculada','fda_vinculada','ema_vinculada','modif_vinculada','manual']));

alter table public.alertas_producto_titular drop constraint if exists chk_apt_una_fuente;
alter table public.alertas_producto_titular add constraint chk_apt_una_fuente
  check (num_nonnulls(alerta_digemid_id, alerta_pavs_id, alerta_fda_id, alerta_ema_id, alerta_modif_id) <= 1);

notify pgrst, 'reload schema';
