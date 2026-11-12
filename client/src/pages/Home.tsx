import { useEffect } from "react";
import { trpc } from "@/lib/trpc";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Loader2, RefreshCw, Waves, Gauge, Database, Clock3 } from "lucide-react";
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

const statusClass: Record<string, string> = {
  Normalidade: "border-emerald-200 bg-emerald-50 text-emerald-800",
  Atenção: "border-amber-200 bg-amber-50 text-amber-800",
  Alerta: "border-orange-200 bg-orange-50 text-orange-800",
  Emergência: "border-red-200 bg-red-50 text-red-800",
};

function formatTime(value: string | undefined) {
  return value ? new Date(value).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : "—";
}

export default function Home() {
  const snapshot = trpc.hydrology.snapshot.useQuery(undefined, { refetchInterval: 300000, retry: 1 });
  const history = trpc.hydrology.history.useQuery({ days: 1 }, { refetchInterval: 300000, retry: 1 });
  const access = trpc.hydrology.registerAccess.useMutation();
  useEffect(() => { access.mutate({ kind: "app" }); }, []);

  const rivers = snapshot.data?.rivers ?? [];
  const dams = snapshot.data?.damReadings ?? [];
  const riverChart = (bridgeId: string) => (history.data?.rivers ?? []).filter((row: any) => row.bridge_id === bridgeId).map((row: any) => ({ time: formatTime(row.measured_at), value: Number(row.level_m) }));
  const damChart = (damId: string) => (history.data?.dams ?? []).filter((row: any) => row.dam_id === damId).map((row: any) => ({ time: formatTime(row.measured_at), value: Number(row.level_m ?? row.occupancy_percent ?? 0) }));

  return (
    <main className="min-h-screen bg-slate-50 text-slate-900">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-7xl items-center justify-between px-5 py-5">
          <div><p className="text-xs font-semibold uppercase tracking-[0.2em] text-cyan-700">Monitoramento hidrológico</p><h1 className="mt-1 text-2xl font-bold tracking-tight">Nível do Rio · Rio do Sul</h1></div>
          <Button variant="outline" onClick={() => { snapshot.refetch(); history.refetch(); }} disabled={snapshot.isFetching} className="gap-2"><RefreshCw className={snapshot.isFetching ? "animate-spin" : ""} size={16} /> Atualizar</Button>
        </div>
      </header>
      <div className="mx-auto max-w-7xl space-y-6 px-5 py-7">
        {snapshot.error && <Card className="border-red-200 bg-red-50"><CardContent className="p-5 text-sm text-red-800">Não foi possível ler o banco agora. Verifique as credenciais do Supabase e tente novamente.</CardContent></Card>}
        <section className="grid gap-4 sm:grid-cols-3"><Metric icon={<Waves size={18} />} label="Pontes monitoradas" value={String(snapshot.data?.bridges.length ?? 0)} /><Metric icon={<Gauge size={18} />} label="Barragens monitoradas" value={String(snapshot.data?.dams.length ?? 0)} /><Metric icon={<Database size={18} />} label="Retenção" value="7 dias" /></section>
        <section className="grid gap-5 lg:grid-cols-3">
          {rivers.length === 0 && <Card className="lg:col-span-3"><CardContent className="flex items-center gap-2 p-8 text-slate-500">{snapshot.isLoading && <Loader2 className="animate-spin" size={18} />} Aguardando a primeira coleta da fonte oficial.</CardContent></Card>}
          {rivers.map((row: any) => <RiverCard key={row.bridge_id} row={row} bridge={snapshot.data?.bridges.find((b: any) => b.id === row.bridge_id)} points={riverChart(row.bridge_id)} />)}
        </section>
        <section><div className="mb-3 flex items-end justify-between"><div><p className="text-xs font-semibold uppercase tracking-[0.2em] text-cyan-700">Reservatórios</p><h2 className="text-xl font-bold">Barragens e comportas</h2></div><span className="text-sm text-slate-500">Coleta a cada 5 minutos</span></div><div className="grid gap-5 md:grid-cols-2">{dams.map((row: any) => <DamCard key={row.dam_id} row={row} dam={snapshot.data?.dams.find((d: any) => d.id === row.dam_id)} points={damChart(row.dam_id)} />)}</div></section>
        <footer className="flex flex-wrap items-center justify-between gap-2 border-t border-slate-200 pt-5 text-sm text-slate-500"><span className="flex items-center gap-2"><Clock3 size={15} /> Última atualização {formatTime(snapshot.data?.asOf)}</span><span>Desenvolvimento por Marcos A. das Neves</span></footer>
      </div>
    </main>
  );
}

function Metric({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) { return <Card><CardContent className="flex items-center gap-3 p-5"><span className="rounded-xl bg-cyan-50 p-2 text-cyan-700">{icon}</span><div><p className="text-xs text-slate-500">{label}</p><p className="text-xl font-bold">{value}</p></div></CardContent></Card>; }

function RiverCard({ row, bridge, points }: { row: any; bridge: any; points: any[] }) { const status = row.status ?? "Normalidade"; return <Card className={`overflow-hidden border-2 ${statusClass[status] ?? "border-slate-200 bg-white"}`}><CardHeader className="flex-row items-start justify-between space-y-0"><div><CardTitle className="text-base">{bridge?.name ?? "Estação"}</CardTitle><p className="mt-1 text-xs text-slate-500">{bridge?.river_name}</p></div><Badge className="border-0 bg-white/70">{status}</Badge></CardHeader><CardContent><div className="flex items-end gap-2"><strong className="text-4xl tracking-tight">{Number(row.level_m).toFixed(2).replace(".", ",")}</strong><span className="mb-1 font-semibold">m</span></div><div className="mt-4 h-24"><ResponsiveContainer width="100%" height="100%"><AreaChart data={points.length ? points : [{ time: "agora", value: Number(row.level_m) }]}><defs><linearGradient id={`river-${row.bridge_id}`} x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor="#0891b2" stopOpacity={0.35}/><stop offset="95%" stopColor="#0891b2" stopOpacity={0}/></linearGradient></defs><CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#cbd5e1"/><XAxis dataKey="time" hide/><YAxis domain={["auto", "auto"]} hide/><Tooltip formatter={(value) => [`${Number(value).toFixed(2)} m`, "Nível"]}/><Area type="monotone" dataKey="value" stroke="#0e7490" fill={`url(#river-${row.bridge_id})`} strokeWidth={2}/></AreaChart></ResponsiveContainer></div><p className="mt-2 text-xs text-slate-500">Faixas oficiais: normal abaixo de 4,50 m · atenção até 5,50 m · alerta até 6,50 m</p></CardContent></Card>; }

function DamCard({ row, dam, points }: { row: any; dam: any; points: any[] }) { const pct = row.occupancy_percent == null ? null : Number(row.occupancy_percent); return <Card><CardHeader><CardTitle className="flex items-center justify-between text-base"><span>{dam?.name ?? "Barragem"}</span><Badge variant="outline">{formatTime(row.measured_at)}</Badge></CardTitle><p className="text-xs text-slate-500">{dam?.river_name ?? "Reservatório"}</p></CardHeader><CardContent><div className="flex items-end gap-2"><strong className="text-3xl text-cyan-800">{row.level_m == null ? "—" : Number(row.level_m).toFixed(2).replace(".", ",")}</strong><span className="mb-1 font-semibold">m</span>{pct != null && <span className="mb-1 ml-auto text-sm font-medium">{pct.toFixed(1).replace(".", ",")}% ocupado</span>}</div><div className="mt-3 h-2 overflow-hidden rounded-full bg-slate-200"><div className="h-full rounded-full bg-emerald-500" style={{ width: `${Math.min(100, Math.max(0, pct ?? 0))}%` }} /></div><p className="mt-4 text-sm font-medium">Comportas <span className="font-normal text-slate-600">{row.gates_open ?? 0}/{row.gates_total ?? 0} abertas</span></p><div className="mt-3 h-20"><ResponsiveContainer width="100%" height="100%"><AreaChart data={points}><XAxis dataKey="time" hide/><YAxis hide/><Tooltip/><Area type="monotone" dataKey="value" stroke="#059669" fill="#d1fae5" strokeWidth={2}/></AreaChart></ResponsiveContainer></div></CardContent></Card>; }
