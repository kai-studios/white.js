const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);

// Built-in error page, used when the site has no views/error.eta of its own
export function errorPage(status, message) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${status}</title>
<style>body{font-family:system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0}main{text-align:center}h1{font-size:4rem;margin:0}</style>
</head>
<body><main><h1>${status}</h1><p>${escapeHtml(message)}</p></main></body>
</html>`;
}
