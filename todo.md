# Acompanhamento — aprendizado adaptativo v3 e 60 dias

## Implementado e verificado em 13/11/2026

- [x] Preservar o núcleo determinístico e implementar quatro especialistas com pesos aprendidos por ponte, horizonte e regime.
- [x] Corrigir duplicação de aceleração e manter a margem originalmente emitida.
- [x] Exigir 24 resultados para propor alterações e 12 emissões posteriores à proposta para comparação prospectiva.
- [x] Bloquear validação de propostas com emissões anteriores; rejeitar propostas que pioram a perda do campeão.
- [x] Persistir erros agregados, pesos, campeão e propostas no Supabase.
- [x] Aplicar retenção de 60 dias a dados detalhados; manter cadastros e memória aprendida agregada.
- [x] Proteger a RPC de aprendizado com revisão, transação e idempotência por previsão.
- [x] Executar teste SQL de idempotência, conflito e privilégios com rollback: nenhum registro sintético permaneceu.
- [x] Passar 56 testes backend, verificação TypeScript e build de produção.
- [x] Emitir nove previsões adaptativas reais: três horizontes para cada uma das três pontes.
- [x] Confirmar REST local v3 com retenção e acurácia de 60 dias; REST publicado ainda é v2.
- [x] Atualizar Android 1.3.2/code15, manter Mostrar mais/filtro e compatibilidade v2/v3 sem misturar estatísticas.
- [x] Publicar Android no GitHub, executar testes JVM e gerar/verificar o APK.
- [x] Concluir avaliação temporal somente leitura: 34 pares; MAE adaptativo 4,172 cm, v2 6,987 cm, persistência 2,441 cm. Amostra pequena, sem comprovação de superioridade.

## Implantação pendente

Publicar o checkpoint adaptativo no WebDev. A retenção já foi aplicada no Supabase e o mesmo cron de cinco minutos permanece ativo. Não criar outro agendador. Antes da republicação, o cron usa a lógica anterior, embora as funções de limpeza já preservem 60 dias. Depois, verificar a versão REST publicada e os próximos eventos de aprendizado quando os horizontes vencerem.

Acurácia v3 começa sem resultados conferidos e cresce com cada horizonte concluído. Não é necessário esperar 60 dias para exibir resultados. Leituras correlacionadas e um único evento não provam precisão para outras enchentes. Não houve contratação nem alteração de plano; monitorar a cota de armazenamento de 60 dias.
