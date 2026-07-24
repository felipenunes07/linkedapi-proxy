// HTML da pagina de documentacao (Scalar). Servida em GET /docs, publica.
// Carrega o Scalar do CDN e aponta para /openapi.json (mesma origem). Nada de
// segredo/infra aqui: so a referencia da spec, que ja e curada.
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
    <script src="https://cdn.jsdelivr.net/npm/@scalar/api-reference"></script>
  </body>
</html>`;
