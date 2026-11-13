# Validação da previsão determinística v2

A atualização foi baseada no Android 1.2.0 fornecido pelo proprietário. Os níveis atuais de rios e barragens continuam independentes do modelo e são consultados diretamente na fonte oficial. As previsões de 1, 2 e 3 horas, sua conferência e seu histórico foram centralizados no backend.

## O que foi verificado

As suítes de testes cobrem sinais de subida/descida/aceleração, picos isolados, timestamps futuros/antigos, duplicatas, lacunas antigas e recentes, campos nulos, limites oficiais, chuva acumulada, atraso obrigatório para contribuições quantitativas e mudanças de comportas sem reaplicação. O contrato REST foi testado com snapshots v2 reais das três pontes. Testes de acesso do cron verificam autenticação e vínculo persistente do agendamento.

O Android 1.3.0 teve testes JVM do parser e compilação APK executados no GitHub Actions. Foram removidos ForecastEngine, ForecastStore e SupabaseForecast. O dispositivo não calcula ou escreve previsões; somente o último snapshot pode ficar em cache offline. Histórico e acurácia de previsão permanecem no servidor.

## O que não foi comprovado

Uma avaliação temporal sobre os registros disponíveis consultou até sete dias, mas encontrou somente poucos pares válidos por horizonte. Esse recorte não demonstrou vantagem consistente da v2 sobre simplesmente repetir o último nível medido. A avaliação é reproduzível pelo script `scripts/backtest-forecast-v2.ts`; ela não usa observações futuras na entrada nem grava previsões simuladas na tabela de produção.

Esses resultados não autorizam publicar taxa de acerto garantida, erro fixo de 1–2 cm, margem estatisticamente validada ou grau de confiança alto. O aplicativo identifica o modelo como experimental. A acurácia prospectiva começou separada das previsões antigas; as emissões de pré-validação foram preservadas com versão `deterministic-v2-preflight`, fora da estatística v2.

Chuva, estações a montante, ocupação das barragens e manobras são contexto observado. Conversões em centímetros de rio e atrasos hidrológicos permanecem desativados até calibração explícita. Não há inferência de vazão a partir apenas de nível ou número de comportas. Um único evento e poucos dias de dados não bastam para validar previsão de enchente.

## Implantação

O proprietário publicou o backend v2 em 12/11/2026. O HTTP cron do projeto foi habilitado para cinco minutos, com identidade de cron vinculada ao registro habilitado em `forecast_jobs`. Foram verificadas duas execuções automáticas HTTP 200, concluídas às 22:16:17 e 22:22:32 (Brasília). Cada execução registrou três rios, duas barragens e nove previsões. A API publicada retornou o modelo v2 e seus três horizontes para cada ponte.

O intervalo real entre essas conclusões foi 375 segundos. A configuração de cinco minutos não garante despacho ou gravação exatamente a cada 300 segundos. Novas instalações precisam criar e vincular seu próprio cron após publicar; o SQL inicial não reativa automaticamente outro projeto.

A precisão deve ser acompanhada por ponte e horizonte: MAE em cm, cobertura da margem e número de casos conferidos. Ausência de leitura real deve ser registrada como `sem_medicao`, sem contar como acerto nem erro. As previsões não substituem avisos da Defesa Civil.
