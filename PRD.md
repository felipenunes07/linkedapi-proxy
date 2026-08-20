# PRD — Camada proxy sobre a Unipile (LinkedIn)
> **Codinome do projeto:** a definir
> **Versão do documento:** 1.0
> **Data:** 24/07/2026
> **Status:** V1 em definição / pré-desenvolvimento
> **Autor:** Victor Baggio (Playbook Lab)
---
## Como usar este documento
Este PRD serve dois públicos: o time que vai construir a V1, e futuras sessões de IA (Claude) que precisem retomar o projeto do zero. Ele descreve o *porquê* do produto, o *o quê* da V1, e as decisões técnicas já tomadas — com o raciocínio por trás de cada uma, para que ninguém as reabra sem motivo.
Para uma sessão de IA que esteja começando agora: leia primeiro a seção "Visão do produto" e "Objetivos da V1", depois "Decisões técnicas". A seção "Referências" no final aponta para a documentação oficial da Unipile — em especial o índice legível por máquina em `https://developer.unipile.com/llms.txt`, que lista todas as páginas em Markdown e os endpoints em formato OpenAPI. Comece por ele para explorar a API.
---
## 1. Visão do produto
### O problema
Existe uma demanda clara de pessoas e pequenos times que gostariam de usar uma API unificada de mensageria como a Unipile para automatizar ações no LinkedIn (enviar mensagens, convites de conexão, ler conversas), mas esbarram em duas barreiras:
1. **Custo mínimo em moeda estrangeira.** A Unipile cobra um piso de ~€49/mês (~R$283) que já inclui até 10 contas conectadas. Para quem quer conectar apenas 1 perfil, pagar esse piso inteiro em euro é proibitivo e sem sentido econômico.
2. **Fricção técnica.** Configurar DSN, tokens, hosted auth, webhooks e entender a documentação de uma API robusta é barreira alta para o público não-técnico da comunidade Playbook Lab.
### A solução
Uma plataforma proprietária que se posiciona como uma "Unipile mais acessível e mais simples" para o público brasileiro focado em vendas via LinkedIn. O cliente cria uma conta, conecta seu LinkedIn, recebe uma API key nossa, e usa "a nossa API" — que por baixo roteia para a infraestrutura real da Unipile, sob uma única conta-mestra que controlamos.
O cliente paga uma fração do custo (uma assinatura em BRL, via Pix) em vez de contratar a Unipile direto, e nunca precisa lidar com a complexidade da infraestrutura por trás. A marca dele vê apenas a nossa.
### Para quem
Público primário: membros da comunidade Playbook Lab e clientes da agência — pessoas e pequenos times que fazem prospecção e vendas via LinkedIn e querem automação sem contratar infra internacional cara.
### O shift estratégico
Este projeto move a Playbook Lab de "agência de serviços + comunidade de educação" para também operar um **produto de infraestrutura**. Isso é uma decisão consciente: implica responsabilidades novas (uptime, suporte técnico, LGPD sobre tokens e mensagens de terceiros, monitoramento de abuso). O produto não é uma feature — é uma nova linha de receita com carga operacional própria.
---
## 2. Modelo de negócio e economia
> Esta seção documenta o racional comercial. **Billing não faz parte da V1** (ver Objetivos da V1), mas a economia orienta as decisões.
- **Preço ao cliente (alvo):** R$57/mês por seat (1 seat = 1 conta de LinkedIn conectada).
- **Custo por conta na Unipile:** ~€5/mês (~R$29 ao câmbio de ~R$5,77/€ em jul/2026).
- **Margem bruta por cliente:** ~R$28/mês, antes de taxas do gateway de pagamento e do custo de tempo/suporte.
- **Piso de custo:** €49/mês (~R$283) fixo, independente do número de contas até 10.
- **Breakeven:** ~6 clientes pagantes. Abaixo disso, a operação subsidia o piso e opera no prejuízo.
- **Comportamento acima de 10 contas:** custo passa a ~€5 linear por conta adicional; a margem por cliente estabiliza em ~R$28.
**Implicação de negócio:** a meta inicial não é "validar com 3 pessoas" — é **lotar rapidamente os primeiros ~10 seats** para sair do subsídio do piso. O lucro depende de volume, não de qualquer ganho de arbitragem entre estar dentro ou fora dos 10 slots (o custo por slot é praticamente plano em ~€5).
---
## 3. Princípios e restrições
Regras que guiam todas as decisões e que **não devem ser reabertas** sem forte justificativa.
### Segurança (inegociável)
- **O `account_id` é sempre resolvido no servidor**, a partir da API key autenticada. Nunca é aceito do corpo da requisição do cliente. Esta é a regra de segurança mais crítica do sistema: sem ela, o cliente A consegue agir como o cliente B.
- **O master token e o DSN da Unipile nunca saem do servidor.** Não vão para o cliente, não vão para o front-end, não vão para logs. Vivem em secrets manager. Um vazamento do master token compromete o negócio inteiro.
- Da API key nós guardamos apenas o hash — o valor é exibido uma única vez na criação.
### Compliance
- O modelo de revenda sob conta-mestra foi **confirmado como permitido pela Unipile**.
- O cliente e a operação devem respeitar os Termos de Uso do LinkedIn. Automação agressiva (volume alto de convites/mensagens) é o que mais restringe contas. Por isso, **rate limiting é obrigatório mesmo na V1** (ver Marcos).
- A responsabilidade de compliance sobre o comportamento de outreach recai sobre nós como operador — não sobre a Unipile.
### Arquitetura
- **Uma única conta-mestra Unipile.** Sem sharding. (O custo por slot é plano, então sharding não traz ganho econômico; e o principal risco de suspensão agiria no nível do dono da conta, não de assinaturas isoladas.) O modelo de dados fica simples, mas sem acoplamentos que impeçam segmentar no futuro caso surja um motivo concreto.
- **Escopo LinkedIn apenas.** Sem WhatsApp, Instagram, e-mail ou calendário na V1.
- **Sem Recruiter, Jobs ou Ads.** Recruiter em especial é a origem de problemas de sessão/reconexão descritos na doc da Unipile — desabilitá-lo reduz suporte.
- **Sem n8n.** O caminho síncrono (proxy) e a ingestão de eventos não passam por n8n, por risco de timeout/acúmulo de fila sob rajada. Trabalho assíncrono (quando existir, na fase 2) usa fila dedicada com retry nativo.
---
## 4. Objetivos da V1
### A pergunta que a V1 responde
> "Eu consigo chamar `api.minhamarca.com/v1/...` com uma chave que eu emiti, e isso executa a ação correta no LinkedIn da conta certa — sem que um cliente consiga tocar na conta de outro?"
Se isso funciona, o núcleo do negócio está provado. Todo o resto é evolução.
### Objetivos concretos
1. Provar o **roteamento**: request na nossa API → chamada correta na Unipile → ação executada no LinkedIn.
2. Provar o **isolamento multi-tenant**: cada API key só acessa a conta do seu próprio tenant.
3. Provar o **manejo seguro de segredos**: master token e DSN nunca expostos.
4. Ter um **conjunto mínimo de endpoints** de LinkedIn funcionando de ponta a ponta.
5. Ter um **rate limiter** protegendo contra o excesso que restringe contas.
6. Poder **testar com uma pessoa real** (não-desenvolvedor) usando uma chave + documentação.
### O que é sucesso na V1
Uma pessoa de teste recebe uma API key e um link de documentação, e consegue — sozinha — enviar uma mensagem e um convite de conexão pelo LinkedIn conectado, através da nossa API, sem nunca ver a palavra "Unipile" e sem que o time explique no braço.
### O que está explicitamente FORA da V1
- Billing / integração com Asaas (fase 2).
- Subsistema de webhooks e fan-out de eventos para o cliente (fase 2).
- Painel/inbox visual para o cliente.
- Hosted auth de auto-conexão pode ficar como V1.5 (ver Marco 4) — na V1 core, a conta de teste já está conectada manualmente.
- Qualquer canal além de LinkedIn.
- Sharding / múltiplas contas-mestra.
---
## 5. Decisões técnicas e racional
### Duas planas separadas
O sistema tem dois planos que vivem separados:
- **Control plane** (cadastro, emissão de chave, futuramente painel e billing): tolerante a latência.
- **Data plane** (o proxy que roteia a chamada do cliente para a Unipile em tempo real): precisa ser rápido e sempre no ar. **É o coração da V1.**
### O proxy / gateway
Recebe a chamada do cliente e, em cada request: autentica a API key nossa → resolve o tenant e o `account_id` → **força o `account_id` server-side** → aplica rate limit → roteia para `https://{DSN}/api/v1/...` injetando o master token no header → registra uso → devolve a resposta.
### Por que Cloudflare Workers + Hono
O proxy precisa ser um serviço síncrono, de baixa latência, sempre disponível, feito para ser proxy. Cloudflare Workers + Hono atende bem: rápido, global, barato, sem cold-start relevante. Alternativa aceitável: Vercel Functions (se houver preferência por concentrar tudo num só provedor). **n8n foi descartado** para este caminho — não foi feito para ser API pública síncrona e falha sob rajada.
### Por que sem n8n em lugar nenhum
O modo de falha temido (fila acumulando, timeout) ocorre quando se acopla ingestão e processamento num workflow bloqueante. Na V1 não há trabalho assíncrono. Na fase 2 (webhooks para o cliente), o padrão será: endpoint de ingestão valida e enfileira, responde 200 na hora; um consumidor processa depois, com retry nativo (Cloudflare Queues / Upstash QStash / Inngest / pgmq no Supabase). Isso remove o modo de falha por design.
### Stack da V1
| Camada | Escolha | Observação |
|---|---|---|
| Proxy (data plane) | Cloudflare Workers + Hono | Alternativa: Vercel Functions |
| Banco de dados | Supabase (Postgres) | RLS para isolamento de tenant |
| Segredos | Secrets do Worker | Master token e DSN nunca no cliente |
| Rate limiting | Cloudflare KV ou Upstash Redis | Contador por chave por janela |
| Documentação | Scalar (a partir do OpenAPI) | Gratuito, renderiza OpenAPI |
| n8n | Não usar | — |
---
## 6. Arquitetura da V1 (fluxo)
```
App do cliente
   │  POST api.minhamarca.com/v1/...   (header: X-API-KEY = chave NOSSA)
   ▼
Proxy (Cloudflare Worker + Hono)
   │  1. autentica a chave → resolve tenant
   │  2. resolve account_id do tenant (do banco, NUNCA do request)
   │  3. checa rate limit
   │  4. injeta master token + DSN + account_id
   ▼
Unipile (conta-mestra única)
   │
   ▼
LinkedIn (conta do cliente)  ← limites do LinkedIn aplicam aqui
```
---
## 7. Escopo de endpoints da V1
Conjunto **mínimo e curado** (não espelhamos os 500+ endpoints da Unipile). Foco em vendas via LinkedIn:
1. **Enviar mensagem** em um chat existente.
2. **Enviar convite de conexão.**
3. **Listar chats** (necessário para obter um `chat_id` de destino).
> **Nota de risco:** enviar convite e enviar mensagem são exatamente as ações que restringem contas no LinkedIn quando usadas em volume. Por isso o rate limiter entra já na V1, não como enfeite. Considerar, na definição de limites default, os valores conservadores recomendados pela Unipile (ver Referências → Provider Limits).
Endpoints de leitura de perfil, posts/comentários e outros ficam para depois, conforme demanda.
---
## 8. Modelo de dados (V1)
Mínimo necessário para provar isolamento. Três tabelas:
- **`tenants`** — o cliente. (id, nome, data de criação, status)
- **`api_keys`** — (id, tenant_id, hash_da_chave, status, data de criação). Guardar apenas o hash.
- **`connected_accounts`** — (id, tenant_id, unipile_account_id, provider = 'linkedin', status). O vínculo entre tenant e a conta real na Unipile.
Isolamento via RLS do Supabase: um tenant nunca lê dado de outro. A resolução de `account_id` sempre parte da API key → tenant → `connected_accounts`.
---
## 9. Marcos da V1
Cada marco é testável isoladamente. Os três primeiros já provam o negócio inteiro com uma conta real — sem billing, sem onboarding, sem fila.
### Marco 0 — Fundação ✅ (pré-requisitos já atendidos)
Conta Unipile ativa, credenciais em mãos, e uma conta de LinkedIn de teste conectada via dashboard da Unipile. `account_id`, DSN e master token disponíveis e guardados com segurança.
*Status: concluído (o usuário já possui conta e credenciais).*
### Marco 1 — Proxy esqueleto (o coração)
Um Worker com **um** endpoint: enviar mensagem. Chave hardcoded, `account_id` seedado. Exercita roteamento, manejo de segredo e injeção server-side.
**Feito quando:** um POST com a chave e uma mensagem de teste resulta em mensagem enviada de verdade no LinkedIn conectado.
### Marco 2 — Camada de dados e isolamento
Substitui o hardcode por Supabase (as três tabelas). A chave passa a resolver tenant → `account_id` a partir do banco.
**Feito quando:** duas chaves diferentes apontam para duas contas diferentes, e está demonstrado que a chave A não consegue agir pela conta do tenant B — mesmo passando o `account_id` do B no request.
### Marco 3 — Conjunto V1 de endpoints + rate limit
Adiciona enviar convite de conexão e listar chats. Implementa o rate limiter por chave (contador por janela via KV/Redis).
**Feito quando:** as três ações funcionam e o limiter corta o excesso antes de a própria equipe se queimar testando.
### Marco 4 — Auto-conexão (pode ser V1.5)
Constrói a hosted auth da Unipile: backend gera link white-label, redireciona o usuário, recebe o `account_id` em callback e grava em `connected_accounts`. Desabilitar Recruiter/Jobs no parâmetro de conexão.
**Feito quando:** alguém que não é a equipe conecta o próprio LinkedIn e sai com um `account_id` funcionando, sem tocar no painel da Unipile.
### Marco 5 — Documentação mínima e emissão de chave
OpenAPI spec dos 3 endpoints, renderizado com Scalar. Forma simples de emitir/revogar chave (pode ser script no início).
**Feito quando:** dá para entregar a uma pessoa de teste uma chave + link de doc, e ela usa sem explicação verbal.
---
## 10. Fora de escopo / Fase 2+
- **Billing (Asaas):** assinatura recorrente em BRL, Pix/boleto, controle de inadimplência (pausar `account_id`, nunca deletar). Definir taxa por transação do Asaas no cálculo de margem.
- **Webhooks para o cliente:** ingestão de eventos da Unipile (nova mensagem, status de conta) + fan-out assinado (HMAC) para a URL do cliente, com fila e retry. Padrão: ingestão desacoplada do processamento.
- **Reconexão automatizada:** capturar webhook de status de conta da Unipile e notificar o cliente quando o LinkedIn cair/pedir re-login. É o principal centro de custo de suporte previsto.
- **Painel admin (operador):** visão de todos os tenants, saúde das contas, uso, e monitoramento de abuso (detectar quem manda volume demais antes de o LinkedIn restringir).
- **Painel/inbox do cliente**, expansão de endpoints, e comercialização (aquisição dos primeiros clientes).
---
## 11. Riscos e mitigações
| Risco | Mitigação |
|---|---|
| Vazamento do master token | Segredo só no servidor; nunca em cliente/log; rotação possível |
| Cliente A age como cliente B | `account_id` forçado server-side; RLS no banco |
| Conta de LinkedIn restringida por outreach agressivo | Rate limiter obrigatório desde a V1; limites default conservadores |
| Reconexão frequente de conta | Desabilitar Recruiter; automação de notificação (fase 2) |
| Subsídio do piso abaixo de 6 clientes | Meta de lotar os primeiros ~10 seats rápido (fase de comercialização) |
| Dependência de fornecedor único (Unipile) | Aceito conscientemente na V1; monitorar mudanças de ToS/preço |
---
## 12. Perguntas em aberto
- Domínio da API: registrar `linkedapi.com.br` (o nome LinkedAPI já está em uso nos docs e na spec).
- Infra do banco: o projeto Supabase do Marco 2 saiu do ar (ver docs/decisoes.md, "Em aberto"); restaurar ou criar novo e aplicar as migrations 0001-0003.
- Taxa efetiva do Asaas no ticket de R$57 (impacta margem; relevante só na fase 2).
- Resolvidas: valores default do rate limiter (M3.5: 80 mensagens/dia, 30 convites/dia) e provedor do contador (M3.4: Cloudflare KV).
---
## 13. Referências
### Documentação oficial da Unipile
- **Índice legível por máquina (começar por aqui numa nova sessão de IA):** https://developer.unipile.com/llms.txt
- Getting Started: https://developer.unipile.com/docs/getting-started
- API Usage (autenticação, DSN, Access Token): https://developer.unipile.com/docs/api-usage
- API Reference: https://developer.unipile.com/reference
- Métodos de conexão: https://developer.unipile.com/docs/connect-accounts
- Hosted Auth Wizard: https://developer.unipile.com/docs/hosted-auth
- Guia LinkedIn: https://developer.unipile.com/docs/linkedin
- Objeto de mensagem: https://developer.unipile.com/docs/message-payload
- Enviar mensagens: https://developer.unipile.com/docs/send-messages
- Recuperar mensagens: https://developer.unipile.com/docs/get-messages
- Convidar usuários (convites de conexão): https://developer.unipile.com/docs/invite-users
- Detectar convites aceitos: https://developer.unipile.com/docs/detecting-accepted-invitations
- Posts e comentários: https://developer.unipile.com/docs/posts-and-comments
- **Limites e restrições por provedor (importante para o rate limiter):** https://developer.unipile.com/docs/provider-limits-and-restrictions
- Lista de features por provedor: https://developer.unipile.com/docs/list-provider-features
- Visão geral de webhooks (fase 2): https://developer.unipile.com/docs/webhooks-2
- Webhook de status de conta (fase 2): https://developer.unipile.com/docs/account-lifecycle
- Webhook de novas mensagens (fase 2): https://developer.unipile.com/docs/new-messages-webhook
- Node.js SDK: https://developer.unipile.com/docs/nodejs-sdk
- Dashboard: https://dashboard.unipile.com
### SDKs (GitHub)
- Organização Unipile no GitHub: https://github.com/unipile
- Node.js SDK: https://github.com/unipile/unipile-node-sdk
### Stack (referência técnica)
- Hono (framework do proxy): https://hono.dev
- Cloudflare Workers: https://developers.cloudflare.com/workers/
- Cloudflare Queues (fase 2): https://developers.cloudflare.com/queues/
- Supabase: https://supabase.com/docs
- Scalar (documentação a partir de OpenAPI): https://github.com/scalar/scalar
- Asaas (gateway de pagamento, fase 2): https://docs.asaas.com
---
*Fim do PRD v1.0. Atualizar a versão e a data a cada revisão relevante.*
