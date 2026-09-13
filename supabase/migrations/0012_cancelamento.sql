-- Migration 0012. Cancelamento pelo proprio cliente (F2.37).
--
-- Ate aqui so existia o caminho de ENTRAR: pagar, ativar, e pausar quando
-- atrasava. Cancelar era um e-mail para o operador, e quem cancelasse a
-- autorizacao no banco continuava usando (nenhum evento de assinatura
-- cancelada era escutado, entao nada pausava).
--
-- Regra escolhida: cancelou, o acesso vale ATE O FIM DO PERIODO QUE ELE JA
-- PAGOU. Para isso o vinculo precisa saber ate quando esta pago:
--
--   access_until: preenchido a cada pagamento confirmado (vencimento da
--   cobranca paga + folga de um ciclo). Enquanto ele estiver no futuro, a
--   conta serve, mesmo com a assinatura cancelada. Passou, a faxina de hora
--   em hora PAUSA a conta (nunca apaga, mesma regra da inadimplencia).
--
-- Quem nunca pagou fica com NULL: nao ha periodo pago para respeitar.

alter table billing_subscriptions add column if not exists access_until timestamptz;

-- A faxina procura por vinculo cancelado com acesso vencido.
create index if not exists billing_subscriptions_access_until_idx
  on billing_subscriptions(access_until)
  where access_until is not null;
