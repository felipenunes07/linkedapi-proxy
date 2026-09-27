import { Hono } from 'hono';
import type { Context } from 'hono';
import type { Env, RateLimitAction, Variables } from '../types';
import { rateLimit, recordUsage, persistUsage, tetoDeTentativas } from '../middleware/rateLimit';
import { unipileForm, unipileGet, unipileJson } from '../lib/unipile';
import type { Consulta } from '../lib/unipile';
import { abreCursor, selaCursor } from '../lib/cursor';
import { erroDaOrigem } from '../lib/erros';
import type { OpcoesErro } from '../lib/erros';
import { asRecord, pickString } from '../lib/sanitize';
import {
  idValido,
  lerBooleano,
  lerData,
  lerEntrada,
  lerJson,
  lerLimite,
  textoValido,
} from '../lib/entrada';
import {
  cursorDaOrigem,
  itens,
  projetaChat,
  projetaComentario,
  projetaConexao,
  projetaConvite,
  projetaEmpresa,
  projetaListaMensagens,
  projetaListaParticipantes,
  projetaMe,
  projetaMensagem,
  projetaParametroBusca,
  projetaPerfil,
  projetaPost,
  projetaReacao,
  projetaResultadoBusca,
  projetaSaldoInmail,
  projetaSeguidor,
} from '../lib/projecoes';

// Endpoints de LinkedIn alem dos 3 da V1 (F2.41). Montado DENTRO de /v1, atras
// do authMiddleware: quem chega aqui ja tem tenant resolvido.
//
// Regras que valem para TODA rota deste arquivo (as mesmas do CLAUDE.md):
//   1. account_id sai SEMPRE de c.get('tenant'); nada do request vira conta.
//      Parametros do cliente sao escolhidos um a um, nunca espalhados.
//   2. Recurso por id (conversa, mensagem) tem POSSE conferida no servidor:
//      a sondagem de 2026-09-22 provou que a origem devolve conversa e
//      mensagens de OUTRA conta quando se pede por id, mesmo passando a nossa
//      conta junto. Sem a conferencia, um chat_id vazado virava leitura
//      cruzada. De outra conta = 404 not_found, igual a inexistente.
//   3. Resposta de sucesso so com whitelist (lib/projecoes) e cursor lacrado
//      (lib/cursor): nada de infraestrutura sai.
//   4. Tudo que toca o LinkedIn ao vivo passa por rate limit, e a cota so
//      conta o que a origem aceitou.

type Ctx = Context<{ Bindings: Env; Variables: Variables }>;

export const linkedin = new Hono<{ Bindings: Env; Variables: Variables }>();

const enc = encodeURIComponent;

function conta(c: Ctx): string {
  return c.get('tenant').unipileAccountId;
}

// O account_id NOSSO da conta escolhida no request (F2.42), para os links
// que a resposta devolve (download de anexo). null = a conta da chave.
function escolhida(c: Ctx): string | null {
  return c.get('tenant').accountIdEscolhido ?? null;
}

// Registra o uso aceito (KV do limite + historico persistente).
async function registra(c: Ctx, acao: RateLimitAction, quantidade = 1): Promise<void> {
  const tenant = c.get('tenant');
  await recordUsage(c.env.RATE_LIMIT, tenant.tenantId, acao, quantidade);
  persistUsage(c, tenant.tenantId, acao, quantidade);
}

async function jsonDaOrigem(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return {};
  }
}

// Le `limit` e `cursor` da query. O cursor do cliente so vira cursor da
// origem se abrir com a conta do tenant E o escopo desta rota.
async function paginacao(
  c: Ctx,
  escopo: string,
  maximo = 100,
): Promise<{ limit?: string; cursor?: string } | Response> {
  const limite = lerLimite(c, maximo);
  if (limite === null) {
    return c.json({ error: 'invalid_limit', max: maximo }, 400);
  }
  const bruto = c.req.query('cursor');
  let cursor: string | undefined;
  if (bruto !== undefined) {
    const aberto = await abreCursor(c.env.UNIPILE_MASTER_TOKEN, conta(c), escopo, bruto);
    if (!aberto) return c.json({ error: 'invalid_cursor' }, 400);
    cursor = aberto;
  }
  return { limit: limite === undefined ? undefined : String(limite), cursor };
}

async function lista(c: Ctx, escopo: string, bruto: unknown, items: unknown[]) {
  const cursor = await selaCursor(
    c.env.UNIPILE_MASTER_TOKEN,
    conta(c),
    escopo,
    cursorDaOrigem(bruto),
  );
  return c.json({ ok: true, data: { items, cursor } });
}

// Filtros before/after (ISO 8601) das listas de conversa e mensagem.
function periodo(c: Ctx): { before?: string; after?: string } | Response {
  const before = lerData(c, 'before');
  const after = lerData(c, 'after');
  if (before === null) return c.json({ error: 'invalid_before' }, 400);
  if (after === null) return c.json({ error: 'invalid_after' }, 400);
  return { before, after };
}

function paramId(c: Ctx, nome: string): string | Response {
  const v = c.req.param(nome);
  return idValido(v) ? v : c.json({ error: `invalid_${nome}` }, 400);
}

// ---------------------------------------------------------------- posse

function negaPosse(c: Ctx, recurso: string): Response {
  // Sinal para o operador: tentativa de ler recurso de outra conta. So o
  // tenant (uuid nosso) e o tipo, nunca o id pedido.
  console.warn(`posse_negada: tenant=${c.get('tenant').tenantId} recurso=${recurso}`);
  return c.json({ error: 'not_found' }, 404);
}

// Conversa do proprio tenant, ou a resposta de erro pronta. `id` e o id
// CONFERIDO (o do objeto que a origem devolveu): as chamadas seguintes usam
// ele, nunca o que o cliente mandou. Medido em 2026-09-22: a origem aceita
// tambem o id da thread do LinkedIn (compartilhado pelos dois participantes)
// quando vai junto a conta; sem isso, uma escrita seguinte SEM conta podia,
// em tese, resolver para a copia de outro tenant na mesma conversa.
async function chatDoTenant(
  c: Ctx,
  chatId: string,
): Promise<{ id: string; chat: Record<string, unknown> } | Response> {
  const res = await unipileGet(c.env, `/chats/${enc(chatId)}`, { account_id: conta(c) });
  if (!res.ok) return erroDaOrigem(c, res, { naoEncontrado: [400, 403, 404] });
  const chat = asRecord(await jsonDaOrigem(res));
  const id = pickString(chat, 'id');
  if (pickString(chat, 'account_id') !== conta(c) || !id) return negaPosse(c, 'chat');
  return { id, chat };
}

async function mensagemDoTenant(
  c: Ctx,
  messageId: string,
): Promise<{ id: string; msg: Record<string, unknown> } | Response> {
  const res = await unipileGet(c.env, `/messages/${enc(messageId)}`);
  if (!res.ok) return erroDaOrigem(c, res, { naoEncontrado: [400, 403, 404] });
  const msg = asRecord(await jsonDaOrigem(res));
  const id = pickString(msg, 'id');
  if (pickString(msg, 'account_id') !== conta(c) || !id) return negaPosse(c, 'message');
  return { id, msg };
}

// Listas por participante vem filtradas pela conta na origem; o filtro aqui
// e a segunda barreira (item de outra conta nunca sai).
function soDaConta(c: Ctx, bruto: unknown): unknown[] {
  return itens(bruto).filter((i) => pickString(asRecord(i), 'account_id') === conta(c));
}

// Tetos de abuso da caixa de entrada: leitura sem cota diaria (a origem
// sincroniza, nao toca o LinkedIn), mas que chama a origem mesmo assim.
export const TETO_LEITURAS_CAIXA = 5000;
export const TETO_DOWNLOADS = 500;
const tetoCaixa = tetoDeTentativas('inbox_reads', TETO_LEITURAS_CAIXA);

// ================================================================ conta

// GET /v1/me: o proprio perfil da conta conectada.
linkedin.get('/me', rateLimit('network_reads'), async (c) => {
  const res = await unipileGet(c.env, '/users/me', { account_id: conta(c) });
  if (!res.ok) return erroDaOrigem(c, res);
  await registra(c, 'network_reads');
  return c.json({ ok: true, data: projetaMe(await jsonDaOrigem(res)) });
});

// GET /v1/inmail-balance: creditos de InMail disponiveis.
linkedin.get('/inmail-balance', rateLimit('network_reads'), async (c) => {
  const res = await unipileGet(c.env, '/linkedin/inmail_balance', { account_id: conta(c) });
  if (!res.ok) return erroDaOrigem(c, res);
  await registra(c, 'network_reads');
  return c.json({ ok: true, data: projetaSaldoInmail(await jsonDaOrigem(res)) });
});

// ================================================================ perfis

const SECOES_PERFIL = new Set([
  '*',
  '*_preview',
  'about',
  'experience',
  'education',
  'languages',
  'skills',
  'certifications',
  'volunteering_experience',
  'projects',
  'recommendations_received',
  'recommendations_given',
  'experience_preview',
  'education_preview',
  'languages_preview',
  'skills_preview',
  'certifications_preview',
  'volunteering_experience_preview',
  'projects_preview',
  'recommendations_received_preview',
  'recommendations_given_preview',
]);

// Perfil inexistente, a origem responde 422 invalid_recipient.
const PERFIL_NAO_ENCONTRADO: OpcoesErro = { motivosNaoEncontrado: ['invalid_recipient'] };

// GET /v1/profiles/{identifier}: perfil por provider_id ou identificador
// publico (o final da URL do perfil). Conta como visita de perfil.
linkedin.get('/profiles/:identifier', rateLimit('profile_views'), async (c) => {
  const id = paramId(c, 'identifier');
  if (id instanceof Response) return id;

  let secoes: string[] | undefined;
  const bruto = c.req.query('sections');
  if (bruto !== undefined) {
    secoes = bruto.split(',').map((s) => s.trim()).filter(Boolean);
    if (secoes.length === 0 || secoes.some((s) => !SECOES_PERFIL.has(s))) {
      return c.json({ error: 'invalid_sections' }, 400);
    }
  }
  // Por padrao a visita NAO e notificada a pessoa; so notifica se pedido.
  const notificar = lerBooleano(c.req.query('notify'));
  if (notificar === null) return c.json({ error: 'invalid_notify' }, 400);

  const res = await unipileGet(c.env, `/users/${enc(id)}`, {
    account_id: conta(c),
    linkedin_sections: secoes,
    notify: notificar ? 'true' : 'false',
  });
  if (!res.ok) return erroDaOrigem(c, res, PERFIL_NAO_ENCONTRADO);
  await registra(c, 'profile_views');
  return c.json({ ok: true, data: projetaPerfil(await jsonDaOrigem(res)) });
});

// Listas de conteudo de um perfil (ou de uma empresa): posts, comentarios
// e reacoes. O identificador e o provider_id (ACo... para pessoa; numerico
// para empresa).
function listaDeConteudo(
  tipo: 'posts' | 'comments' | 'reactions',
  empresa: boolean,
) {
  return async (c: Ctx) => {
    const id = paramId(c, 'identifier');
    if (id instanceof Response) return id;
    const escopo = `${empresa ? 'company' : 'profile'}_${tipo}:${id}`;
    const pag = await paginacao(c, escopo);
    if (pag instanceof Response) return pag;

    const query: Consulta = { account_id: conta(c), ...pag };
    if (empresa) query.is_company = 'true';
    const res = await unipileGet(c.env, `/users/${enc(id)}/${tipo}`, query);
    if (!res.ok) return erroDaOrigem(c, res, PERFIL_NAO_ENCONTRADO);
    await registra(c, 'content_reads');

    const bruto = await jsonDaOrigem(res);
    const projeta: (raw: unknown) => unknown =
      tipo === 'posts' ? projetaPost : tipo === 'comments' ? projetaComentario : projetaReacao;
    return lista(c, escopo, bruto, itens(bruto).map(projeta));
  };
}

linkedin.get('/profiles/:identifier/posts', rateLimit('content_reads'), listaDeConteudo('posts', false));
linkedin.get('/profiles/:identifier/comments', rateLimit('content_reads'), listaDeConteudo('comments', false));
linkedin.get('/profiles/:identifier/reactions', rateLimit('content_reads'), listaDeConteudo('reactions', false));

// GET /v1/profiles/{provider_id}/chats: conversas com esta pessoa. Leitura
// da caixa de entrada sincronizada, sem limite diario.
linkedin.get('/profiles/:identifier/chats', tetoCaixa, async (c) => {
  const id = paramId(c, 'identifier');
  if (id instanceof Response) return id;
  const escopo = `attendee_chats:${id}`;
  const pag = await paginacao(c, escopo);
  if (pag instanceof Response) return pag;
  const per = periodo(c);
  if (per instanceof Response) return per;

  const res = await unipileGet(c.env, `/chat_attendees/${enc(id)}/chats`, {
    account_id: conta(c),
    ...pag,
    ...per,
  });
  if (!res.ok) return erroDaOrigem(c, res);
  const bruto = await jsonDaOrigem(res);
  return lista(c, escopo, bruto, soDaConta(c, bruto).map((x) => projetaChat(x, escolhida(c))));
});

// GET /v1/profiles/{provider_id}/messages: mensagens trocadas com esta pessoa.
linkedin.get('/profiles/:identifier/messages', tetoCaixa, async (c) => {
  const id = paramId(c, 'identifier');
  if (id instanceof Response) return id;
  const escopo = `attendee_messages:${id}`;
  const pag = await paginacao(c, escopo);
  if (pag instanceof Response) return pag;
  const per = periodo(c);
  if (per instanceof Response) return per;

  const res = await unipileGet(c.env, `/chat_attendees/${enc(id)}/messages`, {
    account_id: conta(c),
    ...pag,
    ...per,
  });
  if (!res.ok) return erroDaOrigem(c, res);
  const bruto = await jsonDaOrigem(res);
  return lista(c, escopo, bruto, soDaConta(c, bruto).map((x) => projetaMensagem(x, escolhida(c))));
});

// POST /v1/profiles/{provider_id}/endorsements: endossa uma competencia do
// perfil. O `endorsement_id` vem de `skills[].endorsement_id` do perfil.
linkedin.post('/profiles/:identifier/endorsements', rateLimit('reactions'), async (c) => {
  const id = paramId(c, 'identifier');
  if (id instanceof Response) return id;
  const body = await lerJson(c);
  if (body instanceof Response) return body;
  const bruto = body.endorsement_id;
  const endosso =
    typeof bruto === 'number' ? bruto : typeof bruto === 'string' && /^\d{1,20}$/.test(bruto) ? Number(bruto) : NaN;
  if (!Number.isSafeInteger(endosso) || endosso <= 0) {
    return c.json({ error: 'missing_endorsement_id' }, 400);
  }

  const res = await unipileJson(c.env, 'POST', '/linkedin/profile/endorse', {
    account_id: conta(c),
    profile_id: id,
    skill_endorsement_id: endosso,
  });
  if (!res.ok) return erroDaOrigem(c, res, PERFIL_NAO_ENCONTRADO);
  await registra(c, 'reactions');
  const data = asRecord(await jsonDaOrigem(res));
  return c.json({ ok: true, data: { endorsed: data.endorsed === true } });
});

// ================================================================ empresas

// GET /v1/companies/{identifier}: pagina de empresa por identificador
// publico (final da URL /company/...), id numerico ou urn.
linkedin.get('/companies/:identifier', rateLimit('profile_views'), async (c) => {
  const id = paramId(c, 'identifier');
  if (id instanceof Response) return id;
  const res = await unipileGet(c.env, `/linkedin/company/${enc(id)}`, { account_id: conta(c) });
  if (!res.ok) return erroDaOrigem(c, res, PERFIL_NAO_ENCONTRADO);
  await registra(c, 'profile_views');
  return c.json({ ok: true, data: projetaEmpresa(await jsonDaOrigem(res)) });
});

linkedin.get('/companies/:identifier/posts', rateLimit('content_reads'), listaDeConteudo('posts', true));

// ================================================================ busca

// Filtros aceitos por categoria (WHITELIST, revisao F2.41): so o que a busca
// classica documenta. Conta e API nunca vem do cliente (a API do LinkedIn e
// sempre a classica: Sales Navigator e Recruiter ficam desligados na
// conexao). Filtro desconhecido e 400, para o integrador saber que ele nao
// teve efeito.
const FILTROS_BUSCA: Record<string, ReadonlySet<string>> = {
  people: new Set([
    'keywords',
    'industry',
    'location',
    'profile_language',
    'network_distance',
    'company',
    'past_company',
    'school',
    'service',
    'connections_of',
    'followers_of',
    'open_to',
    'advanced_keywords',
  ]),
  companies: new Set(['keywords', 'industry', 'location', 'has_job_offers', 'headcount', 'network_distance']),
  posts: new Set(['keywords', 'sort_by', 'date_posted', 'content_type', 'posted_by', 'mentioning', 'author']),
};

// Toda chamada de busca carrega uma pagina do LinkedIn, tenha ela 0 ou 10
// resultados: cobrar so os resultados deixaria 1000 paginas/dia com
// `limit=1` (ou busca vazia de graca). Cada chamada custa no minimo uma
// pagina padrao (10), o que da ~100 buscas/dia no limite default.
const CUSTO_MINIMO_BUSCA = 10;

// So as buscas de pessoas, empresas e posts (`content`); grupos, eventos,
// escolas e vagas ficam fora do escopo, como na busca por filtro. Sai a URL
// normalizada, nunca a string crua.
const CAMINHOS_BUSCA = new Set([
  '/search/results/people/',
  '/search/results/companies/',
  '/search/results/content/',
]);

function urlDeBusca(v: unknown): string | null {
  if (typeof v !== 'string' || v.length > 2048) return null;
  try {
    const u = new URL(v);
    const caminho = u.pathname.endsWith('/') ? u.pathname : `${u.pathname}/`;
    if (
      u.protocol !== 'https:' ||
      (u.hostname !== 'www.linkedin.com' && u.hostname !== 'linkedin.com') ||
      u.username ||
      u.password ||
      u.port ||
      !CAMINHOS_BUSCA.has(caminho)
    ) {
      return null;
    }
    u.hash = '';
    return u.href;
  } catch {
    return null;
  }
}

// POST /v1/search: busca de pessoas, empresas ou posts, com filtros, ou a
// partir de uma URL de busca do LinkedIn. O limite diario conta RESULTADOS.
linkedin.post('/search', rateLimit('search_results'), async (c) => {
  const pag = await paginacao(c, 'search', 50);
  if (pag instanceof Response) return pag;

  let corpo: Record<string, unknown>;
  if (pag.cursor) {
    // Proxima pagina: a busca original viaja dentro do cursor.
    corpo = { cursor: pag.cursor };
  } else {
    const body = await lerJson(c);
    if (body instanceof Response) return body;
    if (body.url !== undefined) {
      const url = urlDeBusca(body.url);
      if (!url) return c.json({ error: 'invalid_search_url' }, 400);
      corpo = { url };
    } else {
      const categoria = typeof body.category === 'string' ? body.category : '';
      const aceitos = Object.hasOwn(FILTROS_BUSCA, categoria) ? FILTROS_BUSCA[categoria] : undefined;
      if (!aceitos) return c.json({ error: 'invalid_category' }, 400);
      corpo = { api: 'classic', category: categoria };
      for (const [k, v] of Object.entries(body)) {
        // `account_id` (o NOSSO, F2.42) ja foi consumido pelo authMiddleware
        // para escolher a conta; nunca segue para a origem.
        if (k === 'category' || k === 'account_id') continue;
        if (!aceitos.has(k)) return c.json({ error: 'unknown_filter', filter: k.slice(0, 64) }, 400);
        corpo[k] = v;
      }
    }
  }

  const res = await unipileJson(c.env, 'POST', '/linkedin/search', corpo, {
    account_id: conta(c),
    limit: pag.limit,
  });
  if (!res.ok) return erroDaOrigem(c, res, { naoEncontrado: [] });

  const bruto = await jsonDaOrigem(res);
  const resultados = itens(bruto);
  await registra(c, 'search_results', Math.max(CUSTO_MINIMO_BUSCA, resultados.length));
  const projetados = resultados.map((r) => {
    const item = asRecord(r);
    const tipo = pickString(item, 'type');
    const categoria =
      tipo === 'COMPANY' ? 'companies' : 'social_id' in item ? 'posts' : 'people';
    return projetaResultadoBusca(r, categoria);
  });
  const paging = asRecord(asRecord(bruto).paging);
  const cursor = await selaCursor(
    c.env.UNIPILE_MASTER_TOKEN,
    conta(c),
    'search',
    cursorDaOrigem(bruto),
  );
  return c.json({
    ok: true,
    data: {
      items: projetados,
      cursor,
      total_count: typeof paging.total_count === 'number' ? paging.total_count : null,
    },
  });
});

const TIPOS_PARAMETRO = new Set([
  'LOCATION',
  'PEOPLE',
  'CONNECTIONS',
  'COMPANY',
  'SCHOOL',
  'INDUSTRY',
  'SERVICE',
  'JOB_FUNCTION',
  'JOB_TITLE',
  'EMPLOYMENT_TYPE',
  'SKILL',
]);

// GET /v1/search/parameters: o LinkedIn filtra por id, nao por texto. Esta
// rota converte "Sao Paulo" no id de LOCATION, "Marketing" no de INDUSTRY etc.
linkedin.get('/search/parameters', rateLimit('network_reads'), async (c) => {
  const tipo = c.req.query('type');
  if (!tipo || !TIPOS_PARAMETRO.has(tipo)) return c.json({ error: 'invalid_type' }, 400);
  const keywords = c.req.query('keywords');
  if (keywords !== undefined && keywords.length > 200) {
    return c.json({ error: 'invalid_keywords' }, 400);
  }
  const limite = lerLimite(c, 100);
  if (limite === null) return c.json({ error: 'invalid_limit', max: 100 }, 400);

  const res = await unipileGet(c.env, '/linkedin/search/parameters', {
    account_id: conta(c),
    type: tipo,
    keywords,
    limit: limite === undefined ? undefined : String(limite),
  });
  if (!res.ok) return erroDaOrigem(c, res, { naoEncontrado: [] });
  await registra(c, 'network_reads');
  const bruto = await jsonDaOrigem(res);
  return c.json({ ok: true, data: { items: itens(bruto).map(projetaParametroBusca) } });
});

// ================================================================ rede

// GET /v1/relations: suas conexoes (1o grau). `filter` busca por nome.
linkedin.get('/relations', rateLimit('network_reads'), async (c) => {
  const pag = await paginacao(c, 'relations');
  if (pag instanceof Response) return pag;
  const filtro = c.req.query('filter');
  if (filtro !== undefined && filtro.length > 200) return c.json({ error: 'invalid_filter' }, 400);

  const res = await unipileGet(c.env, '/users/relations', {
    account_id: conta(c),
    filter: filtro,
    ...pag,
  });
  if (!res.ok) return erroDaOrigem(c, res, { naoEncontrado: [] });
  await registra(c, 'network_reads');
  const bruto = await jsonDaOrigem(res);
  return lista(c, 'relations', bruto, itens(bruto).map(projetaConexao));
});

// GET /v1/followers: quem segue o seu perfil.
linkedin.get('/followers', rateLimit('network_reads'), async (c) => {
  const pag = await paginacao(c, 'followers');
  if (pag instanceof Response) return pag;
  const res = await unipileGet(c.env, '/users/followers', { account_id: conta(c), ...pag });
  if (!res.ok) return erroDaOrigem(c, res, { naoEncontrado: [] });
  await registra(c, 'network_reads');
  const bruto = await jsonDaOrigem(res);
  return lista(c, 'followers', bruto, itens(bruto).map(projetaSeguidor));
});

// GET /v1/invitations/sent e /received: convites pendentes.
function listaDeConvites(recebidos: boolean) {
  return async (c: Ctx) => {
    const escopo = recebidos ? 'invitations_received' : 'invitations_sent';
    const pag = await paginacao(c, escopo);
    if (pag instanceof Response) return pag;
    const res = await unipileGet(
      c.env,
      recebidos ? '/users/invite/received' : '/users/invite/sent',
      { account_id: conta(c), ...pag },
    );
    if (!res.ok) return erroDaOrigem(c, res, { naoEncontrado: [] });
    await registra(c, 'network_reads');
    const bruto = await jsonDaOrigem(res);
    return lista(c, escopo, bruto, itens(bruto).map((i) => projetaConvite(i, recebidos)));
  };
}

linkedin.get('/invitations/sent', rateLimit('network_reads'), listaDeConvites(false));
linkedin.get('/invitations/received', rateLimit('network_reads'), listaDeConvites(true));

// DELETE /v1/invitations/sent/{invitation_id}: cancela um convite pendente.
linkedin.delete('/invitations/sent/:invitation_id', rateLimit('invitation_responses'), async (c) => {
  const id = paramId(c, 'invitation_id');
  if (id instanceof Response) return id;
  const res = await unipileJson(c.env, 'DELETE', `/users/invite/sent/${enc(id)}`, undefined, {
    account_id: conta(c),
  });
  if (!res.ok) {
    return erroDaOrigem(c, res, { motivosNaoEncontrado: ['invalid_invitation_id'] });
  }
  await registra(c, 'invitation_responses');
  return c.json({ ok: true, data: { canceled: true } });
});

// POST /v1/invitations/received/{invitation_id}: aceita ou recusa. O
// `shared_secret` vem da listagem de convites recebidos.
linkedin.post('/invitations/received/:invitation_id', rateLimit('invitation_responses'), async (c) => {
  const id = paramId(c, 'invitation_id');
  if (id instanceof Response) return id;
  const body = await lerJson(c);
  if (body instanceof Response) return body;
  if (body.action !== 'accept' && body.action !== 'decline') {
    return c.json({ error: 'invalid_action' }, 400);
  }
  if (!textoValido(body.shared_secret, 1024)) {
    return c.json({ error: 'missing_shared_secret' }, 400);
  }

  const res = await unipileJson(c.env, 'POST', `/users/invite/received/${enc(id)}`, {
    provider: 'LINKEDIN',
    account_id: conta(c),
    shared_secret: body.shared_secret,
    action: body.action,
  });
  if (!res.ok) {
    return erroDaOrigem(c, res, { motivosNaoEncontrado: ['invalid_invitation_id'] });
  }
  await registra(c, 'invitation_responses');
  const data = asRecord(await jsonDaOrigem(res));
  return c.json({ ok: true, data: { status: pickString(data, 'status') ?? body.action } });
});

// ================================================================ conversas

const TEMAS_EMPRESA = new Set(['service_request', 'request_demo', 'support', 'careers', 'other']);
const MAX_TEXTO_MENSAGEM = 8000;

// POST /v1/chats: abre conversa nova com uma pessoa (ou InMail, ou com uma
// pagina de empresa via `topic`). Conta na cota de mensagens.
linkedin.post('/chats', rateLimit('messages'), async (c) => {
  const entrada = await lerEntrada(c);
  if (entrada instanceof Response) return entrada;
  const { campos, arquivos } = entrada;

  if (!idValido(campos.provider_id)) return c.json({ error: 'missing_provider_id' }, 400);
  const temTexto = campos.text !== undefined;
  if (temTexto && !textoValido(campos.text, MAX_TEXTO_MENSAGEM)) {
    return c.json({ error: 'invalid_text' }, 400);
  }
  if (!temTexto && arquivos.length === 0) return c.json({ error: 'missing_text' }, 400);
  const inmail = lerBooleano(campos.inmail);
  if (inmail === null) return c.json({ error: 'invalid_inmail' }, 400);
  if (campos.subject !== undefined && !textoValido(campos.subject, 200)) {
    return c.json({ error: 'invalid_subject' }, 400);
  }
  if (campos.topic !== undefined && (typeof campos.topic !== 'string' || !TEMAS_EMPRESA.has(campos.topic))) {
    return c.json({ error: 'invalid_topic' }, 400);
  }
  if (campos.invitation_id !== undefined && !idValido(campos.invitation_id)) {
    return c.json({ error: 'invalid_invitation_id' }, 400);
  }

  const form = new FormData();
  form.set('account_id', conta(c));
  form.append('attendees_ids', campos.provider_id);
  if (typeof campos.text === 'string') form.set('text', campos.text);
  if (typeof campos.subject === 'string') form.set('subject', campos.subject);
  form.set('linkedin[api]', 'classic');
  if (inmail) form.set('linkedin[inmail]', 'true');
  if (typeof campos.topic === 'string') form.set('linkedin[topic]', campos.topic);
  if (typeof campos.invitation_id === 'string') {
    form.set('linkedin[invitation_id]', campos.invitation_id);
  }
  for (const arquivo of arquivos) form.append('attachments', arquivo, arquivo.name);

  const res = await unipileForm(c.env, '/chats', form);
  if (!res.ok) return erroDaOrigem(c, res, PERFIL_NAO_ENCONTRADO);
  await registra(c, 'messages');
  const data = asRecord(await jsonDaOrigem(res));
  return c.json({
    ok: true,
    data: { chat_id: pickString(data, 'chat_id'), message_id: pickString(data, 'message_id') },
  });
});

// GET /v1/chats/{chat_id}: detalhe da conversa, com a ultima mensagem.
linkedin.get('/chats/:chat_id', tetoCaixa, async (c) => {
  const id = paramId(c, 'chat_id');
  if (id instanceof Response) return id;
  const posse = await chatDoTenant(c, id);
  if (posse instanceof Response) return posse;
  return c.json({ ok: true, data: projetaChat(posse.chat, escolhida(c)) });
});

// GET /v1/chats/{chat_id}/messages: historico da conversa, da mais recente
// para a mais antiga.
linkedin.get('/chats/:chat_id/messages', tetoCaixa, async (c) => {
  const id = paramId(c, 'chat_id');
  if (id instanceof Response) return id;
  const per = periodo(c);
  if (per instanceof Response) return per;
  const remetente = c.req.query('sender_id');
  if (remetente !== undefined && !idValido(remetente)) {
    return c.json({ error: 'invalid_sender_id' }, 400);
  }
  if (lerLimite(c, 100) === null) return c.json({ error: 'invalid_limit', max: 100 }, 400);

  const posse = await chatDoTenant(c, id);
  if (posse instanceof Response) return posse;
  // Escopo pelo id CONFERIDO: o cursor so vale para esta conversa.
  const escopo = `chat_messages:${posse.id}`;
  const pag = await paginacao(c, escopo);
  if (pag instanceof Response) return pag;
  const res = await unipileGet(c.env, `/chats/${enc(posse.id)}/messages`, {
    ...pag,
    ...per,
    sender_id: remetente,
  });
  if (!res.ok) return erroDaOrigem(c, res, { naoEncontrado: [403, 404] });
  const bruto = await jsonDaOrigem(res);
  return lista(c, escopo, bruto, projetaListaMensagens(bruto, escolhida(c)));
});

// GET /v1/chats/{chat_id}/attendees: participantes da conversa.
linkedin.get('/chats/:chat_id/attendees', tetoCaixa, async (c) => {
  const id = paramId(c, 'chat_id');
  if (id instanceof Response) return id;
  const posse = await chatDoTenant(c, id);
  if (posse instanceof Response) return posse;
  const res = await unipileGet(c.env, `/chats/${enc(posse.id)}/attendees`);
  if (!res.ok) return erroDaOrigem(c, res, { naoEncontrado: [403, 404] });
  const bruto = await jsonDaOrigem(res);
  return c.json({ ok: true, data: { items: projetaListaParticipantes(bruto) } });
});

// PATCH /v1/chats/{chat_id}: marca como lida (`read: true`) ou nao lida.
linkedin.patch('/chats/:chat_id', rateLimit('chat_actions'), async (c) => {
  const id = paramId(c, 'chat_id');
  if (id instanceof Response) return id;
  const body = await lerJson(c);
  if (body instanceof Response) return body;
  if (typeof body.read !== 'boolean') return c.json({ error: 'missing_read' }, 400);

  const posse = await chatDoTenant(c, id);
  if (posse instanceof Response) return posse;
  const res = await unipileJson(c.env, 'PATCH', `/chats/${enc(posse.id)}`, {
    action: 'setReadStatus',
    value: body.read,
  });
  if (!res.ok) return erroDaOrigem(c, res, { naoEncontrado: [403, 404] });
  await registra(c, 'chat_actions');
  return c.json({ ok: true, data: { updated: true } });
});

// DELETE /v1/chats/{chat_id}: apaga a conversa no LinkedIn. Irreversivel.
linkedin.delete('/chats/:chat_id', rateLimit('chat_actions'), async (c) => {
  const id = paramId(c, 'chat_id');
  if (id instanceof Response) return id;
  const posse = await chatDoTenant(c, id);
  if (posse instanceof Response) return posse;
  const res = await unipileJson(c.env, 'DELETE', `/chats/${enc(posse.id)}`);
  if (!res.ok) return erroDaOrigem(c, res, { naoEncontrado: [403, 404] });
  await registra(c, 'chat_actions');
  return c.json({ ok: true, data: { deleted: true } });
});

// ================================================================ mensagens

// GET /v1/messages/{message_id}
linkedin.get('/messages/:message_id', tetoCaixa, async (c) => {
  const id = paramId(c, 'message_id');
  if (id instanceof Response) return id;
  const posse = await mensagemDoTenant(c, id);
  if (posse instanceof Response) return posse;
  return c.json({ ok: true, data: projetaMensagem(posse.msg, escolhida(c)) });
});

// So repassa content-type com cara de tipo MIME; o resto vira binario.
function tipoMime(v: string | null): string {
  const base = (v ?? '').split(';')[0]?.trim() ?? '';
  return /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i.test(base) ? base : 'application/octet-stream';
}

// GET /v1/messages/{message_id}/attachments/{attachment_id}: baixa o anexo.
// O arquivo passa pelo Worker; a url da origem nunca sai.
linkedin.get(
  '/messages/:message_id/attachments/:attachment_id',
  tetoDeTentativas('attachment_downloads', TETO_DOWNLOADS),
  async (c) => {
    const id = paramId(c, 'message_id');
    if (id instanceof Response) return id;
    const anexoId = paramId(c, 'attachment_id');
    if (anexoId instanceof Response) return anexoId;

    const posse = await mensagemDoTenant(c, id);
    if (posse instanceof Response) return posse;
    const anexos = Array.isArray(posse.msg.attachments) ? posse.msg.attachments : [];
    if (!anexos.some((a) => pickString(asRecord(a), 'id') === anexoId)) {
      return c.json({ error: 'not_found' }, 404);
    }

    const res = await unipileGet(
      c.env,
      `/messages/${enc(posse.id)}/attachments/${enc(anexoId)}`,
    );
    if (!res.ok) return erroDaOrigem(c, res, { naoEncontrado: [403, 404] });
    const headers = new Headers({
      'content-type': tipoMime(res.headers.get('content-type')),
      'content-disposition': 'attachment',
      'cache-control': 'private, no-store',
      'x-content-type-options': 'nosniff',
      // Anexo e conteudo de terceiro: se alguem abrir no navegador (html,
      // svg), roda isolado, sem script nem origem.
      'content-security-policy': "sandbox; default-src 'none'",
    });
    const tamanho = res.headers.get('content-length');
    if (tamanho && /^\d+$/.test(tamanho)) headers.set('content-length', tamanho);
    return new Response(res.body, { status: 200, headers });
  },
);

// PATCH /v1/messages/{message_id}: edita o texto (so mensagem sua, na
// primeira hora depois do envio; regra do LinkedIn).
linkedin.patch('/messages/:message_id', rateLimit('chat_actions'), async (c) => {
  const id = paramId(c, 'message_id');
  if (id instanceof Response) return id;
  const body = await lerJson(c);
  if (body instanceof Response) return body;
  if (!textoValido(body.text, MAX_TEXTO_MENSAGEM)) return c.json({ error: 'missing_text' }, 400);

  const posse = await mensagemDoTenant(c, id);
  if (posse instanceof Response) return posse;
  const res = await unipileJson(c.env, 'PATCH', `/messages/${enc(posse.id)}`, { text: body.text });
  if (!res.ok) return erroDaOrigem(c, res, { naoEncontrado: [403, 404] });
  await registra(c, 'chat_actions');
  return c.json({ ok: true, data: { edited: true } });
});

// DELETE /v1/messages/{message_id}: apaga (so mensagem sua, na primeira hora).
linkedin.delete('/messages/:message_id', rateLimit('chat_actions'), async (c) => {
  const id = paramId(c, 'message_id');
  if (id instanceof Response) return id;
  const posse = await mensagemDoTenant(c, id);
  if (posse instanceof Response) return posse;
  const res = await unipileJson(c.env, 'DELETE', `/messages/${enc(posse.id)}`);
  if (!res.ok) return erroDaOrigem(c, res, { naoEncontrado: [403, 404] });
  await registra(c, 'chat_actions');
  return c.json({ ok: true, data: { deleted: true } });
});

// POST /v1/messages/{message_id}/reactions: reage com um emoji.
linkedin.post('/messages/:message_id/reactions', rateLimit('reactions'), async (c) => {
  const id = paramId(c, 'message_id');
  if (id instanceof Response) return id;
  const body = await lerJson(c);
  if (body instanceof Response) return body;
  if (!textoValido(body.reaction, 16)) return c.json({ error: 'missing_reaction' }, 400);

  const posse = await mensagemDoTenant(c, id);
  if (posse instanceof Response) return posse;
  const res = await unipileJson(c.env, 'POST', `/messages/${enc(posse.id)}/reaction`, {
    reaction: body.reaction,
  });
  if (!res.ok) return erroDaOrigem(c, res, { naoEncontrado: [403, 404] });
  await registra(c, 'reactions');
  return c.json({ ok: true, data: { reacted: true } });
});

// ================================================================ posts

const MAX_TEXTO_POST = 3000;
const MAX_TEXTO_COMENTARIO = 1250;
const REACOES_POST = new Set(['like', 'celebrate', 'support', 'love', 'insightful', 'funny']);

function linkExternoValido(v: unknown): v is string {
  if (typeof v !== 'string' || v.length > 2048) return false;
  try {
    const u = new URL(v);
    return u.protocol === 'https:' || u.protocol === 'http:';
  } catch {
    return false;
  }
}

// POST /v1/posts: publica no feed (texto, link e ate 5 imagens/video).
// `as_organization` publica como a pagina de empresa que voce administra
// (ids em GET /v1/me, `organizations`).
linkedin.post('/posts', rateLimit('posts'), async (c) => {
  const entrada = await lerEntrada(c);
  if (entrada instanceof Response) return entrada;
  const { campos, arquivos } = entrada;
  if (!textoValido(campos.text, MAX_TEXTO_POST)) return c.json({ error: 'missing_text' }, 400);
  if (campos.external_link !== undefined && !linkExternoValido(campos.external_link)) {
    return c.json({ error: 'invalid_external_link' }, 400);
  }
  if (campos.as_organization !== undefined && !idValido(campos.as_organization)) {
    return c.json({ error: 'invalid_as_organization' }, 400);
  }

  const form = new FormData();
  form.set('account_id', conta(c));
  form.set('text', campos.text);
  if (typeof campos.external_link === 'string') form.set('external_link', campos.external_link);
  if (typeof campos.as_organization === 'string') form.set('as_organization', campos.as_organization);
  for (const arquivo of arquivos) form.append('attachments', arquivo, arquivo.name);

  const res = await unipileForm(c.env, '/posts', form);
  if (!res.ok) return erroDaOrigem(c, res, { naoEncontrado: [] });
  await registra(c, 'posts');
  const data = asRecord(await jsonDaOrigem(res));
  return c.json({ ok: true, data: { post_id: pickString(data, 'post_id') } });
});

// Post inexistente responde 404 ou 422 conforme a rota (medido no E2E de
// 2026-09-22: comentar em post que nao existe volta 422 invalid_post).
const POST_NAO_ENCONTRADO: OpcoesErro = {
  naoEncontrado: [404],
  motivosNaoEncontrado: ['invalid_post', 'invalid_post_id', 'resource_not_found'],
};

// GET /v1/posts/{post_id}: `post_id` e o `social_id` de um post (ou o numero
// que aparece em "activity-..." na URL do post).
linkedin.get('/posts/:post_id', rateLimit('content_reads'), async (c) => {
  const id = paramId(c, 'post_id');
  if (id instanceof Response) return id;
  const res = await unipileGet(c.env, `/posts/${enc(id)}`, { account_id: conta(c) });
  if (!res.ok) return erroDaOrigem(c, res, POST_NAO_ENCONTRADO);
  await registra(c, 'content_reads');
  return c.json({ ok: true, data: projetaPost(await jsonDaOrigem(res)) });
});

// GET /v1/posts/{post_id}/comments e /reactions. `comment_id` opcional lista
// as respostas (ou reacoes) de um comentario.
function listaDoPost(tipo: 'comments' | 'reactions') {
  return async (c: Ctx) => {
    const id = paramId(c, 'post_id');
    if (id instanceof Response) return id;
    const comentario = c.req.query('comment_id');
    if (comentario !== undefined && !idValido(comentario)) {
      return c.json({ error: 'invalid_comment_id' }, 400);
    }
    const ordem = c.req.query('sort_by');
    if (tipo === 'comments' && ordem !== undefined && ordem !== 'MOST_RECENT' && ordem !== 'MOST_RELEVANT') {
      return c.json({ error: 'invalid_sort_by' }, 400);
    }
    const escopo = `post_${tipo}:${id}:${comentario ?? ''}`;
    const pag = await paginacao(c, escopo);
    if (pag instanceof Response) return pag;

    const res = await unipileGet(c.env, `/posts/${enc(id)}/${tipo}`, {
      account_id: conta(c),
      comment_id: comentario,
      sort_by: tipo === 'comments' ? ordem : undefined,
      ...pag,
    });
    if (!res.ok) return erroDaOrigem(c, res, POST_NAO_ENCONTRADO);
    await registra(c, 'content_reads');
    const bruto = await jsonDaOrigem(res);
    const projeta: (raw: unknown) => unknown =
      tipo === 'comments' ? projetaComentario : projetaReacao;
    return lista(c, escopo, bruto, itens(bruto).map(projeta));
  };
}

linkedin.get('/posts/:post_id/comments', rateLimit('content_reads'), listaDoPost('comments'));
linkedin.get('/posts/:post_id/reactions', rateLimit('content_reads'), listaDoPost('reactions'));

// POST /v1/posts/{post_id}/comments: comenta (ou responde a um comentario
// com `comment_id`).
linkedin.post('/posts/:post_id/comments', rateLimit('comments'), async (c) => {
  const id = paramId(c, 'post_id');
  if (id instanceof Response) return id;
  const entrada = await lerEntrada(c);
  if (entrada instanceof Response) return entrada;
  const { campos, arquivos } = entrada;
  if (!textoValido(campos.text, MAX_TEXTO_COMENTARIO)) return c.json({ error: 'missing_text' }, 400);
  if (campos.comment_id !== undefined && !idValido(campos.comment_id)) {
    return c.json({ error: 'invalid_comment_id' }, 400);
  }
  if (campos.as_organization !== undefined && !idValido(campos.as_organization)) {
    return c.json({ error: 'invalid_as_organization' }, 400);
  }

  const form = new FormData();
  form.set('account_id', conta(c));
  form.set('text', campos.text);
  if (typeof campos.comment_id === 'string') form.set('comment_id', campos.comment_id);
  if (typeof campos.as_organization === 'string') form.set('as_organization', campos.as_organization);
  for (const arquivo of arquivos) form.append('attachments', arquivo, arquivo.name);

  const res = await unipileForm(c.env, `/posts/${enc(id)}/comments`, form);
  if (!res.ok) return erroDaOrigem(c, res, POST_NAO_ENCONTRADO);
  await registra(c, 'comments');
  const data = asRecord(await jsonDaOrigem(res));
  return c.json({ ok: true, data: { comment_id: pickString(data, 'comment_id') } });
});

// POST /v1/posts/{post_id}/reactions: reage ao post (ou a um comentario).
linkedin.post('/posts/:post_id/reactions', rateLimit('reactions'), async (c) => {
  const id = paramId(c, 'post_id');
  if (id instanceof Response) return id;
  const body = await lerJson(c);
  if (body instanceof Response) return body;
  const tipo = body.reaction_type ?? 'like';
  if (typeof tipo !== 'string' || !REACOES_POST.has(tipo)) {
    return c.json({ error: 'invalid_reaction_type' }, 400);
  }
  if (body.comment_id !== undefined && !idValido(body.comment_id)) {
    return c.json({ error: 'invalid_comment_id' }, 400);
  }
  if (body.as_organization !== undefined && !idValido(body.as_organization)) {
    return c.json({ error: 'invalid_as_organization' }, 400);
  }

  const corpo: Record<string, unknown> = {
    account_id: conta(c),
    post_id: id,
    reaction_type: tipo,
  };
  if (typeof body.comment_id === 'string') corpo.comment_id = body.comment_id;
  if (typeof body.as_organization === 'string') corpo.as_organization = body.as_organization;
  const res = await unipileJson(c.env, 'POST', '/posts/reaction', corpo);
  if (!res.ok) return erroDaOrigem(c, res, POST_NAO_ENCONTRADO);
  await registra(c, 'reactions');
  return c.json({ ok: true, data: { reacted: true } });
});
