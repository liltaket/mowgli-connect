# syntax=docker/dockerfile:1
FROM --platform=$BUILDPLATFORM golang:1.24@sha256:d2d2bc1c84f7e60d7d2438a3836ae7d0c847f4888464e7ec9ba3a1339a1ee804 AS build
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
FROM cloudflare/cloudflared:2026.10.4@sha256:c6c7ae1d5dfdcb094ad344ed68ccffc26635c9c6be80965664c33baf064b0515 AS cloudflared

# Alpine for nft (egress lock) and setpriv (privilege drop); see entrypoint.sh.
FROM alpine:3.22@sha256:bfe7ceb9f09ec0566c48fb93356e45a47a00be5a1dd14fa5b909e7709c66b034
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
