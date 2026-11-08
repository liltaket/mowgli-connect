// Theme toggle and copy button for the project site. No dependencies.
(function () {
  var root = document.documentElement;
  var KEY = "mowgli-connect-theme";

  function stored() {
    try { return localStorage.getItem(KEY); } catch (e) { return null; }
  }
  function store(v) {
    try {
      if (v) localStorage.setItem(KEY, v); else localStorage.removeItem(KEY);
    } catch (e) {}
  }
  function systemDark() {
    return window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
  }
  function current() {
    var t = root.getAttribute("data-theme");
    if (t === "dark" || t === "light") return t;
    return systemDark() ? "dark" : "light";
  }

  var toggle = document.getElementById("theme-toggle");
  if (toggle) {
    function label() {
      var next = current() === "dark" ? "light" : "dark";
      toggle.setAttribute("aria-label", "Switch to " + next + " theme");
      toggle.setAttribute("title", "Switch to " + next + " theme");
    }
    toggle.hidden = false;
    label();
    toggle.addEventListener("click", function () {
      var next = current() === "dark" ? "light" : "dark";
      root.setAttribute("data-theme", next);
      // Back on the system default: forget the choice so the OS setting wins again.
      store(next === (systemDark() ? "dark" : "light") ? null : next);
      label();
    });
    if (window.matchMedia) {
      window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", function () {
        if (!stored()) { root.removeAttribute("data-theme"); label(); }
      });
    }
  }

  var btn = document.getElementById("copy");
  var code = document.getElementById("cmd");
  var out = document.getElementById("copy-status");
  if (!btn || !code || !out) return;
  var timer;
  function say(t) {
    out.textContent = t;
    clearTimeout(timer);
    timer = setTimeout(function () { out.textContent = ""; }, 3000);
  }
  function fallback() {
    var r = document.createRange();
    r.selectNodeContents(code);
    var sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(r);
    var ok = false;
    try { ok = document.execCommand("copy"); } catch (e) {}
    say(ok ? "Copied." : "Selected. Press Ctrl+C to copy.");
  }
  btn.addEventListener("click", function () {
    var text = code.textContent.trim();
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(text).then(function () { say("Copied."); }, fallback);
    } else {
      fallback();
    }
  });
})();
