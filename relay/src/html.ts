

/** Marker for already-safe HTML. Everything else interpolated through `html` is escaped. */
export class SafeHtml {
  constructor(readonly value: string) {}
  toString(): string {
    return this.value;
  }
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

type Interp = SafeHtml | string | number | null | undefined | Interp[];

function render(v: Interp): string {
  if (v === null || v === undefined) return "";
  if (v instanceof SafeHtml) return v.value;
  if (Array.isArray(v)) return v.map(render).join("");
  return escapeHtml(String(v));
}

export function html(strings: TemplateStringsArray, ...values: Interp[]): SafeHtml {
  let out = strings[0] ?? "";
  values.forEach((v, i) => {
    out += render(v) + (strings[i + 1] ?? "");
  });
  return new SafeHtml(out);
}

export const CSP = [
  "default-src 'none'",
  "style-src 'self'",
  "form-action 'self'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
].join("; ");

export const SECURITY_HEADERS: Record<string, string> = {
  "Content-Security-Policy": CSP,
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Strict-Transport-Security": "max-age=31536000",
  "Cache-Control": "no-store",
};

export function page(title: string, body: SafeHtml, status = 200, extra: HeadersInit = {}): Response {
  const doc = html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} · Mowgli Connect</title>
<link rel="stylesheet" href="/style.css">
</head>
<body>
<main>
<h1>Mowgli Connect <small>prototype</small></h1>
${body}
</main>
</body>
</html>`;
  const headers = new Headers({ "Content-Type": "text/html; charset=utf-8", ...SECURITY_HEADERS });
  new Headers(extra).forEach((v, k) => headers.append(k, v));
  return new Response(doc.value, { status, headers });
}

export const STYLE_CSS = `
:root{color-scheme:light dark;--bg:#fafaf7;--fg:#1c1f1a;--muted:#667064;--line:#d9ddd3;--accent:#2f6b3a;--danger:#a3281f}
@media (prefers-color-scheme:dark){:root{--bg:#161815;--fg:#e8ebe4;--muted:#99a396;--line:#2e332b;--accent:#7cc48a;--danger:#ef8a80}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,sans-serif}
main{max-width:46rem;margin:0 auto;padding:1.5rem 16px 4rem}
h1{font-size:1.4rem;margin:0 0 1.5rem}h1 small{font-size:.7rem;color:var(--muted);font-weight:400;margin-left:.4rem}
h2{font-size:1.1rem;margin:2rem 0 .6rem}
a{color:var(--accent)}
table{width:100%;border-collapse:collapse}
th,td{text-align:left;padding:.5rem .4rem;border-bottom:1px solid var(--line);vertical-align:top;word-break:break-word}
th{font-size:.8rem;color:var(--muted);font-weight:500}
code{font:.9em ui-monospace,monospace}
input[type=text]{font:inherit;padding:.45rem .6rem;border:1px solid var(--line);border-radius:6px;background:transparent;color:inherit;min-width:12rem}
button,.btn{font:inherit;padding:.4rem .8rem;border:1px solid var(--line);border-radius:6px;background:transparent;color:inherit;cursor:pointer;text-decoration:none;display:inline-block}
button.primary,.btn.primary{background:var(--accent);border-color:var(--accent);color:var(--bg)}
button.danger{color:var(--danger);border-color:var(--danger)}
form.inline{display:inline}
.row{display:flex;gap:.5rem;flex-wrap:wrap;align-items:center;margin:.25rem 0}
.notice{border-left:3px solid var(--accent);padding:.4rem .8rem;margin:0 0 1rem}
.error{border-left:3px solid var(--danger);padding:.4rem .8rem;margin:0 0 1rem}
.muted{color:var(--muted)}
.actions{display:flex;gap:.4rem;flex-wrap:wrap}
`;
