# syntax=docker/dockerfile:1
FROM --platform=$BUILDPLATFORM golang:1.24 AS build
ARG TARGETOS TARGETARCH VERSION=dev
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH \
    go build -trimpath -ldflags="-s -w -X main.version=$VERSION" -o /out/connect-agent ./cmd/connect-agent \
 && mkdir -p /out/data

# Pinned cloudflared (same release T3 Connect pins). Multi-arch: amd64 + arm64.
FROM cloudflare/cloudflared:2026.10.4 AS cloudflared

# Alpine for nft (egress lock) and setpriv (privilege drop); see entrypoint.sh.
FROM alpine:3.22
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
