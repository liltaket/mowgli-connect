# Synthetic robot traffic

This simulator speaks Foxglove WebSocket v1 to the real MowgliNext GUI, without ROS or a robot. `wsmeter` subscribes to the GUI's multiplex socket and measures the delivered MessagePack frames. The synthetic values, patterns, rates and resulting traffic are not measurements of a real robot. HTTP polling, tiles, authentication and client-to-server application traffic are not represented in the payload totals.

## Build and run

Go 1.24 or later is required. From this directory:

```sh
(cd foxglove-sim && go build -o foxglove-sim .)
go build -o wsmeter/wsmeter ./wsmeter
mkdir -p run/web run/db
printf '<!doctype html><title>Simulator</title>\n' > run/web/index.html
```

Start the simulator in a separate terminal (replace `default` with `stress` for the stress workload):

```sh
./foxglove-sim/foxglove-sim -preset default
```

Start the provided GUI in another terminal, from this directory:

```sh
API_ADDR=127.0.0.1:4006 WEB_DIR="$PWD/run/web" DB_PATH="$PWD/run/db" \
HOMEKIT_ENABLED=false MQTT_ENABLED=false FOXGLOVE_URL=ws://127.0.0.1:8765 \
ROS_MASTER_URI=http://127.0.0.1:1 \
/path/to/mowgli-gui  # built from MowgliNext gui/
```

After the GUI reports `foxglove: connected`, allow at least 10 seconds for the first map poll, then run the meter. Repeat with `-set map` and with `-compression=true`:

```sh
./wsmeter/wsmeter -url ws://127.0.0.1:4006/api/mowglinext/multiplex \
  -host 127.0.0.1:4006 -origin http://127.0.0.1:4006 \
  -set dashboard -duration 10s -compression=false
```

Stop both servers with Ctrl-C. `-url` also accepts HTTP(S) base URLs and WS(S) URLs, `-cookie` sets the Cookie header, and `-topics` overrides the comma-separated topic set. `-host` and `-origin` let a proxy preserve the external host and origin. The dashboard set follows the page's stream hooks, including the `fusionRaw` alias and virtual map; diagnostics snapshots are HTTP and are not included. The map set covers the streams in `useMapStreams` with status; it does not enable the conditional recording trajectory. Cached initial messages can increase measured rates in short windows.

Use `./foxglove-sim/foxglove-sim -h` for flags. The default is 720 scan samples at 20 Hz, two 400×400 grids at 1 Hz, and four areas of 100 points. `-scan-ranges`, `-scan-rate`, `-grid-size`, `-grid-rate`, `-areas`, and `-area-points` tune the workload. The stress preset sets two 1,000×1,000 grids at 2 Hz and ten 3,000-point areas, changing the map every five seconds (approximately 1.07 MB JSON). Preset values override the related size and rate flags; use the default preset to set custom values. The GUI may throttle or coalesce upstream updates. Service support is limited to the map-area enumeration required for the virtual map; the simulator is not a control-service emulator.

The meter reports payload bytes after WebSocket decompression, the largest received message, and the standard deviation of inter-arrival intervals in milliseconds per topic. The connection counter reports received raw socket bytes during the window, including WebSocket framing and, for WSS, TLS records; it excludes handshake bytes and can include protocol control traffic. The extension response states whether compression was actually negotiated. Counts and rates vary with scheduling, cached messages, and map bursts.

## Local results


Synthetic-data measurements on the dev machine, 2026-11-08, with the supplied GUI binary and a single local meter connection. Each row is a separate 10-second window after startup; `wire` counts downstream raw socket bytes. Values are decimal bytes per second, rounded by the meter.

| Preset | Topic set | Compression requested | Payload B/s | Wire B/s |
|---|---|---:|---:|---:|
| Default | Dashboard | No | 165,417 | 165,472 |
| Default | Dashboard | Yes | 165,411 | 165,465 |
| Default | Map | No | 351,826 | 351,942 |
| Default | Map | Yes | 368,261 | 368,379 |
| Stress | Dashboard | No | 1,238,320 | 1,238,377 |
| Stress | Dashboard | Yes | 1,238,412 | 1,238,469 |
| Stress | Map | No | 2,080,512 | 2,080,629 |
| Stress | Map | Yes | 1,879,130 | 1,879,243 |

The GUI did **not** negotiate permessage-deflate in any run, including those that requested it; differences between those rows reflect sampling and scheduling, not compression. In stress runs, the two grids reached approximately 0.8–1.0 Hz per topic despite 2 Hz simulator publication; the largest received grid frame was 1,000,211 bytes. Stress map frames reached 780,343 MessagePack bytes. See [measurements.txt](measurements.txt) for per-topic rates, sizes, and jitter. These results do not establish tunnel, authentication-proxy, or robot performance.

The GUI log reported `foxglove: connected` and the simulator logged subscriptions for the requested ROS channels. Focused grid and map service CDR round-trip tests pass with `(cd foxglove-sim && go test ./...)`; `go test ./...` in this directory checks the meter build.

The CDR parser/writer and ROS interface schema snapshots in `foxglove-sim` were copied from the MowgliNext reference checkout. They remain under its [license](foxglove-sim/LICENSE).
