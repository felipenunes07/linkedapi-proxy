-- Migration 0006. Webhook do cliente (fase 2).
--
-- O tenant pode registrar uma URL para receber eventos (ex.: mensagem
-- recebida), assinados com HMAC-SHA256. O secret fica em claro nesta tabela
-- (precisa ser recuperavel para assinar); a tabela e service-role-only como as
-- demais, e o secret e gerado por nos com 256 bits (nunca escolhido pelo
-- cliente). URL obrigatoriamente https (validado no Worker).

alter table tenants add column if not exists webhook_url text;
alter table tenants add column if not exists webhook_secret text;
