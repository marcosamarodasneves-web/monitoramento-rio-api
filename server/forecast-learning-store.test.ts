import { describe, expect, it } from 'vitest';
import { learnVerifiedForecasts } from './forecast-learning-store';
import { initialLearningState } from './forecast-adaptive-model';
const now=Date.parse('2026-11-13T16:00:00Z');
function record(id=1){return {id,bridge:'ricardo-kanitz',horizon_h:2,base_time:new Date(now-3*3600000).toISOString(),target_time:new Date(now-3600000).toISOString(),current_level:5.2,predicted_level:5.3,actual_level:5.25,actual_time:new Date(now-3600000).toISOString(),details:{generated_at:new Date(now-3*3600000).toISOString(),adaptive:{horizons:{2:{regime:'stable',revision:0,candidates:{persistence:5.2,damped:5.25,trend:5.3,acceleration:5.4}}}}}};}
function fake(rows:any[],conflictOnce=false,disabled=false){
 let state:any=null, revision=0;const events=new Set<number>(),calls:any[]=[];
 const db:any={from:(table:string)=>{
  const q:any={};for(const key of ['select','eq','in','lte','order','limit','maybeSingle'])q[key]=()=>q;
  q.then=(resolve:any)=>Promise.resolve({error:null,data:table==='central_river_forecasts'?rows.filter(r=>!events.has(r.id)):state?{state,revision,enabled:!disabled}:disabled?{state:initialLearningState('stable'),revision:0,enabled:false}:null}).then(resolve);
  return q;
 },rpc:async(name:string,args:any)=>{
  calls.push({name,args});
  if(events.has(args.p_forecast_id))return {data:{already_applied:true},error:null};
  if(conflictOnce){conflictOnce=false;return {data:{conflict:true,revision},error:null};}
  if(args.p_expected_revision!==revision)return {data:{conflict:true,revision},error:null};
  state=args.p_after_state;revision++;events.add(args.p_forecast_id);return {data:{applied:true,revision},error:null};
 }};
 return {db,calls,events,getState:()=>state};
}
describe('persistência do aprendizado',()=>{
 it('processa a conferência uma vez e o segundo ciclo não aprende novamente',async()=>{
  const f=fake([record()]);expect((await learnVerifiedForecasts(f.db,now)).applied).toBe(1);
  expect((await learnVerifiedForecasts(f.db,now)).applied).toBe(0);expect(f.getState().state_count).toBe(1);
  expect(f.calls[0].args.p_forecast_id).toBe(1);expect(f.calls[0].args.p_regime).toBe('stable');
 });
 it('não usa uma medição futura nem uma medição ausente',async()=>{
  const f=fake([{...record(1),actual_time:new Date(now+60000).toISOString()},{...record(2),actual_level:null}]);
  expect((await learnVerifiedForecasts(f.db,now)).applied).toBe(0);expect(f.calls).toHaveLength(0);
 });
 it('não treina quando o administrador desativou a chave',async()=>{
  const f=fake([record()],false,true);expect((await learnVerifiedForecasts(f.db,now)).applied).toBe(0);expect(f.calls).toHaveLength(0);
 });
 it('recarrega estado e tenta novamente um conflito de revisão sem duplicar eventos',async()=>{
  const f=fake([record()],true);const r=await learnVerifiedForecasts(f.db,now);
  expect(r.applied).toBe(1);expect(r.conflicts).toBe(1);expect(f.events.size).toBe(1);expect(f.getState().state_count).toBe(1);
 });
});
