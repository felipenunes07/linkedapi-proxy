# Pesquisa: checkout do cartao com a nossa marca (2026-09-10)

Motivo: o dono achou o checkout hospedado do Asaas pouco profissional (mostra a razao social da conta, sem logo). Pesquisa feita por 3 agentes com fontes (Unipile, Asaas, alternativas) e uma sintese. Decisao pendente em docs/pendencias.md.

Legenda: **[fato]** está confirmado em página ou documentação oficial, com o link ao lado. **[inferência]** é conclusão nossa a partir dos fatos. **[não verificado]** é o que as pesquisas não conseguiram confirmar.

## 1. Como a Unipile faz

A Unipile usa a Stripe. O cliente cria a conta e usa 7 dias de teste sem cartão. Na hora de assinar, ele escolhe o plano numa tabela de preços da Stripe dentro do painel da Unipile, e essa tabela leva para a página de pagamento hospedada pela Stripe. Trocar cartão, ver faturas e cancelar ficam no portal do cliente da Stripe.
Fontes: teste e preço em https://www.unipile.com/pricing-api/. O uso da Stripe foi visto no código do painel dashboard.unipile.com, baixado em 10/09/2026. O funcionamento da tabela e do portal está em https://docs.stripe.com/payments/checkout/pricing-table.

Então eles também não pedem o cartão numa página própria. A diferença é que a página da Stripe aceita logo, cores e um nome de exibição livre, que não precisa ser a razão social [fato: https://docs.stripe.com/payments/checkout/customization/appearance.md?payment-ui=stripe-hosted]. Se a Unipile colocou mesmo logo e cores na página dela é [não verificado], porque a tela exige login.

## 2. Opções para o nosso cartão

### Opção A: ajustar o Asaas (a mais barata)
A ideia é trocar o nome exibido pelo nome fantasia, subir logo e cores e já preencher os dados que o cliente informou no nosso cadastro.

- **Como fica para o cliente:**
  - O pagamento continua num endereço asaas.com. A documentação não fala em domínio próprio [fato: https://docs.asaas.com/docs/link-do-checkout-e-redirecionamento-do-cliente.md].
  - **Nome no topo:** só dá para trocar por um dos nomes registrados no CNPJ na Receita. Não dá para escrever "Playbook API" livremente [fato: https://docs.asaas.com/docs/alterar-o-nome-de-uma-subconta-pj-via-api e https://docs.asaas.com/reference/recuperar-dados-comerciais.md]. A troca só vale para empresa que não é MEI e que tem nome fantasia registrado. Isso vem de verificação parcial, porque a central de ajuda deu erro 403: https://central.ajuda.asaas.com/hc/pt-br/articles/32093924293659-Como-utilizar-o-nome-fantasia-na-minha-conta-Asaas-e-nas-faturas. Se essa troca muda o topo do checkout é [não verificado].
  - **Logo e cores:** a configuração existe, mas a documentação diz que vale só para a fatura [fato: https://docs.asaas.com/reference/recuperar-configuracoes-de-personalizacao.md]. O Asaas anunciou logo e cores no checkout "até o final de 2025" [fato: https://www.ecommercebrasil.com.br/noticias/asaas-destaca-beneficios-do-checkout-durante-forum-ecommerce-brasil-2025]. Não achamos nenhuma confirmação de que isso foi lançado [não verificado].
  - **Endereço e celular:** dá para deixar preenchidos, mas não achamos opção para esconder esses campos [fato: https://docs.asaas.com/reference/create-new-checkout e https://docs.asaas.com/docs/como-informar-os-dados-do-cliente].
- **O que exige de gente:** nenhuma conta nova. Alguém precisa conferir se a FTX tem nome fantasia na Receita e subir logo e cores no painel. A personalização passa por aprovação do Asaas antes de valer [fato: mesmo link da personalização acima].
- **Esforço de código:** baixo.
- **Custo conhecido:** não achamos preço para a personalização. A taxa atual do Asaas no cartão não entrou nesta pesquisa.
- **Pix Automático na nossa página:** continua igual.

**Variante A2, o "link de pagamento" recorrente do Asaas:**
- Tem uma opção para não exigir endereço [fato: https://docs.asaas.com/reference/criar-um-link-de-pagamentos].
- Continua em asaas.com, sem logo nem cores (só permite até 5 imagens) [fato: https://docs.asaas.com/docs/criando-um-link-de-pagamentos.md].
- Talvez o formulário do cartão continue pedindo CEP e número mesmo assim, porque a cobrança por API exige CEP, número e telefone do titular [fato: https://docs.asaas.com/reference/criar-cobranca-com-cartao-de-credito]. Na tela hospedada isso é [não verificado].
- Esforço baixo. Resolve-se com um teste no ambiente de testes do Asaas.

[inferência] Esta opção pode resolver o nome e diminuir o que o cliente digita. Provavelmente não resolve tudo o que incomodou.

### Opção B: Stripe só para o cartão (a mais profissional, igual à Unipile)
- **Como fica para o cliente:**
  - A página de pagamento da Stripe mostra o nosso logo, cores e fonte, com o nome "Playbook API" [fato: https://docs.stripe.com/payments/checkout/customization/appearance.md?payment-ui=stripe-hosted].
  - Opcional: endereço próprio, algo como pagamento.nossodominio.com.br [fato: https://docs.stripe.com/payments/checkout/custom-domains.md?payment-ui=stripe-hosted].
  - Portal pronto e com a nossa marca para trocar cartão, cancelar e ver faturas [fato: https://docs.stripe.com/customer-management].
  - Quais dados a página da Stripe pede (endereço, telefone) é [não verificado].
- **Variante mais integrada:** o campo do cartão da Stripe fica dentro da nossa página. Mesmo assim continuamos no nível mais simples de segurança de cartão (SAQ A), porque o campo roda num quadro isolado da Stripe [fato: https://stripe.com/guides/pci-compliance].
- **O que exige de gente:** abrir uma conta Stripe Brasil em nome da empresa. Os documentos pedidos são [não verificado]. [inferência] Deve pedir CNPJ, dados do sócio e conta bancária, como qualquer processador de pagamento.
- **Esforço de código:** médio na página hospedada, porque é um segundo provedor, com avisos de pagamento próprios e dois sistemas para conferir. Na variante dentro da nossa página, o esforço é alto.
- **Custo conhecido:** cartão nacional custa 3,99% + R$ 0,39 por cobrança, mais 0,7% pelo módulo de assinaturas. O domínio próprio é opcional e custa US$ 10/mês [fato: https://stripe.com/br/pricing]. Numa cobrança de R$ 57, dá cerca de R$ 3,06 [inferência, conta nossa].
- **Pix Automático na nossa página:** sim, fica no Asaas. A Stripe diz que o Pix Automático não está disponível no Brasil [fato: https://docs.stripe.com/payments/pix]. Passamos a ter dois provedores.

### Opção C: Pagar.me só para o cartão
- **Como fica para o cliente:** link hospedado com o nosso logo e duas cores. Só o nome é obrigatório, e endereço e telefone são opcionais [fato: https://docs.pagar.me/reference/create-link]. Não achamos domínio próprio nem portal do cliente.
- **O que exige de gente:** uma conta Pagar.me da empresa [inferência].
- **Esforço de código:** médio.
- **Custo conhecido:** plano Essencial com crédito à vista a 4,19%, sem mensalidade [fato: https://www.pagar.me/ofertas]. Numa cobrança de R$ 57, dá cerca de R$ 2,39 [inferência]. Se essa taxa vale também para cobrança recorrente é [não verificado].
- **Pix Automático na nossa página:** sim, fica no Asaas, porque as assinaturas da Pagar.me não aceitam Pix [fato: https://docs.pagar.me/docs/assinatura]. Dois provedores.

### Opção D: Mercado Pago
- **Como fica para o cliente:** o pagamento acontece no "Ambiente Mercado Pago" [fato: https://www.mercadopago.com.br/developers/pt/docs/subscriptions/overview]. Se dá para colocar logo e cores é [não verificado], porque a página da documentação deu erro. [inferência] A marca do Mercado Pago aparece bastante, o que pode não resolver a impressão de pouco profissional.
- **Cartão na nossa página:** existe essa possibilidade, também no nível SAQ A [fato: https://www.mercadopago.com.br/developers/pt/docs/security/pci].
- **O que exige de gente:** uma conta Mercado Pago da empresa [inferência].
- **Esforço de código:** médio. Com o cartão dentro da nossa página, é alto.
- **Custo conhecido:** crédito a 3,98% recebendo em 30 dias (cerca de R$ 2,27 em R$ 57) ou 4,98% recebendo na hora [fato: https://www.mercadopago.com.br/ferramentas-para-vender/check-out].
- **Pix Automático:** as assinaturas aceitam Pix, mas se é Pix Automático é [não verificado]. Na prática, o Pix continuaria no Asaas.

### Opção E: Vindi, trocando tudo por um provedor só
- **Como fica para o cliente:** página de pagamento personalizável, inclusive para assinaturas [fato: https://blog.vindi.com.br/pagina-de-pagamentos/]. Tem Pix Automático [fato: https://vindi.com.br/formas-de-pagamentos/pix/].
- **O que exige de gente:** uma conta Vindi nova, além de migrar o Pix que hoje já funciona.
- **Esforço de código:** alto, porque é uma migração completa.
- **Custo conhecido:** o plano com API é o Pro, de R$ 499/mês. O cartão sai a partir de 2,75% + R$ 0,39 [fato: https://vindi.com.br/precos/]. [inferência] R$ 499/mês é a receita de uns 9 assinantes, então só compensa com uma base bem maior.
- **Pix Automático na nossa página:** tem Pix Automático, mas manter o QR na nossa tela é [não verificado].

### Descartada: Iugu
Não publica taxas, e na fatura do cartão do cliente sempre aparece "Iugu*" [fato: https://dev.iugu.com/docs/cc-configuracoes-extras e https://www.iugu.com/planos].

### Resumo

| Opção | Marca própria no pagamento | Código | Custo por cobrança de R$ 57 | Pix continua na nossa página |
|---|---|---|---|---|
| A. Asaas ajustado | Parcial, e o logo no checkout não foi confirmado | Baixo | Taxa atual (não levantada) | Sim |
| B. Stripe | Completa: nome, logo, cores, domínio e portal | Médio | cerca de R$ 3,06 | Sim, no Asaas |
| C. Pagar.me | Logo e cores, sem portal | Médio | cerca de R$ 2,39 | Sim, no Asaas |
| D. Mercado Pago | Não verificado | Médio | cerca de R$ 2,27 (em 30 dias) | Sim, no Asaas |
| E. Vindi | Sim | Alto | cerca de R$ 1,96 + R$ 499/mês | A confirmar |

## 3. Recomendação

**Fazer em duas etapas.**

**Etapa 1: testar o Asaas ajustado (poucos dias, custo quase zero).**
1. Confirmar se a FTX tem nome fantasia na Receita.
2. Subir logo e cores.
3. Preencher de antemão os dados do cliente.
4. Comparar no ambiente de testes o checkout atual com o link de pagamento sem endereço.

O critério é simples. Se o topo mostrar um nome aceitável e o logo aparecer, ficamos no Asaas. Se continuar a razão social ou sem logo, vamos para a etapa 2. [inferência] A nossa expectativa é que o celular continue sendo pedido e que o logo não apareça no checkout. Se o senhor já sabe que quer o nível da Unipile, pode pular esta etapa.

**Etapa 2: Stripe só para o cartão, na página hospedada com a nossa marca (Opção B).**

Por quê:
- É a única opção com documentação clara para quatro coisas: nome de exibição livre, logo e cores, domínio próprio e portal de autoatendimento pronto.
- É o mesmo modelo da Unipile e da Linked API, que o cliente desse mercado já conhece.
- O Pix Automático continua na nossa página, pelo Asaas.
- Custa uns R$ 0,67 a mais por cobrança do que a Pagar.me [inferência]. A Pagar.me fica como plano B, caso o senhor prefira pagar menos e abrir mão do portal.

**O que o senhor precisa decidir:**
1. A FTX tem nome fantasia registrado na Receita, e qual é? Sem isso, o Asaas nunca vai mostrar "Playbook API".
2. Aceita dois provedores, com dois painéis e dois extratos: Asaas para o Pix e Stripe para o cartão?
3. Aceita cerca de R$ 3,06 por cobrança no cartão? Para comparar, precisamos levantar a taxa que o Asaas cobra hoje.
4. Quer endereço próprio na página de pagamento, por US$ 10/mês?
5. Quem abre e fica responsável pela conta Stripe, com os dados da empresa, do sócio e da conta bancária?
6. Qual é o nome definitivo do produto e qual é o logo? Os dois vão aparecer na página de pagamento.
