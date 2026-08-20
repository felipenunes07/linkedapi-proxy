// Helpers compartilhados dos scripts standalone (keys.ts tem copia propria
// anterior a este arquivo; scripts novos importam daqui).
//
// Le segredos de process.env ou de .dev.vars (gitignored). Nunca logar valores.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

let devVarsCache: Record<string, string> | null = null;

// Parser minimo de dotenv: linhas KEY=VALUE, ignora comentarios (#) e vazias,
// remove aspas simples/duplas em volta do valor. Suficiente para .dev.vars.
function parseDevVars(): Record<string, string> {
  if (devVarsCache) {
    return devVarsCache;
  }
  const out: Record<string, string> = {};
  const path = resolve(__dirname, '..', '.dev.vars');
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    devVarsCache = out;
    return out;
  }
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith('#')) {
      continue;
    }
    const eq = trimmed.indexOf('=');
    if (eq === -1) {
      continue;
    }
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  devVarsCache = out;
  return out;
}

// Variavel obrigatoria: process.env primeiro, senao .dev.vars; falta = erro.
export function loadEnv(name: string): string {
  const fromProcess = process.env[name];
  if (fromProcess && fromProcess.length > 0) {
    return fromProcess;
  }
  const value = parseDevVars()[name];
  if (!value) {
    fail(
      `Falta ${name}. Defina em .dev.vars (na raiz do projeto) ou como variavel de ambiente.`,
    );
  }
  return value;
}

// Variavel opcional: undefined quando ausente.
export function loadEnvOptional(name: string): string | undefined {
  const fromProcess = process.env[name];
  if (fromProcess && fromProcess.length > 0) {
    return fromProcess;
  }
  return parseDevVars()[name] || undefined;
}

export function fail(message: string): never {
  console.error(`erro: ${message}`);
  process.exit(1);
}
