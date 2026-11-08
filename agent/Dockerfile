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

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=cloudflared /usr/local/bin/cloudflared /usr/local/bin/cloudflared
COPY --from=build /out/connect-agent /usr/local/bin/connect-agent
# A fresh named volume inherits this ownership, so the nonroot user can write its key.
COPY --from=build --chown=65532:65532 --chmod=0700 /out/data /data
VOLUME /data
ENTRYPOINT ["/usr/local/bin/connect-agent"]
CMD ["run"]
