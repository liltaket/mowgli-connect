// Theme toggle, install tabs and copy buttons for the project site. No dependencies.
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

  // Install tabs: without JavaScript both ways are shown one after the other.
  var tablist = document.querySelector("[role=tablist]");
  if (tablist) {
    var tabs = Array.prototype.slice.call(tablist.querySelectorAll("[role=tab]"));
    function select(tab, focus) {
      tabs.forEach(function (t) {
        var on = t === tab;
        t.setAttribute("aria-selected", on ? "true" : "false");
        t.tabIndex = on ? 0 : -1;
        document.getElementById(t.getAttribute("aria-controls")).hidden = !on;
      });
      if (focus) tab.focus();
    }
    tabs.forEach(function (t, i) {
      t.addEventListener("click", function () { select(t, false); });
      t.addEventListener("keydown", function (e) {
        var j = e.key === "ArrowRight" ? i + 1 : e.key === "ArrowLeft" ? i - 1 : e.key === "Home" ? 0 : e.key === "End" ? tabs.length - 1 : null;
        if (j === null) return;
        e.preventDefault();
        select(tabs[(j + tabs.length) % tabs.length], true);
      });
    });
    root.classList.add("has-tabs");
    tablist.hidden = false;
    select(location.hash === "#agent" ? tabs[1] : tabs[0], false);
    window.addEventListener("hashchange", function () {
      if (location.hash === "#agent") select(tabs[1], false);
    });
  }

  // Copy buttons: data-copy names the element whose text is copied.
  Array.prototype.forEach.call(document.querySelectorAll("[data-copy]"), function (btn) {
    var code = document.getElementById(btn.getAttribute("data-copy"));
    var out = btn.parentNode.querySelector(".copy-status");
    if (!code || !out) return;
    var timer;
    function say(t) {
      out.textContent = t;
      btn.classList.toggle("done", t === "Copied.");
      clearTimeout(timer);
      timer = setTimeout(function () { out.textContent = ""; btn.classList.remove("done"); }, 3000);
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
  });
})();
