import type { SupabaseClient } from '@supabase/supabase-js';
import { computeForecastV2 } from './forecast-model-v2';
import { rainForBridge, type ForecastContext } from './forecast-sources';
import { ADAPTIVE_MODEL_VERSION, applyAdaptiveForecast, detectRegime, type LearningState } from './forecast-adaptive-model';
import { learnVerifiedForecasts, learningStates } from './forecast-learning-store';

export const FORECAST_RETENTION_DAYS = 60;
export const FORECAST_MODEL_VERSION = ADAPTIVE_MODEL_VERSION;
export const LEGACY_MODEL_VERSION = 'deterministic-v2';
export const CENTRAL_FORECAST_TABLE = 'central_river_forecasts';
const MINUTE = 60000;
const HOUR = 60 * MINUTE;
const MATCH_WINDOW = 10 * MINUTE;
export type ForecastOutcome = 'pendente' | 'dentro' | 'quase' | 'fora' | 'sem_medicao';
export type ForecastSample = { measured_at: string; level_m: number };
export type ForecastBridge = { id: string; station_id: string | null };
export type ForecastDam = { id: string; gates_open: number | null; gates_total: number | null; gate_delta?: number };
export function classifyForecast(errorCm: number, toleranceCm: number): ForecastOutcome {
  if (!Number.isFinite(errorCm) || !Number.isFinite(toleranceCm) || toleranceCm <= 0) return 'sem_medicao';
  return Math.abs(errorCm) <= toleranceCm ? 'dentro' : Math.abs(errorCm) <= toleranceCm * 2 ? 'quase' : 'fora';
}
// Adapter only for existing deterministic core tests.
export function computeForecast(bridge: ForecastBridge, samples: ForecastSample[], _dams: ForecastDam[], now = Date.now()) {
  const f = computeForecastV2({ bridge, samples, now });
  return f.horizons.map(h => ({ bridge: bridge.id, horizon_h: h.hours, target_time: h.target_time, base_time: f.base_time, current_level: f.current_level, predicted_level: h.predicted_level, band_cm: h.band_cm, tolerance_cm: h.band_cm, confidence: h.confidence, outcome: 'pendente' as const }));
}
async function allRows(build: () => any) {
  const rows: any[] = [];
  for (let offset = 0; offset < 200000; offset += 1000) {
    const result = await build().range(offset, offset + 999);
    if (result.error) throw result.error;
    rows.push(...(result.data ?? []));
    if ((result.data?.length ?? 0) < 1000) return rows;
  }
  throw new Error('Histórico excede o limite de paginação; revise a retenção.');
}

export async function recordAndResolveForecasts(db: SupabaseClient, bridges: ForecastBridge[], _dams: ForecastDam[] = [], now = Date.now()) {
  const cutoff = new Date(now - FORECAST_RETENTION_DAYS * 24 * HOUR).toISOString();
  // Resolva também as emissões v2 pendentes sem alterar o cálculo que foi emitido.
  const pending = await allRows(() => db.from(CENTRAL_FORECAST_TABLE)
    .select('id,bridge,horizon_h,target_time,predicted_level,tolerance_cm,model_version')
    .in('model_version', [FORECAST_MODEL_VERSION, LEGACY_MODEL_VERSION]).eq('outcome','pendente')
    .gte('base_time',cutoff).lte('target_time',new Date(now).toISOString()).order('id'));
  const targetTimes = pending.map(row => Date.parse(row.target_time)).filter(Number.isFinite);
  const actuals = targetTimes.length ? await allRows(() => db.from('river_readings')
    .select('id,bridge_id,measured_at,level_m').gte('measured_at',new Date(Math.min(...targetTimes)-MATCH_WINDOW).toISOString())
    .lte('measured_at',new Date(now).toISOString()).order('measured_at').order('id')) : [];
  const updates: {id:number;version:string;patch:Record<string,unknown>}[] = [];
  for (const row of pending) {
    const target = Date.parse(row.target_time);
    if (!Number.isFinite(target) || now < target+MATCH_WINDOW) continue;
    const candidates = actuals.filter(r => r.bridge_id === row.bridge && Math.abs(Date.parse(r.measured_at)-target) <= MATCH_WINDOW &&
      r.level_m !== null && Number.isFinite(Number(r.level_m)) && Number(r.level_m) >= 0)
      .sort((a,b) => Math.abs(Date.parse(a.measured_at)-target)-Math.abs(Date.parse(b.measured_at)-target));
    const match = candidates[0];
    if (!match && now < target+6*HOUR) continue;
    const errorCm = match ? (Number(row.predicted_level)-Number(match.level_m))*100 : null;
    updates.push({id:row.id,version:row.model_version,patch:match
      ? {actual_level:Number(match.level_m),actual_time:match.measured_at,error_cm:errorCm,outcome:classifyForecast(errorCm!,Number(row.tolerance_cm))}
      : {outcome:'sem_medicao'}});
  }
  let resolved = 0;
  for (let i=0;i<updates.length;i+=8) {
    await Promise.all(updates.slice(i,i+8).map(async ({id,version,patch}) => {
      const result = await db.from(CENTRAL_FORECAST_TABLE).update({...patch,updated_at:new Date(now).toISOString()})
        .eq('id',id).eq('outcome','pendente').eq('model_version',version);
      if (result.error) throw result.error;
      resolved++;
    }));
  }
  // Recupera inclusive conferências de uma chamada interrompida antes de aprender.
  const learning = await learnVerifiedForecasts(db,now);
  const recent = new Date(now-12*HOUR).toISOString();
  const [history,damHistory,contexts,calibration,states] = await Promise.all([
    allRows(() => db.from('river_readings').select('id,bridge_id,measured_at,level_m').gte('measured_at',recent).lte('measured_at',new Date(now).toISOString()).order('measured_at').order('id')),
    allRows(() => db.from('dam_readings').select('id,dam_id,measured_at,level_m,occupancy_percent,gates_open,gates_total').gte('measured_at',recent).lte('measured_at',new Date(now).toISOString()).order('measured_at').order('id')),
    db.from('forecast_context').select('payload,collected_at').lte('collected_at',new Date(now).toISOString()).order('collected_at',{ascending:false}).limit(1),
    db.from('forecast_calibration').select('bridge_id,parameters'),
    learningStates(db),
  ]);
  if (contexts.error || calibration.error) throw contexts.error ?? calibration.error;
  const context:ForecastContext|null = contexts.data?.[0] && now-Date.parse(contexts.data[0].collected_at)<=30*MINUTE ? contexts.data[0].payload : null;
  const byBridge = new Map<string,ForecastSample[]>();
  for (const row of history) {
    if (row.level_m === null) continue;
    const list = byBridge.get(row.bridge_id) ?? [];
    list.push({measured_at:row.measured_at,level_m:Number(row.level_m)});byBridge.set(row.bridge_id,list);
  }
  let generated = 0;
  for (const bridge of bridges) {
    const parameters = calibration.data?.find(row=>row.bridge_id===bridge.id)?.parameters ?? {};
    const tributaries = bridge.id==='dom-tito' ? ['br-470','ricardo-kanitz'].map(id=>({id,name:id==='br-470'?'Itajaí do Oeste — BR-470':'Itajaí do Sul — Hannelore',samples:byBridge.get(id)??[],...(parameters.upstream?.[id]??{})})) : [];
    const upper = bridge.id==='br-470' ? (context?.upstream??[]).map(station=>({...station,...(parameters.upstream?.[station.id]??{})})) : [];
    const damIds = bridge.id==='br-470'?['taio']:bridge.id==='ricardo-kanitz'?['ituporanga']:['taio','ituporanga'];
    const dams = damIds.map(id=>({id,name:id==='taio'?'Taió':'Ituporanga',samples:damHistory.filter(r=>r.dam_id===id),...(parameters.dams?.[id]??{})}));
    const base = computeForecastV2({bridge,samples:byBridge.get(bridge.id)??[],now,upstream:[...tributaries,...upper],dams,rain:rainForBridge(context,bridge.id),calibration:parameters});
    if (!base.available) continue;
    const regime = detectRegime(base);
    const selected:Partial<Record<1|2|3,LearningState>> = {};
    for (const h of [1,2,3] as const) {
      const row=states.find(s=>s.bridge===bridge.id && s.horizon_h===h && s.regime===regime);
      if (row) selected[h]=row.state as LearningState;
    }
    const f=applyAdaptiveForecast(base,selected);
    f.notes.push(...(context?.notes??['Chuva e dados a montante indisponíveis nesta coleta.']));
    const rows=f.horizons.map(h=>({bridge:bridge.id,horizon_h:h.hours,base_time:f.base_time,target_time:h.target_time,station_id:bridge.station_id??'',device_bucket:'backend-adaptive-v3',current_level:f.current_level,predicted_level:h.predicted_level,band_cm:h.band_cm,tolerance_cm:h.band_cm,confidence:h.confidence,outcome:'pendente',model_version:FORECAST_MODEL_VERSION,
      // Memorial completo só na linha +1; outras linhas guardam os candidatos congelados necessários ao aprendizado.
      details:h.hours===1?f:{model_version:f.model_version,generated_at:f.generated_at,base_time:f.base_time,adaptive:{horizons:{[h.hours]:f.adaptive.horizons[h.hours]}}}}));
    const result=await db.from(CENTRAL_FORECAST_TABLE).upsert(rows,{onConflict:'bridge,target_time,horizon_h,model_version',ignoreDuplicates:true}).select('id');
    if(result.error)throw result.error;
    generated+=result.data?.length??0;
  }
  const cleanup=await db.rpc('cleanup_forecast_v2');
  if(cleanup.error)throw cleanup.error;
  return {model_version:FORECAST_MODEL_VERSION,generated,resolved,pendingChecked:pending.length,learning};
}

export async function getCentralForecasts(db:SupabaseClient,bridge?:string,hours=24,now=Date.now()) {
  if(bridge&&!['dom-tito','br-470','ricardo-kanitz'].includes(bridge))throw new Error('Ponte inválida');
  if(!Number.isFinite(hours)||hours<1||hours>FORECAST_RETENTION_DAYS*24)throw new Error('hours deve estar entre 1 e 1440');
  const wanted=bridge?[bridge]:['dom-tito','br-470','ricardo-kanitz'];
  const latestResults=await Promise.all(wanted.map(id=>db.from(CENTRAL_FORECAST_TABLE).select('details,model_version').eq('bridge',id)
    .eq('horizon_h',1).in('model_version',[FORECAST_MODEL_VERSION,LEGACY_MODEL_VERSION]).order('base_time',{ascending:false}).limit(1)));
  for(const result of latestResults)if(result.error)throw result.error;
  const version=latestResults.some(r=>r.data?.[0]?.model_version===FORECAST_MODEL_VERSION)?FORECAST_MODEL_VERSION:LEGACY_MODEL_VERSION;
  let historyQuery=db.from(CENTRAL_FORECAST_TABLE).select('*').eq('model_version',version)
    .gte('base_time',new Date(now-hours*HOUR).toISOString()).order('base_time',{ascending:false}).order('id',{ascending:false}).limit(1000);
  if(bridge)historyQuery=historyQuery.eq('bridge',bridge);
  const accuracyView=version===FORECAST_MODEL_VERSION?'river_forecasts_accuracy_v3':'river_forecasts_accuracy_v2';
  const [historyResult,accuracyResult]=await Promise.all([historyQuery,bridge?db.from(accuracyView).select('*').eq('bridge',bridge):db.from(accuracyView).select('*')]);
  if(historyResult.error||accuracyResult.error)throw historyResult.error??accuracyResult.error;
  const latest=latestResults.map((result,i)=>{
    const f=result.data?.[0]?.details;
    if(!f || f.model_version!==version || !Number.isFinite(Date.parse(f.base_time)) || now-Date.parse(f.base_time)>30*MINUTE || Date.parse(f.base_time)>now)
      return {bridge:wanted[i],available:false,unavailable_reason:'Sem previsão centralizada recente desta versão. O servidor aguarda leituras válidas.',model_version:version,horizons:[],notes:[]};
    return f;
  });
  const forecasts=(historyResult.data??[]).map(({details,device_bucket,learning_applied,...row})=>row);
  return {model_version:version,as_of:new Date(now).toISOString(),latest,forecasts,history_truncated:forecasts.length===1000,accuracy:accuracyResult.data??[],accuracy_days:FORECAST_RETENTION_DAYS,retention_days:FORECAST_RETENTION_DAYS,disclaimer:'Estimativa experimental; não substitui os avisos oficiais da Defesa Civil.'};
}
