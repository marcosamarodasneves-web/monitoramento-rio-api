import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
import { writeFileSync } from "node:fs";
import { computeForecastV2 } from "../server/forecast-model-v2";
const url=process.env.SUPABASE_URL,key=process.env.SUPABASE_KEY;
if(!url||!key) throw new Error('Configure SUPABASE_URL e SUPABASE_KEY somente no servidor.');
const db=createClient(url,key,{auth:{persistSession:false}}), now=Date.now(), hour=3600000;
const all:any[]=[];
for(let offset=0;;offset+=1000){
 const result=await db.from('river_readings').select('id,bridge_id,measured_at,level_m').gte('measured_at',new Date(now-7*24*hour).toISOString()).lte('measured_at',new Date(now).toISOString()).order('measured_at').order('id').range(offset,offset+999);
 if(result.error)throw result.error;all.push(...(result.data??[]));if((result.data?.length??0)<1000)break;if(offset>50000)throw Error('Retenção excede limite');
}
const scores:any[]=[];
for(const bridge of ['dom-tito','br-470','ricardo-kanitz']){
 const samples=all.filter(s=>s.bridge_id===bridge&&s.level_m!==null).map(s=>({measured_at:s.measured_at,level_m:Number(s.level_m)}));
 const errors=new Map<number,any[]>();let lastIssue=0;
 for(const sample of samples){
  const issue=Date.parse(sample.measured_at);if(issue-lastIssue<30*60000)continue;lastIssue=issue;
  // Each issue can see only its own past; held-out readings never enter the model.
  const input=samples.filter(s=>Date.parse(s.measured_at)<=issue&&Date.parse(s.measured_at)>=issue-6*hour);
  const prediction=computeForecastV2({bridge:{id:bridge,station_id:null},samples:input,now:issue});if(!prediction.available)continue;
  for(const h of prediction.horizons){
   const target=Date.parse(h.target_time);if(target+10*60000>now)continue;
   const nearest=samples.filter(s=>Date.parse(s.measured_at)>issue&&Math.abs(Date.parse(s.measured_at)-target)<=10*60000).sort((a,b)=>Math.abs(Date.parse(a.measured_at)-target)-Math.abs(Date.parse(b.measured_at)-target))[0];if(!nearest)continue;
   const error=Math.abs(h.predicted_level-nearest.level_m)*100, baseline=Math.abs(sample.level_m-nearest.level_m)*100;
   const rows=errors.get(h.hours)??[];rows.push({error,baseline,inBand:error<=h.band_cm});errors.set(h.hours,rows);
  }
 }
 for(const h of [1,2,3]){
  const rows=errors.get(h)??[],mean=(key:string)=>rows.length?rows.reduce((s,r)=>s+r[key],0)/rows.length:null;
  const ordered=rows.map(r=>r.error).sort((a,b)=>a-b);
  scores.push({bridge,horizon_h:h,comparisons:rows.length,mae_v2_cm:mean('error'),mae_persistence_cm:mean('baseline'),p90_v2_cm:ordered.length?ordered[Math.ceil(ordered.length*.9)-1]:null,band_coverage_percent:rows.length?100*rows.filter(r=>r.inBand).length/rows.length:null,adequate_sample:rows.length>=100});
 }
}
const report={created_at:new Date(now).toISOString(),period_days:7,method:'Simulação temporal da tendência v2; sem ajustes de chuva/comportas não calibrados. Nível constante é o baseline. Não grava previsões ou altera o banco.',warning:'Poucas observações ou um único evento não comprovam precisão hidrológica. Resultados simulados não substituem avaliação prospectiva.',scores};
const out=process.argv[2]??'/tmp/backtest-forecast-v2.json';writeFileSync(out,JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
