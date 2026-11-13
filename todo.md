# Acompanhamento — previsão determinística v2

## Implementado e verificado

- [x] Usar Android 1.2.0 anexado como base, preservando níveis atuais diretamente da Defesa Civil.
- [x] Remover ForecastEngine, ForecastStore e SupabaseForecast do Android.
- [x] Adaptar card, memorial, histórico e acurácia para o contrato REST central +1/+2/+3 h.
- [x] Manter apenas o último snapshot de previsão em cache, sem SQL ou histórico de previsão no aparelho.
- [x] Compilar Android 1.3.0 no GitHub Actions com testes JVM de parser, nulos, cotas e horários antigos/futuros.
- [x] Implementar tendências de 1/3/6 h, aceleração simétrica, suavização de picos e tratamento de lacunas/staleness.
- [x] Integrar chuva medida e contexto de estações a montante e barragens.
- [x] Aplicar Supabase aditivo com tabela central exclusiva, parâmetros e contexto internos e acurácia por versão/horizonte.
- [x] Separar previsões legadas e pré-validação da estatística central v2.
- [x] Conferir pela leitura real mais próxima do alvo em ±10 min, com margem igual à emitida e sem_medicao fora do denominador.
- [x] Garantir retenção de sete dias de previsões/contexto e preservar cadastros.
- [x] Preparar callback HTTP autenticado e registro persistente do cron, sem temporizador residente.
- [x] Validar tipos e 41 testes backend, build de produção e contrato REST.
- [x] Executar avaliação temporal contra nível persistente; amostra pequena não demonstra superioridade consistente.

## Para entrar em produção

Publicar o checkpoint final no WebDev. Após a publicação, ativar um único Heartbeat HTTP do projeto para `/api/scheduled/hydrology`, expressão UTC `0 */5 * * * *`, registrar seu task_uid em forecast_jobs e verificar execução real. O registro foi preparado desativado. Fonte atualizada no GitHub não equivale a backend publicado.

## Limites hidrológicos

Coeficientes chuva→nível, comportas→nível e atrasos de propagação não foram calibrados e ficam desativados como contribuição numérica. Contexto não é vazão. Fonte meteorológica prevista é opt-in com licença compatível; a prioridade é telemetria medida. O modelo e sua margem são experimentais, sem precisão prometida. Acurácia prospectiva deve ser acompanhada por ponte e horizonte.
