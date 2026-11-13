import { describe, expect, it } from "vitest";
import { finiteNumber, parseGaugeObservations, parseLevelHistory, rainForBridge } from "./forecast-sources";
const now=Date.parse('2026-11-13T01:00:00Z');
describe('telemetria de previsão',()=>{
 it('não transforma nulo, vazio ou ausente em zero',()=>{expect(finiteNumber(null)).toBeNull();expect(finiteNumber('')).toBeNull();expect(finiteNumber(undefined)).toBeNull();expect(finiteNumber('0')).toBe(0);expect(finiteNumber('1,2')).toBe(1.2);});
 it('rejeita sensor silencioso, antigo ou sem pluviômetro',()=>{const s={station_id:'s',rainfall_sensor:1,last_reading_at:'2026-11-13T00:50:00Z',rainfall_1h:0,rainfall_24h:0};expect(parseGaugeObservations([s],now)).toHaveLength(1);expect(parseGaugeObservations([{...s,last_reading_at:null},{...s,last_reading_at:'2026-11-12T00:00:00Z'},{...s,rainfall_sensor:0}],now)).toHaveLength(0);});
 it('não usa histórico de chuva como nível nem vazão',()=>{expect(parseLevelHistory({rain:[{timestamp:'2026-11-13T00:50:00Z',value:5}]},now)).toEqual([]);expect(parseLevelHistory({level:[{timestamp:'2026-11-13T00:50:00Z',value:5},{timestamp:'2026-11-13T02:00:00Z',value:6}]},now)).toHaveLength(1);});
 it('separa chuva por ramo da bacia',()=>{const context={captured_at:new Date(now).toISOString(),upstream:[],weather:null,notes:[],gauges:[{station_id:'s',name:'Ituporanga',river_name:'Rio Itajaí do Sul',measured_at:new Date(now).toISOString(),mm1h:10,mm2h:10,mm24h:20}]};expect(rainForBridge(context,'br-470')?.observed1hMm).toBeUndefined();expect(rainForBridge(context,'ricardo-kanitz')?.observed1hMm).toBe(10);});
});
