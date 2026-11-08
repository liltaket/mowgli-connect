package gateway

import (
	"fmt"
	"net/http"
	"sort"
	"strings"
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
	var st wsStats
	out := newWSOut(client, compress)
	started := time.Now()
	var wg sync.WaitGroup
	wg.Add(2)
	go func() {
		defer wg.Done()
		defer finish()
		st.upBytes = pump(client, upConn, func() { _ = client.SetReadDeadline(time.Now().Add(wsReadTimeout)) })
	}()
	go func() {
		defer wg.Done()
		defer finish()
		relayDown(upConn, out, g.throttleFor(r.URL.Path), &st)
	}()
	defer func() {
		// Close both ends so the goroutines return, then report what the socket carried.
		client.Close()
		upConn.Close()
		wg.Wait()
		g.logSocket(r.URL.Path, time.Since(started), compress, out.sent, &st)
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

// pump copies messages from src to dst until either side fails, forwarding close frames. It
// returns the number of payload bytes copied.
func pump(src, dst *websocket.Conn, onRead func()) (n int64) {
	for {
		typ, data, err := src.ReadMessage()
		if err != nil {
			forwardClose(dst, err)
			return n
		}
		n += int64(len(data))
		if onRead != nil {
			onRead()
		}
		_ = dst.SetWriteDeadline(time.Now().Add(wsWriteTimeout))
		if err := dst.WriteMessage(typ, data); err != nil {
			return n
		}
	}
}

func (g *Gateway) throttleFor(path string) map[string]time.Duration {
	if path != g.cfg.ThrottlePath {
		return nil
	}
	return g.cfg.Throttle
}

// logSocket reports one closed socket: how long it was open, what the app sent and what went
// over the tunnel after compression and throttling, and the heaviest multiplex topics. Sockets
// shorter than a few seconds carrying little are not worth a line.
func (g *Gateway) logSocket(path string, d time.Duration, compressed bool, sent int64, st *wsStats) {
	if d < 5*time.Second && st.rawDown < 64<<10 {
		return
	}
	type tb struct {
		t string
		n int64
	}
	var top []tb
	for t, n := range st.topicRaw {
		top = append(top, tb{t, n})
	}
	sort.Slice(top, func(i, j int) bool { return top[i].n > top[j].n })
	var b strings.Builder
	for i, x := range top {
		if i == 5 {
			break
		}
		if i > 0 {
			b.WriteByte(',')
		}
		fmt.Fprintf(&b, "%s:%dk", x.t, x.n>>10)
	}
	secs := max(d.Seconds(), 1)
	g.cfg.Logger.Info("websocket closed", "path", path, "seconds", int(d.Seconds()), "compressed", compressed,
		"app_kB", st.rawDown>>10, "tunnel_kB", sent>>10, "tunnel_kBps", fmt.Sprintf("%.1f", float64(sent)/1024/secs),
		"up_kB", st.upBytes>>10, "frames", st.frames, "throttled", st.held, "top_app_kB", b.String())
}
