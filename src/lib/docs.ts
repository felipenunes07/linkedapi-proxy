import type { Env } from '../types';

// HTML da pagina de documentacao (Scalar). Servida em GET /docs, publica.
// Carrega o Scalar do CDN e aponta para /openapi.json (mesma origem). Nada de
// segredo/infra aqui: so a referencia da spec, que ja e curada.
//
// IMPORTANT: versao PINADA + SRI. E a pagina onde o cliente cola a propria API
// key no playground; um CDN comprometido nao pode virar script arbitrario aqui.
// Para atualizar a versao: trocar a URL e recalcular o hash sha384 do arquivo
// exato (ex.: curl <url> | openssl dgst -sha384 -binary | openssl base64 -A).
//
// Pelo mesmo motivo, TODO o resto da pagina (estilo, icones, fonte) e local:
// nenhuma origem de terceiro alem do proprio Scalar.
const SCALAR_URL =
  'https://cdn.jsdelivr.net/npm/@scalar/api-reference@1.65.1/dist/browser/standalone.min.js';
const SCALAR_SRI =
  'sha384-NAMzfHXRsxRYhcKmRnZGVLvlBeXTWtpYd0jWgeZ7fk89X95GIJBK1H4bUwkP4IZJ';

const PAINEL_PADRAO = 'https://app.playbooklab.com.br/painel';
const SUPORTE = 'victor@playbooklab.com.br';

// Altura da nossa barra (marca + abas). O Scalar tem suporte NATIVO a header
// proprio: com esta variavel, a barra lateral e o conteudo dele ja nascem
// abaixo dela, sem hack de posicionamento.
const ALTURA_BARRA = 92;
const ALTURA_BARRA_MOBILE = 116;

const ESTILO = `
  :root {
    --scalar-custom-header-height: ${ALTURA_BARRA}px;
    --doc-navy: #0f2736;
    --doc-fonte: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    --doc-yellow: #dddf4c;
  }

  /* Escuro por padrao (o toggle do Scalar continua valendo), com a paleta da
     marca: e a mesma tela, so que nossa. */
  .dark-mode {
    --scalar-background-1: #0d1b24;
    --scalar-background-2: #12212b;
    --scalar-background-3: #172a36;
    --scalar-color-1: #e6edf3;
    --scalar-color-2: #a9bac6;
    --scalar-color-3: #7d8f9c;
    --scalar-color-accent: var(--doc-yellow);
    --scalar-background-accent: #1d3341;
    --scalar-border-color: #1e3240;
  }
  .dark-mode .sidebar {
    --scalar-sidebar-background-1: #0a141b;
    --scalar-sidebar-color-1: #e6edf3;
    --scalar-sidebar-color-2: #8ea0ad;
    --scalar-sidebar-border-color: #1e3240;
    --scalar-sidebar-item-hover-background: #12212b;
    --scalar-sidebar-item-hover-color: #ffffff;
    --scalar-sidebar-item-active-background: #172a36;
    --scalar-sidebar-color-active: #ffffff;
    --scalar-sidebar-search-background: #0d1b24;
    --scalar-sidebar-search-border-color: #1e3240;
    --scalar-sidebar-search-color: #8ea0ad;
  }
  .light-mode {
    --scalar-background-1: #ffffff;
    --scalar-background-2: #f4f5f7;
    --scalar-background-3: #eef0f3;
    --scalar-color-1: #0f2736;
    --scalar-color-2: #475569;
    --scalar-color-3: #64748b;
    --scalar-color-accent: #0a66c2;
    --scalar-background-accent: #e8f1fb;
    --scalar-border-color: #e5e7eb;
  }
  .light-mode .sidebar {
    --scalar-sidebar-background-1: #f7f8fa;
    --scalar-sidebar-color-1: #0f2736;
    --scalar-sidebar-color-2: #64748b;
    --scalar-sidebar-border-color: #e5e7eb;
    --scalar-sidebar-item-hover-background: #eef0f3;
    --scalar-sidebar-item-active-background: #e8eaee;
    --scalar-sidebar-color-active: #0f2736;
  }

  body { margin: 0; padding-top: var(--scalar-custom-header-height); }

  /* Barra de ferramentas do proprio Scalar (Developer Tools, Configure,
     Share, Deploy): e da plataforma deles, nao do nosso cliente. */
  .api-reference-toolbar { display: none !important; }

  /* Uma busca so: a do topo. A da lateral continua existindo no DOM (e ela
     que o botao aciona), apenas escondida. */
  .doc-sem-busca-lateral { display: none !important; }

  /* Barra propria, na cor da marca. Duas faixas, como o topo de uma doc de
     API: marca + busca centralizada + links, e embaixo versao e abas. */
  .doc-barra {
    position: fixed; inset: 0 0 auto 0; z-index: 50;
    height: var(--scalar-custom-header-height);
    background: var(--doc-navy); color: #ffffff;
    font-family: var(--doc-fonte);
    display: flex; flex-direction: column;
    border-bottom: 1px solid rgba(255, 255, 255, 0.08);
  }
  .doc-linha {
    position: relative; display: flex; align-items: center;
    gap: 16px; padding: 0 20px; height: 56px;
  }
  /* Mesmo logo da landing e do painel, nas medidas de la (22px/600/-0.4px). */
  .doc-marca {
    display: inline-flex; align-items: center; gap: 10px;
    color: #ffffff; text-decoration: none;
    font-size: 22px; font-weight: 600; line-height: 1; letter-spacing: -0.4px;
    white-space: nowrap;
  }
  .doc-marca svg { width: 40px; height: 22px; flex: none; }
  /* Centralizada na TELA, nao no espaco que sobra: e o que da o alinhamento
     limpo do topo. */
  .doc-busca {
    position: absolute; left: 50%; transform: translateX(-50%);
    width: min(345px, 38vw);
    display: flex; align-items: center; gap: 9px; height: 36px;
    background: #f1f3f5; border: 0; border-radius: 999px;
    padding: 0 14px; cursor: pointer;
    color: #6b7280; font: inherit; font-size: 13.5px; text-align: left;
  }
  .doc-busca:hover { background: #e8ebee; }
  .doc-busca span { flex: 1; }
  .doc-busca kbd {
    font-family: inherit; font-size: 10.5px; font-weight: 600; letter-spacing: 0.6px;
    color: #9aa3ad; border: 0; padding: 0;
  }
  .doc-links {
    margin-left: auto; display: flex; align-items: center; gap: 24px;
    font-size: 14px; font-weight: 500;
  }
  .doc-links a { color: #e6edf3; text-decoration: none; white-space: nowrap; }
  .doc-links a:hover { color: #ffffff; }
  .doc-tema {
    display: grid; place-items: center; width: 34px; height: 34px; flex: none;
    background: rgba(255, 255, 255, 0.1); border: 0; border-radius: 999px;
    color: #e6edf3; cursor: pointer;
  }
  .doc-tema:hover { background: rgba(255, 255, 255, 0.18); color: #ffffff; }
  .doc-tema svg { width: 17px; height: 17px; }
  .doc-abas { display: flex; align-items: center; gap: 10px; padding: 0 20px; height: 36px; }
  .doc-versao {
    font-size: 13.5px; font-weight: 500; color: #cbd5e1;
    padding: 4px 2px; margin-right: 8px;
  }
  .doc-aba {
    display: inline-flex; align-items: center; gap: 7px;
    font-size: 14px; font-weight: 500; color: #94a3b8; text-decoration: none;
    border: 1px solid transparent; border-radius: 8px; padding: 5px 11px;
  }
  .doc-aba:hover { color: #ffffff; }
  .doc-aba.on {
    color: var(--doc-navy); font-weight: 600; background: #f1f3f5; border-color: #f1f3f5;
  }
  .doc-aba.on:hover { color: var(--doc-navy); background: #e8ebee; }
  .doc-aba svg { width: 15px; height: 15px; flex: none; }

  /* Tela media: a busca sai do centro absoluto para nao colidir. */
  @media (max-width: 1080px) {
    .doc-busca { position: static; transform: none; width: auto; flex: 1; max-width: 320px; }
    .doc-links { gap: 18px; }
  }

  @media (max-width: 800px) {
    :root { --scalar-custom-header-height: ${ALTURA_BARRA_MOBILE}px; }
    .doc-linha { flex-wrap: wrap; height: auto; padding: 10px 14px 0; gap: 10px; }
    .doc-marca { font-size: 20px; }
    .doc-busca { order: 3; max-width: none; width: 100%; flex: 0 0 100%; }
    .doc-links { margin-left: auto; gap: 16px; font-size: 13.5px; }
    .doc-abas { padding: 0 14px; height: 34px; }
  }
`;

// Marca da pagina: a mesma da landing e do painel, para a documentacao nao
// parecer um servico de terceiro no meio do caminho.
const LOGO = `<svg viewBox="0 0 46 24" fill="none" aria-hidden="true">
        <path d="M3 7l5 5-5 5" stroke="#00b3f0" stroke-width="3.6" stroke-linecap="round" stroke-linejoin="round"/>
        <path d="M15 5l7 7-7 7" stroke="#2fc98e" stroke-width="4.2" stroke-linecap="round" stroke-linejoin="round"/>
        <path d="M30 3l9 9-9 9" stroke="#dddf4c" stroke-width="4.8" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>`;

const ICONE_BUSCA = `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5" stroke-linecap="round"/></svg>`;
const ICONE_CODIGO = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 18l-6-6 6-6M15 6l6 6-6 6"/></svg>`;
const ICONE_TEMA = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="4.2"/><path d="M12 2.6v2.2M12 19.2v2.2M2.6 12h2.2M19.2 12h2.2M5.3 5.3l1.6 1.6M17.1 17.1l1.6 1.6M18.7 5.3l-1.6 1.6M6.9 17.1l-1.6 1.6"/></svg>`;
const ICONE_PAINEL = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18M9 9v11"/></svg>`;

// Painel do cliente: a mesma URL configurada para os e-mails. Sem ela, o padrao.
function enderecos(env: Env): { painel: string; site: string } {
  const bruto = (env.PORTAL_URL ?? PAINEL_PADRAO).trim();
  const painel = bruto.startsWith('https://') ? bruto : PAINEL_PADRAO;
  try {
    return { painel, site: new URL(painel).origin };
  } catch {
    return { painel: PAINEL_PADRAO, site: new URL(PAINEL_PADRAO).origin };
  }
}

export function docsHtml(env: Env): string {
  const { painel, site } = enderecos(env);
  return `<!doctype html>
<html lang="pt-BR">
  <head>
    <title>Playbook API, Documentacao</title>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <!-- A mesma fonte da landing e do painel, para a marca no topo ser a
         MESMA em todas as telas. So folha de estilo (nenhum script de
         terceiro entra nesta pagina, onde o cliente cola a propria chave). -->
    <link rel="preconnect" href="https://fonts.googleapis.com" />
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet" />
    <style>${ESTILO}</style>
  </head>
  <body>
    <header class="doc-barra">
      <div class="doc-linha">
        <a class="doc-marca" href="${site}">${LOGO}playbook api</a>
        <button type="button" class="doc-busca" id="docBusca">
          ${ICONE_BUSCA}<span>Buscar na documentacao</span><kbd>CTRL K</kbd>
        </button>
        <nav class="doc-links">
          <a href="${painel}">Meu painel</a>
          <a href="${site}">Site</a>
          <a href="mailto:${SUPORTE}">Suporte</a>
          <button type="button" class="doc-tema" id="docTema" title="Alternar claro e escuro" aria-label="Alternar claro e escuro">${ICONE_TEMA}</button>
        </nav>
      </div>
      <nav class="doc-abas">
        <span class="doc-versao">v1.0.0</span>
        <span class="doc-aba on">${ICONE_CODIGO}Referencia da API</span>
        <a class="doc-aba" href="${painel}">${ICONE_PAINEL}Meu painel</a>
      </nav>
    </header>
    <script
      id="api-reference"
      data-url="/openapi.json"
      data-configuration='{"darkMode":true,"hideModels":true,"hideDownloadButton":false,"searchHotKey":"k","metaData":{"title":"Playbook API, Documentacao"}}'
    ></script>
    <script
      src="${SCALAR_URL}"
      integrity="${SCALAR_SRI}"
      crossorigin="anonymous"
    ></script>
    <script>
      // A busca do topo e a MESMA do Scalar: o botao da barra so aciona o
      // gatilho que ja existe na lateral (versao pinada por SRI, entao o
      // seletor nao muda por baixo). Sem ele, a lateral continua buscando.
      // Claro/escuro: o Scalar marca o modo com uma classe no <body> e o
      // nosso estilo segue a mesma classe. A escolha fica no navegador.
      function aplicarTema(modo) {
        document.body.classList.toggle('dark-mode', modo === 'escuro');
        document.body.classList.toggle('light-mode', modo !== 'escuro');
      }
      try {
        var salvo = localStorage.getItem('playbook_docs_tema');
        if (salvo) aplicarTema(salvo);
      } catch (e) { /* sem storage: vale o padrao */ }
      document.getElementById('docTema').addEventListener('click', function () {
        var escuro = !document.body.classList.contains('dark-mode');
        aplicarTema(escuro ? 'escuro' : 'claro');
        try { localStorage.setItem('playbook_docs_tema', escuro ? 'escuro' : 'claro'); } catch (e) {}
      });

      function gatilhoDaBusca() {
        var botoes = document.querySelectorAll('aside button, .sidebar button');
        for (var i = 0; i < botoes.length; i++) {
          if (/search|buscar/i.test(botoes[i].textContent || '')) return botoes[i];
        }
        return null;
      }

      document.getElementById('docBusca').addEventListener('click', function () {
        var alvo = gatilhoDaBusca();
        if (alvo) alvo.click();
      });

      // Uma busca so na tela: a de cima. A da lateral fica escondida, mas viva
      // (e nela que o clique acima bate). O Scalar monta a lateral depois do
      // carregamento, entao tentamos algumas vezes antes de desistir.
      var tentativas = 0;
      var procura = setInterval(function () {
        var alvo = gatilhoDaBusca();
        if (alvo && alvo.parentElement) {
          alvo.parentElement.classList.add('doc-sem-busca-lateral');
          clearInterval(procura);
        } else if (++tentativas > 20) {
          clearInterval(procura);
        }
      }, 250);
    </script>
  </body>
</html>`;
}
