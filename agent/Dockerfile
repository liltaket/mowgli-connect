# syntax=docker/dockerfile:1
FROM --platform=$BUILDPLATFORM golang:1.27.4@sha256:fe517acaa580cc7915457080f850c37e618b3c1e750f98b58fc6429b605147a1 AS build
ARG TARGETOS TARGETARCH VERSION=dev
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH \
    go build -trimpath -ldflags="-s -w -X main.version=$VERSION" -o /out/connect-agent ./cmd/connect-agent \
 && mkdir -p /out/data

# Base images pinned by tag and multi-arch index digest (amd64 + arm64). cloudflared: same
# release T3 Connect pins.
FROM cloudflare/cloudflared:2026.11.0@sha256:b94b96edf2c9c4360f8879c8580cfaa99077f19c849ec595ca2f711b27d4f344 AS cloudflared

# Alpine for nft (egress lock) and setpriv (privilege drop); see entrypoint.sh.
FROM alpine:3.22@sha256:bfe7ceb9f09ec0566c48fb93356e45a47a00be5a1dd14fa5b909e7709c66b034
LABEL org.opencontainers.image.licenses="PolyForm-Noncommercial-1.0.0" \
      org.opencontainers.image.source="https://github.com/liltaket/mowgli-connect"
# Numeric ids only: 65532 = agent, 65533 = cloudflared (see entrypoint.sh).
RUN apk add --no-cache nftables setpriv ca-certificates
COPY --from=cloudflared /usr/local/bin/cloudflared /usr/local/bin/cloudflared
COPY --from=build /out/connect-agent /usr/local/bin/connect-agent
COPY --chmod=0755 entrypoint.sh /usr/local/bin/entrypoint.sh
# A fresh named volume inherits this ownership, so the agent user can write its key.
COPY --from=build --chown=65532:65532 --chmod=0700 /out/data /data
VOLUME /data
ENV MC_LISTEN=127.0.0.1:4007 MC_UPSTREAM=http://host.docker.internal:4006
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["run"]
