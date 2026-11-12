# Acompanhamento do projeto

## Entregue e validado

- [x] Criar o esquema PostgreSQL no Supabase.
- [x] Configurar retenção de sete dias.
- [x] Cadastrar pontes e barragens iniciais.
- [x] Criar políticas iniciais para rios e barragens.
- [x] Implementar coletor normalizador da fonte hidrológica.
- [x] Gravar níveis, percentual de ocupação e comportas.
- [x] Expor snapshot, histórico e contagem de acessos pela API REST.
- [x] Criar endpoint protegido para disparo externo do coletor.
- [x] Criar painel web com gráficos e faixas oficiais de criticidade.
- [x] Corrigir o coletor para gravar rios e barragens a cada cinco minutos enquanto o serviço estiver ativo.
- [x] Disponibilizar preview funcional pelo checkpoint do projeto.
- [x] Deixar documentado o contrato que o APK Android deve consumir.
- [x] Preparar o Android para tentar a API intermediária antes do fallback legado.
- [x] Permitir ajuste de nomes, referências e regras diretamente nas tabelas do Supabase.
- [x] Validar tipos, seis testes automatizados, API REST, autenticação do endpoint de coleta e build de produção.

## Dependências externas pendentes

- [ ] Publicar o projeto em uma URL permanente pelo painel do projeto.
- [ ] Configurar a execução periódica real no ambiente de hospedagem publicado. O código possui `setInterval` para o serviço ativo e endpoint protegido para cron externo; o agendamento definitivo depende do modo de hospedagem escolhido.
- [ ] Substituir no `app/build.gradle` a URL temporária pela URL permanente publicada e gerar o APK final. O fallback legado permanece ativo até essa troca.
