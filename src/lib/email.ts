import type { Env } from '../types';

// E-mail transacional (F2.20) via Resend, por HTTP (sem SDK). OPCIONAL: sem
// RESEND_API_KEY e EMAIL_FROM nada e enviado e o onboarding segue funcionando,
// porque o link do painel ja aparece na propria tela do checkout. O e-mail e o
// caminho de quem fechou a aba e de quem volta depois ("entrar no painel").
//
// Disciplina de log: o endereco do destinatario e dado pessoal e o corpo leva
// um link com credencial. Nenhum dos dois vai para log; so o status HTTP.

const RESEND_URL = 'https://api.resend.com/emails';

export function emailConfigured(env: Env): boolean {
  return Boolean(env.RESEND_API_KEY && env.EMAIL_FROM);
}

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
}

export async function sendEmail(env: Env, msg: EmailMessage): Promise<boolean> {
  if (!emailConfigured(env)) {
    return false;
  }
  try {
    const res = await fetch(RESEND_URL, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${env.RESEND_API_KEY}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        from: env.EMAIL_FROM,
        to: [msg.to],
        subject: msg.subject,
        text: msg.text,
        html: msg.html,
      }),
    });
    if (!res.ok) {
      console.error(`email_send_failed:${res.status}`);
      return false;
    }
    return true;
  } catch {
    console.error('email_send_failed:network');
    return false;
  }
}
