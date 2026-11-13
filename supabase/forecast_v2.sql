-- Migração aditiva. As previsões antigas permanecem na tabela legada.
begin;
alter table public.river_forecasts add column if not exists model_version text not null default 'legacy';
alter table public.river_forecasts add column if not exists details jsonb;
create index if not exists river_forecasts_model_base_idx on public.river_forecasts(model_version,bridge,base_time desc);

-- Exclusiva do backend: versões antigas do APK não escrevem nesta tabela.
create table if not exists public.central_river_forecasts (
 id bigint generated always as identity primary key,
 bridge text not null references public.bridges(id),
 horizon_h smallint not null check(horizon_h between 1 and 3),
 base_time timestamptz not null,
 target_time timestamptz not null,
 station_id text not null default '',
 device_bucket text not null default 'backend-v2',
 current_level double precision not null,
 predicted_level double precision not null,
 band_cm double precision not null check(band_cm>0),
 tolerance_cm double precision not null check(tolerance_cm>0),
 confidence smallint not null default 0,
 outcome text not null default 'pendente',
 actual_level double precision,
 actual_time timestamptz,
 error_cm double precision,
 model_version text not null default 'deterministic-v2',
 details jsonb not null,
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 unique(bridge,target_time,horizon_h,model_version)
);
create index if not exists central_forecast_base_idx on public.central_river_forecasts(bridge,model_version,base_time desc);
alter table public.central_river_forecasts enable row level security;
revoke all on public.central_river_forecasts from anon,authenticated;
grant all on public.central_river_forecasts to service_role;
grant usage,select on sequence public.central_river_forecasts_id_seq to service_role;

create table if not exists public.forecast_context (
 collected_at timestamptz primary key,source text not null,payload jsonb not null,
 created_at timestamptz not null default now()
);
alter table public.forecast_context enable row level security;
revoke all on public.forecast_context from anon,authenticated;
grant all on public.forecast_context to service_role;

create table if not exists public.forecast_calibration (
 bridge_id text primary key references public.bridges(id),parameters jsonb not null default '{}',
 notes text not null default 'Sem calibração hidrológica: chuva e manobras são contexto, não conversão mm→cm.',
 updated_at timestamptz not null default now()
);
alter table public.forecast_calibration enable row level security;
revoke all on public.forecast_calibration from anon,authenticated;
grant all on public.forecast_calibration to service_role;
insert into public.forecast_calibration(bridge_id) select id from public.bridges on conflict(bridge_id) do nothing;

create table if not exists public.forecast_jobs (
 job_key text primary key,schedule_cron_task_uid varchar(65) unique,
 enabled boolean not null default false
);
alter table public.forecast_jobs enable row level security;
revoke all on public.forecast_jobs from anon,authenticated;
grant all on public.forecast_jobs to service_role;
insert into public.forecast_jobs(job_key) values('hydrology-collector') on conflict(job_key) do nothing;

create or replace view public.river_forecasts_accuracy_v2 with(security_invoker=true) as
select bridge,horizon_h,model_version,count(*) as previsoes,
 count(*) filter(where outcome in('dentro','quase','fora')) as conferidas,
 count(*) filter(where outcome='dentro') as dentro_da_margem,
 count(*) filter(where outcome='quase') as quase,
 count(*) filter(where outcome='fora') as fora,
 count(*) filter(where outcome='sem_medicao') as sem_medicao,
 100.0*count(*) filter(where outcome='dentro')/nullif(count(*) filter(where outcome in('dentro','quase','fora')),0) as pct_dentro,
 avg(abs(error_cm)) filter(where outcome in('dentro','quase','fora')) as erro_medio_cm
from public.central_river_forecasts
where model_version='deterministic-v2' and base_time>=now()-interval '7 days'
group by bridge,horizon_h,model_version;

create or replace function public.cleanup_forecast_v2()
returns void language plpgsql security definer set search_path=public as $$
begin
 delete from public.river_forecasts where base_time<now()-interval '7 days';
 delete from public.central_river_forecasts where base_time<now()-interval '7 days';
 delete from public.forecast_context where collected_at<now()-interval '7 days';
end; $$;
revoke all on function public.cleanup_forecast_v2() from public,anon,authenticated;
grant execute on function public.cleanup_forecast_v2() to service_role;
notify pgrst,'reload schema';
commit;
