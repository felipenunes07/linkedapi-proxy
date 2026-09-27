// Projecoes das respostas dos endpoints de LinkedIn (F2.41).
//
// Mesma politica de lib/sanitize.ts: WHITELIST. So o campo listado aqui
// chega ao cliente; campo novo que a origem passe a devolver nao vaza. Para
// os objetos ricos que vem do LinkedIn (experiencia, formacao, anexos de
// post...), a whitelist e do nivel de cima e o conteudo aninhado passa por
// `limpa`, uma segunda barreira que remove, em qualquer profundidade, chaves
// de infraestrutura (account_id e afins) e strings que apontem para a origem.
//
// Entrada e sempre `unknown` (corpo upstream): tipo inesperado vira null.

import { asRecord, pickNumber, pickString as pickStringCru } from './sanitize';

// Chaves que nunca saem, em nenhum nivel: identificam a conta na conta-mestra
// ou sao metadados internos da origem (nome do objeto, provedor, caixa).
const CHAVES_INFRA = new Set([
  'account_id',
  'account_type',
  'object',
  'provider',
  'mailbox_id',
  'organization_id',
]);

const PROFUNDIDADE_MAXIMA = 8;

function stringDeInfra(v: string): boolean {
  return /unipile/i.test(v) || v.startsWith('att://');
}

export function limpa(valor: unknown, profundidade = 0): unknown {
  if (profundidade > PROFUNDIDADE_MAXIMA) return null;
  if (typeof valor === 'string') return stringDeInfra(valor) ? null : valor;
  if (typeof valor === 'number' || typeof valor === 'boolean' || valor === null) {
    return valor;
  }
  if (Array.isArray(valor)) {
    return valor.map((item) => limpa(item, profundidade + 1));
  }
  if (typeof valor === 'object') {
    const saida: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(valor as Record<string, unknown>)) {
      if (CHAVES_INFRA.has(k)) continue;
      saida[k] = limpa(v, profundidade + 1);
    }
    return saida;
  }
  return null;
}

// Copia so as chaves listadas (ausente vira null), com `limpa` no valor.
export function projeta<K extends string>(
  raw: unknown,
  campos: readonly K[],
): Record<K, unknown> {
  const obj = asRecord(raw);
  const saida = {} as Record<K, unknown>;
  for (const campo of campos) {
    saida[campo] = campo in obj ? limpa(obj[campo]) : null;
  }
  return saida;
}

// Mesma leitura de sanitize.pickString, com a faxina de `limpa`: url de
// foto, perfil etc. lidas campo a campo tambem nao podem apontar para a
// origem (revisao F2.41).
function pickString(obj: Record<string, unknown>, key: string): string | null {
  const v = pickStringCru(obj, key);
  return v !== null && stringDeInfra(v) ? null : v;
}

function pickBool(obj: Record<string, unknown>, key: string): boolean | null {
  const v = obj[key];
  if (typeof v === 'boolean') return v;
  // A origem representa varios booleanos como 0/1.
  if (v === 0 || v === 1) return v === 1;
  return null;
}

function itens(raw: unknown): unknown[] {
  const obj = asRecord(raw);
  return Array.isArray(obj.items) ? obj.items : [];
}

// Cursor da origem para a proxima pagina. Algumas listas o devolvem na raiz,
// outras dentro de `paging`.
export function cursorDaOrigem(raw: unknown): string | null {
  const obj = asRecord(raw);
  // Leitura crua: o cursor vai lacrado, nunca sai como veio.
  return pickStringCru(obj, 'cursor') ?? pickStringCru(asRecord(obj.paging), 'cursor');
}

// ---------------------------------------------------------------- mensagens

export interface Anexo {
  id: string | null;
  type: string | null;
  mimetype: string | null;
  file_name: string | null;
  file_size: number | null;
  unavailable: boolean | null;
  // Caminho NOSSO para baixar o arquivo (a url da origem nao sai).
  download_path: string | null;
}

// `contaEscolhida`: o account_id NOSSO (acc_...) quando a request escolheu
// outra conta do grupo (F2.42). Vai no caminho de download, senao o link
// baixaria pela conta da chave e daria 404.
function projetaAnexo(raw: unknown, messageId: string | null, contaEscolhida: string | null): Anexo {
  const a = asRecord(raw);
  const id = pickString(a, 'id');
  const sufixo = contaEscolhida ? `?account_id=${encodeURIComponent(contaEscolhida)}` : '';
  return {
    id,
    type: pickString(a, 'type'),
    mimetype: pickString(a, 'mimetype'),
    file_name: pickString(a, 'file_name'),
    file_size: pickNumber(a, 'file_size'),
    unavailable: pickBool(a, 'unavailable'),
    download_path:
      id && messageId && pickBool(a, 'unavailable') !== true
        ? `/v1/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(id)}${sufixo}`
        : null,
  };
}

export function projetaMensagem(raw: unknown, contaEscolhida: string | null = null) {
  const m = asRecord(raw);
  const id = pickString(m, 'id');
  const reacoes = Array.isArray(m.reactions) ? m.reactions : [];
  const anexos = Array.isArray(m.attachments) ? m.attachments : [];
  const citada = m.quoted ? asRecord(m.quoted) : null;
  return {
    id,
    chat_id: pickString(m, 'chat_id'),
    sender_id: pickString(m, 'sender_id'),
    sender_attendee_id: pickString(m, 'sender_attendee_id'),
    text: pickString(m, 'text'),
    subject: pickString(m, 'subject'),
    timestamp: pickString(m, 'timestamp'),
    message_type: pickString(m, 'message_type'),
    is_sender: pickBool(m, 'is_sender'),
    seen: pickBool(m, 'seen'),
    delivered: pickBool(m, 'delivered'),
    edited: pickBool(m, 'edited'),
    deleted: pickBool(m, 'deleted'),
    hidden: pickBool(m, 'hidden'),
    is_event: pickBool(m, 'is_event'),
    event_type: pickNumber(m, 'event_type'),
    reactions: reacoes.map((r) => {
      const x = asRecord(r);
      return {
        value: pickString(x, 'value'),
        sender_id: pickString(x, 'sender_id'),
        is_sender: pickBool(x, 'is_sender'),
      };
    }),
    attachments: anexos.map((a) => projetaAnexo(a, id, contaEscolhida)),
    quoted: citada
      ? {
          id: pickString(citada, 'id'),
          sender_id: pickString(citada, 'sender_id'),
          text: pickString(citada, 'text'),
        }
      : null,
  };
}

export function projetaListaMensagens(raw: unknown, contaEscolhida: string | null = null) {
  return itens(raw).map((m) => projetaMensagem(m, contaEscolhida));
}

// ---------------------------------------------------------------- conversas

export function projetaChat(raw: unknown, contaEscolhida: string | null = null) {
  const c = asRecord(raw);
  const ultima = c.lastMessage ?? c.last_message;
  return {
    id: pickString(c, 'id'),
    name: pickString(c, 'name'),
    timestamp: pickString(c, 'timestamp'),
    unread_count: pickNumber(c, 'unread_count'),
    archived: pickNumber(c, 'archived'),
    attendee_provider_id: pickString(c, 'attendee_provider_id'),
    read_only: pickBool(c, 'read_only'),
    pinned: pickBool(c, 'pinned'),
    muted_until: limpa(c.muted_until ?? null),
    last_message: ultima ? projetaMensagem(ultima, contaEscolhida) : null,
  };
}

export function projetaParticipante(raw: unknown) {
  const p = asRecord(raw);
  const esp = asRecord(p.specifics);
  return {
    id: pickString(p, 'id'),
    provider_id: pickString(p, 'provider_id'),
    name: pickString(p, 'name'),
    is_self: pickBool(p, 'is_self'),
    hidden: pickBool(p, 'hidden'),
    profile_url: pickString(p, 'profile_url'),
    picture_url: pickString(p, 'picture_url'),
    occupation: pickString(esp, 'occupation'),
    network_distance: pickString(esp, 'network_distance'),
    is_company: typeof esp.is_company === 'boolean' ? esp.is_company : null,
  };
}

export function projetaListaParticipantes(raw: unknown) {
  return itens(raw).map(projetaParticipante);
}

// ---------------------------------------------------------------- perfis

export function projetaMe(raw: unknown) {
  const m = asRecord(raw);
  const orgs = Array.isArray(m.organizations) ? m.organizations : [];
  return {
    provider_id: pickString(m, 'provider_id'),
    public_identifier: pickString(m, 'public_identifier'),
    first_name: pickString(m, 'first_name'),
    last_name: pickString(m, 'last_name'),
    headline: pickString(m, 'occupation'),
    location: pickString(m, 'location'),
    email: pickString(m, 'email'),
    profile_picture_url: pickString(m, 'profile_picture_url'),
    premium: pickBool(m, 'premium'),
    open_profile: pickBool(m, 'open_profile'),
    // Paginas de empresa que a conta administra.
    organizations: orgs.map((o) => {
      const x = asRecord(o);
      return { id: pickString(x, 'id'), name: pickString(x, 'name') };
    }),
  };
}

const CAMPOS_PERFIL = [
  'provider_id',
  'public_identifier',
  'member_urn',
  'first_name',
  'last_name',
  'pronoun',
  'headline',
  'summary',
  'location',
  'primary_locale',
  'contact_info',
  'birthdate',
  'websites',
  'creator_website',
  'hashtags',
  'public_profile_url',
  'profile_picture_url',
  'profile_picture_url_large',
  'background_picture_url',
  'network_distance',
  'connections_count',
  'follower_count',
  'shared_connections_count',
  'connected_at',
  'can_send_inmail',
  'invitation',
  'is_relationship',
  'is_self',
  'is_open_profile',
  'is_premium',
  'is_verified',
  'is_influencer',
  'is_creator',
  'is_hiring',
  'is_open_to_work',
  'work_experience',
  'work_experience_total_count',
  'education',
  'education_total_count',
  'skills',
  'skills_total_count',
  'languages',
  'languages_total_count',
  'certifications',
  'certifications_total_count',
  'projects',
  'projects_total_count',
  'volunteering_experience',
  'volunteering_experience_total_count',
  'recommendations',
] as const;

export function projetaPerfil(raw: unknown) {
  return projeta(raw, CAMPOS_PERFIL);
}

const CAMPOS_EMPRESA = [
  'id',
  'name',
  'public_identifier',
  'entity_urn',
  'profile_url',
  'description',
  'tagline',
  'logo',
  'website',
  'phone',
  'industry',
  'organization_type',
  'foundation_date',
  'employee_count',
  'employee_count_range',
  'followers_count',
  'locations',
  'hashtags',
  'activities',
  'messaging',
  'claimed',
  'is_following',
  'is_employee',
  'acquired_by',
] as const;

export function projetaEmpresa(raw: unknown) {
  return projeta(raw, CAMPOS_EMPRESA);
}

// ---------------------------------------------------------------- rede

export function projetaConexao(raw: unknown) {
  const r = asRecord(raw);
  return {
    // Mesmo identificador aceito por POST /v1/invitations e POST /v1/chats.
    provider_id: pickString(r, 'member_id'),
    public_identifier: pickString(r, 'public_identifier'),
    first_name: pickString(r, 'first_name'),
    last_name: pickString(r, 'last_name'),
    headline: pickString(r, 'headline'),
    public_profile_url: pickString(r, 'public_profile_url'),
    profile_picture_url: pickString(r, 'profile_picture_url'),
    member_urn: pickString(r, 'member_urn'),
    connection_urn: pickString(r, 'connection_urn'),
    connected_at: pickNumber(r, 'created_at'),
  };
}

export function projetaSeguidor(raw: unknown) {
  const f = asRecord(raw);
  return {
    provider_id: pickString(f, 'id'),
    name: pickString(f, 'name'),
    headline: pickString(f, 'headline'),
    profile_url: pickString(f, 'profile_url'),
    profile_picture_url: pickString(f, 'profile_picture_url'),
  };
}

export function projetaConvite(raw: unknown, recebido: boolean) {
  const i = asRecord(raw);
  const base = {
    id: pickString(i, 'id'),
    date: pickString(i, 'date'),
    parsed_datetime: pickString(i, 'parsed_datetime'),
    invitation_text: pickString(i, 'invitation_text'),
    invited_user: pickString(i, 'invited_user'),
    invited_user_id: pickString(i, 'invited_user_id'),
    invited_user_public_id: pickString(i, 'invited_user_public_id'),
    invited_user_description: pickString(i, 'invited_user_description'),
    invited_user_profile_picture_url: pickString(i, 'invited_user_profile_picture_url'),
  };
  if (!recebido) return base;
  const quem = asRecord(i.inviter);
  return {
    ...base,
    inviter: {
      name: pickString(quem, 'inviter_name'),
      provider_id: pickString(quem, 'inviter_id'),
      public_identifier: pickString(quem, 'inviter_public_identifier'),
      description: pickString(quem, 'inviter_description'),
    },
    // Token do proprio LinkedIn, exigido para aceitar/recusar este convite.
    shared_secret: pickString(asRecord(i.specifics), 'shared_secret'),
  };
}

// ---------------------------------------------------------------- conteudo

const CAMPOS_POST = [
  'id',
  'social_id',
  'share_url',
  'title',
  'text',
  'date',
  'parsed_datetime',
  'reaction_counter',
  'comment_counter',
  'repost_counter',
  'impressions_counter',
  'user_reacted',
  'author',
  'written_by',
  'permissions',
  'mentions',
  'attachments',
  'is_repost',
  'repost_id',
  'repost_parsed_datetime',
  'reposted_by',
  'repost_content',
  'poll',
  'article',
] as const;

export function projetaPost(raw: unknown) {
  return projeta(raw, CAMPOS_POST);
}

const CAMPOS_COMENTARIO = [
  'id',
  'post_id',
  'post_urn',
  'thread_id',
  'date',
  'author',
  'author_details',
  'text',
  'picture_url',
  'reaction_counter',
  'reply_counter',
  'impressions_counter',
  'user_reacted',
] as const;

export function projetaComentario(raw: unknown) {
  return projeta(raw, CAMPOS_COMENTARIO);
}

export function projetaReacao(raw: unknown) {
  return projeta(raw, ['value', 'post_id', 'comment_id', 'author'] as const);
}

// ---------------------------------------------------------------- busca

const CAMPOS_BUSCA_PESSOA = [
  'type',
  'id',
  'public_identifier',
  'public_profile_url',
  'profile_url',
  'profile_picture_url',
  'profile_picture_url_large',
  'member_urn',
  'name',
  'first_name',
  'last_name',
  'headline',
  'location',
  'industry',
  'network_distance',
  'connections_count',
  'followers_count',
  'shared_connections_count',
  'pending_invitation',
  'can_send_inmail',
  'premium',
  'verified',
  'open_profile',
  'current_positions',
] as const;

const CAMPOS_BUSCA_EMPRESA = [
  'type',
  'id',
  'name',
  'profile_url',
  'logo',
  'summary',
  'industry',
  'location',
  'followers_count',
  'job_offers_count',
  'headcount',
] as const;

export function projetaResultadoBusca(raw: unknown, categoria: string) {
  if (categoria === 'companies') return projeta(raw, CAMPOS_BUSCA_EMPRESA);
  if (categoria === 'posts') return projetaPost(raw);
  return projeta(raw, CAMPOS_BUSCA_PESSOA);
}

export function projetaParametroBusca(raw: unknown) {
  const p = asRecord(raw);
  return {
    id: pickString(p, 'id'),
    title: pickString(p, 'title'),
    picture_url: pickString(p, 'picture_url'),
  };
}

export function projetaSaldoInmail(raw: unknown) {
  const s = asRecord(raw);
  return {
    premium: pickNumber(s, 'premium'),
    sales_navigator: pickNumber(s, 'sales_navigator'),
    recruiter: pickNumber(s, 'recruiter'),
  };
}

export { itens };
