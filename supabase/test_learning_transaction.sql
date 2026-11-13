-- Teste de infraestrutura, com rollback obrigatório: nenhum dado de teste permanece.
begin;
do $$
declare f1 bigint;f2 bigint;r jsonb;prior jsonb;rev bigint;next_state jsonb;
begin
 select state,revision into prior,rev from public.forecast_learning_state where bridge='dom-tito' and horizon_h=1 and regime='stable';
 prior:=coalesce(prior,'{"version":"adaptive-v3","regime":"stable","state_count":0,"weights":{"persistence":0.5,"damped":0.3,"trend":0.2,"acceleration":0}}'::jsonb);
 rev:=coalesce(rev,0);
 next_state:=jsonb_set(prior,'{state_count}',to_jsonb(coalesce((prior->>'state_count')::int,0)+1));
 insert into public.central_river_forecasts(bridge,horizon_h,base_time,target_time,current_level,predicted_level,band_cm,tolerance_cm,outcome,actual_level,actual_time,model_version,details)
 values('dom-tito',1,'1900-01-01T00:00:00Z','1900-01-01T01:00:00Z',4.2,4.3,20,20,'dentro',4.3,'1900-01-01T01:00:00Z','adaptive-v3','{"adaptive":{"horizons":{"1":{"regime":"stable"}}}}') returning id into f1;
 r:=public.apply_forecast_learning_event(f1,'stable',rev,prior,next_state,'{"infrastructure_test":true}'::jsonb);
 if r->>'applied'<>'true' then raise exception 'Primeiro evento não aplicado: %',r;end if;
 r:=public.apply_forecast_learning_event(f1,'stable',rev,prior,next_state,'{}'::jsonb);
 if r->>'already_applied'<>'true' then raise exception 'Duplicação não bloqueada: %',r;end if;
 if (select count(*) from public.forecast_learning_events where forecast_id=f1)<>1 then raise exception 'Evento duplicado';end if;
 insert into public.central_river_forecasts(bridge,horizon_h,base_time,target_time,current_level,predicted_level,band_cm,tolerance_cm,outcome,actual_level,actual_time,model_version,details)
 values('dom-tito',1,'1900-01-02T00:00:00Z','1900-01-02T01:00:00Z',4.2,4.3,20,20,'dentro',4.3,'1900-01-02T01:00:00Z','adaptive-v3','{"adaptive":{"horizons":{"1":{"regime":"stable"}}}}') returning id into f2;
 r:=public.apply_forecast_learning_event(f2,'stable',rev,prior,next_state,'{}'::jsonb);
 if r->>'conflict'<>'true' then raise exception 'Conflito de revisão não bloqueado: %',r;end if;
 if exists(select 1 from public.forecast_learning_events where forecast_id=f2) then raise exception 'Conflito alterou auditoria';end if;
 if has_table_privilege('anon','public.forecast_learning_state','INSERT') then raise exception 'Estado exposto ao anon';end if;
 if has_function_privilege('anon','public.apply_forecast_learning_event(bigint,text,bigint,jsonb,jsonb,jsonb)','EXECUTE') then raise exception 'RPC exposta ao anon';end if;
end; $$;
rollback;
select 'PASS: idempotência, compare-and-swap e privilégios; dados de teste revertidos' as resultado;
