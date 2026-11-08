package gateway

import (
	"bytes"
	"compress/flate"
	"encoding/binary"
	"errors"
	"time"

	"github.com/gorilla/websocket"
)

// Cloudflare does not negotiate permessage-deflate end to end, so compression happens at the
// application layer instead: the agent injects /_connect/ws.js into HTML pages, the script adds
// wsCompressParam to same-origin WebSocket URLs, and the agent then sends every downstream
// message as a binary frame with a one-byte header (wsFlag*) followed by the raw or
// deflate-raw payload. The script restores the original text or binary message before the app
// sees it. Clients without the script get the original frames.
const (
	wsCompressParam = "__mcz"
	wsCompressMin   = 256 // smaller messages are not worth compressing

	wsFlagText    = 1 // payload was a text message (else binary)
	wsFlagDeflate = 2 // payload is deflate-raw compressed
)

type frame struct {
	typ  int
	data []byte
}

// wsOut writes downstream messages to the browser, optionally in the compressed framing.
type wsOut struct {
	conn     *websocket.Conn
	compress bool
	fw       *flate.Writer
	buf      bytes.Buffer
}

func newWSOut(conn *websocket.Conn, compress bool) *wsOut {
	o := &wsOut{conn: conn, compress: compress}
	if compress {
		o.fw, _ = flate.NewWriter(nil, flate.BestSpeed)
	}
	return o
}

func (o *wsOut) send(f frame) error {
	_ = o.conn.SetWriteDeadline(time.Now().Add(wsWriteTimeout))
	if !o.compress {
		return o.conn.WriteMessage(f.typ, f.data)
	}
	flag := byte(0)
	if f.typ == websocket.TextMessage {
		flag = wsFlagText
	}
	payload := f.data
	if len(f.data) >= wsCompressMin {
		o.buf.Reset()
		o.fw.Reset(&o.buf)
		_, _ = o.fw.Write(f.data)
		if o.fw.Close() == nil && o.buf.Len() < len(f.data) {
			flag |= wsFlagDeflate
			payload = o.buf.Bytes()
		}
	}
	w, err := o.conn.NextWriter(websocket.BinaryMessage)
	if err != nil {
		return err
	}
	if _, err := w.Write([]byte{flag}); err != nil {
		return err
	}
	if _, err := w.Write(payload); err != nil {
		return err
	}
	return w.Close()
}

// relayDown copies upstream messages to the browser. Messages of a throttled topic (full
// snapshots such as occupancy grids) are sent at most once per interval: a message that
// arrives too early is held back and replaced by newer ones, and the latest is sent when the
// interval has passed, so the browser always ends up with the current state.
func relayDown(src *websocket.Conn, out *wsOut, throttle map[string]time.Duration) {
	msgs := make(chan frame)
	quit := make(chan struct{})
	defer close(quit)
	var readErr error
	go func() {
		defer close(msgs)
		for {
			typ, data, err := src.ReadMessage()
			if err != nil {
				readErr = err
				return
			}
			select {
			case msgs <- frame{typ, data}:
			case <-quit:
				return
			}
		}
	}()

	pending := map[string]frame{}
	next := map[string]time.Time{}
	for {
		var timer <-chan time.Time
		if len(pending) > 0 {
			var due time.Time
			for t := range pending {
				if due.IsZero() || next[t].Before(due) {
					due = next[t]
				}
			}
			timer = time.After(time.Until(due))
		}
		select {
		case f, ok := <-msgs:
			if !ok {
				forwardClose(out.conn, readErr)
				return
			}
			topic := ""
			if len(throttle) > 0 && f.typ == websocket.BinaryMessage {
				topic, _ = msgpackTopic(f.data)
			}
			iv, limited := throttle[topic]
			if !limited {
				if out.send(f) != nil {
					return
				}
				continue
			}
			if _, held := pending[topic]; held || time.Now().Before(next[topic]) {
				pending[topic] = f
				continue
			}
			next[topic] = time.Now().Add(iv)
			if out.send(f) != nil {
				return
			}
		case now := <-timer:
			for t, f := range pending {
				if now.Before(next[t]) {
					continue
				}
				delete(pending, t)
				next[t] = now.Add(throttle[t])
				if out.send(f) != nil {
					return
				}
			}
		}
	}
}

// forwardClose sends dst the close frame matching how the other side went away.
func forwardClose(dst *websocket.Conn, err error) {
	code, text := websocket.CloseGoingAway, ""
	var ce *websocket.CloseError
	if errors.As(err, &ce) {
		code, text = ce.Code, ce.Text
		switch code { // reserved codes that must not be sent on the wire
		case websocket.CloseNoStatusReceived, websocket.CloseAbnormalClosure, websocket.CloseTLSHandshake:
			code = websocket.CloseNormalClosure
		}
	}
	_ = dst.WriteControl(websocket.CloseMessage, websocket.FormatCloseMessage(code, text), time.Now().Add(wsWriteTimeout))
}

// msgpackTopic returns the "topic" string of a MessagePack map such as the GUI's multiplex
// frames {topic, data}. Key order is not fixed, so other values are skipped without decoding.
func msgpackTopic(b []byte) (string, bool) {
	n, p, ok := mpMapLen(b, 0)
	if !ok {
		return "", false
	}
	for i := 0; i < n; i++ {
		key, q, isStr := mpStr(b, p)
		if !isStr {
			return "", false
		}
		if key == "topic" {
			v, _, isStr := mpStr(b, q)
			return v, isStr
		}
		if p, ok = mpSkip(b, q); !ok {
			return "", false
		}
	}
	return "", false
}

func mpMapLen(b []byte, p int) (int, int, bool) {
	if p >= len(b) {
		return 0, 0, false
	}
	switch c := b[p]; {
	case c&0xf0 == 0x80:
		return int(c & 0x0f), p + 1, true
	case c == 0xde && p+3 <= len(b):
		return int(binary.BigEndian.Uint16(b[p+1:])), p + 3, true
	case c == 0xdf && p+5 <= len(b):
		return int(binary.BigEndian.Uint32(b[p+1:])), p + 5, true
	}
	return 0, 0, false
}

func mpStr(b []byte, p int) (string, int, bool) {
	if p >= len(b) {
		return "", 0, false
	}
	var n, h int
	switch c := b[p]; {
	case c&0xe0 == 0xa0:
		n, h = int(c&0x1f), 1
	case c == 0xd9 && p+2 <= len(b):
		n, h = int(b[p+1]), 2
	case c == 0xda && p+3 <= len(b):
		n, h = int(binary.BigEndian.Uint16(b[p+1:])), 3
	case c == 0xdb && p+5 <= len(b):
		n, h = int(binary.BigEndian.Uint32(b[p+1:])), 5
	default:
		return "", 0, false
	}
	if n < 0 || p+h+n > len(b) {
		return "", 0, false
	}
	return string(b[p+h : p+h+n]), p + h + n, true
}

// mpSkip returns the offset just past the MessagePack value at p, without recursion.
func mpSkip(b []byte, p int) (int, bool) {
	for todo := 1; todo > 0; todo-- {
		if p >= len(b) {
			return 0, false
		}
		c := b[p]
		var size, items int // bytes after the type byte; nested values still to skip
		lenAt := func(w int) (int, bool) {
			if p+1+w > len(b) {
				return 0, false
			}
			switch w {
			case 1:
				return int(b[p+1]), true
			case 2:
				return int(binary.BigEndian.Uint16(b[p+1:])), true
			default:
				return int(binary.BigEndian.Uint32(b[p+1:])), true
			}
		}
		var n int
		ok := true
		switch {
		case c <= 0x7f || c >= 0xe0 || c == 0xc0 || c == 0xc2 || c == 0xc3:
		case c&0xf0 == 0x80:
			items = 2 * int(c&0x0f)
		case c&0xf0 == 0x90:
			items = int(c & 0x0f)
		case c&0xe0 == 0xa0:
			size = int(c & 0x1f)
		case c == 0xcc || c == 0xd0:
			size = 1
		case c == 0xcd || c == 0xd1:
			size = 2
		case c == 0xca || c == 0xce || c == 0xd2:
			size = 4
		case c == 0xcb || c == 0xcf || c == 0xd3:
			size = 8
		case c >= 0xd4 && c <= 0xd8: // fixext 1, 2, 4, 8, 16 plus the type byte
			size = 1 + 1<<(c-0xd4)
		case c == 0xc4 || c == 0xd9:
			n, ok = lenAt(1)
			size = 1 + n
		case c == 0xc5 || c == 0xda:
			n, ok = lenAt(2)
			size = 2 + n
		case c == 0xc6 || c == 0xdb:
			n, ok = lenAt(4)
			size = 4 + n
		case c == 0xc7:
			n, ok = lenAt(1)
			size = 2 + n
		case c == 0xc8:
			n, ok = lenAt(2)
			size = 3 + n
		case c == 0xc9:
			n, ok = lenAt(4)
			size = 5 + n
		case c == 0xdc:
			items, ok = lenAt(2)
			size = 2
		case c == 0xdd:
			items, ok = lenAt(4)
			size = 4
		case c == 0xde:
			items, ok = lenAt(2)
			items, size = 2*items, 2
		case c == 0xdf:
			items, ok = lenAt(4)
			items, size = 2*items, 4
		default: // 0xc1 is never used
			return 0, false
		}
		if !ok || size < 0 || items < 0 || items > len(b) || p+1+size > len(b) {
			return 0, false
		}
		p += 1 + size
		todo += items
	}
	return p, true
}
