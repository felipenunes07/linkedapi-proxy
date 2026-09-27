import type { Context } from 'hono';
import type { Env, Variables } from '../types';

type Ctx = Context<{ Bindings: Env; Variables: Variables }>;

// Validacao da entrada dos endpoints de LinkedIn (F2.41). Tudo aqui acontece
// ANTES de qualquer chamada a origem: entrada invalida vira 400 e nao consome
// cota nem toca o LinkedIn.

const TAMANHO_MAXIMO_ID = 512;

// Id vindo do path ou do corpo (chat_id, provider_id, social_id, urn...).
// Recusa `.`/`..` (o fetch normaliza segmentos de ponto: `/users/..` viraria
// outra rota da origem), espaco e caractere de controle. O valor segue para
// a origem sempre com encodeURIComponent, entao `/` nao escapa do segmento.
export function idValido(v: unknown): v is string {
  return (
    typeof v === 'string' &&
    v.length > 0 &&
    v.length <= TAMANHO_MAXIMO_ID &&
    !/^\.+$/.test(v) &&
    !/[\s\u0000-\u001f\u007f]/.test(v)
  );
}

// `limit` opcional, inteiro em [1, max]. `null` = invalido.
export function lerLimite(c: Ctx, max: number): number | undefined | null {
  const v = c.req.query('limit');
  if (v === undefined) return undefined;
  if (!/^\d{1,4}$/.test(v)) return null;
  const n = Number(v);
  return n >= 1 && n <= max ? n : null;
}

const FORMATO_DATA = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:?\d{2})?)?$/;

// Data ISO 8601 opcional (filtros before/after). Sai normalizada em UTC.
// `null` = invalida.
export function lerData(c: Ctx, nome: string): string | undefined | null {
  const v = c.req.query(nome);
  if (v === undefined) return undefined;
  if (!FORMATO_DATA.test(v)) return null;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

// Booleano de query/multipart ('true'/'false') ou de JSON (true/false).
// `undefined` = ausente; `null` = invalido.
export function lerBooleano(v: unknown): boolean | undefined | null {
  if (v === undefined) return undefined;
  if (v === true || v === 'true') return true;
  if (v === false || v === 'false') return false;
  return null;
}

// Texto obrigatorio (ou opcional) com teto de tamanho. `null` = invalido.
export function textoValido(v: unknown, max: number): v is string {
  return typeof v === 'string' && v.trim().length > 0 && v.length <= max;
}

// Tetos de corpo, conferidos ANTES de qualquer parse (revisao F2.41): o
// formData()/json() leem o corpo inteiro para a memoria, e um corpo perto do
// teto da plataforma (100 MB) derrubaria o isolate e as requisicoes que
// estivessem nele. JSON da API e pequeno (o maior texto aceito e 8000).
export const MAX_BYTES_JSON = 1024 * 1024;

export type Bytes = Uint8Array | 'grande' | 'ilegivel';

// Le o corpo com teto, parando no primeiro byte acima dele. Confere o
// content-length declarado primeiro (recusa sem ler nada) e o tamanho real
// depois (o declarado pode faltar ou mentir).
export async function lerBytes(c: Ctx, max: number): Promise<Bytes> {
  const declarado = c.req.header('content-length');
  if (declarado && /^\d+$/.test(declarado) && Number(declarado) > max) return 'grande';
  const corpo = c.req.raw.body;
  if (!corpo) return new Uint8Array();
  if (c.req.raw.bodyUsed) {
    // Alguem antes (o authMiddleware le `account_id` do JSON, F2.42) ja leu
    // pelo cache do Hono: o stream original foi consumido, e o cache devolve
    // o mesmo corpo. O teto ainda vale sobre o tamanho real.
    try {
      const cache = new Uint8Array(await c.req.arrayBuffer());
      return cache.byteLength > max ? 'grande' : cache;
    } catch {
      return 'ilegivel';
    }
  }
  try {
    const leitor = corpo.getReader();
    const partes: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await leitor.read();
      if (done) break;
      total += value.byteLength;
      if (total > max) {
        await leitor.cancel().catch(() => {});
        return 'grande';
      }
      partes.push(value);
    }
    const saida = new Uint8Array(total);
    let pos = 0;
    for (const parte of partes) {
      saida.set(parte, pos);
      pos += parte.byteLength;
    }
    return saida;
  } catch {
    return 'ilegivel';
  }
}

function corpoGrande(c: Ctx, max: number): Response {
  return c.json({ error: 'body_too_large', max_bytes: max }, 413);
}

export async function lerJson(c: Ctx): Promise<Record<string, unknown> | Response> {
  const bytes = await lerBytes(c, MAX_BYTES_JSON);
  if (bytes === 'grande') return corpoGrande(c, MAX_BYTES_JSON);
  if (bytes === 'ilegivel') return c.json({ error: 'invalid_json' }, 400);
  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return c.json({ error: 'invalid_json' }, 400);
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return c.json({ error: 'invalid_json' }, 400);
  }
  return body as Record<string, unknown>;
}

// Anexos: ate 5 arquivos e 15 MB somados por chamada. O LinkedIn recusa
// arquivo muito grande de qualquer jeito; o teto aqui evita o Worker gastar
// memoria repassando o que nao vai passar.
export const MAX_ANEXOS = 5;
export const MAX_BYTES_ANEXOS = 15 * 1024 * 1024;

export interface Entrada {
  campos: Record<string, unknown>;
  arquivos: File[];
}

// Corpo JSON ou multipart/form-data. Em multipart, os campos de texto viram
// `campos` e os arquivos do campo `attachments` viram `arquivos`. Qualquer
// outro arquivo e recusado (nao ha outro campo de arquivo na API).
export async function lerEntrada(c: Ctx): Promise<Entrada | Response> {
  const tipo = (c.req.header('content-type') ?? '').toLowerCase();
  if (!tipo.startsWith('multipart/form-data')) {
    const json = await lerJson(c);
    if (json instanceof Response) return json;
    return { campos: json, arquivos: [] };
  }

  // Teto do corpo inteiro = teto dos anexos + folga para os campos e os
  // separadores do multipart. So depois de caber e que vira FormData.
  const maxCorpo = MAX_BYTES_ANEXOS + MAX_BYTES_JSON;
  const bytes = await lerBytes(c, maxCorpo);
  if (bytes === 'grande') {
    return c.json({ error: 'attachments_too_large', max_bytes: MAX_BYTES_ANEXOS }, 413);
  }
  if (bytes === 'ilegivel') return c.json({ error: 'invalid_body' }, 400);
  let form: FormData;
  try {
    form = await new Response(bytes, {
      headers: { 'content-type': c.req.header('content-type') ?? '' },
    }).formData();
  } catch {
    return c.json({ error: 'invalid_body' }, 400);
  }
  const campos: Record<string, unknown> = {};
  const arquivos: File[] = [];
  let somaAnexos = 0;
  for (const [nome, bruto] of form.entries()) {
    // Os tipos do runtime declaram so string; em multipart chega File tambem.
    const valor = bruto as unknown as File | string;
    if (typeof valor === 'string') {
      if (!(nome in campos)) campos[nome] = valor;
      continue;
    }
    if (nome !== 'attachments') {
      return c.json({ error: 'invalid_attachment_field' }, 400);
    }
    arquivos.push(valor);
    somaAnexos += valor.size;
  }
  if (arquivos.length > MAX_ANEXOS) {
    return c.json({ error: 'too_many_attachments', max: MAX_ANEXOS }, 400);
  }
  if (somaAnexos > MAX_BYTES_ANEXOS) {
    return c.json({ error: 'attachments_too_large', max_bytes: MAX_BYTES_ANEXOS }, 413);
  }
  return { campos, arquivos };
}
