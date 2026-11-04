-- Carga Certa: banco de dados (Supabase / Postgres)
-- Rode este arquivo inteiro no SQL Editor do Supabase.

-- ---------- tabelas ----------
create table public.settings (
  id int primary key default 1 check (id = 1),
  auto_approve boolean not null default false  -- true: placa+bloco+apto iguais aos da base entram aprovados
);
insert into public.settings default values;

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  name text not null,
  bloco text not null,
  apto text not null,
  phone text not null,
  plate text not null unique,
  car text not null,
  role text not null default 'morador' check (role in ('morador','sindico')),
  status text not null default 'pending' check (status in ('pending','approved','blocked')),
  created_at timestamptz not null default now()
);

-- lista de veículos que a administração já tem (usada para agilizar o cadastro)
create table public.base_veiculos (
  plate text primary key,
  name text,
  bloco text not null,
  apto text not null,
  car text
);

create table public.points (
  id smallint primary key,
  name text not null,
  off boolean not null default false,
  off_reason text,
  off_since timestamptz
);
insert into public.points (id, name) values (1, 'Ponto 1'), (2, 'Ponto 2');

create table public.sessions (
  id bigint generated always as identity primary key,
  point_id smallint not null references public.points(id),
  profile_id uuid not null references public.profiles(id),
  started_at timestamptz not null default now(),
  ends_at timestamptz not null,
  released_at timestamptz,
  n10 boolean not null default false,
  nend boolean not null default false
);
create unique index sessions_one_active_per_point on public.sessions(point_id) where released_at is null;
create unique index sessions_one_active_per_profile on public.sessions(profile_id) where released_at is null;
create index sessions_started_idx on public.sessions(started_at);

create table public.queue (
  id bigint generated always as identity primary key,
  profile_id uuid not null unique references public.profiles(id) on delete cascade,
  joined_at timestamptz not null default now()
);

create table public.queue_waits (
  id bigint generated always as identity primary key,
  profile_id uuid not null,
  joined_at timestamptz not null,
  called_at timestamptz not null default now()
);

create table public.reservations (
  point_id smallint primary key references public.points(id),
  profile_id uuid not null references public.profiles(id) on delete cascade,
  until timestamptz not null
);

create table public.reports (
  id bigint generated always as identity primary key,
  profile_id uuid not null references public.profiles(id) on delete cascade,
  point_id smallint not null references public.points(id),
  tipo text not null,
  descricao text not null default '',
  status text not null default 'open' check (status in ('open','done')),
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);

create table public.notices (
  id bigint generated always as identity primary key,
  text text not null,
  auto boolean not null default false,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table public.push_subscriptions (
  id bigint generated always as identity primary key,
  profile_id uuid not null references public.profiles(id) on delete cascade,
  endpoint text not null unique,
  p256dh text not null,
  auth text not null,
  created_at timestamptz not null default now()
);

-- caixa de saída de avisos: cada linha vira um push (profile_id nulo = todos os aprovados)
create table public.notifications (
  id bigint generated always as identity primary key,
  profile_id uuid references public.profiles(id) on delete cascade,
  body text not null,
  created_at timestamptz not null default now()
);

-- ---------- funções auxiliares ----------
create function public.is_sindico() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from profiles where id = auth.uid() and role = 'sindico' and status = 'approved')
$$;

create function public.is_approved() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from profiles where id = auth.uid() and status = 'approved')
$$;

create function public.push_notify(p_profile uuid, p_body text) returns void
language sql security definer set search_path = public as $$
  insert into notifications (profile_id, body) values (p_profile, p_body)
$$;

create function public.call_next(p_point smallint) returns void
language plpgsql security definer set search_path = public as $$
declare v_q record;
begin
  if exists (select 1 from points where id = p_point and off) then return; end if;
  if exists (select 1 from reservations where point_id = p_point) then return; end if;
  if exists (select 1 from sessions where point_id = p_point and released_at is null) then return; end if;
  select qq.id, qq.profile_id, qq.joined_at into v_q
    from queue qq join profiles pr on pr.id = qq.profile_id
   where pr.status = 'approved'
   order by qq.joined_at limit 1;
  if v_q.id is null then return; end if;
  delete from queue where id = v_q.id;
  insert into queue_waits (profile_id, joined_at) values (v_q.profile_id, v_q.joined_at);
  insert into reservations (point_id, profile_id, until) values (p_point, v_q.profile_id, now() + interval '10 minutes');
  perform push_notify(v_q.profile_id, 'Sua vez! O ponto ' || p_point || ' está reservado para você por 10 min.');
end $$;

create function public.dispatch_queue() returns void
language plpgsql security definer set search_path = public as $$
declare v_p smallint;
begin
  for v_p in select id from points order by id loop
    perform call_next(v_p);
  end loop;
end $$;

-- ---------- uso dos pontos ----------
create function public.start_charge(p_point smallint, p_minutes int) returns void
language plpgsql security definer set search_path = public as $$
declare v_me uuid := auth.uid(); v_res reservations;
begin
  if not is_approved() then raise exception 'Seu cadastro ainda não foi aprovado.'; end if;
  if p_minutes is null or p_minutes < 5 or p_minutes > 720 then raise exception 'Informe um tempo entre 5 min e 12 h.'; end if;
  if exists (select 1 from points where id = p_point and off) then raise exception 'Esse ponto está fora de serviço.'; end if;
  select * into v_res from reservations where point_id = p_point;
  if v_res.point_id is not null and v_res.profile_id <> v_me then
    raise exception 'Esse ponto está reservado para outro morador.';
  end if;
  begin
    insert into sessions (point_id, profile_id, ends_at) values (p_point, v_me, now() + make_interval(mins => p_minutes));
  exception when unique_violation then
    raise exception 'Esse ponto está ocupado ou você já está carregando.';
  end;
  delete from reservations where point_id = p_point;
  delete from queue where profile_id = v_me;
end $$;

create function public.release_point(p_point smallint) returns void
language plpgsql security definer set search_path = public as $$
declare v_s sessions;
begin
  select * into v_s from sessions where point_id = p_point and released_at is null for update;
  if v_s.id is null then raise exception 'Esse ponto já está livre.'; end if;
  if v_s.profile_id <> auth.uid() and not is_sindico() then raise exception 'Sem permissão.'; end if;
  update sessions set released_at = now() where id = v_s.id;
  perform call_next(p_point);
end $$;

create function public.join_queue() returns void
language plpgsql security definer set search_path = public as $$
declare v_me uuid := auth.uid();
begin
  if not is_approved() then raise exception 'Seu cadastro ainda não foi aprovado.'; end if;
  if exists (select 1 from sessions where profile_id = v_me and released_at is null) then
    raise exception 'Você já está carregando.';
  end if;
  if not exists (select 1 from points where not off) then raise exception 'Todos os pontos estão fora de serviço.'; end if;
  if exists (
    select 1 from points p
     where not p.off
       and not exists (select 1 from sessions s where s.point_id = p.id and s.released_at is null)
       and (not exists (select 1 from reservations r where r.point_id = p.id)
            or exists (select 1 from reservations r where r.point_id = p.id and r.profile_id = v_me))
  ) then
    raise exception 'Há ponto livre. Inicie a carga.';
  end if;
  insert into queue (profile_id) values (v_me) on conflict (profile_id) do nothing;
end $$;

create function public.leave_queue() returns void
language sql security definer set search_path = public as $$
  delete from queue where profile_id = auth.uid()
$$;

-- ---------- rotina por minuto (avisos e reservas vencidas) ----------
create function public.tick() returns void
language plpgsql security definer set search_path = public as $$
declare s record; r record; v_head uuid;
begin
  for s in select * from sessions
            where released_at is null and not n10 and ends_at > now() and ends_at - now() <= interval '10 minutes' loop
    update sessions set n10 = true where id = s.id;
    perform push_notify(s.profile_id, 'Faltam 10 min para terminar a carga no ponto ' || s.point_id || '.');
    select qq.profile_id into v_head from queue qq join profiles pr on pr.id = qq.profile_id
     where pr.status = 'approved' order by qq.joined_at limit 1;
    if v_head is not null then
      perform push_notify(v_head, 'O ponto ' || s.point_id || ' libera em cerca de 10 min. Você é o próximo.');
    end if;
  end loop;
  for s in select * from sessions where released_at is null and not nend and ends_at <= now() loop
    update sessions set nend = true where id = s.id;
    perform push_notify(s.profile_id, 'Carga terminada no ponto ' || s.point_id || '. Retire o carro para liberar.');
  end loop;
  for r in select * from reservations where until < now() loop
    delete from reservations where point_id = r.point_id;
    perform push_notify(r.profile_id, 'O tempo para assumir o ponto ' || r.point_id || ' acabou. A vez passou para o próximo.');
    perform call_next(r.point_id);
  end loop;
end $$;

-- ---------- leitura do painel (sem expor celular a moradores) ----------
create function public.board() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_s boolean := is_sindico();
begin
  if not is_approved() then raise exception 'Sem acesso.'; end if;
  return jsonb_build_object(
    'now', now(),
    'points', (select coalesce(jsonb_agg(jsonb_build_object(
        'id', p.id, 'off', p.off, 'off_reason', p.off_reason, 'off_since', p.off_since,
        'session', (select jsonb_build_object('profile_id', s.profile_id, 'name', pr.name, 'bloco', pr.bloco, 'apto', pr.apto,
                      'car', pr.car, 'plate', pr.plate, 'started_at', s.started_at, 'ends_at', s.ends_at,
                      'phone', case when v_s then pr.phone end)
                    from sessions s join profiles pr on pr.id = s.profile_id
                    where s.point_id = p.id and s.released_at is null),
        'reservation', (select jsonb_build_object('profile_id', rv.profile_id, 'name', pr.name, 'bloco', pr.bloco, 'apto', pr.apto,
                      'car', pr.car, 'plate', pr.plate, 'until', rv.until, 'phone', case when v_s then pr.phone end)
                    from reservations rv join profiles pr on pr.id = rv.profile_id where rv.point_id = p.id)
      ) order by p.id), '[]'::jsonb) from points p),
    'queue', (select coalesce(jsonb_agg(jsonb_build_object(
        'profile_id', qq.profile_id, 'name', pr.name, 'bloco', pr.bloco, 'apto', pr.apto, 'joined_at', qq.joined_at
      ) order by qq.joined_at), '[]'::jsonb) from queue qq join profiles pr on pr.id = qq.profile_id),
    'notice', (select jsonb_build_object('text', n.text, 'created_at', n.created_at)
                 from notices n where n.active order by n.id desc limit 1)
  );
end $$;

-- ---------- cadastro ----------
create function public.lookup_plate(p_plate text) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_b base_veiculos; v_plate text := upper(trim(p_plate));
begin
  if auth.uid() is null then raise exception 'Faça login.'; end if;
  if exists (select 1 from profiles where plate = v_plate) then return jsonb_build_object('registered', true); end if;
  select * into v_b from base_veiculos where plate = v_plate;
  if v_b.plate is null then return null; end if;
  return jsonb_build_object('registered', false, 'first_name', split_part(coalesce(v_b.name, ''), ' ', 1),
                            'bloco', v_b.bloco, 'apto', v_b.apto, 'car', v_b.car);
end $$;

create function public.register_profile(p_name text, p_bloco text, p_apto text, p_phone text, p_plate text, p_car text) returns text
language plpgsql security definer set search_path = public as $$
declare v_plate text := upper(trim(p_plate)); v_status text := 'pending'; v_b base_veiculos; v_auto boolean;
begin
  if auth.uid() is null then raise exception 'Faça login.'; end if;
  if v_plate !~ '^[A-Z]{3}[0-9][A-Z0-9][0-9]{2}$' then raise exception 'Placa inválida. Exemplo: ABC1D23.'; end if;
  if length(regexp_replace(coalesce(p_phone, ''), '\D', '', 'g')) < 10 then raise exception 'Celular inválido. Inclua o DDD.'; end if;
  if coalesce(trim(p_name), '') = '' or coalesce(trim(p_bloco), '') = '' or coalesce(trim(p_apto), '') = '' or coalesce(trim(p_car), '') = '' then
    raise exception 'Preencha todos os campos.';
  end if;
  select auto_approve into v_auto from settings;
  select * into v_b from base_veiculos where plate = v_plate;
  if v_auto and v_b.plate is not null and lower(trim(v_b.bloco)) = lower(trim(p_bloco)) and lower(trim(v_b.apto)) = lower(trim(p_apto)) then
    v_status := 'approved';
  end if;
  begin
    insert into profiles (id, name, bloco, apto, phone, plate, car, status)
    values (auth.uid(), trim(p_name), trim(p_bloco), trim(p_apto), trim(p_phone), v_plate, trim(p_car), v_status);
  exception when unique_violation then
    raise exception 'Essa placa ou esse usuário já está cadastrado.';
  end;
  return v_status;
end $$;

-- ---------- problemas ----------
create function public.create_report(p_point smallint, p_tipo text, p_desc text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not is_approved() then raise exception 'Sem acesso.'; end if;
  insert into reports (profile_id, point_id, tipo, descricao) values (auth.uid(), p_point, p_tipo, coalesce(p_desc, ''));
end $$;

create function public.resolve_report(p_id bigint) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not is_sindico() then raise exception 'Apenas o síndico.'; end if;
  update reports set status = 'done', resolved_at = now() where id = p_id;
end $$;

-- ---------- ações do síndico ----------
create function public.post_notice(p_text text, p_auto boolean default false) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not is_sindico() then raise exception 'Apenas o síndico.'; end if;
  if coalesce(trim(p_text), '') = '' then raise exception 'Escreva a mensagem.'; end if;
  update notices set active = false where active;
  insert into notices (text, auto) values (trim(p_text), p_auto);
  insert into notifications (profile_id, body) values (null, trim(p_text));
end $$;

create function public.end_notice() returns void
language plpgsql security definer set search_path = public as $$
begin
  if not is_sindico() then raise exception 'Apenas o síndico.'; end if;
  update notices set active = false where active;
end $$;

create function public.set_points_off(p_points smallint[], p_reason text, p_notify boolean) returns void
language plpgsql security definer set search_path = public as $$
declare v_p smallint; v_owner uuid; v_res_profile uuid; v_list text := '';
begin
  if not is_sindico() then raise exception 'Apenas o síndico.'; end if;
  foreach v_p in array p_points loop
    continue when exists (select 1 from points where id = v_p and off);
    v_owner := null; v_res_profile := null;
    update sessions set released_at = now() where point_id = v_p and released_at is null returning profile_id into v_owner;
    if v_owner is not null then
      perform push_notify(v_owner, 'Seu ponto foi bloqueado pela administração: ' || p_reason || '.');
    end if;
    delete from reservations where point_id = v_p returning profile_id into v_res_profile;
    if v_res_profile is not null then
      perform push_notify(v_res_profile, 'A reserva do ponto ' || v_p || ' foi cancelada: ' || p_reason || '. Você continua na frente da fila.');
      insert into queue (profile_id, joined_at)
      values (v_res_profile, coalesce((select min(joined_at) from queue), now()) - interval '1 second')
      on conflict (profile_id) do nothing;
    end if;
    update points set off = true, off_reason = p_reason, off_since = now() where id = v_p;
    v_list := v_list || case when v_list = '' then '' else ' e ' end || v_p::text;
  end loop;
  if p_notify and v_list <> '' then
    perform post_notice(case when position(' e ' in v_list) > 0 then 'Pontos ' else 'Ponto ' end || v_list || ' fora de serviço. ' || p_reason || '.', true);
  end if;
  perform dispatch_queue();
end $$;

create function public.reactivate_point(p_point smallint) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not is_sindico() then raise exception 'Apenas o síndico.'; end if;
  update points set off = false, off_reason = null, off_since = null where id = p_point;
  if not exists (select 1 from points where off) then
    update notices set active = false where auto and active;
  end if;
  perform dispatch_queue();
end $$;

create function public.force_release(p_point smallint) returns void
language plpgsql security definer set search_path = public as $$
declare v_res uuid;
begin
  if not is_sindico() then raise exception 'Apenas o síndico.'; end if;
  if exists (select 1 from sessions where point_id = p_point and released_at is null) then
    update sessions set released_at = now() where point_id = p_point and released_at is null;
  else
    delete from reservations where point_id = p_point returning profile_id into v_res;
    if v_res is not null then
      perform push_notify(v_res, 'A administração cancelou a reserva do ponto ' || p_point || '.');
    end if;
  end if;
  perform call_next(p_point);
end $$;

create function public.kick_queue(p_profile uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not is_sindico() then raise exception 'Apenas o síndico.'; end if;
  delete from queue where profile_id = p_profile;
end $$;

create function public.set_profile_status(p_profile uuid, p_status text) returns void
language plpgsql security definer set search_path = public as $$
declare v_pt smallint;
begin
  if not is_sindico() then raise exception 'Apenas o síndico.'; end if;
  if p_status not in ('approved','blocked','pending') then raise exception 'Status inválido.'; end if;
  update profiles set status = p_status where id = p_profile;
  if p_status <> 'approved' then
    delete from queue where profile_id = p_profile;
    delete from reservations where profile_id = p_profile;
    for v_pt in update sessions set released_at = now() where profile_id = p_profile and released_at is null returning point_id loop
      null;
    end loop;
    perform dispatch_queue();
  end if;
end $$;

create function public.import_base(p_rows jsonb) returns int
language plpgsql security definer set search_path = public as $$
declare v_r jsonb; v_n int := 0; v_plate text;
begin
  if not is_sindico() then raise exception 'Apenas o síndico.'; end if;
  for v_r in select * from jsonb_array_elements(p_rows) loop
    v_plate := upper(trim(v_r->>'plate'));
    continue when v_plate !~ '^[A-Z]{3}[0-9][A-Z0-9][0-9]{2}$' or coalesce(v_r->>'bloco', '') = '' or coalesce(v_r->>'apto', '') = '';
    insert into base_veiculos (plate, name, bloco, apto, car)
    values (v_plate, nullif(trim(v_r->>'name'), ''), trim(v_r->>'bloco'), trim(v_r->>'apto'), nullif(trim(v_r->>'car'), ''))
    on conflict (plate) do update set name = excluded.name, bloco = excluded.bloco, apto = excluded.apto, car = excluded.car;
    v_n := v_n + 1;
  end loop;
  return v_n;
end $$;

-- ---------- relatórios ----------
create function public.monthly_report(p_month date default current_date) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_from timestamptz; v_to timestamptz; v_agg jsonb; v_hist int[]; v_top jsonb; v_wait numeric; v_open int; v_done int;
begin
  if not is_sindico() then raise exception 'Apenas o síndico.'; end if;
  v_from := date_trunc('month', p_month::timestamp) at time zone 'America/Bahia';
  v_to := v_from + interval '1 month';
  select jsonb_build_object(
      'total', count(*),
      'hours', round(coalesce(sum(extract(epoch from (coalesce(released_at, ends_at) - started_at))) / 3600.0, 0)::numeric, 1),
      'avg_minutes', round(coalesce(avg(extract(epoch from (coalesce(released_at, ends_at) - started_at)) / 60.0), 0)::numeric),
      'late', count(*) filter (where released_at is not null and released_at > ends_at + interval '10 minutes'))
    into v_agg from sessions where started_at >= v_from and started_at < v_to;
  select array_agg(coalesce(x.c, 0) order by h.h) into v_hist
    from generate_series(0, 23) as h(h)
    left join (select extract(hour from started_at at time zone 'America/Bahia')::int as hh, count(*)::int as c
                 from sessions where started_at >= v_from and started_at < v_to group by 1) x on x.hh = h.h;
  select coalesce(jsonb_agg(jsonb_build_object('name', t.name, 'count', t.c) order by t.c desc, t.name), '[]'::jsonb) into v_top
    from (select pr.name, count(*) as c from sessions s join profiles pr on pr.id = s.profile_id
           where s.started_at >= v_from and s.started_at < v_to group by pr.name order by c desc, pr.name limit 5) t;
  select round(avg(extract(epoch from (called_at - joined_at)) / 60.0)::numeric) into v_wait
    from queue_waits where called_at >= v_from and called_at < v_to;
  select count(*) filter (where status = 'open'), count(*) filter (where status = 'done') into v_open, v_done
    from reports where created_at >= v_from and created_at < v_to;
  return v_agg || jsonb_build_object('hist', to_jsonb(v_hist), 'top', v_top, 'avg_wait', coalesce(v_wait, 0),
                                      'reports_open', v_open, 'reports_done', v_done, 'from', v_from);
end $$;

create function public.admin_history(p_limit int default 30) returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not is_sindico() then raise exception 'Apenas o síndico.'; end if;
  return (select coalesce(jsonb_agg(jsonb_build_object('name', t.name, 'bloco', t.bloco, 'apto', t.apto, 'point_id', t.point_id,
            'started_at', t.started_at, 'ended_at', t.ended_at) order by t.started_at desc), '[]'::jsonb)
          from (select pr.name, pr.bloco, pr.apto, s.point_id, s.started_at, coalesce(s.released_at, s.ends_at) as ended_at
                  from sessions s join profiles pr on pr.id = s.profile_id
                 where s.released_at is not null order by s.started_at desc limit p_limit) t);
end $$;

-- ---------- segurança por linha (RLS) ----------
alter table public.settings enable row level security;
alter table public.profiles enable row level security;
alter table public.base_veiculos enable row level security;
alter table public.points enable row level security;
alter table public.sessions enable row level security;
alter table public.queue enable row level security;
alter table public.queue_waits enable row level security;
alter table public.reservations enable row level security;
alter table public.reports enable row level security;
alter table public.notices enable row level security;
alter table public.push_subscriptions enable row level security;
alter table public.notifications enable row level security;

create policy profiles_read on public.profiles for select using (id = auth.uid() or public.is_sindico());
create policy base_sindico on public.base_veiculos for all using (public.is_sindico()) with check (public.is_sindico());
create policy points_read on public.points for select using (public.is_approved());
create policy sessions_read on public.sessions for select using (public.is_approved());
create policy queue_read on public.queue for select using (public.is_approved());
create policy reservations_read on public.reservations for select using (public.is_approved());
create policy reports_read on public.reports for select using (profile_id = auth.uid() or public.is_sindico());
create policy notices_read on public.notices for select using (public.is_approved());
create policy settings_read on public.settings for select using (public.is_sindico());
create policy push_own on public.push_subscriptions for all using (profile_id = auth.uid()) with check (profile_id = auth.uid());
create policy notif_read on public.notifications for select
  using (profile_id = auth.uid() or (profile_id is null and public.is_approved()) or public.is_sindico());

-- ---------- permissões das funções ----------
do $$
declare f record;
begin
  for f in select p.oid::regprocedure as sig, p.proname
             from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public' loop
    execute format('revoke all on function %s from public', f.sig);
    execute format('revoke all on function %s from anon', f.sig);
    if f.proname in ('call_next', 'dispatch_queue', 'push_notify', 'tick') then
      execute format('revoke all on function %s from authenticated', f.sig);
    else
      execute format('grant execute on function %s to authenticated', f.sig);
    end if;
  end loop;
end $$;

-- ---------- permissões das tabelas (funciona com "expor novas tabelas" desligado) ----------
-- As políticas RLS acima continuam decidindo quem vê o quê; aqui só abrimos a porta da API.
grant usage on schema public to anon, authenticated;
grant select on public.profiles, public.points, public.sessions, public.queue, public.reservations,
                public.reports, public.notices, public.notifications to authenticated;
grant select, insert, update, delete on public.push_subscriptions to authenticated;
