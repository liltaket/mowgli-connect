package gateway

import (
	"bytes"
	"compress/gzip"
	"io"
	"net/http"
	"regexp"
	"strconv"
	"strings"
)

const (
	maxInjectHTML = 4 << 20 // HTML pages larger than this are passed through untouched
	gzipMin       = 1024
)

var headTag = regexp.MustCompile(`(?i)<head(\s[^>]*)?>`)

const shimTag = `<script src="/_connect/ws.js"></script>`

// wantsHTML reports whether r is a page load whose HTML may get the WebSocket shim.
func wantsHTML(r *http.Request) bool {
	return r.Method == http.MethodGet && (r.Header.Get("Sec-Fetch-Dest") == "document" || strings.Contains(r.Header.Get("Accept"), "text/html"))
}

// privateCache stops Cloudflare's edge from caching anything behind the gateway (it caches
// .js and similar by extension when the origin allows it), which would serve authenticated
// content to anyone without passing the gateway. Browsers may still cache.
func privateCache(h http.Header) {
	cc := strings.ToLower(h.Get("Cache-Control"))
	if strings.Contains(cc, "private") || strings.Contains(cc, "no-store") {
		return
	}
	var keep []string
	for _, d := range strings.Split(h.Get("Cache-Control"), ",") {
		d = strings.TrimSpace(d)
		l := strings.ToLower(d)
		if d == "" || l == "public" || strings.HasPrefix(l, "s-maxage") {
			continue
		}
		keep = append(keep, d)
	}
	h.Set("Cache-Control", strings.Join(append([]string{"private"}, keep...), ", "))
}

// injectShim adds the WebSocket decompression script to an uncompressed HTML response.
func injectShim(resp *http.Response) error {
	if resp.StatusCode != http.StatusOK || resp.Header.Get("Content-Encoding") != "" ||
		!strings.HasPrefix(resp.Header.Get("Content-Type"), "text/html") {
		return nil
	}
	if resp.ContentLength > maxInjectHTML {
		return nil
	}
	orig := resp.Body
	body, err := io.ReadAll(io.LimitReader(orig, maxInjectHTML+1))
	if err != nil {
		orig.Close()
		return err
	}
	if len(body) > maxInjectHTML {
		// Too large to rewrite: send the buffered prefix and then the rest, unchanged.
		resp.Body = struct {
			io.Reader
			io.Closer
		}{io.MultiReader(bytes.NewReader(body), orig), orig}
		return nil
	}
	orig.Close()
	if loc := headTag.FindIndex(body); loc != nil {
		body = append(body[:loc[1]:loc[1]], append([]byte(shimTag), body[loc[1]:]...)...)
	}
	resp.Body = io.NopCloser(bytes.NewReader(body))
	resp.ContentLength = int64(len(body))
	resp.Header.Set("Content-Length", strconv.Itoa(len(body)))
	return nil
}

func compressible(contentType string) bool {
	ct := strings.ToLower(strings.TrimSpace(strings.Split(contentType, ";")[0]))
	switch {
	case ct == "text/event-stream": // streamed; gzip buffering would delay events
		return false
	case strings.HasPrefix(ct, "text/"), strings.HasSuffix(ct, "+json"), strings.HasSuffix(ct, "+xml"),
		ct == "application/json", ct == "application/javascript", ct == "application/xml",
		ct == "application/yaml", ct == "application/x-yaml", ct == "image/svg+xml":
		return true
	}
	return false
}

// gzipResponse compresses text responses the app sends uncompressed (its API JSON), so they
// take less of the robot's uplink. Cloudflare passes gzip on or recompresses for the browser.
func gzipResponse(resp *http.Response) {
	h := resp.Header
	if resp.Request == nil || !strings.Contains(resp.Request.Header.Get("Accept-Encoding"), "gzip") ||
		h.Get("Content-Encoding") != "" || resp.StatusCode == http.StatusNoContent || resp.StatusCode == http.StatusNotModified ||
		resp.Request.Method == http.MethodHead || (resp.ContentLength >= 0 && resp.ContentLength < gzipMin) ||
		!compressible(h.Get("Content-Type")) {
		return
	}
	src := resp.Body
	pr, pw := io.Pipe()
	go func() {
		zw, _ := gzip.NewWriterLevel(pw, gzip.DefaultCompression)
		_, err := io.Copy(zw, src)
		if err == nil {
			err = zw.Close()
		}
		src.Close()
		pw.CloseWithError(err)
	}()
	resp.Body = pr
	resp.ContentLength = -1
	h.Del("Content-Length")
	h.Set("Content-Encoding", "gzip")
	h.Add("Vary", "Accept-Encoding")
	if etag := h.Get("ETag"); etag != "" && !strings.HasPrefix(etag, "W/") {
		h.Set("ETag", "W/"+etag) // the bytes differ from the strong validator's
	}
}
