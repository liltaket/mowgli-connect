// wsmeter measures one GUI multiplex WebSocket connection.
package main

import (
	"bytes"
	"compress/flate"
	"context"
	"crypto/tls"
	"flag"
	"fmt"
	"github.com/gorilla/websocket"
	"github.com/vmihailenco/msgpack/v5"
	"io"
	"log"
	"math"
	"net"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"sync/atomic"
	"time"
)

type counted struct {
	net.Conn
	read    atomic.Uint64
	written atomic.Uint64
}

func (c *counted) Read(p []byte) (int, error) {
	n, e := c.Conn.Read(p)
	c.read.Add(uint64(n))
	return n, e
}
func (c *counted) Write(p []byte) (int, error) {
	n, e := c.Conn.Write(p)
	c.written.Add(uint64(n))
	return n, e
}

type stats struct {
	count, bytes, max int
	last              time.Time
	sum, sq           float64
	intervals         int
	// -analyze: what per-message deflate would send, and deflate of the XOR with the previous
	// frame of the same topic (a delta encoding) when the sizes match.
	fast, best, delta int
	prev              []byte
}

func deflated(b []byte, level int) int {
	var buf bytes.Buffer
	w, _ := flate.NewWriter(&buf, level)
	w.Write(b)
	w.Close()
	return buf.Len()
}

func main() {
	target := flag.String("url", "ws://127.0.0.1:4006/api/mowglinext/multiplex", "GUI WS or HTTP(S) URL")
	host := flag.String("host", "", "Host header override")
	origin := flag.String("origin", "", "Origin header")
	cookie := flag.String("cookie", "", "Cookie header")
	set := flag.String("set", "dashboard", "dashboard or map")
	topics := flag.String("topics", "", "comma-separated topic override")
	duration := flag.Duration("duration", 20*time.Second, "measurement window")
	compress := flag.Bool("compression", false, "request permessage-deflate")
	mcz := flag.Bool("mcz", false, "ask a Mowgli Connect agent for compressed messages (1-byte header + optional deflate-raw)")
	analyze := flag.Bool("analyze", false, "report what per-message deflate and delta+deflate would send")
	flag.Parse()
	if *duration <= 0 {
		log.Fatal("duration must be positive")
	}
	u, e := url.Parse(*target)
	if e != nil {
		log.Fatal(e)
	}
	switch u.Scheme {
	case "http":
		u.Scheme = "ws"
	case "https":
		u.Scheme = "wss"
	case "ws", "wss":
	default:
		log.Fatal("expected http(s) or ws(s) URL")
	}
	if u.Path == "" || u.Path == "/" {
		u.Path = "/api/mowglinext/multiplex"
	}
	sets := map[string]string{"dashboard": "status,highLevelStatus,power,emergency,mowProgress,coverageSession,gnssStatus,fusionRaw,map", "map": "pose,map,path,plan,lidar,obstacles,mowProgress,lidarMap,status,highLevelStatus"}
	if *topics == "" {
		*topics = sets[*set]
		if *topics == "" {
			log.Fatal("unknown set")
		}
	}
	names := strings.Split(*topics, ",")
	if *mcz {
		q := u.Query()
		q.Set("__mcz", "1")
		u.RawQuery = q.Encode()
	}
	var wire *counted
	d := websocket.Dialer{EnableCompression: *compress, HandshakeTimeout: 10 * time.Second, NetDialContext: func(ctx context.Context, network, addr string) (net.Conn, error) {
		c, e := (&net.Dialer{}).DialContext(ctx, network, addr)
		if e == nil {
			wire = &counted{Conn: c}
			return wire, nil
		}
		return nil, e
	}, TLSClientConfig: &tls.Config{MinVersion: tls.VersionTLS12}}
	h := http.Header{}
	if *host != "" {
		h.Set("Host", *host)
	}
	if *origin != "" {
		h.Set("Origin", *origin)
	}
	if *cookie != "" {
		h.Set("Cookie", *cookie)
	}
	c, resp, e := d.Dial(u.String(), h)
	if e != nil {
		if resp != nil {
			log.Fatalf("dial: %v (HTTP %s)", e, resp.Status)
		}
		log.Fatal(e)
	}
	defer c.Close()
	fmt.Printf("set=%s window=%s compression_requested=%t negotiated=%q\n", *set, *duration, *compress, resp.Header.Get("Sec-WebSocket-Extensions"))
	st := map[string]*stats{}
	for _, name := range names {
		name = strings.TrimSpace(name)
		if name == "" {
			continue
		}
		st[name] = &stats{}
		if e = c.WriteJSON(map[string]string{"op": "subscribe", "topic": name}); e != nil {
			log.Fatal(e)
		}
	}
	var cpu time.Duration
	start := time.Now()
	before := wire.read.Load()
	end := start.Add(*duration)
	_ = c.SetReadDeadline(end)
	for {
		typ, b, e := c.ReadMessage()
		if e != nil {
			if ne, ok := e.(net.Error); ok && ne.Timeout() {
				break
			}
			if e == io.EOF {
				break
			}
			log.Fatalf("read: %v", e)
		}
		if typ != websocket.BinaryMessage {
			continue
		}
		if *mcz {
			if len(b) == 0 {
				log.Fatal("empty framed message")
			}
			flag := b[0]
			b = b[1:]
			if flag&2 != 0 {
				if b, e = io.ReadAll(flate.NewReader(bytes.NewReader(b))); e != nil {
					log.Fatal(e)
				}
			}
			if flag&1 != 0 {
				continue
			}
		}
		dec := msgpack.NewDecoder(bytes.NewReader(b))
		n, e := dec.DecodeMapLen()
		if e != nil {
			log.Fatal(e)
		}
		topic := ""
		for i := 0; i < n; i++ {
			k, e := dec.DecodeString()
			if e != nil {
				log.Fatal(e)
			}
			if k == "topic" {
				topic, e = dec.DecodeString()
			} else {
				e = dec.Skip()
			}
			if e != nil {
				log.Fatal(e)
			}
		}
		s := st[topic]
		if s == nil {
			continue
		}
		now := time.Now()
		if !s.last.IsZero() {
			v := now.Sub(s.last).Seconds() * 1000
			s.sum += v
			s.sq += v * v
			s.intervals++
		}
		s.last = now
		s.count++
		s.bytes += len(b)
		if *analyze {
			t0 := time.Now()
			f := deflated(b, flate.BestSpeed)
			cpu += time.Since(t0)
			s.fast += f
			s.best += deflated(b, flate.DefaultCompression)
			d := f
			if len(s.prev) == len(b) {
				x := make([]byte, len(b))
				for i := range b {
					x[i] = b[i] ^ s.prev[i]
				}
				d = min(f, deflated(x, flate.BestSpeed))
			}
			s.delta += d
			s.prev = append(s.prev[:0], b...)
		}
		if len(b) > s.max {
			s.max = len(b)
		}
	}
	elapsed := time.Since(start).Seconds()
	sort.Strings(names)
	fmt.Println("topic messages msg/s payload_B/s max_frame_B jitter_stddev_ms")
	total := 0
	for _, name := range names {
		s := st[name]
		if s == nil {
			continue
		}
		j := 0.
		if s.intervals > 0 {
			mean := s.sum / float64(s.intervals)
			j = math.Sqrt(math.Max(0, s.sq/float64(s.intervals)-mean*mean))
		}
		fmt.Printf("%s %d %.2f %.0f %d %.2f\n", name, s.count, float64(s.count)/elapsed, float64(s.bytes)/elapsed, s.max, j)
		total += s.bytes
	}
	if *analyze {
		fmt.Println("topic raw_B/s deflate_fast_B/s deflate_default_B/s delta+deflate_B/s")
		var r, f, b, d int
		for _, name := range names {
			if s := st[name]; s != nil && s.count > 0 {
				fmt.Printf("%s %.0f %.0f %.0f %.0f\n", name, float64(s.bytes)/elapsed, float64(s.fast)/elapsed, float64(s.best)/elapsed, float64(s.delta)/elapsed)
				r, f, b, d = r+s.bytes, f+s.fast, b+s.best, d+s.delta
			}
		}
		fmt.Printf("ANALYZE raw=%.0f fast=%.0f (%.1fx) default=%.0f (%.1fx) delta=%.0f (%.1fx) B/s; deflate_fast CPU %.1f ms/s on this machine\n",
			float64(r)/elapsed, float64(f)/elapsed, float64(r)/float64(max(f, 1)), float64(b)/elapsed, float64(r)/float64(max(b, 1)),
			float64(d)/elapsed, float64(r)/float64(max(d, 1)), float64(cpu.Milliseconds())/elapsed)
	}
	fmt.Printf("TOTAL payload_B/s=%.0f wire_read_B/s=%.0f wire_read_B=%d elapsed=%.3f (wire includes websocket framing; TLS records when wss)\n", float64(total)/elapsed, float64(wire.read.Load()-before)/elapsed, wire.read.Load()-before, elapsed)
}
