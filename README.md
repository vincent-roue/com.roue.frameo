# Frameo for Homey Pro

This independent community app sends photos to Frameo frames from Homey Pro. It also provides a frame gallery, photo widgets, and media inventory for users who grant viewing permission on their frames.

The engine supports Homey systems running Linux ARM64 or AMD64 with Homey software 12.9.0 or later. Node.js reports AMD64 as x64; the app selects the matching packaged engine from the runtime architecture. Real-frame testing covers Homey Pro (2023) with a Pexar Frameo frame. Homey Pro mini, Homey Pro (2026) and Homey Self-Hosted Server remain untested with a real frame.

## Setup guides

[English](docs/guides/README.txt) · [Français](docs/guides/README.fr.txt) · [Nederlands](docs/guides/README.nl.txt) · [Deutsch](docs/guides/README.de.txt)

## Build

Use Node.js 22 to test the Homey runtime with `npm test`. Use Node.js 24 to build the package with the Homey CLI. Run `npm install --ignore-scripts` followed by `npm run build`. The build validates the Homey package at publish level, assembles its manifest and settings screens, and writes a local archive with its SHA-256.

Both Linux engines are built from the same source in `vendor/unframeo`, with CGO disabled. Use Go 1.27.3, run the package tests from that directory and rebuild both architectures with the parameters below.

```sh
cd vendor/unframeo
go test ./cmd/homey-frameo ./internal/config ./internal/frameo ./internal/mdns ./internal/sdg
CGO_ENABLED=0 GOOS=linux GOARCH=arm64 go build -trimpath -buildvcs=false -ldflags='-s -w' -o ../../app/bin/homey-frameo-linux-arm64 ./cmd/homey-frameo
CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -buildvcs=false -ldflags='-s -w' -o ../../app/bin/homey-frameo-linux-amd64 ./cmd/homey-frameo
```

The corresponding upstream revision is in [UPSTREAM.json](engine/UPSTREAM.json). See the [adapter protocol](engine/PROTOCOL.md), [privacy notes](docs/PRIVACY.md), [GPL license](app/LICENSE), [upstream credits](app/NOTICE) and [asset notices](app/ASSET-NOTICES.txt).
