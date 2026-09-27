// Documentacao do `account_id` (F2.42). Em vez de repetir o campo a mao em
// cada operacao do openapi.json, a spec servida passa por aqui: toda
// operacao do /v1 ganha o campo (no corpo, quando a operacao tem corpo; na
// query, quando nao tem), mais a rota GET /v1/accounts e a secao da
// introducao. Rota nova ganha o campo sozinha, e o teste de docs confere que
// nenhuma ficou de fora.

type Objeto = Record<string, unknown>;

// Operacoes em que a escolha de conta nao se aplica: a rotacao e sempre da
// chave usada, e a lista de contas e a propria fonte dos ids.
const SEM_CONTA = new Set(['/v1/keys/rotate', '/v1/accounts']);
const METODOS = ['get', 'post', 'put', 'patch', 'delete'];

const EXEMPLO = 'acc_3f9c2b7a1d4e8f6051a2b3c4';

const DESCRICAO_CAMPO =
  'Conta de LinkedIn com que a chamada acontece (`GET /v1/accounts` lista as suas). ' +
  'Opcional: sem ele, vale a conta da propria chave. De uma conta que nao e sua: `404 account_not_found`.';

const CAMPO: Objeto = {
  type: 'string',
  pattern: '^acc_[0-9a-f]{24}$',
  description: DESCRICAO_CAMPO,
  example: EXEMPLO,
};

const SECAO = [
  '## Varias contas com uma chave',
  '',
  'Se voce tem mais de uma conta de LinkedIn no painel, uma chave so atende todas. ' +
    'Cada conta tem um `account_id` (ex.: `' + EXEMPLO + '`), que aparece no painel e em `GET /v1/accounts`. ' +
    'Passe o `account_id` em qualquer chamada para escolher com qual conta a acao acontece: ' +
    'no corpo (JSON ou multipart) das chamadas que tem corpo, ou na query string nas demais. ' +
    'Sem `account_id`, a chamada usa a conta da propria chave.',
  '',
  '```bash',
  'curl "https://api.playbooklab.com.br/v1/chats?account_id=' + EXEMPLO + '" -H "X-API-KEY: lk_live_..."',
  '',
  'curl https://api.playbooklab.com.br/v1/messages -H "X-API-KEY: lk_live_..." \\',
  '  -H "content-type: application/json" \\',
  '  -d \'{"account_id": "' + EXEMPLO + '", "chat_id": "abc123", "text": "Ola!"}\'',
  '```',
  '',
  'Limite diario e webhook sao de cada conta: configure o webhook de cada uma passando o `account_id` ' +
    '(pode ser a mesma URL). Todo evento traz a conta de origem em `data.account_id`. ' +
    'O `account_id` nao muda quando voce reconecta o LinkedIn.',
  '',
].join('\n');

function objeto(v: unknown): Objeto | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Objeto) : null;
}

// Segue um $ref local (#/components/...). Sem $ref, devolve o proprio objeto.
function resolve(spec: Objeto, v: unknown): Objeto | null {
  const o = objeto(v);
  if (!o) return null;
  const ref = o.$ref;
  if (typeof ref !== 'string' || !ref.startsWith('#/')) return o;
  let atual: unknown = spec;
  for (const parte of ref.slice(2).split('/')) {
    atual = objeto(atual)?.[parte];
  }
  return objeto(atual);
}

// Acrescenta account_id ao schema do corpo. Schema com `properties` ganha a
// propriedade (inclusive os de additionalProperties:false, que sem isso
// diriam que o campo e proibido). Schema composto ganha um allOf.
function noCorpo(spec: Objeto, conteudo: Objeto, tipo: string): void {
  const midia = objeto(conteudo[tipo]);
  if (!midia) return;
  const schema = resolve(spec, midia.schema);
  const props = schema ? objeto(schema.properties) : null;
  if (schema && props) {
    if (!('account_id' in props)) props.account_id = CAMPO;
    return;
  }
  midia.schema = {
    allOf: [
      midia.schema ?? {},
      { type: 'object', properties: { account_id: CAMPO } },
    ],
  };
}

function naQuery(op: Objeto): void {
  const params = Array.isArray(op.parameters) ? (op.parameters as unknown[]) : [];
  const ja = params.some((p) => {
    const o = objeto(p);
    return o?.$ref === '#/components/parameters/AccountId' || (o?.name === 'account_id' && o?.in === 'query');
  });
  if (!ja) params.push({ $ref: '#/components/parameters/AccountId' });
  op.parameters = params;
}

function introducao(descricao: string): string {
  let d = descricao.replace(
    /a conta usada em cada chamada e determinada pela chave[^.]*\./,
    'sem mais nada, a chamada age pela conta dessa chave. Tem mais de uma conta? Veja **Varias contas com uma chave**, abaixo.',
  );
  if (!d.includes('| `account_not_found` |')) {
    d = d.replace(
      /(\| `not_found` \|[^\n]*\n)/,
      '$1| `account_not_found` | o `account_id` informado nao e de uma conta sua |\n',
    );
  }
  if (!d.includes('## Varias contas com uma chave')) {
    const ancora = d.indexOf('## Primeira chamada');
    d = ancora >= 0 ? `${d.slice(0, ancora)}${SECAO}\n${d.slice(ancora)}` : `${d}\n\n${SECAO}`;
  }
  return d;
}

const ROTA_CONTAS: Objeto = {
  get: {
    tags: ['Contas'],
    summary: 'Listar suas contas',
    description:
      'Lista as contas de LinkedIn que a sua chave alcanca, com o `account_id` de cada uma. ' +
      'Passe esse `account_id` em qualquer outra chamada para escolher a conta. ' +
      'Funciona mesmo com a conta da chave desconectada, para voce ver o estado de todas.',
    operationId: 'listAccounts',
    responses: {
      '200': {
        description: 'Contas da sua chave.',
        content: {
          'application/json': {
            schema: { $ref: '#/components/schemas/AccountListEnvelope' },
            example: {
              ok: true,
              data: {
                items: [
                  {
                    account_id: EXEMPLO,
                    name: 'Fulano de Tal',
                    status: 'active',
                    connected_at: '2026-09-01T12:00:00.000Z',
                    is_key_account: true,
                  },
                  {
                    account_id: 'acc_9e8d7c6b5a4f3e2d1c0b9a88',
                    name: 'Beltrana Souza',
                    status: 'disconnected',
                    connected_at: '2026-09-10T08:30:00.000Z',
                    is_key_account: false,
                  },
                ],
              },
            },
          },
        },
      },
      '401': { $ref: '#/components/responses/Unauthorized' },
    },
  },
};

const SCHEMAS: Objeto = {
  AccountSummary: {
    type: 'object',
    properties: {
      account_id: { type: 'string', description: 'Id da conta para usar nas chamadas.', example: EXEMPLO },
      name: { type: 'string', nullable: true, description: 'Nome do perfil do LinkedIn conectado.' },
      status: {
        type: 'string',
        enum: ['active', 'paused', 'disconnected', 'none'],
        description:
          '`active` pronta para uso; `paused` pagamento em atraso; `disconnected` a sessao caiu e precisa reconectar; `none` ainda nao conectou.',
      },
      connected_at: { type: 'string', format: 'date-time', nullable: true },
      is_key_account: {
        type: 'boolean',
        description: 'A conta da chave usada nesta chamada (a que vale quando nao se passa `account_id`).',
      },
    },
  },
  AccountListEnvelope: {
    type: 'object',
    properties: {
      ok: { type: 'boolean', example: true },
      data: {
        type: 'object',
        properties: {
          items: { type: 'array', items: { $ref: '#/components/schemas/AccountSummary' } },
        },
      },
    },
  },
};

const RESPOSTA_404: Objeto = {
  description: 'O `account_id` informado nao e de uma conta sua.',
  content: {
    'application/json': {
      schema: { $ref: '#/components/schemas/ErrorEnvelope' },
      example: { error: 'account_not_found' },
    },
  },
};

export function comContaSelecionavel<T>(original: T): T {
  const spec = structuredClone(original) as Objeto;
  const components = objeto(spec.components) ?? {};
  spec.components = components;
  components.parameters = {
    ...(objeto(components.parameters) ?? {}),
    AccountId: {
      name: 'account_id',
      in: 'query',
      required: false,
      description: DESCRICAO_CAMPO,
      schema: { type: 'string', pattern: '^acc_[0-9a-f]{24}$' },
      example: EXEMPLO,
    },
  };
  components.schemas = { ...(objeto(components.schemas) ?? {}), ...SCHEMAS };
  components.responses = { ...(objeto(components.responses) ?? {}), AccountNotFound: RESPOSTA_404 };

  const paths = objeto(spec.paths) ?? {};
  spec.paths = paths;
  for (const [caminho, item] of Object.entries(paths)) {
    if (!caminho.startsWith('/v1/') || SEM_CONTA.has(caminho)) continue;
    for (const metodo of METODOS) {
      const op = objeto(objeto(item)?.[metodo]);
      if (!op) continue;
      const corpo = resolve(spec, op.requestBody);
      const conteudo = corpo ? objeto(corpo.content) : null;
      if (conteudo && Object.keys(conteudo).length > 0) {
        for (const tipo of Object.keys(conteudo)) noCorpo(spec, conteudo, tipo);
      } else {
        naQuery(op);
      }
      // 404 ja documentado (recurso inexistente) segue; senao, entra o da conta.
      const respostas = objeto(op.responses) ?? {};
      if (!('404' in respostas)) respostas['404'] = { $ref: '#/components/responses/AccountNotFound' };
      op.responses = respostas;
    }
  }
  paths['/v1/accounts'] = ROTA_CONTAS;

  const tags = Array.isArray(spec.tags) ? (spec.tags as unknown[]) : [];
  if (!tags.some((t) => objeto(t)?.name === 'Contas')) {
    tags.push({
      name: 'Contas',
      description: 'Suas contas de LinkedIn e o `account_id` de cada uma.',
    });
  }
  spec.tags = tags;
  const grupos = Array.isArray(spec['x-tagGroups']) ? (spec['x-tagGroups'] as unknown[]) : [];
  const sua = grupos.map(objeto).find((g) => g?.name === 'Sua conta');
  if (sua && Array.isArray(sua.tags) && !sua.tags.includes('Contas')) {
    sua.tags = ['Contas', ...(sua.tags as unknown[])];
  }

  const info = objeto(spec.info);
  if (info && typeof info.description === 'string') {
    info.description = introducao(info.description);
  }
  return spec as T;
}
