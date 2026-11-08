package gateway

import (
	"net/http"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

const (
	wsPingInterval = 25 * time.Second // Cloudflare closes idle WebSockets after ~100 s
	wsReadTimeout  = 70 * time.Second
	wsWriteTimeout = 10 * time.Second
	wsMaxMessage   = 64 << 20
	wsAuthRecheck  = 5 * time.Second // bound on how long an open socket outlives its authorization
)

// Headers gorilla sets itself on the upstream handshake.
var wsHopHeaders = map[string]bool{
	"Upgrade": true, "Connection": true, "Sec-Websocket-Key": true, "Sec-Websocket-Version": true,
	"Sec-Websocket-Extensions": true, "Sec-Websocket-Protocol": true,
}

// proxyWebSocket relays frames between the browser and upstream. Unlike a raw byte copy, it
// pings the browser so quiet sockets survive Cloudflare's idle timeout, can compress and
// throttle the downstream leg (see wsopt.go), and closes the socket when the session ends.
func (g *Gateway) proxyWebSocket(w http.ResponseWriter, r *http.Request, sess *session) {
	target := *g.cfg.Upstream
	target.Scheme = map[string]string{"https": "wss"}[target.Scheme]
	if target.Scheme == "" {
		target.Scheme = "ws"
	}
	q := r.URL.Query()
	compress := g.cfg.WSCompression && q.Get(wsCompressParam) == "1"
	rawQuery := r.URL.RawQuery
	if q.Has(wsCompressParam) {
		q.Del(wsCompressParam)
		rawQuery = q.Encode()
	}
	target.Path, target.RawPath, target.RawQuery = r.URL.Path, r.URL.RawPath, rawQuery

	hdr := http.Header{}
	for k, vs := range r.Header {
		if !wsHopHeaders[http.CanonicalHeaderKey(k)] {
			hdr[k] = vs
		}
	}
	hdr.Set("Host", r.Host) // gorilla uses this as the request Host; the GUI compares it with Origin
	setForwarded(hdr, r)

	dialer := websocket.Dialer{
		HandshakeTimeout: 10 * time.Second,
		Subprotocols:     websocket.Subprotocols(r),
	}
	upConn, upResp, err := dialer.DialContext(r.Context(), target.String(), hdr)
	if err != nil {
		status := http.StatusBadGateway
		if upResp != nil && upResp.StatusCode >= 400 {
			status = upResp.StatusCode
		}
		g.cfg.Logger.Warn("upstream websocket dial failed", "path", r.URL.Path, "err", err)
		writeJSON(w, status, map[string]string{"error": "upstream_websocket_failed"})
		return
	}
	defer upConn.Close()

	respHdr := http.Header{}
	if p := upConn.Subprotocol(); p != "" {
		respHdr.Set("Sec-WebSocket-Protocol", p)
	}
	upgrader := websocket.Upgrader{
		HandshakeTimeout: 10 * time.Second,
		CheckOrigin:      func(*http.Request) bool { return true }, // checked by ServeHTTP
	}
	client, err := upgrader.Upgrade(w, r, respHdr)
	if err != nil {
		return // Upgrade already replied
	}
	defer client.Close()
	client.SetReadLimit(wsMaxMessage)
	upConn.SetReadLimit(wsMaxMessage)
	_ = client.SetReadDeadline(time.Now().Add(wsReadTimeout))
	client.SetPongHandler(func(string) error { return client.SetReadDeadline(time.Now().Add(wsReadTimeout)) })

	done := make(chan struct{})
	var once sync.Once
	finish := func() { once.Do(func() { close(done) }) }

	// Each conn has exactly one writer goroutine for data frames; pings use WriteControl,
	// which gorilla allows concurrently.
	go func() {
		defer finish()
		pump(client, upConn, func() { _ = client.SetReadDeadline(time.Now().Add(wsReadTimeout)) })
	}()
	go func() {
		defer finish()
		relayDown(upConn, newWSOut(client, compress), g.throttleFor(r.URL.Path))
	}()

	ping := time.NewTicker(wsPingInterval)
	defer ping.Stop()
	auth := time.NewTicker(wsAuthRecheck)
	defer auth.Stop()
	for {
		select {
		case <-done:
			return
		case <-r.Context().Done():
			return
		case <-ping.C:
			if err := client.WriteControl(websocket.PingMessage, nil, time.Now().Add(wsWriteTimeout)); err != nil {
				return
			}
		case <-auth.C:
			if !g.socketAllowed(sess, r.Method, r.URL.Path) {
				msg := websocket.FormatCloseMessage(websocket.ClosePolicyViolation, "session ended")
				_ = client.WriteControl(websocket.CloseMessage, msg, time.Now().Add(wsWriteTimeout))
				return
			}
		}
	}
}

// pump copies messages from src to dst until either side fails, forwarding close frames.
func pump(src, dst *websocket.Conn, onRead func()) {
	for {
		typ, data, err := src.ReadMessage()
		if err != nil {
			forwardClose(dst, err)
			return
		}
		if onRead != nil {
			onRead()
		}
		_ = dst.SetWriteDeadline(time.Now().Add(wsWriteTimeout))
		if err := dst.WriteMessage(typ, data); err != nil {
			return
		}
	}
}

func (g *Gateway) throttleFor(path string) map[string]time.Duration {
	if path != g.cfg.ThrottlePath {
		return nil
	}
	return g.cfg.Throttle
}
