import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Env } from '../src/types';

// Endpoints de LinkedIn da expansao (F2.41).
//
// Estrategia diferente dos testes da V1: em vez de mockar funcao por funcao
// de lib/unipile, trocamos o `fetch` global por uma ORIGEM FALSA que registra
// cada chamada. Assim o caminho inteiro roda de verdade (auth real, rate
// limit real, montagem da URL, injecao do token, projecao, cursor lacrado) e
// o teste enxerga exatamente o que sairia para a origem.
//
// A origem falsa reproduz o comportamento medido na sondagem real de
// 2026-09-22: pedir conversa/mensagem por id devolve o recurso de OUTRA
// conta mesmo com a nossa conta no query string. E isso que a conferencia de
// posse tem que barrar.

const KEY_A = 'lk_live_key_do_tenant_A';
const KEY_B = 'lk_live_key_do_tenant_B';
const ACCT_A = 'acct-A-interna';
const ACCT_B = 'acct-B-interna';
const DSN = 'api9.unipile.com:13999';
const MASTER = 'master-token-nunca-vaza';

import { hashApiKey } from '../src/lib/tenants';

vi.mock('../src/lib/supabase', () => ({
  supabaseSelect: vi.fn(
    async (_env: Env, table: string, filters: Record<string, string>) => {
      const hashA = await hashApiKey(KEY_A);
      const hashB = await hashApiKey(KEY_B);
      if (table === 'api_keys') {
        if (filters.key_hash === `eq.${hashA}`) return [{ tenant_id: 'tA' }];
        if (filters.key_hash === `eq.${hashB}`) return [{ tenant_id: 'tB' }];
        return [];
      }
      if (table === 'tenants') {
        if (filters.id === 'eq.tA') return [{ id: 'tA' }];
        if (filters.id === 'eq.tB') return [{ id: 'tB' }];
        return [];
      }
      if (table === 'connected_accounts') {
        if (filters.tenant_id === 'eq.tA') return [{ unipile_account_id: ACCT_A }];
        if (filters.tenant_id === 'eq.tB') return [{ unipile_account_id: ACCT_B }];
        return [];
      }
      return [];
    },
  ),
  supabaseUpdate: vi.fn(async () => {}),
  supabaseRpc: vi.fn(async () => {}),
}));

import app from '../src/index';
import { supabaseRpc } from '../src/lib/supabase';
import { DAILY_LIMITS } from '../src/lib/limits';
import { memoryKV } from './helpers';
import { accountIdPublico } from '../src/lib/contas';

// account_id PUBLICO da conta de A (F2.42): o unico que a chave de A pode
// mandar. O da origem (ACCT_B) ou de outro cliente vira 404, ver contas.test.
const CONTA_A = await accountIdPublico('tA');

// ------------------------------------------------------------ origem falsa

interface Chamada {
  method: string;
  path: string; // sem o prefixo /api/v1
  query: URLSearchParams;
  json: Record<string, unknown> | null;
  form: FormData | null;
  apiKey: string | null;
}

let chamadas: Chamada[] = [];
type Rota = (ch: Chamada) => Response | Promise<Response>;
let rotas: Record<string, Rota> = {};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function erro(status: number, tipo: string): Response {
  // Formato real de erro da origem: detail com texto livre que NAO pode sair.
  return json(
    { status, type: `errors/${tipo}`, title: 'x', detail: `detalhe interno ${DSN} ${ACCT_A}` },
    status,
  );
}

function b64(obj: unknown): string {
  return btoa(JSON.stringify(obj));
}

const ANEXO_A = {
  id: 'att1',
  type: 'img',
  url: `att://${ACCT_A}/segredo`,
  mimetype: 'image/png',
  unavailable: false,
  size: { width: 10, height: 10 },
};

function mensagem(id: string, conta: string, chat: string) {
  return {
    object: 'Message',
    id,
    account_id: conta,
    chat_id: chat,
    chat_provider_id: 'urn:li:msg_conversation:x',
    provider_id: 'urn:li:msg_message:x',
    sender_id: 'ACoPessoa',
    sender_attendee_id: 'att-pessoa',
    text: `texto de ${id}`,
    timestamp: '2026-09-20T10:00:00.000Z',
    is_sender: 0,
    seen: 1,
    edited: 0,
    deleted: 0,
    hidden: 0,
    delivered: 1,
    is_event: 0,
    message_type: 'MESSAGE',
    reactions: [{ value: '👍', sender_id: 'ACoPessoa', is_sender: false }],
    attachments: conta === ACCT_A ? [ANEXO_A] : [],
    seen_by: {},
  };
}

function chat(id: string, conta: string) {
  return {
    object: 'Chat',
    id,
    account_id: conta,
    account_type: 'LINKEDIN',
    provider_id: 'urn:li:msg_conversation:y',
    attendee_provider_id: 'ACoPessoa',
    name: `chat ${id}`,
    type: 0,
    timestamp: '2026-09-20T10:00:00.000Z',
    unread_count: 2,
    archived: 0,
    read_only: 0,
    pinned: 1,
    muted_until: null,
    folder: ['INBOX'],
    lastMessage: mensagem(`last-${id}`, conta, id),
  };
}

// Conteudo de LinkedIn "sujo" de proposito: chaves e strings de infra em
// varios niveis, para provar a faxina recursiva.
const PERFIL = {
  object: 'UserProfile',
  provider: 'LINKEDIN',
  provider_id: 'ACoPessoa',
  public_identifier: 'fulano',
  first_name: 'Fulano',
  last_name: 'Silva',
  headline: 'Vendas',
  account_id: ACCT_A,
  work_experience: [
    { company: 'ACME', position: 'SDR', account_id: ACCT_A, logo: `https://${DSN}/x.png` },
  ],
  skills: [{ name: 'Vendas', endorsement_id: 123, endorsed: false }],
  campo_novo_da_origem: 'nao pode sair',
};

function rotasPadrao(): Record<string, Rota> {
  return {
    'GET /users/me': () =>
      json({
        object: 'AccountOwnerProfile',
        provider: 'LINKEDIN',
        provider_id: 'ACoEu',
        public_identifier: 'eu',
        first_name: 'Eu',
        last_name: 'Mesmo',
        occupation: 'Fundador',
        email: 'eu@example.com',
        premium: false,
        open_profile: true,
        organizations: [{ id: '123', mailbox_id: 'mbx-interna', name: 'Minha Empresa' }],
        entity_urn: 'urn:li:x',
      }),
    'GET /linkedin/inmail_balance': () =>
      json({ object: 'LinkedinInmailBalance', premium: 5, recruiter: null, sales_navigator: null }),
    'GET /users/fulano': () => json(PERFIL),
    'GET /users/ACoPessoa': () => json(PERFIL),
    'GET /users/ACoPessoa/posts': () =>
      json({
        object: 'PostList',
        items: [{ object: 'Post', provider: 'LINKEDIN', id: '1', social_id: 'urn:li:activity:1', text: 'post', account_id: ACCT_A }],
        cursor: b64({ pagination_token: 't', start: 10, account_id: [ACCT_A] }),
      }),
    'GET /users/ACoPessoa/comments': () =>
      json({ object: 'CommentList', items: [{ object: 'Comment', id: 'c1', text: 'bom' }], cursor: null }),
    'GET /users/ACoPessoa/reactions': () =>
      json({ object: 'PostReactionList', items: [{ object: 'PostReaction', value: 'LIKE', post_id: 'p' }], cursor: null }),
    'GET /users/123/posts': () => json({ object: 'PostList', items: [], cursor: null }),
    'GET /chat_attendees/ACoPessoa/chats': () =>
      json({ object: 'ChatList', items: [chat('chatA', ACCT_A), chat('chatB', ACCT_B)], cursor: null }),
    'GET /chat_attendees/ACoPessoa/messages': () =>
      json({ object: 'MessageList', items: [mensagem('msgA', ACCT_A, 'chatA'), mensagem('msgB', ACCT_B, 'chatB')], cursor: null }),
    'POST /linkedin/profile/endorse': () => json({ object: 'LinkedinProfileEndorse', endorsed: true }),
    'GET /linkedin/company/playbook': () =>
      json({ object: 'CompanyProfile', id: '123', name: 'Playbook', viewer_permissions: { canX: true }, account_id: ACCT_A }),
    'POST /linkedin/search': () =>
      json({
        object: 'LinkedinSearch',
        items: [
          { object: 'SearchResult', type: 'PEOPLE', id: 'ACo1', name: 'P1', headline: 'h', hiddenCandidate: false },
          { object: 'SearchResult', type: 'PEOPLE', id: 'ACo2', name: 'P2' },
          { object: 'SearchResult', type: 'COMPANY', id: '99', name: 'Empresa' },
        ],
        config: { params: { api: 'classic' } },
        metadata: { search_history_id: 'interno' },
        paging: { start: 0, page_count: 3, total_count: 42 },
        cursor: b64({ account_id: ACCT_A, limit: 3, params: {} }),
      }),
    'GET /linkedin/search/parameters': () =>
      json({ object: 'LinkedinSearchParametersList', items: [{ object: 'LinkedinSearchParameter', id: '105871508', title: 'Sao Paulo' }], paging: { page_count: 1 } }),
    'GET /users/relations': () =>
      json({
        object: 'UserRelationsList',
        items: [{ object: 'UserRelation', member_id: 'ACoAmigo', first_name: 'A', last_name: 'B', created_at: 1700000000000 }],
        cursor: b64({ limit: 1, startIndex: 1 }),
      }),
    'GET /users/followers': () =>
      json({ object: 'UserFollowersList', items: [{ object: 'UserFollower', id: 'ACoSeg', name: 'S' }], cursor: null }),
    'GET /users/invite/sent': () =>
      json({ object: 'InvitationList', items: [{ object: 'InvitationSent', id: 'inv1', invited_user: 'X' }], cursor: null }),
    'GET /users/invite/received': () =>
      json({
        object: 'InvitationList',
        items: [{ object: 'InvitationReceived', id: 'inv9', inviter: { inviter_name: 'Y', inviter_id: 'ACoY' }, specifics: { provider: 'LINKEDIN', shared_secret: 'seg' } }],
        cursor: null,
      }),
    'DELETE /users/invite/sent/inv1': () => json({ object: 'InvitationCanceled' }),
    'POST /users/invite/received/inv9': () => json({ object: 'UserInvitationHandled', status: 'accepted' }),
    'POST /chats': () => json({ object: 'ChatStarted', chat_id: 'chatNovo', message_id: 'm1' }, 201),
    'POST /chats/chatA/messages': () => json({ object: 'MessageSent', message_id: 'mX' }),
    'GET /chats/chatA': () => json(chat('chatA', ACCT_A)),
    // Comportamento REAL da origem: devolve o chat de B para quem pedir.
    'GET /chats/chatB': () => json(chat('chatB', ACCT_B)),
    'GET /chats/chatA/messages': () =>
      json({
        object: 'MessageList',
        items: [mensagem('msgA', ACCT_A, 'chatA')],
        cursor: b64({ limit: 1, chat_id: 'chatA', cursor: { last_id: 'x' } }),
      }),
    'GET /chats/chatB/messages': () =>
      json({ object: 'MessageList', items: [mensagem('msgB', ACCT_B, 'chatB')], cursor: null }),
    'GET /chats/chatA/attendees': () =>
      json({
        object: 'ChatAttendeeList',
        items: [{ object: 'ChatAttendee', id: 'att-pessoa', account_id: ACCT_A, provider_id: 'ACoPessoa', name: 'P', is_self: 0, specifics: { provider: 'LINKEDIN', occupation: 'CEO', network_distance: 'FIRST_DEGREE', is_company: false, member_urn: 'x' } }],
      }),
    'GET /chats/chatB/attendees': () => json({ object: 'ChatAttendeeList', items: [] }),
    'PATCH /chats/chatA': () => json({ object: 'ChatPatched' }),
    'DELETE /chats/chatA': () => json({ object: 'ChatDeleted' }),
    'GET /messages/msgA': () => json(mensagem('msgA', ACCT_A, 'chatA')),
    'GET /messages/msgB': () => json(mensagem('msgB', ACCT_B, 'chatB')),
    'GET /messages/msgA/attachments/att1': () =>
      new Response(new Uint8Array([137, 80, 78, 71]), {
        status: 200,
        headers: { 'content-type': 'image/png', 'content-length': '4', 'x-origem-interna': DSN },
      }),
    'PATCH /messages/msgA': () => json({ object: 'MessagePatched' }),
    'DELETE /messages/msgA': () => json({ object: 'MessageDeleted' }),
    'POST /messages/msgA/reaction': () => json({ object: 'MessageReactionAdded', success: true }),
    'POST /posts': () => json({ object: 'PostCreated', post_id: 'urn:li:activity:77' }, 201),
    'GET /posts/urn:li:activity:1': () =>
      json({ object: 'Post', provider: 'LINKEDIN', id: '1', social_id: 'urn:li:activity:1', text: 't', author: { id: 'ACoPessoa', name: 'P', is_company: false } }),
    'GET /posts/urn:li:activity:1/comments': () =>
      json({ object: 'CommentList', items: [{ object: 'Comment', id: 'c1', text: 'bom', post_id: '1' }], cursor: null, total_items: 1, paging: { start: 0 } }),
    'GET /posts/urn:li:activity:1/reactions': () =>
      json({ object: 'PostReactionList', items: [{ object: 'PostReaction', value: 'LIKE', post_id: '1' }], paging: { cursor: b64({ x: 1 }), start: 0 } }),
    'POST /posts/urn:li:activity:1/comments': () => json({ object: 'CommentSent', comment_id: 'c2' }, 201),
    'POST /posts/reaction': () => json({ object: 'ReactionAdded' }, 201),
  };
}

async function origemFalsa(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
  expect(url.host).toBe(DSN);
  const headers = new Headers(init?.headers);
  const ch: Chamada = {
    method: init?.method ?? 'GET',
    path: decodeURIComponent(url.pathname.replace(/^\/api\/v1/, '')),
    query: url.searchParams,
    json: typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : null,
    form: init?.body instanceof FormData ? init.body : null,
    apiKey: headers.get('X-API-KEY'),
  };
  chamadas.push(ch);
  const rota = rotas[`${ch.method} ${ch.path}`];
  return rota ? rota(ch) : erro(404, 'resource_not_found');
}

let env: Env;

beforeEach(() => {
  chamadas = [];
  rotas = rotasPadrao();
  vi.stubGlobal('fetch', vi.fn(origemFalsa));
  vi.mocked(supabaseRpc).mockClear();
  env = {
    ENVIRONMENT: 'test',
    UNIPILE_DSN: DSN,
    UNIPILE_MASTER_TOKEN: MASTER,
    SUPABASE_URL: 'https://fake.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'service-role-nunca-vaza',
    RATE_LIMIT: memoryKV(),
  } as Env;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function chamar(
  method: string,
  path: string,
  opts: { key?: string; body?: unknown; form?: FormData } = {},
) {
  const headers: Record<string, string> = { 'X-API-KEY': opts.key ?? KEY_A };
  let body: BodyInit | undefined;
  if (opts.form) {
    body = opts.form;
  } else if (opts.body !== undefined) {
    headers['content-type'] = 'application/json';
    body = typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body);
  }
  return app.request(path, { method, headers, body }, env);
}

// Nada de infraestrutura pode aparecer na resposta ao cliente.
function semVazamento(texto: string) {
  const baixo = texto.toLowerCase();
  for (const proibido of [ACCT_A, ACCT_B, DSN, MASTER, 'unipile', 'att://', 'account_id', 'mailbox_id']) {
    expect(baixo).not.toContain(proibido.toLowerCase());
  }
}

function ultima(): Chamada {
  const ch = chamadas.at(-1);
  if (!ch) throw new Error('nenhuma chamada a origem');
  return ch;
}

// ============================================================ leitura

interface CasoLeitura {
  nome: string;
  path: string;
  origem: string; // "METHOD /path" esperado na origem
  contaNaQuery: boolean;
  acao: keyof typeof DAILY_LIMITS | null;
}

const LEITURAS: CasoLeitura[] = [
  { nome: 'me', path: '/v1/me', origem: 'GET /users/me', contaNaQuery: true, acao: 'network_reads' },
  { nome: 'inmail', path: '/v1/inmail-balance', origem: 'GET /linkedin/inmail_balance', contaNaQuery: true, acao: 'network_reads' },
  { nome: 'perfil', path: '/v1/profiles/fulano', origem: 'GET /users/fulano', contaNaQuery: true, acao: 'profile_views' },
  { nome: 'posts do perfil', path: '/v1/profiles/ACoPessoa/posts', origem: 'GET /users/ACoPessoa/posts', contaNaQuery: true, acao: 'content_reads' },
  { nome: 'comentarios do perfil', path: '/v1/profiles/ACoPessoa/comments', origem: 'GET /users/ACoPessoa/comments', contaNaQuery: true, acao: 'content_reads' },
  { nome: 'reacoes do perfil', path: '/v1/profiles/ACoPessoa/reactions', origem: 'GET /users/ACoPessoa/reactions', contaNaQuery: true, acao: 'content_reads' },
  { nome: 'conversas com a pessoa', path: '/v1/profiles/ACoPessoa/chats', origem: 'GET /chat_attendees/ACoPessoa/chats', contaNaQuery: true, acao: null },
  { nome: 'mensagens com a pessoa', path: '/v1/profiles/ACoPessoa/messages', origem: 'GET /chat_attendees/ACoPessoa/messages', contaNaQuery: true, acao: null },
  { nome: 'empresa', path: '/v1/companies/playbook', origem: 'GET /linkedin/company/playbook', contaNaQuery: true, acao: 'profile_views' },
  { nome: 'posts da empresa', path: '/v1/companies/123/posts', origem: 'GET /users/123/posts', contaNaQuery: true, acao: 'content_reads' },
  { nome: 'parametros de busca', path: '/v1/search/parameters?type=LOCATION&keywords=Sao%20Paulo', origem: 'GET /linkedin/search/parameters', contaNaQuery: true, acao: 'network_reads' },
  { nome: 'conexoes', path: '/v1/relations?filter=ana', origem: 'GET /users/relations', contaNaQuery: true, acao: 'network_reads' },
  { nome: 'seguidores', path: '/v1/followers', origem: 'GET /users/followers', contaNaQuery: true, acao: 'network_reads' },
  { nome: 'convites enviados', path: '/v1/invitations/sent', origem: 'GET /users/invite/sent', contaNaQuery: true, acao: 'network_reads' },
  { nome: 'convites recebidos', path: '/v1/invitations/received', origem: 'GET /users/invite/received', contaNaQuery: true, acao: 'network_reads' },
  { nome: 'detalhe do chat', path: '/v1/chats/chatA', origem: 'GET /chats/chatA', contaNaQuery: true, acao: null },
  { nome: 'mensagens do chat', path: '/v1/chats/chatA/messages', origem: 'GET /chats/chatA/messages', contaNaQuery: false, acao: null },
  { nome: 'participantes do chat', path: '/v1/chats/chatA/attendees', origem: 'GET /chats/chatA/attendees', contaNaQuery: false, acao: null },
  { nome: 'mensagem', path: '/v1/messages/msgA', origem: 'GET /messages/msgA', contaNaQuery: false, acao: null },
  { nome: 'post', path: '/v1/posts/urn:li:activity:1', origem: 'GET /posts/urn:li:activity:1', contaNaQuery: true, acao: 'content_reads' },
  { nome: 'comentarios do post', path: '/v1/posts/urn:li:activity:1/comments', origem: 'GET /posts/urn:li:activity:1/comments', contaNaQuery: true, acao: 'content_reads' },
  { nome: 'reacoes do post', path: '/v1/posts/urn:li:activity:1/reactions', origem: 'GET /posts/urn:li:activity:1/reactions', contaNaQuery: true, acao: 'content_reads' },
];

describe('leituras: rota certa na origem, conta do tenant, nada vaza', () => {
  for (const caso of LEITURAS) {
    it(caso.nome, async () => {
      // account_id no query do cliente (o nosso, F2.42): escolhe a conta,
      // mas nunca chega a origem como veio; a origem so ve a conta resolvida.
      const sep = caso.path.includes('?') ? '&' : '?';
      const res = await chamar('GET', `${caso.path}${sep}account_id=${CONTA_A}`);
      expect(res.status).toBe(200);
      const texto = await res.text();
      semVazamento(texto);
      expect(JSON.parse(texto).ok).toBe(true);

      const ch = ultima();
      expect(`${ch.method} ${ch.path}`).toBe(caso.origem);
      expect(ch.apiKey).toBe(MASTER);
      if (caso.contaNaQuery) expect(ch.query.get('account_id')).toBe(ACCT_A);
      expect(ch.query.getAll('account_id')).not.toContain(CONTA_A);

      // Cota: leitura que toca o LinkedIn conta 1; caixa de entrada nao conta.
      const dia = new Date().toISOString().slice(0, 10);
      if (caso.acao) {
        expect(await env.RATE_LIMIT.get(`rl:tA:${caso.acao}:${dia}`)).toBe('1');
      } else {
        expect(vi.mocked(supabaseRpc)).not.toHaveBeenCalled();
      }
    });
  }
});

describe('projecoes', () => {
  it('perfil: whitelist no topo e faxina recursiva no conteudo aninhado', async () => {
    const res = await chamar('GET', '/v1/profiles/fulano');
    const body = (await res.json()) as { data: Record<string, unknown> };
    expect(body.data.first_name).toBe('Fulano');
    expect(body.data).not.toHaveProperty('campo_novo_da_origem');
    expect(body.data).not.toHaveProperty('provider');
    const exp = (body.data.work_experience as Record<string, unknown>[])[0];
    expect(exp).toEqual({ company: 'ACME', position: 'SDR', logo: null });
  });

  it('perfil: visita NAO notifica por padrao; secoes validadas', async () => {
    await chamar('GET', '/v1/profiles/fulano?sections=experience,skills');
    expect(ultima().query.get('notify')).toBe('false');
    expect(ultima().query.getAll('linkedin_sections')).toEqual(['experience', 'skills']);

    await chamar('GET', '/v1/profiles/fulano?notify=true');
    expect(ultima().query.get('notify')).toBe('true');

    const n = chamadas.length;
    const res = await chamar('GET', '/v1/profiles/fulano?sections=recruiting_activity');
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_sections' });
    expect(chamadas.length).toBe(n);
  });

  it('mensagem: anexo sai com caminho NOSSO de download, sem a url da origem', async () => {
    const res = await chamar('GET', '/v1/messages/msgA');
    const body = (await res.json()) as { data: { attachments: Record<string, unknown>[]; is_sender: boolean } };
    expect(body.data.attachments[0]).toEqual({
      id: 'att1',
      type: 'img',
      mimetype: 'image/png',
      file_name: null,
      file_size: null,
      unavailable: false,
      download_path: '/v1/messages/msgA/attachments/att1',
    });
    expect(body.data.is_sender).toBe(false);
  });

  it('me: organizacoes sem o id interno de caixa', async () => {
    const res = await chamar('GET', '/v1/me');
    const body = (await res.json()) as { data: Record<string, unknown> };
    expect(body.data.organizations).toEqual([{ id: '123', name: 'Minha Empresa' }]);
    expect(body.data.headline).toBe('Fundador');
  });

  it('convites recebidos trazem o shared_secret para aceitar/recusar', async () => {
    const res = await chamar('GET', '/v1/invitations/received');
    const body = (await res.json()) as { data: { items: Record<string, unknown>[] } };
    expect(body.data.items[0]?.shared_secret).toBe('seg');
    expect(body.data.items[0]?.inviter).toEqual({
      name: 'Y',
      provider_id: 'ACoY',
      public_identifier: null,
      description: null,
    });
  });

  it('conexoes: member_id vira provider_id (o que o convite e a conversa aceitam)', async () => {
    const res = await chamar('GET', '/v1/relations');
    const body = (await res.json()) as { data: { items: Record<string, unknown>[] } };
    expect(body.data.items[0]?.provider_id).toBe('ACoAmigo');
  });

  it('empresa: permissoes de administrador da pagina nao saem', async () => {
    const res = await chamar('GET', '/v1/companies/playbook');
    const body = (await res.json()) as { data: Record<string, unknown> };
    expect(body.data.name).toBe('Playbook');
    expect(body.data).not.toHaveProperty('viewer_permissions');
  });
});

// ============================================================ posse

describe('posse: recurso de outra conta vira 404, mesmo a origem entregando', () => {
  it('detalhe de chat de B pela chave de A', async () => {
    const res = await chamar('GET', '/v1/chats/chatB');
    expect(res.status).toBe(404);
    const texto = await res.text();
    expect(JSON.parse(texto)).toEqual({ error: 'not_found' });
    semVazamento(texto);
    expect(texto).not.toContain('chat chatB');
  });

  it('mensagens de chat de B: nem chega a listar', async () => {
    const res = await chamar('GET', '/v1/chats/chatB/messages');
    expect(res.status).toBe(404);
    expect(chamadas.map((c) => c.path)).toEqual(['/chats/chatB']);
  });

  it('participantes de chat de B', async () => {
    const res = await chamar('GET', '/v1/chats/chatB/attendees');
    expect(res.status).toBe(404);
    expect(chamadas.map((c) => c.path)).toEqual(['/chats/chatB']);
  });

  it('marcar como lido / apagar chat de B: nenhuma escrita sai', async () => {
    expect((await chamar('PATCH', '/v1/chats/chatB', { body: { read: true } })).status).toBe(404);
    expect((await chamar('DELETE', '/v1/chats/chatB')).status).toBe(404);
    expect(chamadas.every((c) => c.method === 'GET')).toBe(true);
  });

  it('enviar pelo atalho /v1/chats/{id}/messages em chat de B: a origem recusa e vira 404', async () => {
    // O envio usa o account_id como guarda na origem (provado no real):
    // chat de outra conta responde 403.
    rotas['POST /chats/chatB/messages'] = (ch) =>
      ch.form?.get('account_id') === ACCT_B ? json({ message_id: 'x' }) : erro(403, 'forbidden');
    const res = await chamar('POST', '/v1/chats/chatB/messages', { body: { text: 'oi' } });
    expect(res.status).toBe(404);
    expect(ultima().form?.get('account_id')).toBe(ACCT_A);
  });

  it('mensagem de B: ler, editar, apagar, reagir e baixar anexo', async () => {
    expect((await chamar('GET', '/v1/messages/msgB')).status).toBe(404);
    expect((await chamar('PATCH', '/v1/messages/msgB', { body: { text: 'x' } })).status).toBe(404);
    expect((await chamar('DELETE', '/v1/messages/msgB')).status).toBe(404);
    expect((await chamar('POST', '/v1/messages/msgB/reactions', { body: { reaction: '👍' } })).status).toBe(404);
    expect((await chamar('GET', '/v1/messages/msgB/attachments/att1')).status).toBe(404);
    expect(chamadas.every((c) => c.method === 'GET' && c.path === '/messages/msgB')).toBe(true);
  });

  it('listas por pessoa: item de outra conta e filtrado mesmo se a origem mandar', async () => {
    for (const path of ['/v1/profiles/ACoPessoa/chats', '/v1/profiles/ACoPessoa/messages']) {
      const res = await chamar('GET', path);
      const texto = await res.text();
      semVazamento(texto);
      const body = JSON.parse(texto) as { data: { items: { id: string }[] } };
      expect(body.data.items.map((i) => i.id)).toEqual([path.endsWith('chats') ? 'chatA' : 'msgA']);
    }
  });

  it('anexo que nao e da mensagem: 404 sem baixar nada', async () => {
    const res = await chamar('GET', '/v1/messages/msgA/attachments/outro');
    expect(res.status).toBe(404);
    expect(chamadas.map((c) => c.path)).toEqual(['/messages/msgA']);
  });

  it('chat inexistente: 404 not_found', async () => {
    const res = await chamar('GET', '/v1/chats/nao-existe');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'not_found' });
  });
});

// ============================================================ cursor

describe('cursor lacrado', () => {
  async function primeiraPagina(key = KEY_A) {
    const res = await chamar('GET', '/v1/chats/chatA/messages', { key });
    const body = (await res.json()) as { data: { cursor: string | null } };
    return body.data.cursor;
  }

  it('sai opaco (sem conta nem chat) e volta para a origem como veio', async () => {
    const cursor = await primeiraPagina();
    expect(cursor).toBeTruthy();
    expect(() => JSON.parse(atob(String(cursor)))).toThrow();

    const res = await chamar('GET', `/v1/chats/chatA/messages?cursor=${cursor}&limit=5`);
    expect(res.status).toBe(200);
    const enviado = ultima().query.get('cursor');
    expect(JSON.parse(atob(String(enviado)))).toEqual({ limit: 1, chat_id: 'chatA', cursor: { last_id: 'x' } });
    expect(ultima().query.get('limit')).toBe('5');
  });

  it('cursor da busca (que carrega a conta dentro) nao sai legivel', async () => {
    const res = await chamar('POST', '/v1/search', { body: { category: 'people', keywords: 'x' } });
    const texto = await res.text();
    semVazamento(texto);
  });

  it('cursor adulterado: 400 e a lista nao e pedida a origem', async () => {
    const cursor = String(await primeiraPagina());
    const adulterado = cursor.slice(0, -2) + (cursor.endsWith('A') ? 'BB' : 'AA');
    const n = chamadas.length;
    const res = await chamar('GET', `/v1/chats/chatA/messages?cursor=${adulterado}`);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_cursor' });
    // O escopo do cursor e o id CONFERIDO da conversa, entao a posse roda
    // antes; a lista em si nunca sai.
    expect(chamadas.slice(n).map((c) => c.path)).toEqual(['/chats/chatA']);
  });

  it('cursor por id da thread e por id da conversa e o mesmo escopo (id conferido)', async () => {
    rotas['GET /chats/urn:li:thread:1'] = () => json(chat('chatA', ACCT_A));
    const cursor = await primeiraPagina();
    const res = await chamar('GET', `/v1/chats/urn:li:thread:1/messages?cursor=${cursor}`);
    expect(res.status).toBe(200);
    // A lista sai pelo id conferido, nunca pelo que o cliente mandou.
    expect(ultima().path).toBe('/chats/chatA/messages');
  });

  it('cursor de OUTRO tenant: 400', async () => {
    rotas['GET /chats/chatB/messages'] = () =>
      json({ items: [], cursor: b64({ chat_id: 'chatB' }) });
    const res = await chamar('GET', '/v1/chats/chatB/messages', { key: KEY_B });
    const cursorDeB = ((await res.json()) as { data: { cursor: string } }).data.cursor;
    const n = chamadas.length;
    const r = await chamar('GET', `/v1/relations?cursor=${cursorDeB}`, { key: KEY_A });
    expect(r.status).toBe(400);
    expect(chamadas.length).toBe(n);
  });

  it('cursor de outra rota (ou de outro chat) do mesmo tenant: 400', async () => {
    const cursor = await primeiraPagina();
    expect((await chamar('GET', `/v1/relations?cursor=${cursor}`)).status).toBe(400);
    rotas['GET /chats/chatC'] = () => json(chat('chatC', ACCT_A));
    expect((await chamar('GET', `/v1/chats/chatC/messages?cursor=${cursor}`)).status).toBe(400);
  });

  it('cursor forjado em base64 comum: 400', async () => {
    const forjado = b64({ account_id: [ACCT_B], limit: 10 });
    expect((await chamar('GET', `/v1/relations?cursor=${forjado}`)).status).toBe(400);
  });

  it('cursor dentro de paging (reacoes de post) tambem e lacrado', async () => {
    const res = await chamar('GET', '/v1/posts/urn:li:activity:1/reactions');
    const body = (await res.json()) as { data: { cursor: string | null } };
    expect(body.data.cursor).toBeTruthy();
    expect(() => JSON.parse(atob(String(body.data.cursor)))).toThrow();
  });
});

// ============================================================ escrita

describe('escritas: corpo certo na origem, conta do tenant', () => {
  it('POST /v1/chats: conversa nova (InMail), conta de A, cota de mensagens', async () => {
    const res = await chamar('POST', '/v1/chats', {
      body: { provider_id: 'ACoPessoa', text: 'oi', inmail: true, subject: 'assunto', account_id: CONTA_A },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, data: { chat_id: 'chatNovo', message_id: 'm1' } });
    const f = ultima().form;
    expect(f?.get('account_id')).toBe(ACCT_A);
    expect(f?.getAll('attendees_ids')).toEqual(['ACoPessoa']);
    expect(f?.get('linkedin[api]')).toBe('classic');
    expect(f?.get('linkedin[inmail]')).toBe('true');
    const dia = new Date().toISOString().slice(0, 10);
    expect(await env.RATE_LIMIT.get(`rl:tA:messages:${dia}`)).toBe('1');
  });

  it('POST /v1/chats com anexo em multipart', async () => {
    const form = new FormData();
    form.set('provider_id', 'ACoPessoa');
    form.set('text', 'segue');
    form.append('attachments', new File([new Uint8Array([1, 2, 3])], 'proposta.pdf', { type: 'application/pdf' }));
    const res = await chamar('POST', '/v1/chats', { form });
    expect(res.status).toBe(200);
    const anexo = ultima().form?.get('attachments') as unknown as File;
    expect(anexo.name).toBe('proposta.pdf');
    expect(anexo.size).toBe(3);
  });

  it('POST /v1/messages com anexo em multipart (sem texto vale)', async () => {
    const form = new FormData();
    form.set('chat_id', 'chatA');
    form.append('attachments', new File([new Uint8Array([9])], 'a.png', { type: 'image/png' }));
    const res = await chamar('POST', '/v1/messages', { form });
    expect(res.status).toBe(200);
    expect(ultima().form?.get('account_id')).toBe(ACCT_A);
    expect(ultima().form?.get('text')).toBeNull();
    expect((ultima().form?.get('attachments') as unknown as File).name).toBe('a.png');
  });

  it('POST /v1/chats/{chat_id}/messages: atalho com chat no path', async () => {
    const res = await chamar('POST', '/v1/chats/chatA/messages', { body: { text: 'oi' } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, data: { message_id: 'mX' } });
    expect(ultima().path).toBe('/chats/chatA/messages');
  });

  it('endosso de competencia', async () => {
    const res = await chamar('POST', '/v1/profiles/ACoPessoa/endorsements', { body: { endorsement_id: 123 } });
    expect(res.status).toBe(200);
    expect(ultima().json).toEqual({ account_id: ACCT_A, profile_id: 'ACoPessoa', skill_endorsement_id: 123 });
  });

  it('cancelar convite enviado', async () => {
    const res = await chamar('DELETE', '/v1/invitations/sent/inv1');
    expect(res.status).toBe(200);
    expect(ultima().query.get('account_id')).toBe(ACCT_A);
  });

  it('aceitar convite recebido', async () => {
    const res = await chamar('POST', '/v1/invitations/received/inv9', {
      body: { action: 'accept', shared_secret: 'seg', account_id: CONTA_A },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, data: { status: 'accepted' } });
    expect(ultima().json).toEqual({ provider: 'LINKEDIN', account_id: ACCT_A, shared_secret: 'seg', action: 'accept' });
  });

  it('marcar chat como lido', async () => {
    const res = await chamar('PATCH', '/v1/chats/chatA', { body: { read: true } });
    expect(res.status).toBe(200);
    expect(ultima().json).toEqual({ action: 'setReadStatus', value: true });
  });

  it('apagar chat', async () => {
    expect((await chamar('DELETE', '/v1/chats/chatA')).status).toBe(200);
    expect(`${ultima().method} ${ultima().path}`).toBe('DELETE /chats/chatA');
  });

  it('editar, reagir e apagar mensagem', async () => {
    expect((await chamar('PATCH', '/v1/messages/msgA', { body: { text: 'corrigido' } })).status).toBe(200);
    expect(ultima().json).toEqual({ text: 'corrigido' });
    expect((await chamar('POST', '/v1/messages/msgA/reactions', { body: { reaction: '👍' } })).status).toBe(200);
    expect(ultima().json).toEqual({ reaction: '👍' });
    expect((await chamar('DELETE', '/v1/messages/msgA')).status).toBe(200);
  });

  it('baixar anexo: binario com cabecalhos NOSSOS', async () => {
    const res = await chamar('GET', '/v1/messages/msgA/attachments/att1');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    expect(res.headers.get('x-origem-interna')).toBeNull();
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array([137, 80, 78, 71]));
  });

  it('publicar post', async () => {
    const res = await chamar('POST', '/v1/posts', { body: { text: 'Novidade', external_link: 'https://exemplo.com' } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, data: { post_id: 'urn:li:activity:77' } });
    expect(ultima().form?.get('account_id')).toBe(ACCT_A);
    expect(ultima().form?.get('external_link')).toBe('https://exemplo.com');
  });

  it('comentar e responder comentario', async () => {
    const res = await chamar('POST', '/v1/posts/urn:li:activity:1/comments', { body: { text: 'Boa!', comment_id: 'c1' } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, data: { comment_id: 'c2' } });
    expect(ultima().form?.get('comment_id')).toBe('c1');
    expect(ultima().form?.get('account_id')).toBe(ACCT_A);
  });

  it('reagir a post (default like)', async () => {
    const res = await chamar('POST', '/v1/posts/urn:li:activity:1/reactions', { body: {} });
    expect(res.status).toBe(200);
    expect(ultima().json).toEqual({ account_id: ACCT_A, post_id: 'urn:li:activity:1', reaction_type: 'like' });
  });
});

// ============================================================ busca

describe('POST /v1/search', () => {
  it('filtro fora da whitelist (ex.: trocar a API para recruiter) e 400, sem tocar a origem', async () => {
    for (const extra of [{ api: 'recruiter' }, { hiring_project: 'x' }, { category_extra: 1 }]) {
      const res = await chamar('POST', '/v1/search', { body: { category: 'people', ...extra } });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'unknown_filter', filter: Object.keys(extra)[0] });
    }
    // Filtro de empresa nao vale na busca de pessoas, e vice-versa.
    expect((await chamar('POST', '/v1/search', { body: { category: 'people', headcount: [] } })).status).toBe(400);
    expect((await chamar('POST', '/v1/search', { body: { category: 'companies', school: ['1'] } })).status).toBe(400);
    expect(chamadas).toHaveLength(0);
  });

  it('busca vazia ou com limit=1 custa uma pagina (10) da cota', async () => {
    rotas['POST /linkedin/search'] = () => json({ items: [], paging: {}, cursor: null });
    await chamar('POST', '/v1/search?limit=1', { body: { category: 'people', keywords: 'ninguem' } });
    const dia = new Date().toISOString().slice(0, 10);
    expect(await env.RATE_LIMIT.get(`rl:tA:search_results:${dia}`)).toBe('10');
  });

  it('forca a API classica, tira o account_id do grupo e conta RESULTADOS (minimo uma pagina)', async () => {
    const res = await chamar('POST', '/v1/search?limit=10', {
      body: { category: 'people', keywords: 'sdr', location: ['105871508'], account_id: CONTA_A },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { items: Record<string, unknown>[]; total_count: number } };
    expect(body.data.items).toHaveLength(3);
    expect(body.data.items[2]).toMatchObject({ type: 'COMPANY', name: 'Empresa' });
    expect(body.data.items[0]).not.toHaveProperty('hiddenCandidate');
    expect(body.data.total_count).toBe(42);
    expect(ultima().json).toEqual({ api: 'classic', category: 'people', keywords: 'sdr', location: ['105871508'] });
    expect(ultima().query.get('account_id')).toBe(ACCT_A);
    const dia = new Date().toISOString().slice(0, 10);
    // 3 resultados, mas a chamada carregou uma pagina: cobra 10.
    expect(await env.RATE_LIMIT.get(`rl:tA:search_results:${dia}`)).toBe('10');
    // Historico persistente recebe a mesma quantidade.
    expect(vi.mocked(supabaseRpc)).toHaveBeenCalledWith(
      expect.anything(),
      'increment_usage',
      expect.objectContaining({ p_action: 'search_results', p_count: 10 }),
    );
  });

  it('proxima pagina: manda so o cursor da origem', async () => {
    const r1 = await chamar('POST', '/v1/search', { body: { category: 'people', keywords: 'x' } });
    const cursor = ((await r1.json()) as { data: { cursor: string } }).data.cursor;
    const r2 = await chamar('POST', `/v1/search?cursor=${cursor}`);
    expect(r2.status).toBe(200);
    expect(ultima().json).toEqual({ cursor: b64({ account_id: ACCT_A, limit: 3, params: {} }) });
  });

  it('busca por URL do LinkedIn; URL de outro lugar ou do Sales Navigator e recusada', async () => {
    const ok = await chamar('POST', '/v1/search', {
      body: { url: 'https://www.linkedin.com/search/results/people/?keywords=sdr' },
    });
    expect(ok.status).toBe(200);
    expect(ultima().json).toEqual({ url: 'https://www.linkedin.com/search/results/people/?keywords=sdr' });
    for (const url of ['https://evil.com/search/results/x', 'https://www.linkedin.com/sales/search/people', 'http://www.linkedin.com/search/results/x']) {
      const r = await chamar('POST', '/v1/search', { body: { url } });
      expect(r.status).toBe(400);
    }
  });

  it('categoria fora do escopo (vagas) e recusada', async () => {
    const r = await chamar('POST', '/v1/search', { body: { category: 'jobs' } });
    expect(r.status).toBe(400);
    expect(await r.json()).toEqual({ error: 'invalid_category' });
  });

  it('limite de busca: acima de 50 por pagina e recusado', async () => {
    const r = await chamar('POST', '/v1/search?limit=51', { body: { category: 'people' } });
    expect(r.status).toBe(400);
  });
});

// ============================================================ rate limit

describe('rate limit por familia', () => {
  it('estourou o limite do dia: 429 antes de tocar a origem', async () => {
    const dia = new Date().toISOString().slice(0, 10);
    await env.RATE_LIMIT.put(`rl:tA:profile_views:${dia}`, String(DAILY_LIMITS.profile_views));
    const res = await chamar('GET', '/v1/profiles/fulano');
    expect(res.status).toBe(429);
    expect(await res.json()).toMatchObject({ error: 'rate_limited', action: 'profile_views', limit: 80 });
    expect(res.headers.get('Retry-After')).toBeTruthy();
    expect(chamadas).toHaveLength(0);
  });

  it('cada familia tem contador proprio', async () => {
    const dia = new Date().toISOString().slice(0, 10);
    await env.RATE_LIMIT.put(`rl:tA:posts:${dia}`, '5');
    expect((await chamar('POST', '/v1/posts', { body: { text: 'x' } })).status).toBe(429);
    expect((await chamar('POST', '/v1/posts/urn:li:activity:1/comments', { body: { text: 'x' } })).status).toBe(200);
  });

  it('o limite de um tenant nao afeta o outro', async () => {
    const dia = new Date().toISOString().slice(0, 10);
    await env.RATE_LIMIT.put(`rl:tA:network_reads:${dia}`, '200');
    expect((await chamar('GET', '/v1/relations')).status).toBe(429);
    expect((await chamar('GET', '/v1/relations', { key: KEY_B })).status).toBe(200);
  });

  it('erro da origem nao consome cota', async () => {
    rotas['GET /users/fulano'] = () => erro(500, 'unexpected_error');
    const res = await chamar('GET', '/v1/profiles/fulano');
    expect(res.status).toBe(502);
    const dia = new Date().toISOString().slice(0, 10);
    expect(await env.RATE_LIMIT.get(`rl:tA:profile_views:${dia}`)).toBeNull();
  });
});

// ============================================================ erros

describe('erros da origem', () => {
  it('502 com upstream_status e reason, sem o detalhe cru', async () => {
    rotas['GET /users/relations'] = () => erro(429, 'too_many_requests');
    const res = await chamar('GET', '/v1/relations');
    expect(res.status).toBe(502);
    const texto = await res.text();
    expect(JSON.parse(texto)).toEqual({ error: 'upstream_error', upstream_status: 429, reason: 'too_many_requests' });
    semVazamento(texto);
    expect(texto).not.toContain('detalhe interno');
  });

  it('perfil inexistente (422 invalid_recipient na origem) vira 404', async () => {
    const res = await chamar('GET', '/v1/profiles/ninguem');
    expect(res.status).toBe(404);
    rotas['GET /users/ninguem'] = () => erro(422, 'invalid_recipient');
    const r2 = await chamar('GET', '/v1/profiles/ninguem');
    expect(r2.status).toBe(404);
    expect(await r2.json()).toEqual({ error: 'not_found' });
  });

  it('comentar em post inexistente (422 invalid_post na origem) vira 404', async () => {
    rotas['POST /posts/urn:li:activity:9/comments'] = () => erro(422, 'invalid_post');
    const res = await chamar('POST', '/v1/posts/urn:li:activity:9/comments', { body: { text: 'x' } });
    expect(res.status).toBe(404);
    const dia = new Date().toISOString().slice(0, 10);
    expect(await env.RATE_LIMIT.get(`rl:tA:comments:${dia}`)).toBeNull();
  });

  it('400 da origem vira 400 invalid_request com reason', async () => {
    rotas['POST /linkedin/search'] = () => erro(400, 'invalid_parameters');
    const res = await chamar('POST', '/v1/search', { body: { category: 'people', location: ['abc'] } });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_request', reason: 'invalid_parameters' });
  });

  it('reason que nao tem o formato esperado nao sai', async () => {
    rotas['GET /users/followers'] = () => json({ type: `errors/${DSN}` }, 500);
    const res = await chamar('GET', '/v1/followers');
    expect(await res.json()).toEqual({ error: 'upstream_error', upstream_status: 500 });
  });

  it('convite de V1 tambem ganha reason (ex.: limite do LinkedIn)', async () => {
    rotas['POST /users/invite'] = () => erro(422, 'cannot_resend_yet');
    const res = await chamar('POST', '/v1/invitations', { body: { provider_id: 'ACoPessoa' } });
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: 'upstream_error', upstream_status: 422, reason: 'cannot_resend_yet' });
  });
});

// ============================================================ validacao

describe('validacao antes da origem', () => {
  const invalidos: [string, string, unknown?][] = [
    ['GET', '/v1/profiles/..'],
    ['GET', '/v1/profiles/%2E%2E'],
    ['GET', '/v1/chats/..'],
    ['GET', '/v1/chats/chatA/messages?limit=0'],
    ['GET', '/v1/chats/chatA/messages?limit=101'],
    ['GET', '/v1/chats/chatA/messages?before=ontem'],
    ['GET', '/v1/relations?limit=abc'],
    ['GET', '/v1/search/parameters'],
    ['GET', '/v1/search/parameters?type=HIRING_PROJECTS'],
    ['GET', '/v1/posts/urn:li:activity:1/comments?sort_by=RANDOM'],
    ['POST', '/v1/chats', { text: 'sem destinatario' }],
    ['POST', '/v1/chats', { provider_id: 'ACoPessoa' }],
    ['POST', '/v1/chats', { provider_id: 'ACoPessoa', text: 'x', topic: 'vendas' }],
    ['POST', '/v1/messages', { chat_id: '..', text: 'x' }],
    ['POST', '/v1/invitations/received/inv9', { action: 'talvez', shared_secret: 's' }],
    ['POST', '/v1/invitations/received/inv9', { action: 'accept' }],
    ['POST', '/v1/profiles/ACoPessoa/endorsements', { endorsement_id: 'abc' }],
    ['PATCH', '/v1/chats/chatA', { read: 'sim' }],
    ['PATCH', '/v1/messages/msgA', { text: '' }],
    ['POST', '/v1/messages/msgA/reactions', {}],
    ['POST', '/v1/posts', { text: '' }],
    ['POST', '/v1/posts', { text: 'x', external_link: 'javascript:alert(1)' }],
    ['POST', '/v1/posts/urn:li:activity:1/reactions', { reaction_type: 'odio' }],
    ['POST', '/v1/posts/urn:li:activity:1/comments', { text: 'x'.repeat(1251) }],
    ['POST', '/v1/search', '{nao e json'],
  ];
  for (const [method, path, body] of invalidos) {
    it(`${method} ${path} ${body === undefined ? '' : JSON.stringify(body).slice(0, 40)}`, async () => {
      const res = await chamar(method, path, { body });
      expect([400, 404]).toContain(res.status);
      // Nada foi escrito na origem (so a leitura de posse pode ter rodado).
      expect(chamadas.every((c) => c.method === 'GET')).toBe(true);
    });
  }

  it('mais de 5 anexos: 400 sem chamar a origem', async () => {
    const form = new FormData();
    form.set('chat_id', 'chatA');
    for (let i = 0; i < 6; i++) form.append('attachments', new File(['x'], `${i}.txt`));
    const res = await chamar('POST', '/v1/messages', { form });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'too_many_attachments', max: 5 });
    expect(chamadas).toHaveLength(0);
  });

  it('arquivo fora do campo attachments: 400', async () => {
    const form = new FormData();
    form.set('chat_id', 'chatA');
    form.append('outro', new File(['x'], 'x.txt'));
    expect((await chamar('POST', '/v1/messages', { form })).status).toBe(400);
  });

  it('sem chave: 401 em todas as rotas novas', async () => {
    for (const caso of LEITURAS) {
      const res = await app.request(caso.path, { method: 'GET' }, env);
      expect(res.status).toBe(401);
    }
    expect(chamadas).toHaveLength(0);
  });
});

describe('GET /v1/chats: filtros novos', () => {
  it('repassa unread/before/after validados', async () => {
    rotas['GET /chats'] = () => json({ items: [], cursor: null });
    const res = await chamar('GET', '/v1/chats?unread=true&after=2026-09-01&before=2026-09-20T12:00:00Z');
    expect(res.status).toBe(200);
    expect(ultima().query.get('unread')).toBe('true');
    expect(ultima().query.get('after')).toBe('2026-09-01T00:00:00.000Z');
    expect(ultima().query.get('before')).toBe('2026-09-20T12:00:00.000Z');
    expect(ultima().query.get('account_id')).toBe(ACCT_A);
  });

  it('filtro invalido: 400', async () => {
    expect((await chamar('GET', '/v1/chats?unread=talvez')).status).toBe(400);
    expect((await chamar('GET', '/v1/chats?after=amanha')).status).toBe(400);
    expect(chamadas).toHaveLength(0);
  });
});

// ============================================================ revisao de seguranca

describe('correcoes da revisao de seguranca (F2.41)', () => {
  it('toda chamada a origem sai com redirect manual (o token nao segue um 3xx)', async () => {
    await chamar('GET', '/v1/me');
    const init = vi.mocked(fetch).mock.calls.at(-1)?.[1];
    expect(init?.redirect).toBe('manual');
  });

  it('3xx da origem vira erro, nunca e seguido', async () => {
    rotas['GET /users/me'] = () => new Response(null, { status: 302, headers: { location: 'https://evil.example/' } });
    const res = await chamar('GET', '/v1/me');
    expect(res.status).toBe(502);
    expect(chamadas).toHaveLength(1);
  });

  it('JSON acima de 1 MB: 413 antes de qualquer parse e sem tocar a origem', async () => {
    const texto = 'x'.repeat(1024 * 1024 + 10);
    const res = await chamar('POST', '/v1/posts', { body: { text: texto } });
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: 'body_too_large', max_bytes: 1024 * 1024 });
    expect(chamadas).toHaveLength(0);
  });

  it('multipart acima do teto: 413 antes de virar FormData', async () => {
    const form = new FormData();
    form.set('chat_id', 'chatA');
    form.append('attachments', new File([new Uint8Array(17 * 1024 * 1024)], 'grande.bin'));
    const res = await chamar('POST', '/v1/messages', { form });
    expect(res.status).toBe(413);
    expect(chamadas).toHaveLength(0);
  });

  it('caixa de entrada tem teto de abuso (sem cota): 429 acima dele, sem tocar a origem', async () => {
    const dia = new Date().toISOString().slice(0, 10);
    await env.RATE_LIMIT.put(`rlt:tA:inbox_reads:${dia}`, '5000');
    for (const path of ['/v1/chats', '/v1/chats/chatA', '/v1/chats/chatA/messages', '/v1/messages/msgA', '/v1/profiles/ACoPessoa/chats']) {
      const res = await chamar('GET', path);
      expect(res.status).toBe(429);
      expect(await res.json()).toMatchObject({ error: 'rate_limited', reason: 'too_many_attempts', action: 'inbox_reads' });
    }
    expect(chamadas).toHaveLength(0);
    // Outro tenant nao e afetado.
    expect((await chamar('GET', '/v1/chats/chatA', { key: KEY_B })).status).toBe(404);
  });

  it('download de anexo tem teto proprio e sai com CSP sandbox', async () => {
    const res = await chamar('GET', '/v1/messages/msgA/attachments/att1');
    expect(res.headers.get('content-security-policy')).toContain('sandbox');
    const dia = new Date().toISOString().slice(0, 10);
    await env.RATE_LIMIT.put(`rlt:tA:attachment_downloads:${dia}`, '500');
    expect((await chamar('GET', '/v1/messages/msgA/attachments/att1')).status).toBe(429);
  });

  it('url da origem em campo lido direto (foto, perfil) vira null', async () => {
    rotas['GET /chats/chatA/attendees'] = () =>
      json({
        items: [{ id: 'a', account_id: ACCT_A, provider_id: 'ACo', name: 'N', picture_url: `https://${DSN}/foto.png`, profile_url: 'https://www.linkedin.com/in/n' }],
      });
    const res = await chamar('GET', '/v1/chats/chatA/attendees');
    const texto = await res.text();
    semVazamento(texto);
    const body = JSON.parse(texto) as { data: { items: Record<string, unknown>[] } };
    expect(body.data.items[0]?.picture_url).toBeNull();
    expect(body.data.items[0]?.profile_url).toBe('https://www.linkedin.com/in/n');
  });

  it('busca por URL: so pessoas, empresas e posts; sai normalizada', async () => {
    for (const url of [
      'https://www.linkedin.com/search/results/groups/?keywords=x',
      'https://www.linkedin.com/search/results/events/?keywords=x',
      'https://user:senha@www.linkedin.com/search/results/people/',
      'https://www.linkedin.com:8443/search/results/people/',
    ]) {
      expect((await chamar('POST', '/v1/search', { body: { url } })).status).toBe(400);
    }
    const ok = await chamar('POST', '/v1/search', {
      body: { url: 'https://www.linkedin.com/search/results/content?keywords=vendas#topo' },
    });
    expect(ok.status).toBe(200);
    expect(ultima().json).toEqual({ url: 'https://www.linkedin.com/search/results/content?keywords=vendas' });
  });

  it('escrita por id da thread age pelo id CONFERIDO da conversa', async () => {
    rotas['GET /chats/urn:li:thread:9'] = () => json(chat('chatA', ACCT_A));
    const res = await chamar('PATCH', '/v1/chats/urn:li:thread:9', { body: { read: false } });
    expect(res.status).toBe(200);
    expect(`${ultima().method} ${ultima().path}`).toBe('PATCH /chats/chatA');
  });

  it('mensagem por id alternativo: acoes seguem pelo id conferido', async () => {
    rotas['GET /messages/urn:li:msg:9'] = () => json(mensagem('msgA', ACCT_A, 'chatA'));
    expect((await chamar('DELETE', '/v1/messages/urn:li:msg:9')).status).toBe(200);
    expect(`${ultima().method} ${ultima().path}`).toBe('DELETE /messages/msgA');
  });

  it('resposta 2xx que nao e JSON no envio da V1 nao vira 500', async () => {
    rotas['POST /chats/chatA/messages'] = () => new Response('<html>ok</html>', { status: 200 });
    const res = await chamar('POST', '/v1/messages', { body: { chat_id: 'chatA', text: 'oi' } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, data: { message_id: null } });
  });
});

describe('download_path com conta escolhida (F2.42)', () => {
  it('leva o account_id NOSSO quando a request escolheu outra conta do grupo', async () => {
    const { projetaMensagem } = await import('../src/lib/projecoes');
    const semEscolha = projetaMensagem(mensagem('msgA', ACCT_A, 'chatA'));
    expect(semEscolha.attachments[0]?.download_path).toBe('/v1/messages/msgA/attachments/att1');
    const comEscolha = projetaMensagem(mensagem('msgA', ACCT_A, 'chatA'), 'acc_abc123');
    expect(comEscolha.attachments[0]?.download_path).toBe('/v1/messages/msgA/attachments/att1?account_id=acc_abc123');
  });
});
