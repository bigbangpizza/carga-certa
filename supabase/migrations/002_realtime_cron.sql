-- Só funciona no Supabase (não roda em Postgres comum). Rode depois do 001.

-- 1) Tempo real: o app é avisado quando algo muda
alter publication supabase_realtime add table public.points, public.sessions, public.queue,
  public.reservations, public.notices, public.notifications;

-- 2) Rotina de 1 em 1 minuto (avisos de 10 min, fim da carga, reservas vencidas)
--    Antes: Database > Extensions > ative "pg_cron".
create extension if not exists pg_cron;
select cron.schedule('carga-certa-tick', '* * * * *', $$select public.tick()$$);
