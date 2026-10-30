-- 20261030 · PNU Halloween Night growth analytics
-- Supabase Postgres schema snapshot (2026-10-30)
-- Apply once in a fresh Supabase project: SQL Editor -> paste -> Run.
-- The static site only needs the publishable/anon key in assets/config.js.

-- ---------------------------------------------------------------------------
-- 1. event log table (append-only, anonymous session id)
-- ---------------------------------------------------------------------------
create table if not exists public.event_logs (
  id          bigint generated always as identity primary key,
  session_id  text not null check (char_length(session_id) between 8 and 64),
  event_name  text not null check (char_length(event_name) between 1 and 64),
  page        text check (char_length(page) <= 120),
  section     text check (char_length(section) <= 64),
  element     text check (char_length(element) <= 64),
  metadata    jsonb not null default '{}'::jsonb check (pg_column_size(metadata) < 4096),
  referrer    text check (char_length(referrer) <= 500),
  user_agent  text check (char_length(user_agent) <= 400),
  created_at  timestamptz not null default now()
);

create index if not exists event_logs_created_at_idx on public.event_logs (created_at desc);
create index if not exists event_logs_event_name_idx on public.event_logs (event_name, created_at desc);
create index if not exists event_logs_session_idx on public.event_logs (session_id);

alter table public.event_logs enable row level security;

drop policy if exists "anon can insert events" on public.event_logs;
create policy "anon can insert events"
  on public.event_logs
  for insert
  to anon, authenticated
  with check (true);

revoke all on public.event_logs from anon, authenticated;
grant insert on public.event_logs to anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2. main growth stats (p_include_sim = false excludes experiment pilot rows)
-- ---------------------------------------------------------------------------
create or replace function public.get_growth_stats(p_days int default 14, p_include_sim boolean default false)
returns jsonb
language sql
security definer
set search_path = public
as $$
with bounds as (
  select now() - make_interval(days => greatest(1, least(coalesce(p_days, 14), 90))) as since,
         greatest(1, least(coalesce(p_days, 14), 90)) as days
),
enriched as (
  select
    e.*,
    case
      when e.event_name = 'purchase' and (e.metadata->>'amount') ~ '^[0-9]+(\.[0-9]+)?$'
        then (e.metadata->>'amount')::numeric
      else 0
    end as amount,
    case
      when e.event_name = 'purchase' and (e.metadata->>'quantity') ~ '^[0-9]+$'
        then (e.metadata->>'quantity')::int
      else 1
    end as quantity,
    (e.created_at at time zone 'Asia/Seoul')::date as kst_date
  from public.event_logs e, bounds b
  where e.created_at >= b.since
    and (p_include_sim or coalesce(e.metadata->>'exp_demo', '') <> 'true')
),
event_stage as (
  select
    count(distinct session_id) as sessions,
    count(*) as total_events,
    count(*) filter (where event_name = 'click') as clicks,
    count(*) filter (where event_name = 'purchase') as orders,
    count(*) filter (where event_name = 'checkout_open') as checkout_opens,
    coalesce(sum(amount) filter (where event_name = 'purchase'), 0) as revenue,
    coalesce(sum(quantity) filter (where event_name = 'purchase'), 0) as tickets_sold
  from enriched
),
session_flags as (
  select
    session_id,
    bool_or(event_name = 'page_view') as visit,
    bool_or(event_name = 'section_view' and section = 'event_info') as detail,
    bool_or(event_name = 'section_view' and section = 'tickets') as tickets,
    bool_or(event_name = 'checkout_open') as checkout,
    bool_or(event_name = 'purchase') as purchase,
    bool_or(event_name in ('section_view', 'click', 'checkout_open', 'purchase')) as engaged,
    min(created_at) as first_at,
    max(created_at) as last_at
  from enriched
  group by session_id
),
session_stage as (
  select
    count(*) as sessions,
    count(*) filter (where visit) as visits,
    count(*) filter (where detail or tickets or checkout or purchase) as detail,
    count(*) filter (where tickets or checkout or purchase) as tickets,
    count(*) filter (where checkout or purchase) as checkouts,
    count(*) filter (where purchase) as buyers,
    count(*) filter (where engaged) as engaged,
    case when count(*) > 0
      then round(100.0 * count(*) filter (where not engaged) / count(*), 1)
      else 0
    end as bounce_rate,
    coalesce(round(avg(extract(epoch from (last_at - first_at))) filter (where engaged)), 0) as avg_activity
  from session_flags
),
button_stats as (
  select coalesce(jsonb_agg(row_to_json(t) order by t.clicks desc, t.element), '[]'::jsonb) as data
  from (
    select
      coalesce(element, 'unknown') as element,
      coalesce(max(metadata->>'label'), max(element), '알 수 없음') as label,
      coalesce(max(section), '-') as section,
      count(*) as clicks,
      count(distinct session_id) as sessions
    from enriched
    where event_name = 'click'
    group by coalesce(element, 'unknown')
    order by count(*) desc
    limit 12
  ) t
),
ticket_stats as (
  select coalesce(jsonb_agg(row_to_json(t) order by t.revenue desc), '[]'::jsonb) as data
  from (
    select
      coalesce(metadata->>'ticket_type', 'unknown') as ticket_type,
      count(*) as orders,
      coalesce(sum(quantity), 0) as tickets,
      coalesce(sum(amount), 0) as revenue
    from enriched
    where event_name = 'purchase'
    group by coalesce(metadata->>'ticket_type', 'unknown')
  ) t
),
daily_stats as (
  select coalesce(jsonb_agg(row_to_json(t) order by t.date), '[]'::jsonb) as data
  from (
    select
      d::date as date,
      coalesce(v.visits, 0) as visits,
      coalesce(o.orders, 0) as orders,
      coalesce(o.revenue, 0) as revenue
    from generate_series(
      ((now() at time zone 'Asia/Seoul')::date - (select days from bounds) + 1)::timestamp,
      ((now() at time zone 'Asia/Seoul')::date)::timestamp,
      interval '1 day'
    ) d
    left join (
      select kst_date, count(distinct session_id) as visits
      from enriched where event_name = 'page_view'
      group by kst_date
    ) v on v.kst_date = d::date
    left join (
      select kst_date, count(*) as orders, sum(amount) as revenue
      from enriched where event_name = 'purchase'
      group by kst_date
    ) o on o.kst_date = d::date
  ) t
),
device_stats as (
  select coalesce(jsonb_agg(row_to_json(t) order by t.sessions desc), '[]'::jsonb) as data
  from (
    select
      coalesce(metadata->>'device', 'unknown') as device,
      count(distinct session_id) as sessions
    from enriched
    where event_name = 'page_view'
    group by coalesce(metadata->>'device', 'unknown')
  ) t
)
select jsonb_build_object(
  'window_days', (select days from bounds),
  'since', (select since from bounds),
  'totals', jsonb_build_object(
    'sessions', ss.sessions,
    'visits', ss.visits,
    'events', es.total_events,
    'clicks', es.clicks,
    'orders', es.orders,
    'checkout_opens', es.checkout_opens,
    'revenue', es.revenue,
    'tickets_sold', es.tickets_sold,
    'avg_order', case when es.orders > 0 then round(es.revenue / es.orders) else 0 end,
    'engaged_sessions', ss.engaged,
    'bounce_rate', ss.bounce_rate,
    'avg_activity', ss.avg_activity
  ),
  'funnel', jsonb_build_array(
    jsonb_build_object('key', 'visit',    'label', '페이지 방문', 'count', ss.visits),
    jsonb_build_object('key', 'detail',   'label', '이벤트 상세', 'count', ss.detail),
    jsonb_build_object('key', 'tickets',  'label', '티켓 확인',   'count', ss.tickets),
    jsonb_build_object('key', 'checkout', 'label', '예매 시작',   'count', ss.checkouts),
    jsonb_build_object('key', 'purchase', 'label', '예매 완료',   'count', ss.buyers)
  ),
  'buttons', (select data from button_stats),
  'tickets', (select data from ticket_stats),
  'daily', (select data from daily_stats),
  'devices', (select data from device_stats)
)
from event_stage es, session_stage ss;
$$;

-- ---------------------------------------------------------------------------
-- 3. recent event feed (experiment pilot rows excluded)
-- ---------------------------------------------------------------------------
create or replace function public.get_recent_events(p_limit int default 25)
returns table (
  id bigint,
  session_id text,
  event_name text,
  section text,
  element text,
  metadata jsonb,
  created_at timestamptz
)
language sql
security definer
set search_path = public
as $$
  select
    e.id,
    right(e.session_id, 6) as session_id,
    e.event_name,
    e.section,
    e.element,
    e.metadata,
    e.created_at
  from public.event_logs e
  where coalesce(e.metadata->>'exp_demo', '') <> 'true'
  order by e.created_at desc
  limit greatest(1, least(coalesce(p_limit, 25), 100));
$$;

-- ---------------------------------------------------------------------------
-- 4. session-level correlation / segment stats (includes pilot rows)
-- ---------------------------------------------------------------------------
create or replace function public.get_segment_stats(p_days int default 14)
returns jsonb
language sql
security definer
set search_path = public
as $$
with bounds as (
  select now() - make_interval(days => greatest(1, least(coalesce(p_days, 14), 90))) as since
),
ev as (
  select e.* from public.event_logs e, bounds b where e.created_at >= b.since
),
sessions as (
  select
    session_id,
    bool_or(event_name = 'purchase') as purchased,
    bool_or(event_name = 'checkout_open') as checkout,
    count(*) filter (where event_name = 'click') as clicks,
    count(distinct section) filter (where event_name = 'section_view') as sections,
    max(case when event_name = 'page_view' then metadata->>'device' end) as device,
    max(case when event_name = 'page_view' then
      case
        when referrer ilike '%instagram%' then 'instagram'
        when referrer ilike '%google%' or referrer ilike '%naver%' then 'search'
        when referrer ilike '%pusan.ac.kr%' then 'campus'
        when referrer is null or referrer = '' then 'direct'
        else 'other'
      end
    end) as source,
    min(created_at) as started_at,
    extract(epoch from (max(created_at) - min(created_at))) as activity_seconds
  from ev
  group by session_id
),
labeled as (
  select s.*, extract(hour from (started_at at time zone 'Asia/Seoul'))::int as hour
  from sessions s
),
segments as (
  select 'device' as dimension, coalesce(device, 'unknown') as key,
         count(*) as sessions, count(*) filter (where purchased) as buyers
  from labeled group by coalesce(device, 'unknown')
  union all
  select 'source', coalesce(source, 'direct'), count(*), count(*) filter (where purchased)
  from labeled group by coalesce(source, 'direct')
  union all
  select 'time',
         case when hour >= 18 then 'evening' when hour >= 12 then 'afternoon'
              when hour >= 6 then 'morning' else 'night' end,
         count(*), count(*) filter (where purchased)
  from labeled group by 2
  union all
  select 'clicks',
         case when clicks <= 0 then '0' when clicks = 1 then '1' when clicks = 2 then '2' else '3+' end,
         count(*), count(*) filter (where purchased)
  from labeled group by 2
  union all
  select 'sections',
         case when sections <= 0 then '0' when sections = 1 then '1' when sections = 2 then '2' else '3+' end,
         count(*), count(*) filter (where purchased)
  from labeled group by 2
),
corr_row as (
  select
    count(*) as n,
    corr(case when purchased then 1.0 else 0.0 end, clicks::float8) as r_clicks,
    corr(case when purchased then 1.0 else 0.0 end, sections::float8) as r_sections,
    corr(case when purchased then 1.0 else 0.0 end, activity_seconds::float8) as r_activity,
    corr(case when purchased then 1.0 else 0.0 end, coalesce(device = 'mobile', false)::int::float8) as r_mobile,
    corr(case when purchased then 1.0 else 0.0 end, coalesce(source = 'instagram', false)::int::float8) as r_instagram,
    corr(case when purchased then 1.0 else 0.0 end, (hour >= 18)::int::float8) as r_evening
  from labeled
)
select jsonb_build_object(
  'overall', jsonb_build_object(
    'sessions', (select count(*) from labeled),
    'buyers', (select count(*) from labeled where purchased),
    'checkout_sessions', (select count(*) from labeled where checkout)
  ),
  'segments', coalesce((
    select jsonb_agg(row_to_json(t) order by t.dimension, t.sessions desc)
    from segments t
  ), '[]'::jsonb),
  'correlations', (select jsonb_build_object(
    'n', n, 'clicks', r_clicks, 'sections', r_sections, 'activity', r_activity,
    'mobile', r_mobile, 'instagram', r_instagram, 'evening', r_evening
  ) from corr_row)
);
$$;

-- ---------------------------------------------------------------------------
-- 5. experiment results (live traffic and simulation separated)
-- ---------------------------------------------------------------------------
create or replace function public.get_experiment_stats(p_days int default 14)
returns jsonb
language sql
security definer
set search_path = public
as $$
with bounds as (
  select now() - make_interval(days => greatest(1, least(coalesce(p_days, 14), 90))) as since
),
ev as (
  select e.* from public.event_logs e, bounds b where e.created_at >= b.since
),
exposures as (
  select
    session_id,
    element as exp_key,
    coalesce(metadata->>'variant', 'A') as variant,
    (coalesce(metadata->>'simulated', 'false') = 'true') as is_sim,
    min(created_at) as exposed_at
  from ev
  where event_name = 'experiment_exposure'
    and element in ('exp_price_frame', 'exp_quick_checkout')
  group by session_id, element, coalesce(metadata->>'variant', 'A'),
           (coalesce(metadata->>'simulated', 'false') = 'true')
),
flags as (
  select
    e.exp_key,
    e.variant,
    e.is_sim,
    e.session_id,
    bool_or(o.event_name = 'checkout_open' and o.created_at >= e.exposed_at) as checkout,
    bool_or(o.event_name = 'purchase' and o.created_at >= e.exposed_at) as purchase,
    coalesce(sum(
      case when o.event_name = 'purchase' and o.created_at >= e.exposed_at
                and (o.metadata->>'amount') ~ '^[0-9]+(\.[0-9]+)?$'
           then (o.metadata->>'amount')::numeric else 0 end
    ), 0) as revenue
  from exposures e
  left join ev o on o.session_id = e.session_id
  group by e.exp_key, e.variant, e.is_sim, e.session_id, e.exposed_at
),
agg as (
  select
    exp_key,
    variant,
    is_sim,
    revenue,
    purchase,
    case when exp_key = 'exp_price_frame' then checkout else purchase end as converted
  from flags
),
summary as (
  select
    exp_key,
    variant,
    count(*) filter (where not is_sim) as live_sessions,
    count(*) filter (where not is_sim and converted) as live_conversions,
    count(*) filter (where not is_sim and purchase) as live_purchases,
    coalesce(sum(revenue) filter (where not is_sim), 0) as live_revenue,
    count(*) filter (where is_sim) as sim_sessions,
    count(*) filter (where is_sim and converted) as sim_conversions,
    count(*) filter (where is_sim and purchase) as sim_purchases,
    coalesce(sum(revenue) filter (where is_sim), 0) as sim_revenue
  from agg
  group by exp_key, variant
)
select coalesce(jsonb_agg(jsonb_build_object(
  'key', t.exp_key,
  'variants', t.variants
)), '[]'::jsonb)
from (
  select exp_key, jsonb_agg(jsonb_build_object(
    'variant', variant,
    'live_sessions', live_sessions,
    'live_conversions', live_conversions,
    'live_purchases', live_purchases,
    'live_revenue', live_revenue,
    'sim_sessions', sim_sessions,
    'sim_conversions', sim_conversions,
    'sim_purchases', sim_purchases,
    'sim_revenue', sim_revenue
  ) order by variant) as variants
  from summary
  group by exp_key
) t;
$$;

-- ---------------------------------------------------------------------------
-- 6. demo data for the main funnel
-- ---------------------------------------------------------------------------
create or replace function public.seed_demo_data(p_days int default 14, p_sessions_per_day int default 35)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  d int;
  s int;
  sid text;
  ts timestamptz;
  tt text;
  qty int;
  amt int;
  did_detail boolean;
  did_tickets boolean;
  did_checkout boolean;
  did_buy boolean;
  inserted int := 0;
  v_days int := greatest(1, least(coalesce(p_days, 14), 30));
  v_per_day int := greatest(1, least(coalesce(p_sessions_per_day, 35), 200));
begin
  delete from public.event_logs where metadata->>'demo' = 'true';

  for d in reverse (v_days - 1)..0 loop
    for s in 1..v_per_day loop
      sid := 'demo-' || substr(md5(random()::text || clock_timestamp()::text || d || s), 1, 24);
      ts := date_trunc('day', now()) - make_interval(days => d) + interval '9 hours' + (random() * interval '13 hours');
      if ts > now() then
        ts := now() - (random() * interval '4 hours');
      end if;

      insert into public.event_logs (session_id, event_name, page, referrer, user_agent, metadata, created_at)
      values (sid, 'page_view', '/', case
                when random() < 0.38 then 'https://www.instagram.com/'
                when random() < 0.55 then 'https://www.google.com/'
                when random() < 0.65 then 'https://www.pusan.ac.kr/'
                else null end,
              'demo', jsonb_build_object(
                'demo', true,
                'device', case when random() < 0.64 then 'mobile' else 'desktop' end
              ), ts);
      inserted := inserted + 1;

      if random() < 0.42 then
        insert into public.event_logs (session_id, event_name, page, section, element, metadata, created_at)
        values (sid, 'click', '/', 'hero', 'hero_cta',
                jsonb_build_object('demo', true, 'label', '티켓 예매하기'), ts + interval '5 seconds');
        inserted := inserted + 1;
      end if;

      did_detail := random() < 0.74;
      if did_detail then
        insert into public.event_logs (session_id, event_name, page, section, metadata, created_at)
        values (sid, 'section_view', '/', 'event_info', jsonb_build_object('demo', true), ts + interval '9 seconds');
        inserted := inserted + 1;

        if random() < 0.28 then
          insert into public.event_logs (session_id, event_name, page, section, element, metadata, created_at)
          values (sid, 'click', '/', 'event_info', 'program_detail',
                  jsonb_build_object('demo', true, 'label', '프로그램 자세히'), ts + interval '14 seconds');
          inserted := inserted + 1;
        end if;

        did_tickets := random() < 0.63;
        if did_tickets then
          insert into public.event_logs (session_id, event_name, page, section, metadata, created_at)
          values (sid, 'section_view', '/', 'tickets', jsonb_build_object('demo', true), ts + interval '22 seconds');
          inserted := inserted + 1;

          if random() < 0.34 then
            insert into public.event_logs (session_id, event_name, page, section, element, metadata, created_at)
            values (sid, 'click', '/', 'tickets', 'ticket_solo',
                    jsonb_build_object('demo', true, 'label', '1인 티켓 선택'), ts + interval '30 seconds');
            inserted := inserted + 1;
          end if;

          did_checkout := random() < 0.46;
          if did_checkout then
            insert into public.event_logs (session_id, event_name, page, section, metadata, created_at)
            values (sid, 'checkout_open', '/', 'tickets', jsonb_build_object('demo', true), ts + interval '40 seconds');
            inserted := inserted + 1;

            did_buy := random() < 0.58;
            if did_buy then
              tt := case when random() < 0.55 then 'solo'
                         when random() < 0.78 then 'couple'
                         else 'group' end;
              qty := case tt when 'solo' then 1 when 'couple' then 2 else 4 end;
              amt := case tt when 'solo' then 12000 when 'couple' then 20000 else 45000 end;
              insert into public.event_logs (session_id, event_name, page, section, element, metadata, created_at)
              values (sid, 'purchase', '/', 'checkout', 'checkout_submit',
                      jsonb_build_object(
                        'demo', true,
                        'ticket_type', tt,
                        'quantity', qty,
                        'amount', amt,
                        'order_id', 'PNU-' || upper(substr(md5(random()::text), 1, 6))
                      ), ts + interval '65 seconds');
              inserted := inserted + 2;

              insert into public.event_logs (session_id, event_name, page, section, element, metadata, created_at)
              values (sid, 'click', '/', 'checkout', 'checkout_submit',
                      jsonb_build_object('demo', true, 'label', '예매 확정'), ts + interval '64 seconds');
            else
              insert into public.event_logs (session_id, event_name, page, section, metadata, created_at)
              values (sid, 'checkout_abandon', '/', 'checkout', jsonb_build_object('demo', true), ts + interval '55 seconds');
              inserted := inserted + 1;
            end if;
          end if;
        end if;
      end if;
    end loop;
  end loop;

  return jsonb_build_object('ok', true, 'inserted', inserted, 'days', v_days);
end;
$$;

-- ---------------------------------------------------------------------------
-- 7. A/B pilot simulation data (label: simulated + exp_demo)
-- ---------------------------------------------------------------------------
create or replace function public.seed_experiment_demo(p_days int default 14, p_per_variant int default 1200)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_days int := greatest(7, least(coalesce(p_days, 14), 30));
  v_n int := greatest(600, least(coalesce(p_per_variant, 1200), 3000));
  v_e2 int := greatest(300, least(round(v_n * 0.6)::int, 1800));
  v_events int;
begin
  delete from public.event_logs where metadata->>'exp_demo' = 'true';

  create temp table tmp_e1 on commit drop as
  select
    b.*,
    least(0.85, greatest(0.12,
      0.40
      + case b.source when 'instagram' then 0.06 when 'campus' then 0.04 when 'direct' then -0.05 else 0.0 end
      + case when b.is_mobile then -0.04 else 0.02 end
      + case when b.is_b then 0.06 else 0.0 end
      + case when extract(hour from (b.ts at time zone 'Asia/Seoul')) >= 18 then 0.04 else 0.0 end
    )) as p_checkout,
    least(0.85, greatest(0.15,
      0.55
      + case b.source when 'instagram' then 0.03 when 'campus' then 0.02 when 'direct' then -0.03 else 0.0 end
      + case when b.is_mobile then -0.04 else 0.02 end
      + case when extract(hour from (b.ts at time zone 'Asia/Seoul')) >= 18 then 0.02 else 0.0 end
    )) as p_buy
  from (
    select
      a.*,
      case when a.src_r < 0.40 then 'instagram'
           when a.src_r < 0.65 then 'search'
           when a.src_r < 0.85 then 'direct'
           else 'campus' end as source,
      case when a.src_r < 0.40 then 'https://www.instagram.com/'
           when a.src_r < 0.65 then 'https://www.google.com/'
           when a.src_r < 0.85 then null
           else 'https://www.pusan.ac.kr/' end as referrer,
      now() - interval '6 minutes' - (a.age_r * v_days * 86400) * interval '1 second' as ts
    from (
      select
        'sim-e1-' || substr(md5(g::text || clock_timestamp()::text || random()::text), 1, 20) as sid,
        random() < 0.5 as is_b,
        random() < 0.62 as is_mobile,
        random() as src_r,
        random() as age_r,
        random() as detail_r,
        random() as conv_r,
        random() as buy_r,
        random() as ticket_r,
        random() as faq_r,
        case when random() < 0.45 then 2 else floor(random() * 2)::int end as click_n
      from generate_series(1, 2 * v_n) g
    ) a
  ) b;

  insert into public.event_logs (session_id, event_name, page, section, element, metadata, referrer, user_agent, created_at)
  select sid, 'page_view', '/', null, null,
    jsonb_build_object(
      'simulated', true, 'exp_demo', true,
      'device', case when is_mobile then 'mobile' else 'desktop' end,
      'source', source,
      'experiments', jsonb_build_object('exp_price_frame', case when is_b then 'B' else 'A' end)
    ),
    referrer, 'simulated', ts
  from tmp_e1;

  insert into public.event_logs (session_id, event_name, page, section, element, metadata, referrer, user_agent, created_at)
  select sid, 'section_view', '/', 'event_info', null,
    jsonb_build_object('simulated', true, 'exp_demo', true,
      'experiments', jsonb_build_object('exp_price_frame', case when is_b then 'B' else 'A' end)),
    referrer, 'simulated', ts + interval '7 seconds'
  from tmp_e1 where detail_r < 0.8;

  insert into public.event_logs (session_id, event_name, page, section, element, metadata, referrer, user_agent, created_at)
  select sid, 'section_view', '/', 'faq', null,
    jsonb_build_object('simulated', true, 'exp_demo', true,
      'experiments', jsonb_build_object('exp_price_frame', case when is_b then 'B' else 'A' end)),
    referrer, 'simulated', ts + interval '13 seconds'
  from tmp_e1 where faq_r < 0.30;

  insert into public.event_logs (session_id, event_name, page, section, element, metadata, referrer, user_agent, created_at)
  select sid, 'section_view', '/', 'tickets', null,
    jsonb_build_object('simulated', true, 'exp_demo', true,
      'experiments', jsonb_build_object('exp_price_frame', case when is_b then 'B' else 'A' end)),
    referrer, 'simulated', ts + interval '18 seconds'
  from tmp_e1;

  insert into public.event_logs (session_id, event_name, page, section, element, metadata, referrer, user_agent, created_at)
  select sid, 'experiment_exposure', '/', 'experiment', 'exp_price_frame',
    jsonb_build_object(
      'simulated', true, 'exp_demo', true,
      'exp_key', 'exp_price_frame', 'exp_name', '티켓 가격 프레이밍',
      'variant', case when is_b then 'B' else 'A' end,
      'experiments', jsonb_build_object('exp_price_frame', case when is_b then 'B' else 'A' end)
    ),
    referrer, 'simulated', ts + interval '20 seconds'
  from tmp_e1;

  insert into public.event_logs (session_id, event_name, page, section, element, metadata, referrer, user_agent, created_at)
  select t.sid, 'click', '/', 'hero',
    case g when 1 then 'hero_cta' when 2 then 'ticket_couple' else 'program_detail' end,
    jsonb_build_object(
      'simulated', true, 'exp_demo', true,
      'label', case g when 1 then '티켓 예매하기' when 2 then 'COUPLE 티켓 선택' else '프로그램 자세히' end,
      'experiments', jsonb_build_object('exp_price_frame', case when t.is_b then 'B' else 'A' end)
    ),
    t.referrer, 'simulated', t.ts + interval '12 seconds'
  from tmp_e1 t
  cross join lateral generate_series(1, greatest(t.click_n, 0)) g;

  insert into public.event_logs (session_id, event_name, page, section, element, metadata, referrer, user_agent, created_at)
  select sid, 'checkout_open', '/', 'tickets', null,
    jsonb_build_object('simulated', true, 'exp_demo', true,
      'experiments', jsonb_build_object('exp_price_frame', case when is_b then 'B' else 'A' end)),
    referrer, 'simulated', ts + interval '40 seconds'
  from tmp_e1 where conv_r < p_checkout;

  insert into public.event_logs (session_id, event_name, page, section, element, metadata, referrer, user_agent, created_at)
  select sid, 'purchase', '/', 'checkout', 'checkout_submit',
    jsonb_build_object(
      'simulated', true, 'exp_demo', true,
      'ticket_type', case when ticket_r < 0.55 then 'solo' when ticket_r < 0.78 then 'couple' else 'group' end,
      'quantity', case when ticket_r < 0.55 then 1 when ticket_r < 0.78 then 2 else 4 end,
      'amount', case when ticket_r < 0.55 then 12000 when ticket_r < 0.78 then 20000 else 45000 end,
      'order_id', 'SIM-' || upper(substr(md5(sid || 'e1'), 1, 6)),
      'experiments', jsonb_build_object('exp_price_frame', case when is_b then 'B' else 'A' end)
    ),
    referrer, 'simulated', ts + interval '65 seconds'
  from tmp_e1 where conv_r < p_checkout and buy_r < p_buy;

  create temp table tmp_e2 on commit drop as
  select
    b.*,
    least(0.9, greatest(0.15,
      0.52
      + case b.source when 'instagram' then 0.03 when 'campus' then 0.02 when 'direct' then -0.03 else 0.0 end
      + case when b.is_mobile then -0.06 else 0.02 end
      + case when b.is_b then 0.11 else 0.0 end
      + case when extract(hour from (b.ts at time zone 'Asia/Seoul')) >= 18 then 0.03 else 0.0 end
    )) as p_buy
  from (
    select
      a.*,
      case when a.src_r < 0.40 then 'instagram'
           when a.src_r < 0.65 then 'search'
           when a.src_r < 0.85 then 'direct'
           else 'campus' end as source,
      case when a.src_r < 0.40 then 'https://www.instagram.com/'
           when a.src_r < 0.65 then 'https://www.google.com/'
           when a.src_r < 0.85 then null
           else 'https://www.pusan.ac.kr/' end as referrer,
      now() - interval '6 minutes' - (a.age_r * v_days * 86400) * interval '1 second' as ts
    from (
      select
        'sim-e2-' || substr(md5(g::text || clock_timestamp()::text || random()::text), 1, 20) as sid,
        random() < 0.5 as is_b,
        random() < 0.64 as is_mobile,
        random() as src_r,
        random() as age_r,
        random() as detail_r,
        random() as buy_r,
        random() as ticket_r,
        random() as faq_r,
        case when random() < 0.55 then 2 else floor(random() * 2)::int end as click_n
      from generate_series(1, 2 * v_e2) g
    ) a
  ) b;

  insert into public.event_logs (session_id, event_name, page, section, element, metadata, referrer, user_agent, created_at)
  select sid, 'page_view', '/', null, null,
    jsonb_build_object(
      'simulated', true, 'exp_demo', true,
      'device', case when is_mobile then 'mobile' else 'desktop' end,
      'source', source,
      'experiments', jsonb_build_object('exp_quick_checkout', case when is_b then 'B' else 'A' end)
    ),
    referrer, 'simulated', ts
  from tmp_e2;

  insert into public.event_logs (session_id, event_name, page, section, element, metadata, referrer, user_agent, created_at)
  select sid, 'section_view', '/', 'event_info', null,
    jsonb_build_object('simulated', true, 'exp_demo', true,
      'experiments', jsonb_build_object('exp_quick_checkout', case when is_b then 'B' else 'A' end)),
    referrer, 'simulated', ts + interval '7 seconds'
  from tmp_e2 where detail_r < 0.8;

  insert into public.event_logs (session_id, event_name, page, section, element, metadata, referrer, user_agent, created_at)
  select sid, 'section_view', '/', 'faq', null,
    jsonb_build_object('simulated', true, 'exp_demo', true,
      'experiments', jsonb_build_object('exp_quick_checkout', case when is_b then 'B' else 'A' end)),
    referrer, 'simulated', ts + interval '13 seconds'
  from tmp_e2 where faq_r < 0.30;

  insert into public.event_logs (session_id, event_name, page, section, element, metadata, referrer, user_agent, created_at)
  select sid, 'section_view', '/', 'tickets', null,
    jsonb_build_object('simulated', true, 'exp_demo', true,
      'experiments', jsonb_build_object('exp_quick_checkout', case when is_b then 'B' else 'A' end)),
    referrer, 'simulated', ts + interval '18 seconds'
  from tmp_e2;

  insert into public.event_logs (session_id, event_name, page, section, element, metadata, referrer, user_agent, created_at)
  select t.sid, 'click', '/', 'hero',
    case g when 1 then 'hero_cta' when 2 then 'ticket_couple' else 'program_detail' end,
    jsonb_build_object(
      'simulated', true, 'exp_demo', true,
      'label', case g when 1 then '티켓 예매하기' when 2 then 'COUPLE 티켓 선택' else '프로그램 자세히' end,
      'experiments', jsonb_build_object('exp_quick_checkout', case when t.is_b then 'B' else 'A' end)
    ),
    t.referrer, 'simulated', t.ts + interval '12 seconds'
  from tmp_e2 t
  cross join lateral generate_series(1, greatest(t.click_n, 0)) g;

  insert into public.event_logs (session_id, event_name, page, section, element, metadata, referrer, user_agent, created_at)
  select sid, 'checkout_open', '/', 'tickets', null,
    jsonb_build_object('simulated', true, 'exp_demo', true,
      'experiments', jsonb_build_object('exp_quick_checkout', case when is_b then 'B' else 'A' end)),
    referrer, 'simulated', ts + interval '30 seconds'
  from tmp_e2;

  insert into public.event_logs (session_id, event_name, page, section, element, metadata, referrer, user_agent, created_at)
  select sid, 'experiment_exposure', '/', 'experiment', 'exp_quick_checkout',
    jsonb_build_object(
      'simulated', true, 'exp_demo', true,
      'exp_key', 'exp_quick_checkout', 'exp_name', '결제 마찰 (원클릭 예매)',
      'variant', case when is_b then 'B' else 'A' end,
      'experiments', jsonb_build_object('exp_quick_checkout', case when is_b then 'B' else 'A' end)
    ),
    referrer, 'simulated', ts + interval '31 seconds'
  from tmp_e2;

  insert into public.event_logs (session_id, event_name, page, section, element, metadata, referrer, user_agent, created_at)
  select sid, 'purchase', '/', 'checkout', 'checkout_submit',
    jsonb_build_object(
      'simulated', true, 'exp_demo', true,
      'ticket_type', case when ticket_r < 0.55 then 'solo' when ticket_r < 0.78 then 'couple' else 'group' end,
      'quantity', case when ticket_r < 0.55 then 1 when ticket_r < 0.78 then 2 else 4 end,
      'amount', case when ticket_r < 0.55 then 12000 when ticket_r < 0.78 then 20000 else 45000 end,
      'order_id', 'SIM-' || upper(substr(md5(sid || 'e2'), 1, 6)),
      'experiments', jsonb_build_object('exp_quick_checkout', case when is_b then 'B' else 'A' end)
    ),
    referrer, 'simulated', ts + interval '50 seconds'
  from tmp_e2 where buy_r < p_buy;

  select count(*) into v_events
  from public.event_logs
  where metadata->>'exp_demo' = 'true';

  return jsonb_build_object(
    'ok', true,
    'events', v_events,
    'e1_sessions', 2 * v_n,
    'e2_sessions', 2 * v_e2,
    'days', v_days
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 8. execute grants (public read-only aggregates + insert-only log)
-- ---------------------------------------------------------------------------
revoke all on function public.get_growth_stats(int, boolean) from public;
revoke all on function public.get_recent_events(int) from public;
revoke all on function public.get_segment_stats(int) from public;
revoke all on function public.get_experiment_stats(int) from public;
revoke all on function public.seed_demo_data(int, int) from public;
revoke all on function public.seed_experiment_demo(int, int) from public;

grant execute on function public.get_growth_stats(int, boolean) to anon, authenticated;
grant execute on function public.get_recent_events(int) to anon, authenticated;
grant execute on function public.get_segment_stats(int) to anon, authenticated;
grant execute on function public.get_experiment_stats(int) to anon, authenticated;
grant execute on function public.seed_demo_data(int, int) to anon, authenticated;
grant execute on function public.seed_experiment_demo(int, int) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- 9. optional: seed demo data immediately
-- ---------------------------------------------------------------------------
-- select public.seed_demo_data(14, 35);
-- select public.seed_experiment_demo(14, 1200);
