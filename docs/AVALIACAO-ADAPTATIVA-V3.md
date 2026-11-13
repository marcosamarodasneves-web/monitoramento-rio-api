# Avaliação temporal do `adaptive-v3`

**Status do resultado:** concluído em modo read-only.

**JSON reproduzível:** `docs/avaliacao-adaptativa-v3.json`

**Script:** `scripts/backtest-adaptive-v3.ts`

**Modelo avaliado:** `adaptive-v3`, combinando o `deterministic-v2` com `applyAdaptiveForecast`.

## Conclusão executiva

O replay encontrou **34 comparações pareadas reais** nos três rios e nos horizontes disponíveis. O MAE agregado foi:

| Modelo                      |          MAE |
| --------------------------- | -----------: |
| Adaptive-v3                 | **4,172 cm** |
| Deterministic-v2            | **6,987 cm** |
| Persistência (último nível) | **2,441 cm** |

O adaptive-v3 ficou abaixo do v2 neste recorte, com acerto dentro da margem em **82,35%** dos pares, contra **58,82%** do v2. Entretanto, a persistência teve MAE agregado menor que ambos. Assim, **não há base para afirmar superioridade do adaptive-v3**: o resultado é retrospectivo, tem poucos pares por ponte/horizonte e as amostras próximas no tempo são correlacionadas.

A leitura mais favorável ao adaptive-v3 ocorreu em Ricardo-Kanitz nos horizontes de 2 h e 3 h, mas esses resultados têm apenas 6 e 8 pares, respectivamente. Em BR-470 houve 7 pares em 1 h e 3 em 3 h. Dom-Tito teve somente 2 pares em 1 h e nenhum par nos horizontes de 2 h e 3 h. Isso não é amostra suficiente para generalização hidrológica nem para inferir desempenho em futuras cheias.

## Dados e janela

- Fonte: tabela Supabase `river_readings`.
- Acesso: SDK TypeScript do Supabase, somente `select`; nenhuma previsão, estado ou resultado foi gravado.
- Credenciais: lidas exclusivamente do ambiente (`SUPABASE_READONLY_URL`/`SUPABASE_READONLY_KEY`, com fallback aos nomes existentes `SUPABASE_URL`/`SUPABASE_KEY`); nenhum segredo aparece no script, no log ou no JSON.
- Retenção consultada: 60 dias.
- Janela de avaliação: últimos 7 dias disponíveis, conforme limite operacional solicitado.
- Linhas lidas: 570; linhas válidas: 570; linhas inválidas: 0.
- Dados disponíveis: 2026-11-05 21:01:08Z a 2026-11-13 19:46:22Z, aproximadamente 7,948 dias.
- Dias distintos com medição: 9 no conjunto retido e 7 dias no recorte de avaliação.
- Issues tentados: 1.008, a cada 10 minutos.
- Emissões v2 disponíveis: 412 issues/ponte; emissões por horizonte guardadas em memória: 1.236.
- Operações contabilizadas: 20.983, abaixo do limite de 1.000.000.

A retenção de 60 dias foi preservada na consulta, mas a avaliação foi limitada a 7 dias para manter o runtime curto. A disponibilidade observacional efetiva não equivale a 60 dias completos de amostra real.

## Replay temporal e prevenção de vazamento

Cada ponte foi reproduzida em issues sucessivos de 10 minutos. Em cada issue:

1. Foram usadas somente leituras cuja medição e disponibilidade eram passadas ou iguais ao issue.
2. A disponibilidade de cada leitura foi definida como `max(measured_at, collected_at)`.
3. A entrada do v2 usou no máximo as 6 horas anteriores e foi construída antes da emissão.
4. O modelo v2 foi calculado primeiro; o regime foi obtido por `detectRegime`, usando somente as taxas/ruído observados.
5. O estado foi selecionado separadamente por `bridge × horizon × regime` e iniciado com `initialLearningState` quando não havia estado local.
6. `applyAdaptiveForecast` recebeu o estado daquele horizonte/regime e guardou, na emissão em memória, candidatas, regime, horizonte e `issued_revision` numérico.
7. Só depois do treinamento dos outcomes elegíveis a emissão seguinte foi calculada.

O treinamento de uma previsão ocorreu somente quando `target_time + 10 min <= issue_time`. A medição real foi escolhida no intervalo nearest ±10 minutos, e só foi usada se sua medição e sua disponibilidade já fossem menores ou iguais ao issue. Não foram importados estados persistidos, dados de outros usuários ou resultados de execuções anteriores.

Duplicatas de `measured_at` foram resolvidas de forma cronológica no instante do replay: entre duplicatas elegíveis, prevalece a leitura com maior disponibilidade, depois maior `collected_at` e, por fim, o maior identificador. Uma correção coletada mais tarde não pode entrar em um issue anterior.

Os invariantes registrados no JSON foram todos verdadeiros:

- nenhuma amostra futura entrou na entrada;
- nenhum actual futuro treinou o estado;
- `issued_revision` permaneceu congelada;
- estados ficaram separados por ponte, horizonte e regime;
- `band_cm` do v2 e do adaptive permaneceu idêntica;
- o treinamento respeitou `target + 10 min`;
- a medição usada respeitou medição e disponibilidade até o issue.

## Resultados por ponte e horizonte

Valores em cm. `n` é o número de pares reais conferidos; célula sem `n` não deve ser interpretada como zero.

| Ponte          | Horizonte |   n | Adaptive MAE | v2 MAE | Persistência MAE | Adaptive dentro da margem | v2 dentro da margem |
| -------------- | --------: | --: | -----------: | -----: | ---------------: | ------------------------: | ------------------: |
| Dom-Tito       |       1 h |   2 |        2,449 |  2,339 |            2,500 |                       50% |                 50% |
| Dom-Tito       |       2 h |   0 |            — |      — |                — |                         — |                   — |
| Dom-Tito       |       3 h |   0 |            — |      — |                — |                         — |                   — |
| BR-470         |       1 h |   7 |        0,412 |  0,469 |            0,386 |                      100% |                100% |
| BR-470         |       2 h |   0 |            — |      — |                — |                         — |                   — |
| BR-470         |       3 h |   3 |        2,314 |  3,268 |            2,433 |                      100% |              66,67% |
| Ricardo-Kanitz |       1 h |   8 |        1,923 |  2,395 |            2,125 |                       75% |                 75% |
| Ricardo-Kanitz |       2 h |   6 |        6,800 | 11,357 |            2,833 |                    83,33% |              33,33% |
| Ricardo-Kanitz |       3 h |   8 |        8,866 | 16,560 |            4,250 |                       75% |                 25% |

As margens foram as do v2, sem qualquer ajuste. As taxas de acerto adaptive e v2 foram calculadas sobre os mesmos pares e com a mesma `band_cm`; não houve relaxamento da tolerância para favorecer o adaptive. A persistência foi comparada em MAE, mas não foi usada para alterar o estado adaptativo.

## Aprendizado e cold start

Foram criadas 36 chaves de estado (`ponte × horizonte × regime`). Houve 34 outcomes aceitos. Não houve criação de challenger, promoção ou rollback durante este recorte, o que é compatível com o cold start e com a exigência do core de histórico mínimo antes de mudar pesos. Isso significa que a avaliação observa principalmente o comportamento inicial conservador do modelo, não uma demonstração de aprendizado maduro.

O replay não consultou `forecast_learning_state` nem `central_river_forecasts` para inicializar a avaliação. O estado foi sempre criado localmente com `initialLearningState(regime)`, evitando contaminar a avaliação com memória de produção.

## Limitações

As leituras de uma mesma série temporal próximas no relógio não são observações independentes. A avaliação tem somente 7 dias efetivos, poucos pares em vários estratos e não contém quantidade suficiente de cheias independentes. Um único evento de cheia ou poucos dias não provam generalização.

O replay reproduz a comparação do backtest v2 com `river_readings` e não inventa chuva, montante ou barragens ausentes no histórico selecionado. Portanto, ele avalia o comportamento determinístico disponível sob as mesmas entradas, não a capacidade hidrológica completa do sistema.

A diferença aggregate de 2,815 cm a favor do adaptive contra o v2 deve ser lida junto com o baseline de persistência, o pequeno `n` por estrato e a correlação temporal. O resultado não autoriza taxa de acerto garantida, margem calibrada, confiança probabilística, afirmação de superioridade ou substituição dos avisos oficiais.

## Reprodução

No diretório do backend:

```bash
pnpm exec tsx scripts/backtest-adaptive-v3.ts /home/ubuntu/avaliacao-adaptativa-v3.json
```

A execução exige credenciais Supabase no ambiente, faz somente leituras e escreve apenas o JSON de saída solicitado pelo argumento. O script não usa LLM e não altera core, forecast, SQL ou tabelas Supabase.
