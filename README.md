# Frameo for Homey Pro

This independent community app sends photos to Frameo frames from Homey Pro. It also provides a frame gallery, photo widgets, and media inventory for users who grant viewing permission on their frames.

The initial beta targets Homey Pro (2023) with Homey software 12.9.0 or later. The 0.13 runtime was checked with a Pexar Frameo frame. The packaged engine runs on Linux ARM64.

## Setup guides

[English](docs/guides/README.txt) · [Français](docs/guides/README.fr.txt) · [Nederlands](docs/guides/README.nl.txt) · [Deutsch](docs/guides/README.de.txt)

## Build

From this directory, use Node.js 22 and run `npm install --ignore-scripts`, `npm test` and `npm run build`. The last command validates the Homey package at publish level and writes a local archive with its SHA-256. The build assembles the Homey Compose manifest, synchronizes the widget assets and includes the pairing and settings resources in their HTML pages.

The checked-in ARM64 engine is built from `vendor/unframeo`. Use Go 1.27.3, run the package tests from that directory and rebuild the engine with the parameters below.

```sh
cd vendor/unframeo
go test ./cmd/homey-frameo ./internal/config ./internal/frameo ./internal/mdns ./internal/sdg
CGO_ENABLED=0 GOOS=linux GOARCH=arm64 go build -trimpath -buildvcs=false -ldflags='-s -w' -o ../../app/bin/homey-frameo-linux-arm64 ./cmd/homey-frameo
```

The corresponding upstream revision is in [UPSTREAM.json](engine/UPSTREAM.json). See the [adapter protocol](engine/PROTOCOL.md), [privacy notes](docs/PRIVACY.md), [GPL license](app/LICENSE), [upstream credits](app/NOTICE) and [asset notices](app/ASSET-NOTICES.txt).
