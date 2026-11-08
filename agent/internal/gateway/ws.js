// Mowgli Connect: transparent WebSocket decompression (see wsopt.go for the framing).
// Same-origin sockets ask the agent for compressed messages; this wrapper restores each
// original text or binary message, in order, before the app's handlers see it.
(() => {
  "use strict";
  const Native = window.WebSocket;
  if (!Native || window.__mcWebSocket) return;
  try {
    new DecompressionStream("deflate-raw");
  } catch {
    return; // old browser: the agent sends uncompressed frames
  }
  const PARAM = "__mcz", TEXT = 1, DEFLATE = 2;
  const utf8 = new TextDecoder();
  const restored = new WeakSet();

  const inflate = (bytes) =>
    new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw"))).arrayBuffer();

  class MCWebSocket extends Native {
    constructor(url, protocols) {
      let u = null;
      try {
        u = new URL(url, location.href);
      } catch {}
      const mine = u && (u.protocol === "wss:" || u.protocol === "ws:") && u.host === location.host;
      if (mine) u.searchParams.set(PARAM, "1");
      if (protocols === undefined) super(mine ? u.href : url);
      else super(mine ? u.href : url, protocols);
      if (!mine) return;
      this.__mcUrl = String(url instanceof URL ? url.href : new URL(url, location.href).href);
      let queue = Promise.resolve();
      super.addEventListener("message", (ev) => {
        if (restored.has(ev)) return;
        ev.stopImmediatePropagation();
        const raw = ev.data;
        queue = queue
          .then(async () => {
            if (typeof raw === "string") return raw; // not framed (should not happen)
            const buf = raw instanceof Blob ? await raw.arrayBuffer() : raw;
            const flag = new Uint8Array(buf, 0, 1)[0];
            let body = flag & DEFLATE ? await inflate(new Uint8Array(buf, 1)) : buf.slice(1);
            if (flag & TEXT) return utf8.decode(body);
            return this.binaryType === "blob" ? new Blob([body]) : body;
          })
          .then((data) => {
            const out = new MessageEvent("message", { data, origin: ev.origin });
            restored.add(out);
            this.dispatchEvent(out);
          })
          .catch((err) => {
            console.warn("mowgli-connect: bad compressed frame", err);
            this.close(4000, "decode error");
          });
      });
    }
    get url() {
      return this.__mcUrl || super.url;
    }
  }
  window.__mcWebSocket = true;
  window.WebSocket = MCWebSocket;
})();
