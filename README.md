# Monitoramento Rio do Sul — backend e aprendizado adaptativo

O backend centraliza a coleta dos níveis dos rios e das barragens, as previsões de 1, 2 e 3 horas e a conferência com as medições reais. O Android 1.3.2 continua buscando os níveis atuais diretamente da fonte oficial; somente previsão, histórico de previsões e acurácia vêm deste serviço.

## Versão adaptativa v3

O modelo não reescreve código nem depende de um chatbot. Ele combina quatro especialistas matemáticos: persistência, tendência amortecida, tendência linear e projeção com aceleração. Os pesos são aprendidos separadamente por ponte, horizonte e situação observada: estabilidade, subida, descida ou reversão. Os valores candidatos e a revisão usada ficam congelados no momento da emissão.

Depois que a hora prevista chega, o servidor procura a medição real mais próxima dentro de ±10 minutos e espera a janela inteira para conferir. Ausência de medição não é erro de previsão e não entra no aprendizado ou no denominador da acurácia. Após seis horas sem medição, o resultado é sem_medicao. Previsões v2 antigas ainda são conferidas, mas não são misturadas com os resultados v3.

Cada resultado válido atualiza os erros dos especialistas. Após pelo menos 24 resultados na mesma chave, o sistema pode propor uma alteração gradual dos pesos. Uma proposta só é aceita depois de comparação em pelo menos 12 previsões emitidas **depois** da proposta. Se piorar a perda usada na comparação, é rejeitada e o campeão continua ativo. A perda inclui erro em centímetros e penalidades operacionais para subestimar as faixas oficiais. Essas escolhas são heurísticas experimentais, não uma validação hidrológica de toda a bacia.

A margem emitida não é aumentada para melhorar artificialmente a taxa de acertos. Dados de chuva e barragens continuam sendo contexto; conversões chuva→nível e comportas→nível permanecem desativadas enquanto não houver calibração confiável. Aprender os pesos não equivale a aprender automaticamente toda a hidrodinâmica da bacia. Parâmetros hidrológicos explicitamente validados continuam em forecast_calibration.

Open-Meteo é opcional e desativado por padrão. Só ative `OPEN_METEO_NON_COMMERCIAL_ENABLED=true` quando o uso cumprir a licença não comercial; para monetização, configure uma fonte com licença comercial apropriada. Falha meteorológica não impede a leitura dos rios.

## Persistência e 60 dias

A migração `supabase/adaptive_v3_60_days.sql`, aplicada depois de `forecast_v2.sql`, amplia a retenção de leituras, previsões, contexto e logs para **60 dias**. As funções antigas de limpeza são substituídas mantendo seus nomes, para que o backend anterior não volte a apagar previsões com sete dias. A mudança foi aplicada ao Supabase em 13/11/2026. Registros já removidos antes disso não são recuperados.

| Tabela | Finalidade | Retenção |
|---|---|---|
| `river_readings`, `dam_readings` | Medições reais | 60 dias |
| `central_river_forecasts` | Previsões e resultados conferidos | 60 dias |
| `forecast_context` | Contexto usado na coleta | 60 dias |
| `collector_runs`, `daily_access` | Execuções e contagens diárias | 60 dias |
| `forecast_learning_events` | Auditoria das revisões e perdas | 60 dias |
| `forecast_learning_state` | Erros agregados, campeão e proposta por chave | Persistente |
| `bridges`, `dams`, `forecast_calibration`, `forecast_jobs` | Cadastros, parâmetros e agendador | Persistente |

A memória agregada continua depois que os registros detalhados expiram. A RPC `apply_forecast_learning_event` grava evento e estado na mesma transação, controla revisão e impede que retries do cron aprendam novamente com a mesma previsão. As tabelas e a RPC são restritas ao backend; o APK não contém chave administrativa.

O memorial completo de uma emissão é guardado na linha +1 h; +2 h e +3 h guardam apenas os candidatos congelados necessários ao aprendizado. A auditoria não duplica todo o estado agregado em cada evento. Mesmo com essa compactação, 60 dias exigem mais armazenamento: acompanhar o tamanho do banco e as cotas do plano contratado. Não houve contratação nem mudança automática de plano.

## API e aplicativo

`GET /api/hydrology/forecasts?bridge=ricardo-kanitz&hours=24` retorna `latest`, `forecasts`, `accuracy`, `model_version`, `accuracy_days: 60` e `retention_days: 60`. Uma resposta ainda v2 é um fallback compatível, nunca rotulado como acurácia v3. IDs: dom-tito, br-470 e ricardo-kanitz. O histórico de previsões é limitado a 1.000 registros por consulta, com `history_truncated` quando atinge o limite; o app consulta as últimas 24 h de cada ponte. O filtro de conferidas e o botão Mostrar mais operam sobre as linhas recebidas, sem calcular nada localmente.

`GET /api/hydrology/history?days=1` retorna as séries dos níveis; aceita até 60 dias e pagina a consulta ao PostgreSQL para não cortar silenciosamente em mil medições. Snapshot e níveis atuais continuam independentes do aprendizado. `POST /api/hydrology/access` registra o acesso. O disparo externo protegido `POST /api/hydrology/collect` requer `x-collector-secret`, que nunca deve ir no APK.

No início da v3, a acurácia pode não ter resultados conferidos. Ela aparece conforme os horizontes vencem; **não é necessário esperar 60 dias**. A janela de 60 dias passa a crescer com as novas medições. Uma amostra curta ou muitas previsões correlacionadas não garante precisão em outra enchente.

## Implantação

O mesmo Heartbeat HTTP já ativo, a cada cinco minutos, chama `/api/scheduled/hydrology` com autenticação da plataforma e vínculo em `forecast_jobs`. Não há temporizador residente nem novo agendador. Coleta, conferência e aprendizado acontecem no mesmo ciclo idempotente. Pontualidade depende da fonte e do agendador; a programação de cinco minutos não garante 300 segundos exatos entre gravações.

Depois de atualizar os fontes, **republique o checkpoint adaptativo no WebDev**. Commit no GitHub não publica o backend. Após a republicação, confirme `model_version: adaptive-v3` na API e o próximo ciclo bem-sucedido. O APK 1.3.2 aceita tanto v2 como v3 durante essa transição. Sem a republicação, a retenção de 60 dias já está no banco, mas o cron continuará executando o algoritmo anterior.

## Validação e manutenção

Credenciais `SUPABASE_URL` e `SUPABASE_KEY` ficam somente no servidor; não publicar .env no GitHub. `pnpm check`, `pnpm test` e `pnpm build` verificam o projeto. `supabase/test_learning_transaction.sql` testa idempotência, conflito de revisão e privilégios em uma transação com rollback, sem deixar dados de teste. `scripts/backtest-adaptive-v3.ts` faz avaliação cronológica somente leitura; os resultados e limitações estão em `docs/AVALIACAO-ADAPTATIVA-V3.md`.

Para suspender somente a atualização dos pesos de uma chave, um administrador pode definir `enabled=false` em `forecast_learning_state`; as previsões continuam usando o último estado aprovado. Não alterar resultados históricos, tolerâncias ou percentuais para simular melhora.

Esta previsão é experimental e não substitui alertas oficiais da Defesa Civil. Cotas: normal abaixo de 4,50 m; atenção de 4,50 a menos de 5,50 m; alerta de 5,50 até 6,50 m inclusive; emergência acima de 6,50 m.

Desenvolvimento por Marcos A. das Neves.
