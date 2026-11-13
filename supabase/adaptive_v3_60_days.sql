-- Aplicar depois de forecast_v2.sql. Não apaga nem reclassifica previsões existentes.
begin;
alter table public.central_river_forecasts add column if not exists learning_applied boolean not null default false;
create index if not exists central_forecast_learning_queue_idx on public.central_river_forecasts(model_version,target_time,id) where learning_applied=false and outcome in('dentro','quase','fora');

create table if not exists public.forecast_learning_state (
 bridge text not null references public.bridges(id),
 horizon_h smallint not null check(horizon_h between 1 and 3),
 regime text not null check(regime in('stable','rising','falling','turning')),
 state jsonb not null default '{}',
 revision bigint not null default 0,
 enabled boolean not null default true,
 updated_at timestamptz not null default now(),
 primary key(bridge,horizon_h,regime)
);
create table if not exists public.forecast_learning_events (
 forecast_id bigint primary key references public.central_river_forecasts(id) on delete cascade,
 bridge text not null,
 horizon_h smallint not null,
 regime text not null,
 before_state jsonb not null,
 after_state jsonb not null,
 metrics jsonb not null,
 event_at timestamptz not null default now()
);
create index if not exists forecast_learning_events_time_idx on public.forecast_learning_events(event_at);
alter table public.forecast_learning_state enable row level security;
alter table public.forecast_learning_events enable row level security;
revoke all on public.forecast_learning_state,public.forecast_learning_events from anon,authenticated;
grant all on public.forecast_learning_state,public.forecast_learning_events to service_role;

-- Compare-and-swap protege contra cron simultâneo; evento e atualização são atômicos.
create or replace function public.apply_forecast_learning_event(
 p_forecast_id bigint,p_regime text,p_expected_revision bigint,p_before_state jsonb,p_after_state jsonb,p_metrics jsonb
) returns jsonb language plpgsql security definer set search_path=public as $$
declare f public.central_river_forecasts%rowtype;s public.forecast_learning_state%rowtype;issued_regime text;
begin
 select * into f from public.central_river_forecasts where id=p_forecast_id for update;
 if not found then return jsonb_build_object('skipped','missing'); end if;
 if f.learning_applied then return jsonb_build_object('already_applied',true); end if;
 if f.model_version<>'adaptive-v3' or f.outcome not in('dentro','quase','fora') or f.actual_level is null then
  return jsonb_build_object('skipped','not_verified');
 end if;
 issued_regime:=f.details->'adaptive'->'horizons'->(f.horizon_h::text)->>'regime';
 if p_regime is distinct from issued_regime or p_regime not in('stable','rising','falling','turning') then
  raise exception 'Regime não corresponde ao congelado na previsão';
 end if;
 if jsonb_typeof(p_before_state)<>'object' or jsonb_typeof(p_after_state)<>'object' then raise exception 'Estado inválido'; end if;
 insert into public.forecast_learning_state(bridge,horizon_h,regime,state)
 values(f.bridge,f.horizon_h,p_regime,p_before_state) on conflict do nothing;
 select * into s from public.forecast_learning_state where bridge=f.bridge and horizon_h=f.horizon_h and regime=p_regime for update;
 if not s.enabled then return jsonb_build_object('skipped','disabled'); end if;
 if s.revision<>p_expected_revision then return jsonb_build_object('conflict',true,'revision',s.revision); end if;
 insert into public.forecast_learning_events(forecast_id,bridge,horizon_h,regime,before_state,after_state,metrics)
 values(f.id,f.bridge,f.horizon_h,p_regime,
   jsonb_build_object('revision',s.revision,'state_count',s.state->'state_count','weights',s.state->'weights','champion',s.state->'champion','challenger',s.state->'challenger'),
   jsonb_build_object('revision',s.revision+1,'state_count',p_after_state->'state_count','weights',p_after_state->'weights','champion',p_after_state->'champion','challenger',p_after_state->'challenger'),p_metrics);
 update public.forecast_learning_state set state=p_after_state,revision=revision+1,updated_at=now()
 where bridge=f.bridge and horizon_h=f.horizon_h and regime=p_regime;
 update public.central_river_forecasts set learning_applied=true where id=f.id;
 return jsonb_build_object('applied',true,'revision',s.revision+1);
end; $$;
revoke all on function public.apply_forecast_learning_event(bigint,text,bigint,jsonb,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.apply_forecast_learning_event(bigint,text,bigint,jsonb,jsonb,jsonb) to service_role;

create or replace view public.river_forecasts_accuracy_v3 with(security_invoker=true) as
select bridge,horizon_h,model_version,count(*) as previsoes,
 count(*) filter(where outcome in('dentro','quase','fora')) as conferidas,
 count(*) filter(where outcome='dentro') as dentro_da_margem,
 count(*) filter(where outcome='quase') as quase,
 count(*) filter(where outcome='fora') as fora,
 count(*) filter(where outcome='sem_medicao') as sem_medicao,
 100.0*count(*) filter(where outcome='dentro')/nullif(count(*) filter(where outcome in('dentro','quase','fora')),0) as pct_dentro,
 avg(abs(error_cm)) filter(where outcome in('dentro','quase','fora')) as erro_medio_cm
from public.central_river_forecasts where model_version='adaptive-v3' and base_time>=now()-interval '60 days'
group by bridge,horizon_h,model_version;
create or replace view public.river_forecasts_accuracy_v2 with(security_invoker=true) as
select bridge,horizon_h,model_version,count(*) as previsoes,
 count(*) filter(where outcome in('dentro','quase','fora')) as conferidas,
 count(*) filter(where outcome='dentro') as dentro_da_margem,
 count(*) filter(where outcome='quase') as quase,
 count(*) filter(where outcome='fora') as fora,
 count(*) filter(where outcome='sem_medicao') as sem_medicao,
 100.0*count(*) filter(where outcome='dentro')/nullif(count(*) filter(where outcome in('dentro','quase','fora')),0) as pct_dentro,
 avg(abs(error_cm)) filter(where outcome in('dentro','quase','fora')) as erro_medio_cm
from public.central_river_forecasts where model_version='deterministic-v2' and base_time>=now()-interval '60 days'
group by bridge,horizon_h,model_version;
revoke all on public.river_forecasts_accuracy_v3 from anon,authenticated;
grant select on public.river_forecasts_accuracy_v3 to service_role;

-- Manter o nome antigo evita que o backend publicado continue limpando em 7 dias.
create or replace function public.cleanup_forecast_v2()
returns void language plpgsql security definer set search_path=public as $$
begin
 delete from public.river_forecasts where base_time<now()-interval '60 days';
 delete from public.central_river_forecasts where base_time<now()-interval '60 days';
 delete from public.forecast_context where collected_at<now()-interval '60 days';
 delete from public.forecast_learning_events where event_at<now()-interval '60 days';
 -- Não apagar forecast_learning_state: memória agregada persiste após expirar os detalhes.
end; $$;
create or replace function public.cleanup_old_hydrology_readings()
returns void language sql security definer set search_path=public as $$
 delete from public.river_readings where collected_at<now()-interval '60 days';
 delete from public.dam_readings where collected_at<now()-interval '60 days';
 delete from public.collector_runs where started_at<now()-interval '60 days';
 delete from public.daily_access where access_date<current_date-60;
 delete from public.river_forecasts where target_time<now()-interval '60 days';
$$;
revoke all on function public.cleanup_forecast_v2(),public.cleanup_old_hydrology_readings() from public,anon,authenticated;
grant execute on function public.cleanup_forecast_v2(),public.cleanup_old_hydrology_readings() to service_role;
notify pgrst,'reload schema';
commit;
