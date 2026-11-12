# Monitoramento Rio do Sul — API e Histórico

Backend e painel web para acompanhar os níveis dos rios, barragens e comportas de Rio do Sul.

## O que foi implementado

- PostgreSQL no Supabase como histórico central.
- Retenção automática de **7 dias** para leituras e execuções do coletor.
- Cadastro editável de pontes e barragens.
- Coleta fixa a cada **5 minutos** para cada ponte e barragem ativa. O servidor verifica os alvos a cada cinco minutos e grava somente quando já passaram cinco minutos desde a última leitura daquele alvo.
- A tabela `collection_policies` permanece no banco para preservar a configuração existente, mas não é usada pelo coletor nesta versão.
- Histórico de acessos diário na tabela `daily_access`.
- Dashboard web com gráficos, status oficiais e indicadores de comportas.
- API REST para o aplicativo Android.

## API pública do aplicativo

Depois de publicar o projeto, o aplicativo pode consumir:

- `GET /api/hydrology/snapshot` — configuração e última leitura de cada ponte/barragem.
- `GET /api/hydrology/history?days=1` — histórico de até sete dias.
- `POST /api/hydrology/access` com `{ "kind": "app" }` — registra uma abertura do app.
- `POST /api/hydrology/collect` com o cabeçalho `x-collector-secret` — permite que um agendador externo dispare a coleta com segurança.

O endpoint de coleta manual protegido fica disponível pelo procedimento tRPC `hydrology.collectNow`, para uso administrativo autenticado.

## Fonte dos dados

O coletor consulta a fonte pública configurada no backend, normaliza as respostas e grava uma nova leitura de cada item ativo a cada cinco minutos. O aplicativo não consulta a fonte oficial diretamente: ele lê o snapshot e o histórico desta API intermediária.

## Banco de dados

As tabelas principais são:

- `bridges` e `dams`: cadastro dos pontos monitorados;
- `river_readings` e `dam_readings`: leituras com horário medido e horário coletado;
- `collection_policies`: intervalos adaptativos;
- `daily_access`: contagem de acessos por dia;
- `collector_runs`: auditoria das execuções;
- `cleanup_old_hydrology_readings()`: função de limpeza da retenção de sete dias.

As credenciais do Supabase devem permanecer apenas nas variáveis de ambiente do servidor (`SUPABASE_URL` e `SUPABASE_KEY`). Nunca coloque essas variáveis no aplicativo Android nem no frontend.
Para usar o disparo externo, configure também `COLLECTOR_SECRET` no ambiente do servidor e envie o mesmo valor apenas no cabeçalho do agendador.

## Validação

```bash
pnpm check
pnpm test
pnpm build
```
