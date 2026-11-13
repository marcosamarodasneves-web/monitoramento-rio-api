import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks=vi.hoisted(()=>({auth:vi.fn(),registered:vi.fn(),collect:vi.fn()}));
vi.mock('./_core/sdk',()=>({sdk:{authenticateRequest:mocks.auth}}));
vi.mock('./hydrology',()=>({collectTick:mocks.collect,isRegisteredCollectorJob:mocks.registered}));
import { scheduledHydrology } from './scheduled-hydrology';
function response(){const res:any={status:vi.fn(),json:vi.fn()};res.status.mockReturnValue(res);return res;}
describe('callback HTTP do coletor',()=>{
 beforeEach(()=>vi.resetAllMocks());
 it('nega chamadas comuns mesmo que autenticadas',async()=>{mocks.auth.mockResolvedValue({isCron:false});const res=response();await scheduledHydrology({path:'/api/scheduled/hydrology'} as any,res);expect(res.status).toHaveBeenCalledWith(403);expect(mocks.collect).not.toHaveBeenCalled();});
 it('ignora cron sem vínculo persistente',async()=>{mocks.auth.mockResolvedValue({isCron:true,taskUid:'x'});mocks.registered.mockResolvedValue(false);const res=response();await scheduledHydrology({} as any,res);expect(res.json).toHaveBeenCalledWith({ok:true,skipped:'orphan'});expect(mocks.collect).not.toHaveBeenCalled();});
 it('executa somente o cron registrado',async()=>{mocks.auth.mockResolvedValue({isCron:true,taskUid:'known'});mocks.registered.mockResolvedValue(true);mocks.collect.mockResolvedValue({forecasts:{generated:9}});const res=response();await scheduledHydrology({body:{taskUid:'attacker'}} as any,res);expect(mocks.registered).toHaveBeenCalledWith('known');expect(mocks.collect).toHaveBeenCalledTimes(1);});
 it('devolve erro para tentativas de coleta falhas',async()=>{mocks.auth.mockResolvedValue({isCron:true,taskUid:'known'});mocks.registered.mockResolvedValue(true);mocks.collect.mockRejectedValue(Error('failed'));const res=response();await scheduledHydrology({path:'/api/scheduled/hydrology'} as any,res);expect(res.status).toHaveBeenCalledWith(500);});
});
