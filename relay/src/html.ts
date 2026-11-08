

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
  "Referrer-Policy": "same-origin",
  "X-Frame-Options": "DENY",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Strict-Transport-Security": "max-age=31536000",
  "Cache-Control": "no-store",
};

export const HOMEPAGE = "https://liltaket.github.io/mowgli-connect/";

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
<header class="lawn"><div class="bar"><a class="brand" href="/"><span class="mark" aria-hidden="true"></span>Mowgli Connect</a><span class="tag">prototype</span></div></header>
<main>
${body}
</main>
<footer><a href="${HOMEPAGE}">About Mowgli Connect</a><a href="https://github.com/liltaket/mowgli-connect">Source code</a></footer>
</body>
</html>`;
  const headers = new Headers({ "Content-Type": "text/html; charset=utf-8", ...SECURITY_HEADERS });
  new Headers(extra).forEach((v, k) => headers.append(k, v));
  return new Response(doc.value, { status, headers });
}

// Same visual language as the project site (site/index.html): mowed-lawn stripes, safety-yellow
// primary actions. System fonts only, so the strict CSP needs no third-party origins.
export const STYLE_CSS = `
:root{color-scheme:light dark;--bg:#f1f5ee;--card:#fff;--fg:#142017;--muted:#4b5c4e;--line:#cbd8c6;--grass-d:#2f6b33;--grass-l:#3f8340;--signal:#f2c230;--on-signal:#1c1a08;--danger:#a3281f;--ok:#2f6b33}
@media (prefers-color-scheme:dark){:root{--bg:#101a12;--card:#162319;--fg:#e7efe4;--muted:#a6b8a8;--line:#2a3a2d;--danger:#ef8a80;--ok:#7cc48a}}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif;min-height:100vh;display:flex;flex-direction:column}
a{color:inherit;text-underline-offset:3px}
:focus-visible{outline:3px solid var(--signal);outline-offset:2px;border-radius:4px}
.lawn{background:repeating-linear-gradient(90deg,var(--grass-d) 0 3rem,var(--grass-l) 3rem 6rem);color:#fff}
.bar{max-width:46rem;margin:0 auto;padding:1rem 16px;display:flex;align-items:center;gap:.6rem}
.brand{display:flex;align-items:center;gap:.55rem;font-weight:700;font-size:1.1rem;text-decoration:none}
.mark{width:1.5rem;height:1.5rem;border-radius:.4rem;background:var(--signal);box-shadow:inset 0 0 0 .3rem rgba(0,0,0,.12)}
.tag{font-size:.8rem;padding:.1rem .5rem;border-radius:1rem;background:rgba(0,0,0,.22)}
main{flex:1;width:100%;max-width:46rem;margin:0 auto;padding:2rem 16px 3rem}
footer{max-width:46rem;width:100%;margin:0 auto;padding:1.25rem 16px 2rem;display:flex;gap:1.25rem;flex-wrap:wrap;color:var(--muted);font-size:.9rem;border-top:1px solid var(--line)}
h1{font-size:1.8rem;line-height:1.2;margin:0 0 .5rem;letter-spacing:-.01em}
h2{font-size:1.15rem;margin:2.25rem 0 .75rem}
p{margin:0 0 1rem}
.muted{color:var(--muted)}
code{font:.85em ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--muted);word-break:break-all}
.who{display:flex;align-items:center;justify-content:space-between;gap:1rem;flex-wrap:wrap}
.robots{list-style:none;margin:0;padding:0;display:grid;gap:.75rem}
.robot{background:var(--card);border:1px solid var(--line);border-radius:.75rem;padding:1rem 1.1rem;display:grid;grid-template-columns:1fr auto;gap:.25rem 1rem;align-items:center}
.robot .name{font-weight:600;font-size:1.1rem}
.robot .meta{grid-column:1;font-size:.9rem;color:var(--muted)}
.robot .open{grid-row:1/3;grid-column:2}
.state{display:inline-flex;align-items:center;gap:.35rem}
.state::before{content:"";width:.5rem;height:.5rem;border-radius:50%;background:var(--ok)}
.state.wait::before{background:var(--signal)}
.robot details{grid-column:1/-1;margin-top:.5rem;border-top:1px solid var(--line);padding-top:.5rem}
.robot summary{cursor:pointer;color:var(--muted);font-size:.9rem;width:max-content}
.manage{display:grid;gap:.75rem;margin-top:.75rem}
.manage p{font-size:.9rem;color:var(--muted);margin:.25rem 0 0}
.panel{background:var(--card);border:1px solid var(--line);border-radius:.75rem;padding:1.25rem 1.1rem}
label{display:block;font-weight:600;margin:0 0 .35rem}
.fields{display:grid;gap:.75rem}
@media (min-width:40rem){.fields{grid-template-columns:1fr 1fr auto;align-items:end}}
input[type=text]{width:100%;font:inherit;padding:.6rem .7rem;border:1px solid var(--line);border-radius:.5rem;background:var(--bg);color:inherit}
input.code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.08em;text-transform:uppercase}
button,.btn{font:inherit;font-weight:500;padding:.6rem 1rem;border:1px solid var(--line);border-radius:.5rem;background:transparent;color:inherit;cursor:pointer;text-decoration:none;display:inline-block;text-align:center;white-space:nowrap}
button.primary,.btn.primary{background:var(--signal);border-color:var(--signal);color:var(--on-signal)}
button.danger{color:var(--danger);border-color:var(--danger)}
form.inline{display:inline}
.notice,.error{border-radius:.5rem;padding:.7rem .9rem;margin:0 0 1.25rem;background:var(--card);border:1px solid var(--line);border-left:4px solid var(--ok)}
.error{border-left-color:var(--danger)}
.hero{padding:1rem 0 .5rem}
.hero p{font-size:1.1rem;max-width:34rem}
`;
