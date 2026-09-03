// Validacao de CPF/CNPJ (modulo 11) feita ANTES de tocar a API financeira.
// Motivo: documento invalido nunca deve virar tenant no banco nem requisicao
// ao Asaas. Achado I3 do review do F2.14.

export function apenasDigitos(value: string): string {
  return value.replace(/\D/g, '');
}

function digitoModulo11(base: string, pesos: number[]): number {
  const soma = base
    .split('')
    .reduce((acc, ch, i) => acc + Number(ch) * pesos[i]!, 0);
  const resto = soma % 11;
  return resto < 2 ? 0 : 11 - resto;
}

export function cpfValido(cpf: string): boolean {
  if (cpf.length !== 11) return false;
  // Sequencias repetidas (00000000000, 11111111111...) passam no modulo 11.
  if (/^(\d)\1{10}$/.test(cpf)) return false;

  const d1 = digitoModulo11(cpf.slice(0, 9), [10, 9, 8, 7, 6, 5, 4, 3, 2]);
  const d2 = digitoModulo11(cpf.slice(0, 10), [11, 10, 9, 8, 7, 6, 5, 4, 3, 2]);
  return cpf[9] === String(d1) && cpf[10] === String(d2);
}

export function cnpjValido(cnpj: string): boolean {
  if (cnpj.length !== 14) return false;
  if (/^(\d)\1{13}$/.test(cnpj)) return false;

  const p1 = [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
  const p2 = [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
  const d1 = digitoModulo11(cnpj.slice(0, 12), p1);
  const d2 = digitoModulo11(cnpj.slice(0, 13), p2);
  return cnpj[12] === String(d1) && cnpj[13] === String(d2);
}

export function documentoValido(documento: string): boolean {
  return documento.length === 11
    ? cpfValido(documento)
    : documento.length === 14
      ? cnpjValido(documento)
      : false;
}
