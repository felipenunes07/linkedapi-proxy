// HTML da pagina de documentacao (Scalar). Servida em GET /docs, publica.
// Carrega o Scalar do CDN e aponta para /openapi.json (mesma origem). Nada de
// segredo/infra aqui: so a referencia da spec, que ja e curada.
//
// IMPORTANT: versao PINADA + SRI. E a pagina onde o cliente cola a propria API
// key no playground; um CDN comprometido nao pode virar script arbitrario aqui.
// Para atualizar a versao: trocar a URL e recalcular o hash sha384 do arquivo
// exato (ex.: curl <url> | openssl dgst -sha384 -binary | openssl base64 -A).
const SCALAR_URL =
  'https://cdn.jsdelivr.net/npm/@scalar/api-reference@1.65.1/dist/browser/standalone.min.js';
const SCALAR_SRI =
  'sha384-NAMzfHXRsxRYhcKmRnZGVLvlBeXTWtpYd0jWgeZ7fk89X95GIJBK1H4bUwkP4IZJ';

export const docsHtml = `<!doctype html>
<html lang="pt-BR">
  <head>
    <title>LinkedAPI, Documentacao</title>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
  </head>
  <body>
    <script
      id="api-reference"
      data-url="/openapi.json"
      data-configuration='{"theme":"default","hideDownloadButton":false}'
    ></script>
    <script
      src="${SCALAR_URL}"
      integrity="${SCALAR_SRI}"
      crossorigin="anonymous"
    ></script>
  </body>
</html>`;
