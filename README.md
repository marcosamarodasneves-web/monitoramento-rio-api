# Monitoramento Rio do Sul — backend e previsão v2

Backend Node.js/TypeScript com PostgreSQL no Supabase. O aplicativo Android consulta diretamente a Defesa Civil para mostrar os níveis atuais; consulta este backend para receber previsões e estatísticas compartilhadas. Nenhum dispositivo calcula ou grava previsões.

## Previsão determinística v2

O motor valida horários, descarta leituras futuras e nulas, deduplica timestamps e suaviza apenas picos isolados. Calcula tendências nas janelas disponíveis de 1, 3 e 6 horas e projeta os horizontes de 1, 2 e 3 horas. A aceleração tem limite simétrico explícito; não existe o antigo teto de subida de 12 cm/h. Leituras com mais de 30 minutos ou sem cobertura mínima não geram previsão atual.

A chuva medida vem dos pluviômetros ativos da Defesa Civil, com horário validado. As médias são dos pontos disponíveis do ramo monitorado e não uma média areal da bacia. O contexto inclui as séries de Laurentino e Agronômica para o ramo Oeste, os dois tributários para Dom Tito, e as barragens correspondentes ao ramo. Nível de reservatório e número de comportas não são vazão.

**Chuva→nível, comportas→nível e atrasos de viagem da água ainda precisam de calibração hidrológica.** Seus coeficientes permanecem desativados por padrão. Os dados entram no contexto e na incerteza, sem inventar centímetros ou tempos de viagem. Parâmetros explicitamente validados podem ser cadastrados em `forecast_calibration.parameters` por ponte. Não copie valores de uma bacia para outra sem validação.

Previsão meteorológica Open-Meteo é opcional e desativada por padrão. O endpoint público gratuito requer uso não comercial. Somente ative `OPEN_METEO_NON_COMMERCIAL_ENABLED=true` quando o uso cumprir a licença; para monetização, configure uma fonte com licença comercial apropriada. Falha meteorológica não impede a leitura dos rios.

A margem é heurística/experimental, não um intervalo de confiança estatisticamente validado. O motor não substitui avisos oficiais nem garante a antecipação de enchentes. As faixas usadas são: Normal abaixo de 4,50 m; Atenção de 4,50 até abaixo de 5,50 m; Alerta de 5,50 até 6,50 m inclusive; Emergência acima de 6,50 m.

## API para Android

`GET /api/hydrology/forecasts?bridge=dom-tito&hours=24` devolve `latest` (snapshot calculado centralmente e seus três horizontes), `forecasts` (histórico), `accuracy` (sete dias da v2) e a indicação da versão. A ponte pode ser omitida para consultar as três. IDs: `dom-tito`, `br-470`, `ricardo-kanitz`. A janela aceita 1 a 168 horas. Histórico limitado a 1.000 linhas por resposta informa `history_truncated` quando atinge esse limite. A acurácia é agregada separadamente e não depende desse limite.

Também existem `GET /api/hydrology/snapshot`, `GET /api/hydrology/history?days=1` e `POST /api/hydrology/access`. O endpoint protegido `POST /api/hydrology/collect` permite disparo por sistema externo com `x-collector-secret`; nunca inclua esse segredo no APK. O procedimento tRPC de coleta exige administrador.

`latest` contém previsões persistidas: chamadas GET não recalculam o modelo nem escrevem previsões. Assim, todos os usuários recebem o mesmo resultado para a mesma emissão. Dados antigos retornam indisponibilidade, em vez de serem apresentados como previsão atual.

## Supabase e auditoria

A migração aditiva está em `supabase/forecast_v2.sql`. Aplicá-la uma vez no projeto existente. Foram preservadas as tabelas de níveis, os cadastros e as previsões antigas, identificadas como `legacy`. A v2 tem `model_version='deterministic-v2'`, `device_bucket='backend-v2'` e o memorial JSON em `details`.

As emissões v2 são gravadas em **`central_river_forecasts`**, tabela exclusiva do backend com RLS e sem permissão de escrita para os aplicativos. A tabela legada `river_forecasts` permanece separada: versões antigas ainda instaladas não conseguem substituir previsões centrais ou alterar a acurácia v2. A unicidade inclui ponte, horário-alvo, horizonte e versão do modelo.

`forecast_context` guarda chuva e contexto coletado. `forecast_calibration` guarda parâmetros por ponte. Ambas são internas, com RLS e acesso somente pelo backend. `river_forecasts_accuracy_v2` separa os resultados da v2 das previsões antigas e de dispositivos.

A conferência aguarda a janela do horário-alvo e procura a leitura real mais próxima em ±10 minutos. Calcula erro em centímetros e classifica dentro da margem, quase ou fora. Após seis horas sem medição, classifica `sem_medicao`, que não é acerto nem erro e fica fora do denominador de acurácia. A emissão não é sobrescrita quando uma nova execução encontra o mesmo horário-alvo. Limpeza remove previsões e contexto anteriores a sete dias.

## Coleta a cada cinco minutos

Não há temporizador residente no servidor. Instâncias de hospedagem serverless podem parar quando ociosas; o temporizador antigo não garantia coleta permanente.

A rota `/api/scheduled/hydrology` aceita somente chamadas assinadas como cron da plataforma e cujo `taskUid` esteja registrado e habilitado em `forecast_jobs`. A tabela é interna ao servidor. O coletor verifica o intervalo de cinco minutos por alvo e a geração/conferência de previsões é idempotente.

**Publicar o checkpoint que contém esse callback antes de criar o agendamento.** Depois da publicação, o proprietário pode criar um Heartbeat do projeto com expressão UTC `0 */5 * * * *`, caminho `/api/scheduled/hydrology`, e registrar o `task_uid` retornado na linha `hydrology-collector` de `forecast_jobs`, com `enabled=true`. Não ativar dois cron jobs para o mesmo coletor. Um endpoint implantado e um agendamento habilitado são verificações diferentes.

O registro foi preparado desativado; ativação depende da publicação do novo backend. Os fontes no GitHub, por si só, não atualizam a URL publicada.

## Instalação e validação

Credenciais somente no servidor: `SUPABASE_URL` e `SUPABASE_KEY` com privilégio apropriado. Não enviar `.env` ao GitHub. Dependências: `pnpm install --frozen-lockfile`. Verificações: `pnpm check`, `pnpm test`, `pnpm build`.

O script `scripts/backtest-forecast-v2.ts` compara o modelo com repetir o nível atual, usando somente observações passadas em cada emissão simulada. Execute `pnpm exec tsx scripts/backtest-forecast-v2.ts /tmp/backtest.json`. Ele consulta no máximo sete dias e não altera o banco. Poucos exemplos, leituras correlacionadas ou um único evento não comprovam precisão; a validação prospectiva por horizonte continua necessária.
