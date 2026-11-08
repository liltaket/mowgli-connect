

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
  "img-src 'self'", // favicons only
  "script-src 'self'", // only /pair.js; no inline script anywhere
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

export const MARK = markSvg("mark");

export function markSvg(cls: string): SafeHtml {
  return html`<svg class="${cls}" viewBox="0 0 32 32" aria-hidden="true"><rect class="mark-tile" width="32" height="32" rx="8"/><path class="mark-path" d="M8.5 9.5h15v6.5h-15v6.5h10"/><circle class="mark-robot" cx="22.7" cy="22.5" r="2.3"/></svg>`;
}

/** Who is signed in, for the header. Pages that do not know pass nothing and show no account. */
export interface PageUser {
  login: string;
  name: string | null;
  admin?: boolean;
}

function accountBar(user: PageUser | null | undefined): SafeHtml {
  if (user === undefined) return html``;
  if (user === null) return html`<a class="btn small" href="/login">Sign in</a>`;
  const initial = (user.name ?? user.login).trim().charAt(0).toUpperCase() || "?";
  return html`<div class="account">${user.admin ? html`<a class="admin-link" href="/admin">Admin</a>` : ""}<span class="avatar" aria-hidden="true">${initial}</span><span class="who-name"><span class="visually-hidden">Signed in as </span>${user.login}</span><form method="post" action="/logout"><button class="link">Sign out</button></form></div>`;
}

export function page(
  title: string,
  body: SafeHtml,
  status = 200,
  extra: HeadersInit = {},
  user?: PageUser | null,
): Response {
  const doc = html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>${title} · Mowgli Connect</title>
<link rel="icon" href="/favicon.ico" sizes="48x48">
<link rel="icon" href="/icon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<link rel="stylesheet" href="/style.css">
</head>
<body>
<header class="top"><div class="bar"><a class="brand" href="/">${MARK}Mowgli Connect</a><span class="tag">Prototype</span>${accountBar(user)}</div></header>
<main>
${body}
</main>
<footer><a href="${HOMEPAGE}">About Mowgli Connect</a><a href="${HOMEPAGE}#install">Install on a robot</a><a href="https://github.com/liltaket/mowgli-connect">Source code</a></footer>
</body>
</html>`;
  const headers = new Headers({ "Content-Type": "text/html; charset=utf-8", ...SECURITY_HEADERS });
  new Headers(extra).forEach((v, k) => headers.append(k, v));
  return new Response(doc.value, { status, headers });
}

/**
 * A small lawn with a mower working across it, stripe by stripe: the waiting animation. `parked`
 * draws it finished and still (robot offline).
 */
export function lawn(parked = false): SafeHtml {
  return html`<svg class="lawn${parked ? " parked" : ""}" viewBox="0 0 132 76" aria-hidden="true"><rect class="lawn-bed" width="132" height="76" rx="12"/><g transform="translate(14 14)"><path class="lawn-cut" d="M0 0h104v16H0v16h104v16H48"/><path class="lawn-line" d="M0 0h104v16H0v16h104v16H48"/><circle class="lawn-mower" r="5"/></g></svg>`;
}

// Same visual system as the project site (site/assets/site.css): tinted paper, one grass-green
// accent, the mowing-path mark. System fonts only, so the strict CSP needs no other origins.
export const STYLE_CSS = `
:root{color-scheme:light dark;--paper:#fbfcfa;--fog:#f1f5f0;--ink:#18211b;--muted:#5b675f;--line:#d9e0da;--line-strong:#b9c4bb;--grass:#2f7d4a;--grass-deep:#266640;--grass-wash:#e6f2e9;--grass-ink:#1f5a35;--on-grass:#fff;--amber:#b7791b;--danger:#b4322a;--danger-wash:#fbeeec;--focus:#1f5a35;--lawn:#d7eadc}
@media (prefers-color-scheme:dark){:root{--paper:#111613;--fog:#181f1a;--ink:#e8ede8;--muted:#a3ada5;--line:#2b342d;--line-strong:#3f4b42;--grass:#6cc98a;--grass-deep:#5bb97a;--grass-wash:#1b2a1f;--grass-ink:#b2e3c0;--on-grass:#0f1a13;--amber:#e0a54a;--danger:#f08a80;--danger-wash:#2c1a18;--focus:#b2e3c0;--lawn:#1d3424}}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--paper);color:var(--ink);font:16px/1.55 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;min-height:100vh;display:flex;flex-direction:column;overflow-wrap:break-word}
a{color:inherit;text-underline-offset:.2em}
:focus-visible{outline:3px solid var(--focus);outline-offset:3px;border-radius:4px}
.top{border-bottom:1px solid var(--line)}
.bar{max-width:46rem;margin:0 auto;padding:12px 16px;display:flex;align-items:center;gap:.75rem}
.brand{display:inline-flex;align-items:center;gap:.6rem;min-height:40px;font-weight:700;font-size:1.05rem;letter-spacing:-.01em;text-decoration:none}
.mark{width:24px;height:24px;flex:none}
.mark-tile{fill:var(--grass)}
.mark-path{fill:none;stroke:var(--on-grass);stroke-width:2.4;stroke-linecap:round;stroke-linejoin:round}
.mark-robot{fill:var(--on-grass)}
.tag{font-size:.78rem;color:var(--muted);border:1px solid var(--line-strong);border-radius:999px;padding:.05rem .55rem}
main{flex:1;width:100%;max-width:46rem;margin:0 auto;padding:2rem 16px 3.5rem}
footer{max-width:46rem;width:100%;margin:0 auto;padding:1.25rem 16px 2rem;display:flex;gap:1.5rem;flex-wrap:wrap;color:var(--muted);font-size:.9rem;border-top:1px solid var(--line)}
h1{font-size:1.75rem;line-height:1.15;margin:0 0 .5rem;letter-spacing:-.02em}
h2{font-size:1.2rem;margin:2.5rem 0 .75rem;letter-spacing:-.01em}
p{margin:0 0 1rem;max-width:60ch}
.muted{color:var(--muted)}
code{font:.88em ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;overflow-wrap:anywhere}
.who{display:flex;align-items:flex-start;justify-content:space-between;gap:1rem;flex-wrap:wrap;margin-bottom:1.25rem}
.who form{display:flex;align-items:center;gap:.75rem;flex-wrap:wrap;font-size:.95rem}
.robots{list-style:none;margin:0;padding:0;display:grid;gap:.75rem}
.robot{background:var(--fog);border:1px solid var(--line);border-radius:12px;padding:1rem 1.1rem;display:grid;grid-template-columns:minmax(0,1fr) auto;gap:.35rem 1rem;align-items:center}
.robot .name{font-weight:650;font-size:1.15rem;letter-spacing:-.01em;min-width:0}
.robot .open{grid-row:1/3;grid-column:2;align-self:center}
.robot .meta{grid-column:1;display:flex;flex-wrap:wrap;gap:.25rem .9rem;font-size:.92rem;color:var(--muted)}
.state{display:inline-flex;align-items:center;gap:.4rem;color:var(--ink)}
.state::before{content:"";width:.55rem;height:.55rem;border-radius:50%;background:var(--grass);flex:none}
.state.wait::before{background:var(--amber)}
.state.off::before{background:transparent;box-shadow:inset 0 0 0 2px var(--line-strong)}
.robot details{grid-column:1/-1;margin-top:.6rem;border-top:1px solid var(--line);padding-top:.6rem}
.robot summary{cursor:pointer;color:var(--muted);font-size:.92rem;width:max-content;padding:.2rem 0}
.robot summary:hover{color:var(--ink)}
.manage{display:grid;gap:1rem;margin-top:.75rem}
.manage p{font-size:.92rem;color:var(--muted);margin:.35rem 0 0}
.manage code{display:block;color:var(--muted);font-size:.85rem}
.panel{background:var(--fog);border:1px solid var(--line);border-radius:12px;padding:1.25rem 1.1rem}
label{display:block;font-weight:600;margin:0 0 .35rem}
.fields{display:grid;gap:.9rem}
@media (min-width:40rem){.fields{grid-template-columns:minmax(0,1.3fr) minmax(0,1fr) auto;align-items:end}}
input[type=text]{width:100%;font:inherit;padding:.65rem .75rem;border:1px solid var(--line-strong);border-radius:8px;background:var(--paper);color:inherit}
input[type=text]:focus-visible{outline-offset:1px}
input.code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:1.05rem;letter-spacing:.01em}
.hint{margin:.9rem 0 0;font-size:.92rem}
button,.btn{font:inherit;font-weight:600;padding:.6rem 1.1rem;border:1px solid var(--line-strong);border-radius:8px;background:var(--paper);color:inherit;cursor:pointer;text-decoration:none;display:inline-block;text-align:center;white-space:nowrap;min-height:44px}
button:hover,.btn:hover{background:var(--fog)}
button.primary,.btn.primary{background:var(--grass);border-color:var(--grass);color:var(--on-grass)}
button.primary:hover,.btn.primary:hover{background:var(--grass-deep);border-color:var(--grass-deep)}
button.danger{color:var(--danger);border-color:var(--danger)}
button.danger:hover{background:var(--danger-wash)}
form.inline{display:inline}
.notice,.error{border-radius:10px;padding:.8rem 1rem;margin:0 0 1.5rem;background:var(--grass-wash);color:var(--grass-ink);border:1px solid transparent}
.error{background:var(--danger-wash);color:var(--danger);border-color:var(--danger)}
.hero{padding:2.5rem 0 1rem}
.hero h1{font-size:2.2rem;max-width:16ch}
.hero p{font-size:1.1rem;max-width:40ch}
.hero .lead{color:var(--muted)}
.hero .actions{margin:1.5rem 0 1rem}
.standby{padding:1.5rem 0 1rem}
.lawn{display:block;width:132px;height:76px;margin:0 0 1.5rem}
.lawn-bed{fill:var(--lawn)}
.lawn-cut{fill:none;stroke:var(--grass-wash);stroke-width:14;stroke-linejoin:round}
.lawn-line{fill:none;stroke:var(--grass);stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
.lawn-mower{fill:var(--grass);offset-path:path("M0 0h104v16H0v16h104v16H48");offset-rotate:0deg;offset-distance:100%}
.lawn .lawn-cut,.lawn .lawn-line{stroke-dasharray:416}
@media (prefers-reduced-motion:no-preference){.lawn:not(.parked) .lawn-cut,.lawn:not(.parked) .lawn-line{animation:lawn 4.5s linear infinite both}.lawn:not(.parked) .lawn-mower{animation:mower 4.5s linear infinite both}}
@keyframes lawn{0%{stroke-dashoffset:416;opacity:1}80%,90%{stroke-dashoffset:0;opacity:1}100%{stroke-dashoffset:0;opacity:0}}
@keyframes mower{0%{offset-distance:0%}80%,100%{offset-distance:100%}}
.lawn.parked .lawn-line,.lawn.parked .lawn-mower{stroke:var(--line-strong);fill:var(--line-strong)}
.lawn.parked .lawn-line{fill:none}
.lawn.parked .lawn-cut{stroke:var(--fog)}
.lawn.parked .lawn-bed{fill:var(--line)}
@supports not (offset-path:path("M0 0")){.lawn-mower{display:none}}
.visually-hidden{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}
.account{margin-left:auto;display:flex;align-items:center;gap:.55rem;font-size:.93rem;min-width:0}
.avatar{display:inline-grid;place-items:center;width:30px;height:30px;border-radius:50%;background:var(--grass-wash);color:var(--grass-ink);font-weight:700;font-size:.9rem;flex:none}
.who-name{font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:12rem}
.account form{display:flex}
button.link{border:0;background:none;min-height:40px;padding:.4rem .5rem;color:var(--muted);font-weight:500;text-decoration:underline;text-underline-offset:.2em;text-decoration-color:var(--line-strong)}
button.link:hover{background:none;color:var(--ink);text-decoration-color:currentColor}
.bar>.btn.small{margin-left:auto}
.btn.small{min-height:38px;padding:.4rem .9rem;font-size:.93rem}
@media (max-width:30rem){.tag{display:none}.who-name{max-width:7rem}}
.gh{display:inline-flex;align-items:center;gap:.6rem}
.gh svg{width:20px;height:20px;fill:currentColor;flex:none}
.landing{display:grid;gap:2rem;padding:2rem 0 1rem}
.landing h1{font-size:clamp(2rem,1.5rem + 2.4vw,2.7rem);line-height:1.08;max-width:14ch;margin-bottom:1rem}
.landing .lead{font-size:1.12rem;color:var(--muted);max-width:40ch}
.landing .actions{margin:1.75rem 0 1.25rem}
.facts{list-style:none;margin:0;padding:1.1rem 0 0;border-top:1px solid var(--line);display:grid;gap:.5rem;color:var(--muted);font-size:.95rem}
.facts li{position:relative;padding-left:1.6rem}
.facts li::before{content:"";position:absolute;left:.15rem;top:.5em;width:.7rem;height:.4rem;border:solid var(--grass);border-width:0 0 2px 2px;transform:rotate(-45deg)}
.big-mark{width:72px;height:72px}
.big-mark .mark-path{stroke-dasharray:60;stroke-dashoffset:0}
.big-mark .mark-robot{transform-origin:22.7px 22.5px}
@media (prefers-reduced-motion:no-preference){.big-mark .mark-path{animation:mark-draw 1.4s cubic-bezier(.4,0,.2,1) .15s both}.big-mark .mark-robot{animation:pop .4s ease-out 1.45s both}}
@keyframes mark-draw{from{stroke-dashoffset:60}}
@keyframes pop{from{transform:scale(0)}60%{transform:scale(1.25)}}
.admin-link{color:var(--muted);text-decoration:none;font-weight:600;padding:.35rem .6rem;border-radius:8px;margin-right:.25rem}
.admin-link:hover{background:var(--fog);color:var(--ink)}
.count{display:inline-grid;place-items:center;min-width:1.6rem;height:1.6rem;padding:0 .4rem;margin-left:.35rem;border-radius:999px;background:var(--grass-wash);color:var(--grass-ink);font-size:.85rem;vertical-align:.15em}
.people{list-style:none;margin:0;padding:0;display:grid;gap:.6rem}
.person{background:var(--fog);border:1px solid var(--line);border-radius:12px;padding:.9rem 1rem;display:grid;grid-template-columns:auto minmax(0,1fr);gap:.2rem .85rem;align-items:center}
.person-main{display:grid;gap:.15rem;min-width:0}
.person-name{font-weight:650;overflow-wrap:anywhere}
.person .meta{display:flex;flex-wrap:wrap;gap:.2rem .9rem;font-size:.9rem;color:var(--muted)}
.person .full{color:var(--amber);font-weight:600}
.person details{grid-column:1/-1;margin-top:.5rem;border-top:1px solid var(--line);padding-top:.5rem}
.person summary{cursor:pointer;color:var(--muted);font-size:.92rem;width:max-content;padding:.2rem 0}
.inline-fields{display:flex;gap:.5rem;align-items:center;flex-wrap:wrap}
input[type=number]{width:9rem;font:inherit;padding:.6rem .7rem;border:1px solid var(--line-strong);border-radius:8px;background:var(--paper);color:inherit}
@media (min-width:40rem){.fields.fields-2{grid-template-columns:minmax(0,1fr) auto}}
.invitee{display:flex;gap:1rem;align-items:center;margin:1rem 0 1.25rem}
.invitee>div{display:grid;gap:.1rem}
.avatar.big{width:52px;height:52px;font-size:1.3rem}
.address{display:grid;gap:.2rem;margin:0 0 1.25rem;padding:1rem 1.1rem;border-radius:12px;border:1px solid var(--line);background:var(--paper)}
.address strong{font:600 1.05rem ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;color:var(--grass-ink);overflow-wrap:anywhere}
.address span{font-size:.92rem;color:var(--muted)}
.quota{font-size:.92rem;color:var(--muted);margin:-.4rem 0 .75rem}
.panel+p{margin-top:1rem}
.empty{display:grid;gap:.25rem}
.empty strong{color:var(--ink)}
.actions{display:flex;flex-wrap:wrap;gap:.6rem}
.empty{border:1px dashed var(--line-strong);border-radius:12px;padding:1.25rem 1.1rem;color:var(--muted)}
`;

// Formats the pairing-code field while typing: lower case, any run of other characters becomes
// one dash, at most three words. The server accepts any spelling anyway; this only helps.
export const PAIR_JS = `(() => {
  const el = document.getElementById("code");
  if (!el) return;
  el.addEventListener("input", () => {
    const atEnd = el.selectionStart === el.value.length;
    let v = el.value.toLowerCase().replace(/[^a-z]+/g, "-").replace(/^-/, "");
    const words = v.split("-");
    if (words.length > 3) v = words.slice(0, 3).join("-");
    if (v !== el.value) {
      el.value = v;
      if (atEnd) el.setSelectionRange(v.length, v.length);
    }
  });
})();
`;
