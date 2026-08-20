// Projecao das respostas de sucesso: so os campos da NOSSA API saem.
//
// A Unipile devolve objetos com campos internos (account_id da conta-mestra,
// nomes de objeto do provedor, metadados de infra). Repassar o corpo cru fura a
// abstracao white-label (regra de ouro do Marco 5) e expoe o unipile_account_id
// do tenant. Politica: WHITELIST. Campo que nao esta listado aqui NUNCA chega
// ao cliente, mesmo que a Unipile passe a devolver campos novos.
//
// Defensivo por construcao: a entrada e `unknown` (corpo upstream). Campo
// ausente ou com tipo inesperado vira null/omitido, nunca um vazamento.

// Exportados: os hooks de evento (fase 2) usam a mesma disciplina de whitelist
// para projetar payloads externos antes de repassar ao cliente.
export function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : {};
}

export function pickString(
  obj: Record<string, unknown>,
  key: string,
): string | null {
  const v = obj[key];
  return typeof v === 'string' ? v : null;
}

export function pickNumber(
  obj: Record<string, unknown>,
  key: string,
): number | null {
  const v = obj[key];
  return typeof v === 'number' ? v : null;
}

// POST /v1/messages -> { message_id }
export function sanitizeMessageSent(raw: unknown): { message_id: string | null } {
  const obj = asRecord(raw);
  return { message_id: pickString(obj, 'message_id') };
}

// POST /v1/invitations -> { invitation_id }
export function sanitizeInvitationSent(raw: unknown): {
  invitation_id: string | null;
} {
  const obj = asRecord(raw);
  return { invitation_id: pickString(obj, 'invitation_id') };
}

// Resumo de conversa exposto pela nossa API. `attendee_provider_id` e o mesmo
// identificador aceito por POST /v1/invitations (provider_id do destinatario).
export interface ChatSummary {
  id: string | null;
  name: string | null;
  timestamp: string | null;
  unread_count: number | null;
  archived: number | null;
  attendee_provider_id: string | null;
}

// GET /v1/chats -> { items, cursor }
// IMPORTANT: o objeto de chat da Unipile carrega account_id (da conta-mestra) e
// outros campos internos; aqui so passa a whitelist abaixo.
export function sanitizeChatList(raw: unknown): {
  items: ChatSummary[];
  cursor: string | null;
} {
  const obj = asRecord(raw);
  const rawItems = Array.isArray(obj.items) ? obj.items : [];
  const items = rawItems.map((item): ChatSummary => {
    const chat = asRecord(item);
    return {
      id: pickString(chat, 'id'),
      name: pickString(chat, 'name'),
      timestamp: pickString(chat, 'timestamp'),
      unread_count: pickNumber(chat, 'unread_count'),
      archived: pickNumber(chat, 'archived'),
      attendee_provider_id: pickString(chat, 'attendee_provider_id'),
    };
  });
  return { items, cursor: pickString(obj, 'cursor') };
}
