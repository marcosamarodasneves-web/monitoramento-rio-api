import { describe, expect, it } from 'vitest';
import { getCentralForecasts } from './forecast';
const now=Date.parse('2026-11-13T01:00:00Z');
function fakeDb(details:any){
 const reads:any[]=[];
 return {reads,db:{from:(table:string)=>{
   const q:any={fields:'',eqs:[]};
   for(const method of ['gte','order','limit'])q[method]=()=>q;
   q.select=(fields:string)=>{q.fields=fields;return q;};q.eq=(key:string,v:any)=>{q.eqs.push([key,v]);return q;};
   q.then=(resolve:any)=>{reads.push({table,fields:q.fields,eqs:q.eqs});return Promise.resolve({error:null,data:table==='river_forecasts_accuracy_v2'?[]:q.fields==='details'?[{details}]:[]}).then(resolve);};
   return q;
 }}};
}
describe('contrato central v2',()=>{
 it('retorna resultado persistido sem recalcular ou escrever no banco',async()=>{const f={bridge:'dom-tito',available:true,base_time:new Date(now-5*60000).toISOString(),horizons:[{hours:1,predicted_level:5.1}]};const mock=fakeDb(f);const a=await getCentralForecasts(mock.db as any,'dom-tito',24,now);const b=await getCentralForecasts(mock.db as any,'dom-tito',24,now);expect(a.latest).toEqual(b.latest);expect(a.latest[0]).toEqual(f);const central=mock.reads.filter(r=>r.table==='central_river_forecasts');expect(central.length).toBeGreaterThan(0);expect(central.every(r=>r.eqs.some(([k,v]:any[])=>k==='model_version'&&v==='deterministic-v2'))).toBe(true);expect(mock.reads.some(r=>r.table==='river_forecasts')).toBe(false);});
 it('não oferece como atual uma previsão com mais de 30min',async()=>{const mock=fakeDb({base_time:new Date(now-31*60000).toISOString(),available:true});const r=await getCentralForecasts(mock.db as any,'dom-tito',24,now);expect(r.latest[0].available).toBe(false);expect(r.accuracy).toEqual([]);});
 it('rejeita horário inválido ou futuro',async()=>{for(const base_time of ['invalid',new Date(now+60000).toISOString()]){const mock=fakeDb({base_time,available:true});expect((await getCentralForecasts(mock.db as any,'br-470',24,now)).latest[0].available).toBe(false);}});
 it('valida ponte e janela de consulta',async()=>{const mock=fakeDb(null);await expect(getCentralForecasts(mock.db as any,'wrong',24,now)).rejects.toThrow();await expect(getCentralForecasts(mock.db as any,'br-470',NaN,now)).rejects.toThrow();});
});
