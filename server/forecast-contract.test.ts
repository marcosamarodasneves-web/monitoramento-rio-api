import { describe, expect, it } from 'vitest';
import { getCentralForecasts } from './forecast';
const now=Date.parse('2026-11-13T01:00:00Z');
function fakeDb(details:any,history:any[]=[]){
 const reads:any[]=[];
 return {reads,db:{from:(table:string)=>{
   const q:any={fields:'',eqs:[],ins:[]};
   for(const method of ['gte','order','limit'])q[method]=()=>q;
   q.select=(fields:string)=>{q.fields=fields;return q;};
   q.eq=(key:string,v:any)=>{q.eqs.push([key,v]);return q;};
   q.in=(key:string,v:any)=>{q.ins.push([key,v]);return q;};
   q.then=(resolve:any)=>{
    reads.push({table,fields:q.fields,eqs:q.eqs,ins:q.ins});
    const data=table.startsWith('river_forecasts_accuracy_')?[]:q.fields==='details,model_version'?(details?[{details,model_version:details.model_version}]:[]):history;
    return Promise.resolve({error:null,data}).then(resolve);
   };
   return q;
 }}};
}
function fresh(version='adaptive-v3'){return {bridge:'dom-tito',model_version:version,available:true,base_time:new Date(now-5*60000).toISOString(),horizons:[{hours:1,predicted_level:5.1}]};}
describe('contrato central adaptativo',()=>{
 it('retorna resultado persistido sem recalcular e sem escrever no banco',async()=>{
  const f=fresh(),mock=fakeDb(f);const a=await getCentralForecasts(mock.db as any,'dom-tito',24,now);const b=await getCentralForecasts(mock.db as any,'dom-tito',24,now);
  expect(a.latest).toEqual(b.latest);expect(a.latest[0]).toEqual(f);expect(a.model_version).toBe('adaptive-v3');
  expect(mock.reads.some(r=>r.table==='river_forecasts_accuracy_v3')).toBe(true);
  expect(mock.reads.some(r=>r.table==='river_forecasts')).toBe(false);
  expect(mock.reads.filter(r=>r.fields==='*'&&r.table==='central_river_forecasts').every(r=>r.eqs.some(([k,v]:any[])=>k==='model_version'&&v==='adaptive-v3'))).toBe(true);
 });
 it('permite v2 como fallback sem rotular sua acurácia como v3',async()=>{
  const mock=fakeDb(fresh('deterministic-v2'));const r=await getCentralForecasts(mock.db as any,'dom-tito',24,now);
  expect(r.model_version).toBe('deterministic-v2');expect(r.latest[0].available).toBe(true);
  expect(mock.reads.some(r=>r.table==='river_forecasts_accuracy_v2')).toBe(true);
  expect(mock.reads.some(r=>r.table==='river_forecasts_accuracy_v3')).toBe(false);
 });
 it('não oferece como atual uma previsão com mais de 30min',async()=>{const mock=fakeDb({...fresh(),base_time:new Date(now-31*60000).toISOString()});const r=await getCentralForecasts(mock.db as any,'dom-tito',24,now);expect(r.latest[0].available).toBe(false);expect(r.accuracy).toEqual([]);});
 it('rejeita horário inválido ou futuro',async()=>{for(const base_time of ['invalid',new Date(now+60000).toISOString()]){const mock=fakeDb({...fresh(),base_time});expect((await getCentralForecasts(mock.db as any,'br-470',24,now)).latest[0].available).toBe(false);}});
 it('informa retenção/estatística de 60 dias e valida consultas',async()=>{
  const mock=fakeDb(fresh());const r=await getCentralForecasts(mock.db as any,'dom-tito',1440,now);expect(r.accuracy_days).toBe(60);expect(r.retention_days).toBe(60);
  for(const hours of [NaN,0,1441])await expect(getCentralForecasts(mock.db as any,'br-470',hours,now)).rejects.toThrow();
  await expect(getCentralForecasts(mock.db as any,'wrong',24,now)).rejects.toThrow();
 });
 it('remove detalhes internos e indica histórico truncado',async()=>{
  const rows=Array.from({length:1000},(_,id)=>({id,details:{secret:'none'},device_bucket:'internal',learning_applied:true,predicted_level:5}));
  const mock=fakeDb(fresh(),rows);const r=await getCentralForecasts(mock.db as any,'dom-tito',1440,now);
  expect(r.history_truncated).toBe(true);expect(r.forecasts[0]).not.toHaveProperty('details');expect(r.forecasts[0]).not.toHaveProperty('learning_applied');
 });
});
