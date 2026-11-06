// SPDX-License-Identifier: GPL-3.0-or-later
// Homey IPC adapter for unframeo, derived from its command-line client.
// Upstream: https://github.com/borje/unframeo
package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"image"
	"image/color"
	"image/draw"
	"image/jpeg"
	_ "image/png"
	"io"
	"log/slog"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"sync/atomic"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/borje/unframeo/internal/config"
	"github.com/borje/unframeo/internal/frameo"
	"github.com/borje/unframeo/internal/frameo/pb"
	"github.com/borje/unframeo/internal/mdns"
	"github.com/borje/unframeo/internal/sdg"
	"golang.org/x/image/webp"
	"google.golang.org/protobuf/encoding/protowire"
	"google.golang.org/protobuf/proto"
)

const (
	maxRequestBytes  = 512 << 10
	maxPhotoBytes    = 20 << 20
	maxFrames        = 64
	maxInboundBytes  = 1 << 20
	maxGalleryItems  = 10000
	maxGalleryJSON   = 2 << 20
	maxPreviewBytes  = 4 << 20
	maxPreviewSide   = 2048
	maxPreviewPixels = 4000000
	adapterChunkSize = 16316
	upstreamRevision = "149f60b5ac7702f2cbb0761185b0d49a7431bf3f"
)

var keyPattern = regexp.MustCompile(`^[a-fA-F0-9]{64}$`)
var codePattern = regexp.MustCompile(`^[0-9]{7,31}$`)
var quietLog = slog.New(slog.NewTextHandler(io.Discard, nil))
var errInvalidWebP = errors.New("invalid WebP preview header")

type request struct {
	Operation string         `json:"operation"`
	Config    *config.Config `json:"config,omitempty"`
	Code      string         `json:"code,omitempty"`
	Peer      string         `json:"peer,omitempty"`
	Name      string         `json:"name,omitempty"`
	Path      string         `json:"path,omitempty"`
	Caption   string         `json:"caption,omitempty"`
	Fit       bool           `json:"fit,omitempty"`
	Network   string         `json:"network,omitempty"`
	Access    string         `json:"access,omitempty"`
	MediaID   string         `json:"mediaId,omitempty"`
	Size      string         `json:"size,omitempty"`
	Encoding  string         `json:"encoding,omitempty"`
	Visible   *bool          `json:"visible,omitempty"`
}

type publicError struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

type response struct {
	OK     bool           `json:"ok"`
	Result any            `json:"result,omitempty"`
	Config *config.Config `json:"config,omitempty"`
	Error  *publicError   `json:"error,omitempty"`
}

// Keep the private identity in this field only. No error formats an upstream
// error, because those errors can contain keys, paths, or other request data.
func failure(code, message string) response {
	return response{Error: &publicError{Code: code, Message: message}}
}

type frameSession interface {
	GetInfo(context.Context) (*pb.FrameInfo, error)
	RequestPermission(context.Context, frameo.Permission) error
	ListMedia(context.Context) ([]*pb.MediaMetaData, error)
	GetMedia(context.Context, frameo.Fetch) (*frameo.Download, error)
	DeleteMedia(context.Context, []int64) error
	SetMediaVisible(context.Context, []int64, bool) error
	SendPhoto(context.Context, frameo.Photo) (int64, error)
	Close() error
}

type dependencies struct {
	identity func() (*sdg.Identity, error)
	pair     func(context.Context, *config.Config, string) (sdg.PeerID, error)
	connect  func(context.Context, *config.Config, sdg.PeerID, string) (frameSession, string, error)
}

func main() {
	// A malformed request or unexpected runtime fault must not produce a stack
	// trace containing request data. The parent receives a fixed error instead.
	defer func() {
		if recover() != nil {
			_ = json.NewEncoder(os.Stdout).Encode(failure("INTERNAL_ERROR", "The engine could not complete this operation."))
		}
	}()
	r := run(os.Stdin, productionDependencies())
	_ = json.NewEncoder(os.Stdout).Encode(r)
}

func run(input io.Reader, deps dependencies) response {
	data, err := io.ReadAll(io.LimitReader(input, maxRequestBytes+1))
	if err != nil || len(data) > maxRequestBytes {
		return failure("INVALID_REQUEST", "The request is unreadable or too large.")
	}
	var req request
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&req); err != nil {
		return failure("INVALID_REQUEST", "The request must contain one supported JSON object.")
	}
	var extra any
	if err := dec.Decode(&extra); err != io.EOF {
		return failure("INVALID_REQUEST", "Only one request is allowed per process.")
	}
	return execute(req, deps)
}

func execute(req request, deps dependencies) response {
	if req.Network == "" {
		req.Network = "auto"
	}
	if req.Network != "auto" && req.Network != "local" && req.Network != "relay" {
		return failure("INVALID_REQUEST", "The network mode is not supported.")
	}
	req.Name = strings.TrimSpace(req.Name)
	if utf8.RuneCountInString(req.Name) > 80 || strings.ContainsAny(req.Name, "\x00\r\n") || utf8.RuneCountInString(req.Caption) > 1000 {
		return failure("INVALID_REQUEST", "The sender name or caption is invalid.")
	}
	if req.Operation == "probe" {
		return response{OK: true, Result: map[string]any{
			"engine": "homey-frameo", "protocolVersion": 1,
			"goos": runtime.GOOS, "goarch": runtime.GOARCH,
			"revision": upstreamRevision,
		}}
	}
	gallery := req.Operation == "listMedia" || req.Operation == "getMedia" || req.Operation == "deleteMedia" || req.Operation == "setMediaVisible"
	if req.Operation != "pair" && req.Operation != "info" && req.Operation != "send" && req.Operation != "listFrames" && req.Operation != "permission" && !gallery {
		return failure("UNSUPPORTED_OPERATION", "This operation is not supported.")
	}
	if req.Operation == "permission" && req.Access != "view" && req.Access != "manage" {
		return failure("INVALID_ACCESS", "Choose either photo viewing or photo management access.")
	}
	if req.Operation == "pair" && !codePattern.MatchString(req.Code) {
		return failure("INVALID_CODE", "Enter the current numeric friend code shown on the frame.")
	}
	var mediaID int64
	if req.Operation == "getMedia" || req.Operation == "deleteMedia" || req.Operation == "setMediaVisible" {
		var err error
		mediaID, err = parseMediaID(req.MediaID)
		if err != nil {
			return failure("INVALID_MEDIA_ID", "Choose one exact photo identifier from the frame listing.")
		}
	}
	if req.Operation == "setMediaVisible" && req.Visible == nil {
		return failure("INVALID_REQUEST", "Choose whether this exact photo is visible.")
	}
	if req.Operation == "getMedia" && req.Size != "" && req.Size != "preview" {
		return failure("INVALID_REQUEST", "Only stored image previews may be downloaded.")
	}
	if req.Encoding != "" && (req.Operation != "getMedia" || req.Encoding != "jpeg") {
		return failure("INVALID_REQUEST", "Only JPEG conversion of a selected preview is supported.")
	}
	cfg, err := validatedConfig(req.Config)
	if err != nil {
		return failure("INVALID_CONFIG", "The saved frame identity is invalid.")
	}
	if cfg == nil && req.Operation != "pair" {
		return failure("MISSING_CONFIG", "Pair a frame before using this operation.")
	}
	if cfg != nil && req.Name != "" {
		cfg.ClientName = req.Name
	}
	if req.Operation == "listFrames" {
		return response{OK: true, Result: listFrames(cfg)}
	}
	if req.Operation == "pair" {
		ctx, cancel := context.WithTimeout(context.Background(), 75*time.Second)
		defer cancel()
		return pairFrame(ctx, req, cfg, deps)
	}
	peer, err := resolvePeer(cfg, req.Peer)
	if err != nil {
		return failure("UNKNOWN_FRAME", "The selected frame is not paired with this identity.")
	}
	var photoSize int64
	var extension string
	var output *os.File
	if req.Operation == "send" {
		photoSize, extension, err = validatePhoto(req.Path)
		if err != nil {
			return failure("INVALID_IMAGE", "Choose a regular JPEG, PNG, or WebP image no larger than 20 MiB.")
		}
	}
	if req.Operation == "getMedia" {
		output, err = openPreviewOutput(req.Path)
		if err != nil {
			return failure("INVALID_OUTPUT", "A private, empty temporary output file is required.")
		}
		defer output.Close()
	}
	timeout := 25 * time.Second
	if req.Operation == "send" {
		timeout = 150 * time.Second
	} else if req.Operation == "permission" {
		timeout = 75 * time.Second
	} else if req.Operation == "listMedia" {
		timeout = 20 * time.Second
	} else if req.Operation == "getMedia" || req.Operation == "deleteMedia" || req.Operation == "setMediaVisible" {
		timeout = 25 * time.Second
	}
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	policy := policyForOperation(req.Operation, mediaID)
	if req.Operation == "send" {
		policy.sendAttempt = &atomic.Bool{}
	}
	ctx = context.WithValue(ctx, inboundPolicyKey{}, policy)
	client, route, err := deps.connect(ctx, cfg, peer, req.Network)
	if err != nil {
		return networkFailure(err)
	}
	defer client.Close()
	if gallery {
		return runGallery(ctx, client, peer, route, req, mediaID, output)
	}
	if req.Operation == "permission" {
		return requestFramePermission(ctx, client, peer, route, req.Access)
	}
	if req.Operation == "info" {
		info, err := client.GetInfo(ctx)
		if err != nil {
			return networkFailure(err)
		}
		if !validInfo(info) {
			return failure("INVALID_FRAME_RESPONSE", "The frame returned incomplete information.")
		}
		return response{OK: true, Result: infoResult(peer, info, route)}
	}
	id, err := client.SendPhoto(ctx, frameo.Photo{
		Path: req.Path, Extension: extension, Caption: req.Caption,
		Fit: req.Fit, Taken: time.Now().UTC(),
	})
	if err != nil {
		if policy.sendAttempt != nil && policy.sendAttempt.Load() {
			return failure("SEND_UNVERIFIED", "The frame may have received this photo. Check before sending it again.")
		}
		return networkFailure(err)
	}
	return response{OK: true, Result: map[string]any{
		"peer": peer.String(), "mediaId": strconv.FormatInt(id, 10),
		"bytes": photoSize, "confirmed": true, "route": route,
	}}
}

func parseMediaID(value string) (int64, error) {
	id, err := strconv.ParseInt(value, 10, 64)
	if err != nil || strconv.FormatInt(id, 10) != value {
		return 0, errors.New("invalid media id")
	}
	return id, nil
}

func runGallery(ctx context.Context, client frameSession, peer sdg.PeerID, route string, req request, id int64, output *os.File) response {
	info, err := client.GetInfo(ctx)
	if err != nil {
		return mediaFailure(err)
	}
	if !validInfo(info) {
		return failure("INVALID_FRAME_RESPONSE", "The frame returned incomplete information.")
	}
	permission := frameo.PermissionView
	if req.Operation == "deleteMedia" || req.Operation == "setMediaVisible" {
		permission = frameo.PermissionManage
	}
	if !frameo.Granted(info, permission) {
		return failure("PERMISSION_REQUIRED", "The frame has not granted the access required for this operation.")
	}
	if req.Operation == "getMedia" {
		download, err := client.GetMedia(ctx, frameo.Fetch{ID: id, Size: frameo.SizePreview, Attempts: 1, Timeout: 20 * time.Second})
		if err != nil {
			return mediaFailure(err)
		}
		return writePreview(ctx, peer, id, download, output, req.Encoding)
	}
	items, err := client.ListMedia(ctx)
	if err != nil {
		return mediaFailure(err)
	}
	listing, err := mediaListing(peer, items)
	if err != nil {
		return mediaFailure(err)
	}
	if req.Operation == "listMedia" {
		return response{OK: true, Result: listing}
	}
	if !containsMedia(items, id) {
		return failure("MEDIA_NOT_FOUND", "The selected photo is no longer in the frame listing.")
	}
	if req.Operation == "setMediaVisible" {
		visible := *req.Visible
		if err := client.SetMediaVisible(ctx, []int64{id}, visible); err != nil {
			return visibilityUnverified(peer, id, false)
		}
		after, err := client.ListMedia(ctx)
		if err != nil {
			return visibilityUnverified(peer, id, true)
		}
		if _, err := mediaListing(peer, after); err != nil {
			return visibilityUnverified(peer, id, true)
		}
		for _, item := range after {
			if item.GetMediaId() == id && item.GetIsVisible() == visible {
				return response{OK: true, Result: map[string]any{"peer": peer.String(), "mediaId": strconv.FormatInt(id, 10), "visible": visible, "acknowledged": true, "verified": true}}
			}
		}
		return visibilityUnverified(peer, id, true)
	}
	// Once this call starts, a failure cannot establish that nothing changed.
	// Never retry or replace the exact selected identifier with a date-based guess.
	if err := client.DeleteMedia(ctx, []int64{id}); err != nil {
		return deletionUnverified(peer, id, false)
	}
	after, err := client.ListMedia(ctx)
	if err != nil {
		return deletionUnverified(peer, id, true)
	}
	if _, err := mediaListing(peer, after); err != nil || containsMedia(after, id) {
		return deletionUnverified(peer, id, true)
	}
	return response{OK: true, Result: map[string]any{"peer": peer.String(), "mediaId": strconv.FormatInt(id, 10), "acknowledged": true, "deleted": true}}
}

func visibilityUnverified(peer sdg.PeerID, id int64, acknowledged bool) response {
	r := failure("VISIBILITY_UNVERIFIED", "The visibility may have changed. Refresh the gallery before deciding what to do next.")
	r.Result = map[string]any{"peer": peer.String(), "mediaId": strconv.FormatInt(id, 10), "acknowledged": acknowledged, "visible": nil, "verified": false}
	return r
}

func deletionUnverified(peer sdg.PeerID, id int64, acknowledged bool) response {
	r := failure("DELETE_UNVERIFIED", "The deletion may have been applied. Refresh the frame listing before deciding what to do next.")
	r.Result = map[string]any{"peer": peer.String(), "mediaId": strconv.FormatInt(id, 10), "acknowledged": acknowledged, "deleted": nil}
	return r
}

func containsMedia(items []*pb.MediaMetaData, id int64) bool {
	for _, item := range items {
		if item != nil && item.GetMediaId() == id {
			return true
		}
	}
	return false
}

func mediaDate(value int64) any {
	if value <= 0 || value > 253402300799999 {
		return nil
	}
	return time.UnixMilli(value).UTC().Format(time.RFC3339Nano)
}

func mediaListing(peer sdg.PeerID, items []*pb.MediaMetaData) (map[string]any, error) {
	if len(items) > maxGalleryItems {
		return nil, sdg.ErrMessageTooLarge
	}
	seen := make(map[int64]bool, len(items))
	result := make([]map[string]any, 0, len(items))
	for _, item := range items {
		if item == nil || seen[item.GetMediaId()] {
			return nil, errors.New("invalid listing")
		}
		seen[item.GetMediaId()] = true
		kind := "unknown"
		switch item.GetType() {
		case pb.MediaMetaData_Type_MEDIAMETADATA_TYPE_PICTURE:
			kind = "photo"
		case pb.MediaMetaData_Type_MEDIAMETADATA_TYPE_VIDEO:
			kind = "video"
		case pb.MediaMetaData_Type_MEDIAMETADATA_TYPE_GREETING:
			kind = "greeting"
		}
		result = append(result, map[string]any{"mediaId": strconv.FormatInt(item.GetMediaId(), 10), "type": kind,
			"visible": item.GetIsVisible(), "captureDate": mediaDate(item.GetCaptureDate()), "receiveDate": mediaDate(item.GetReceiveDate())})
	}
	listing := map[string]any{"peer": peer.String(), "items": result, "count": len(result)}
	encoded, err := json.Marshal(listing)
	if err != nil || len(encoded) > maxGalleryJSON-1024 {
		return nil, sdg.ErrMessageTooLarge
	}
	return listing, nil
}

func openPreviewOutput(filename string) (*os.File, error) {
	if !filepath.IsAbs(filename) {
		return nil, errors.New("invalid output")
	}
	before, err := os.Lstat(filename)
	if err != nil || !before.Mode().IsRegular() || before.Size() != 0 {
		return nil, errors.New("invalid output")
	}
	parent, err := os.Lstat(filepath.Dir(filename))
	if err != nil || !parent.IsDir() || parent.Mode()&os.ModeSymlink != 0 {
		return nil, errors.New("invalid output")
	}
	if runtime.GOOS != "windows" && (before.Mode().Perm()&0o077 != 0 || parent.Mode().Perm()&0o077 != 0) {
		return nil, errors.New("output not private")
	}
	// Open without truncating. The inode must still be the prevalidated empty
	// regular file before any preview bytes are allowed to replace its contents.
	file, err := os.OpenFile(filename, os.O_WRONLY, 0)
	if err != nil {
		return nil, err
	}
	after, err := file.Stat()
	if err != nil || !os.SameFile(before, after) || !after.Mode().IsRegular() || after.Size() != 0 {
		_ = file.Close()
		return nil, errors.New("output changed")
	}
	return file, nil
}

func writePreview(ctx context.Context, peer sdg.PeerID, id int64, download *frameo.Download, output *os.File, encoding string) response {
	if err := ctx.Err(); err != nil {
		return mediaFailure(err)
	}
	if download == nil || download.Media == nil || download.Media.GetId() != id || len(download.Data) == 0 || int64(download.Media.GetSize()) != int64(len(download.Data)) {
		return failure("INVALID_FRAME_RESPONSE", "The frame did not return the selected photo preview.")
	}
	if len(download.Data) > maxPreviewBytes {
		return failure("MEDIA_TOO_LARGE", "The selected preview exceeds the supported size.")
	}
	mime := http.DetectContentType(download.Data)
	extension := ""
	if mime == "image/jpeg" {
		extension = "jpg"
	} else if mime == "image/png" {
		extension = "png"
	} else if mime == "image/webp" {
		extension = "webp"
	} else {
		return failure("IMAGE_FORMAT_UNSUPPORTED", "The selected preview is not a supported JPEG, PNG, or WebP image.")
	}
	var dimensions image.Config
	var err error
	if mime == "image/webp" {
		dimensions, err = webpPreviewConfig(download.Data)
	} else {
		dimensions, _, err = image.DecodeConfig(bytes.NewReader(download.Data))
	}
	if err != nil || dimensions.Width <= 0 || dimensions.Height <= 0 {
		return failure("IMAGE_FORMAT_UNSUPPORTED", "The selected preview has an unreadable image header.")
	}
	if dimensions.Width > maxPreviewSide || dimensions.Height > maxPreviewSide || int64(dimensions.Width)*int64(dimensions.Height) > maxPreviewPixels {
		return failure("MEDIA_TOO_LARGE", "The selected preview exceeds the supported pixel dimensions.")
	}
	data := download.Data
	if encoding == "jpeg" && mime != "image/jpeg" {
		data, err = encodePreviewJPEG(ctx, data, mime, dimensions)
		if err != nil {
			if errors.Is(err, sdg.ErrMessageTooLarge) || errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
				return mediaFailure(err)
			}
			return failure("IMAGE_FORMAT_UNSUPPORTED", "The selected preview could not be converted to JPEG.")
		}
		mime, extension = "image/jpeg", "jpg"
	}
	if err := ctx.Err(); err != nil {
		return mediaFailure(err)
	}
	if output == nil {
		return failure("INVALID_OUTPUT", "A private temporary output file is required.")
	}
	if n, err := output.Write(data); err != nil || n != len(data) {
		_ = output.Truncate(0)
		return failure("MEDIA_WRITE_FAILED", "The selected preview could not be stored temporarily.")
	}
	if err := output.Close(); err != nil {
		return failure("MEDIA_WRITE_FAILED", "The selected preview could not be stored temporarily.")
	}
	digest := sha256.Sum256(data)
	return response{OK: true, Result: map[string]any{"peer": peer.String(), "mediaId": strconv.FormatInt(id, 10), "bytes": len(data),
		"extension": extension, "mime": mime, "width": dimensions.Width, "height": dimensions.Height, "sha256": hex.EncodeToString(digest[:])}}
}

type previewJPEGWriter struct {
	buffer bytes.Buffer
	limit  int
}

func (w *previewJPEGWriter) Write(data []byte) (int, error) {
	if len(data) > w.limit-w.buffer.Len() {
		return 0, sdg.ErrMessageTooLarge
	}
	return w.buffer.Write(data)
}

// Homey's native Image service rejects WebP even though gallery browsers can
// display it. Only an explicit encoding request performs a full decode, after
// both bounded header readers have agreed on the dimensions. Original gallery
// previews keep their exact bytes and require no decoding or JPEG allocation.
func encodePreviewJPEG(ctx context.Context, data []byte, mime string, expected image.Config) ([]byte, error) {
	if len(data) == 0 || len(data) > maxPreviewBytes || expected.Width <= 0 || expected.Height <= 0 ||
		expected.Width > maxPreviewSide || expected.Height > maxPreviewSide || int64(expected.Width)*int64(expected.Height) > maxPreviewPixels {
		return nil, sdg.ErrMessageTooLarge
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	var decoded image.Image
	var err error
	if mime == "image/webp" {
		config, e := webp.DecodeConfig(bytes.NewReader(data))
		if e != nil || config.Width != expected.Width || config.Height != expected.Height {
			return nil, errInvalidWebP
		}
		decoded, err = webp.Decode(bytes.NewReader(data))
	} else if mime == "image/png" {
		decoded, _, err = image.Decode(bytes.NewReader(data))
	} else {
		return nil, errors.New("unsupported JPEG conversion source")
	}
	if err != nil || decoded == nil {
		return nil, errors.New("invalid preview pixels")
	}
	if decoded.Bounds().Dx() != expected.Width || decoded.Bounds().Dy() != expected.Height {
		return nil, errors.New("preview dimensions changed")
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	// JPEG has no alpha channel. Composite transparent previews against white;
	// the extra canvas is at most four million pixels and is never disk-backed.
	if opaque, ok := decoded.(interface{ Opaque() bool }); !ok || !opaque.Opaque() {
		canvas := image.NewRGBA(image.Rect(0, 0, expected.Width, expected.Height))
		draw.Draw(canvas, canvas.Bounds(), &image.Uniform{C: color.White}, image.Point{}, draw.Src)
		draw.Draw(canvas, canvas.Bounds(), decoded, decoded.Bounds().Min, draw.Over)
		decoded = canvas
	}
	writer := &previewJPEGWriter{limit: maxPreviewBytes}
	if err := jpeg.Encode(writer, decoded, &jpeg.Options{Quality: 85}); err != nil {
		return nil, err
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	return writer.buffer.Bytes(), nil
}

// Read only the bounded container and image headers, never the compressed
// pixels. Frameo stores real previews as WebP. Check both the VP8X canvas and
// underlying bitstream dimensions so a small canvas cannot conceal a larger
// image. Animated WebP is outside the still-preview contract.
// Container/bit layouts: https://developers.google.com/speed/webp/docs/riff_container
func webpPreviewConfig(data []byte) (image.Config, error) {
	if len(data) < 20 || len(data) > maxPreviewBytes || string(data[:4]) != "RIFF" || string(data[8:12]) != "WEBP" ||
		uint64(binary.LittleEndian.Uint32(data[4:8]))+8 != uint64(len(data)) || len(data)%2 != 0 {
		return image.Config{}, errInvalidWebP
	}
	var width, height, canvasWidth, canvasHeight int
	var extended, seenImage, seenAlpha bool
	for offset := 12; offset < len(data); {
		if len(data)-offset < 8 {
			return image.Config{}, errInvalidWebP
		}
		kind := string(data[offset : offset+4])
		size := uint64(binary.LittleEndian.Uint32(data[offset+4 : offset+8]))
		end := uint64(offset) + 8 + size
		paddedEnd := end + size%2
		if paddedEnd > uint64(len(data)) || (size%2 != 0 && data[int(end)] != 0) {
			return image.Config{}, errInvalidWebP
		}
		payload := data[offset+8 : int(end)]
		if offset == 12 && kind != "VP8 " && kind != "VP8L" && kind != "VP8X" {
			return image.Config{}, errInvalidWebP
		}
		switch kind {
		case "VP8X":
			if offset != 12 || extended || seenImage || len(payload) != 10 || payload[0]&0x02 != 0 {
				return image.Config{}, errInvalidWebP
			}
			extended = true
			canvasWidth = 1 + int(payload[4]) + int(payload[5])<<8 + int(payload[6])<<16
			canvasHeight = 1 + int(payload[7]) + int(payload[8])<<8 + int(payload[9])<<16
		case "VP8 ", "VP8L":
			if seenImage {
				return image.Config{}, errInvalidWebP
			}
			if kind == "VP8 " {
				if len(payload) < 10 || payload[0]&1 != 0 || payload[3] != 0x9d || payload[4] != 0x01 || payload[5] != 0x2a {
					return image.Config{}, errInvalidWebP
				}
				width = int(binary.LittleEndian.Uint16(payload[6:8]) & 0x3fff)
				height = int(binary.LittleEndian.Uint16(payload[8:10]) & 0x3fff)
			} else {
				if len(payload) < 5 || payload[0] != 0x2f || seenAlpha {
					return image.Config{}, errInvalidWebP
				}
				bits := binary.LittleEndian.Uint32(payload[1:5])
				if bits>>29 != 0 { // The VP8L bitstream version is currently zero.
					return image.Config{}, errInvalidWebP
				}
				width, height = 1+int(bits&0x3fff), 1+int((bits>>14)&0x3fff)
			}
			if width <= 0 || height <= 0 || (extended && (width != canvasWidth || height != canvasHeight)) {
				return image.Config{}, errInvalidWebP
			}
			seenImage = true
		case "ALPH":
			if !extended || seenImage || seenAlpha || len(payload) < 1 || payload[0]&3 > 1 {
				return image.Config{}, errInvalidWebP
			}
			if payload[0]&3 == 0 && int64(len(payload)-1) != int64(canvasWidth)*int64(canvasHeight) {
				return image.Config{}, errInvalidWebP
			}
			seenAlpha = true
		case "ICCP":
			if !extended || seenImage {
				return image.Config{}, errInvalidWebP
			}
		case "ANIM", "ANMF":
			return image.Config{}, errInvalidWebP
		}
		offset = int(paddedEnd)
	}
	if !seenImage {
		return image.Config{}, errInvalidWebP
	}
	return image.Config{Width: width, Height: height}, nil
}

func mediaFailure(err error) response {
	var refused *frameo.FrameError
	if errors.As(err, &refused) {
		switch refused.Code {
		case pb.Error_MISSING_PERMISSION, pb.Error_UNAUTHORIZED:
			return failure("PERMISSION_REQUIRED", "The frame has not granted the access required for this operation.")
		case pb.Error_MISSING_MEDIA_ITEM, pb.Error_NOT_FOUND:
			return failure("MEDIA_NOT_FOUND", "The selected photo is no longer available on the frame.")
		}
	}
	if errors.Is(err, sdg.ErrMessageTooLarge) {
		return failure("MEDIA_TOO_LARGE", "The frame response exceeds the supported gallery or preview size.")
	}
	if errors.Is(err, frameo.ErrMediaTimeout) {
		return failure("TIMEOUT", "The frame did not finish sending the selected preview in time.")
	}
	return networkFailure(err)
}

// Permission requests are possible only through this explicit operation. The
// upstream helper checks the existing grant first, sends a request only if it is
// missing, and polls GetInfo every two seconds while the owner acts on the frame.
// Pairing, startup information checks and sending never call this function.
func requestFramePermission(ctx context.Context, client frameSession, peer sdg.PeerID, route, access string) response {
	permission := frameo.PermissionView
	if access == "manage" {
		permission = frameo.PermissionManage
	}
	if err := client.RequestPermission(ctx, permission); err != nil {
		return permissionFailure(err)
	}
	info, err := client.GetInfo(ctx)
	if err != nil {
		return permissionFailure(err)
	}
	if !validInfo(info) {
		return failure("INVALID_FRAME_RESPONSE", "The frame returned incomplete information.")
	}
	if !frameo.Granted(info, permission) {
		return failure("PERMISSION_NOT_GRANTED", "The frame has not confirmed the requested permission.")
	}
	result := infoResult(peer, info, route)
	result["access"] = access
	result["granted"] = true
	return response{OK: true, Result: result}
}

func permissionFailure(err error) response {
	var refused *frameo.FrameError
	if errors.As(err, &refused) {
		switch refused.Code {
		case pb.Error_DECLINED, pb.Error_UNAUTHORIZED, pb.Error_MISSING_PERMISSION:
			return failure("PERMISSION_DENIED", "The frame did not allow this permission request.")
		}
	}
	if errors.Is(err, context.DeadlineExceeded) || errors.Is(err, sdg.ErrPeerTimeout) {
		return failure("PERMISSION_TIMEOUT", "The permission was not confirmed within the allowed time. Check the frame.")
	}
	if errors.Is(err, context.Canceled) {
		return failure("ABORTED", "The permission request was interrupted.")
	}
	return networkFailure(err)
}

func validatedConfig(saved *config.Config) (*config.Config, error) {
	if saved == nil {
		return nil, nil
	}
	if !keyPattern.MatchString(saved.PrivateKey) || len(saved.Frames) > maxFrames || utf8.RuneCountInString(saved.ClientName) > 80 || strings.ContainsAny(saved.ClientName, "\x00\r\n") {
		return nil, errors.New("invalid config")
	}
	// Copy before applying transient sender-name overrides or new pairings.
	copy := *saved
	copy.Frames = make(map[string]config.Frame, len(saved.Frames))
	for name, f := range saved.Frames {
		if len(name) == 0 || len(name) > 128 || !keyPattern.MatchString(f.PeerID) || len(f.Name) > 256 {
			return nil, errors.New("invalid config")
		}
		copy.Frames[name] = f
	}
	if copy.DefaultFrame != "" {
		if _, ok := copy.Frames[copy.DefaultFrame]; !ok {
			return nil, errors.New("invalid config")
		}
	}
	if copy.ClientName == "" {
		copy.ClientName = "Homey"
	}
	return &copy, nil
}

func pairFrame(ctx context.Context, req request, cfg *config.Config, deps dependencies) response {
	if cfg == nil {
		id, err := deps.identity()
		if err != nil {
			return failure("IDENTITY_ERROR", "A frame identity could not be created.")
		}
		cfg = &config.Config{PrivateKey: id.Private.String(), ClientName: "Homey", Frames: map[string]config.Frame{}}
	}
	if req.Name != "" {
		cfg.ClientName = req.Name
	}
	if len(cfg.Frames) >= maxFrames {
		return failure("FRAME_LIMIT", "The maximum number of paired frames has been reached.")
	}
	peer, err := deps.pair(ctx, cfg, req.Code)
	if err != nil {
		return networkFailure(err)
	}
	key := peer.String()
	for previous, f := range cfg.Frames {
		if strings.EqualFold(f.PeerID, key) && previous != key {
			delete(cfg.Frames, previous)
			if cfg.DefaultFrame == previous {
				cfg.DefaultFrame = key
			}
		}
	}
	cfg.Frames[key] = config.Frame{PeerID: key, Name: "Frameo", PairedAt: time.Now().UTC()}
	if cfg.DefaultFrame == "" {
		cfg.DefaultFrame = key
	}
	partial := func() response {
		r := failure("PAIR_CONFIRMATION_FAILED", "The friend link was created, but the frame has not confirmed its information. Retry the connection.")
		r.Config = cfg
		r.Result = map[string]any{"paired": true, "confirmed": false, "peer": key}
		return r
	}
	client, route, err := deps.connect(ctx, cfg, peer, req.Network)
	if err != nil {
		return partial()
	}
	defer client.Close()
	info, err := client.GetInfo(ctx)
	if err != nil || !validInfo(info) {
		return partial()
	}
	item := cfg.Frames[key]
	item.Name = safeFrameName(info.GetName())
	cfg.Frames[key] = item
	result := infoResult(peer, info, route)
	result["paired"] = true
	result["confirmed"] = true
	return response{OK: true, Result: result, Config: cfg}
}

func resolvePeer(cfg *config.Config, selected string) (sdg.PeerID, error) {
	if selected == "" {
		f, ok := cfg.Frames[cfg.DefaultFrame]
		if !ok {
			return sdg.PeerID{}, errors.New("unknown frame")
		}
		return sdg.ParseKey(f.PeerID)
	}
	if !keyPattern.MatchString(selected) {
		return sdg.PeerID{}, errors.New("unknown frame")
	}
	for _, f := range cfg.Frames {
		if strings.EqualFold(f.PeerID, selected) {
			return sdg.ParseKey(f.PeerID)
		}
	}
	return sdg.PeerID{}, errors.New("unknown frame")
}

func safeFrameName(name string) string {
	name = strings.TrimSpace(name)
	if name == "" || len(name) > 256 || strings.ContainsAny(name, "\x00\r\n") {
		return "Frameo"
	}
	return name
}

func validInfo(info *pb.FrameInfo) bool {
	return info != nil && info.GetScreenWidth() > 0 && info.GetScreenWidth() <= 16384 && info.GetScreenHeight() > 0 && info.GetScreenHeight() <= 16384
}

func infoResult(peer sdg.PeerID, info *pb.FrameInfo, route string) map[string]any {
	capabilities := info.GetFrameCapabilities()
	result := map[string]any{
		"peer": peer.String(), "name": safeFrameName(info.GetName()),
		"placement": safePlacement(info.GetPlacement()),
		"width":     info.GetScreenWidth(), "height": info.GetScreenHeight(),
		"maySharePairing": info.GetHasPermissionSharePairing(),
		"mayBackup":       info.GetHasPermissionToBackup(),
		"mayView":         info.GetHasPermissionViewPhotos(), "mayManage": info.GetHasPermissionManagePhotos(),
		"maxVideoWidth":     advertisedVideoDimension(capabilities.GetMaxVideoWidth()),
		"maxVideoHeight":    advertisedVideoDimension(capabilities.GetMaxVideoHeight()),
		"protocolConfirmed": true,
	}
	// The route describes this completed connection, not a frame setting. Never
	// expose an arbitrary transport value, address, or underlying error here.
	if route == "local" || route == "relay" {
		result["route"] = route
	}
	return result
}

func safePlacement(value string) string {
	value = strings.TrimSpace(value)
	if utf8.RuneCountInString(value) > 256 || strings.IndexFunc(value, unicode.IsControl) >= 0 {
		return ""
	}
	return value
}

// Proto3 uses zero when a numeric capability was not supplied. Report unknown
// as JSON null, rather than interpreting it as a lack of video support.
func advertisedVideoDimension(value int32) any {
	if value <= 0 || value > 16384 {
		return nil
	}
	return value
}

func listFrames(cfg *config.Config) []map[string]any {
	keys := make([]string, 0, len(cfg.Frames))
	for k := range cfg.Frames {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	result := make([]map[string]any, 0, len(keys))
	for _, k := range keys {
		f := cfg.Frames[k]
		result = append(result, map[string]any{"peer": f.PeerID, "name": safeFrameName(f.Name)})
	}
	return result
}

func validatePhoto(path string) (int64, string, error) {
	if !filepath.IsAbs(path) {
		return 0, "", errors.New("invalid image")
	}
	fi, err := os.Lstat(path)
	if err != nil || !fi.Mode().IsRegular() || fi.Size() <= 0 || fi.Size() > maxPhotoBytes {
		return 0, "", errors.New("invalid image")
	}
	f, err := os.Open(path)
	if err != nil {
		return 0, "", errors.New("invalid image")
	}
	defer f.Close()
	header := make([]byte, 512)
	n, err := f.Read(header)
	if err != nil && err != io.EOF {
		return 0, "", errors.New("invalid image")
	}
	switch http.DetectContentType(header[:n]) {
	case "image/jpeg":
		return fi.Size(), "jpg", nil
	case "image/png":
		return fi.Size(), "png", nil
	case "image/webp":
		return fi.Size(), "webp", nil
	default:
		return 0, "", errors.New("invalid image")
	}
}

func networkFailure(err error) response {
	switch {
	case errors.Is(err, sdg.ErrBadOTP), errors.Is(err, sdg.ErrPairingFailed):
		return failure("INVALID_CODE", "The friend code was not accepted. Generate a fresh code on the frame.")
	case errors.Is(err, sdg.ErrRefused):
		return failure("CONNECTION_REFUSED", "The frame refused the connection or the friend code has expired.")
	case errors.Is(err, context.DeadlineExceeded), errors.Is(err, sdg.ErrPeerTimeout):
		return failure("TIMEOUT", "The frame did not answer within the allowed time.")
	case errors.Is(err, sdg.ErrKeyMismatch), errors.Is(err, sdg.ErrDecrypt):
		return failure("AUTHENTICATION_FAILED", "The frame identity could not be verified.")
	default:
		return failure("CONNECTION_FAILED", "The frame could not be reached or did not confirm the operation.")
	}
}

func productionDependencies() dependencies {
	return dependencies{identity: sdg.NewIdentity, pair: pairOnGrid, connect: connectFrame}
}

type inboundPolicyKey struct{}

type inboundPolicy struct {
	operation   string
	mediaID     int64
	maxSession  int
	maxMessage  int
	sendAttempt *atomic.Bool
}

func policyForOperation(operation string, mediaID int64) inboundPolicy {
	policy := inboundPolicy{operation: operation, mediaID: mediaID, maxSession: maxInboundBytes}
	if operation == "listMedia" || operation == "deleteMedia" || operation == "setMediaVisible" {
		policy.maxSession = 6 << 20
		policy.maxMessage = 2 << 20
	} else if operation == "getMedia" {
		policy.maxSession = 6 << 20
		policy.maxMessage = maxPreviewBytes + (64 << 10)
	}
	return policy
}

func policyFromContext(ctx context.Context) inboundPolicy {
	if policy, ok := ctx.Value(inboundPolicyKey{}).(inboundPolicy); ok {
		return policy
	}
	return policyForOperation("", 0)
}

type boundedPartial struct {
	size  int
	parts map[int32][]byte
	have  int
}

// Reassemble allowed gallery replies here, before the upstream reassembler can
// reserve its much larger per-message allowance. Only two bounded messages may
// be partial at once, with an additional cumulative session traffic budget.
type boundedTransport struct {
	frameo.Transport
	received           int
	policy             inboundPolicy
	partial            map[int64]*boundedPartial
	declaredMediaBytes int
	receivedMediaBytes int
}

func (t *boundedTransport) Send(ctx context.Context, message []byte) error {
	if t.policy.sendAttempt != nil && len(message) >= 8 && binary.BigEndian.Uint32(message[:4]) == 18 {
		typeID := int32(binary.BigEndian.Uint32(message[4:8]))
		if typeID == frameo.TypeMedia || typeID == frameo.TypeMediaDataSegment || typeID == frameo.TypeMultiPartMessage {
			// Mark before the write: a failed write can already have sent bytes.
			t.policy.sendAttempt.Store(true)
		}
	}
	return t.Transport.Send(ctx, message)
}

func (t *boundedTransport) Recv(ctx context.Context) ([]byte, error) {
	if t.policy.maxSession == 0 {
		t.policy = policyForOperation("", 0)
	}
	for {
		message, err := t.Transport.Recv(ctx)
		if err != nil {
			return nil, err
		}
		t.received += len(message)
		if t.received > t.policy.maxSession || len(message) > frameo.MaxMessage {
			return t.reject(sdg.ErrMessageTooLarge)
		}
		if len(message) < 8 || binary.BigEndian.Uint32(message[:4]) != 18 {
			return t.reject(errors.New("invalid frame response"))
		}
		if binary.BigEndian.Uint32(message[4:8]) == uint32(frameo.TypeMultiPartMessage) {
			message, err = t.addPart(message[8:])
			if err != nil {
				return t.reject(err)
			}
			if message == nil {
				continue
			}
		}
		if err := t.validateMessage(message); err != nil {
			return t.reject(err)
		}
		return message, nil
	}
}

func (t *boundedTransport) reject(err error) ([]byte, error) {
	clear(t.partial)
	_ = t.Transport.Close()
	return nil, err
}

func (t *boundedTransport) addPart(payload []byte) ([]byte, error) {
	if t.policy.maxMessage == 0 {
		return nil, sdg.ErrMessageTooLarge
	}
	var part pb.MultiPartMessage
	if err := proto.Unmarshal(payload, &part); err != nil {
		return nil, errors.New("invalid message fragment")
	}
	size := int(part.GetMessageSize())
	index := part.GetDataIndex()
	if size <= 0 || size > t.policy.maxMessage || index < 0 {
		return nil, sdg.ErrMessageTooLarge
	}
	offset := int64(index) * adapterChunkSize
	if offset >= int64(size) {
		return nil, errors.New("invalid fragment position")
	}
	want := min(adapterChunkSize, size-int(offset))
	if len(part.GetMessageData()) != want {
		return nil, errors.New("invalid fragment length")
	}
	if t.partial == nil {
		t.partial = map[int64]*boundedPartial{}
	}
	pending := t.partial[part.GetMessageId()]
	if pending == nil {
		if len(t.partial) >= 2 {
			return nil, sdg.ErrMessageTooLarge
		}
		pending = &boundedPartial{size: size, parts: map[int32][]byte{}}
		t.partial[part.GetMessageId()] = pending
	}
	if pending.size != size {
		return nil, errors.New("fragment size changed")
	}
	if previous, exists := pending.parts[index]; exists {
		if !bytes.Equal(previous, part.GetMessageData()) {
			return nil, errors.New("fragment contents changed")
		}
	} else {
		pending.parts[index] = part.GetMessageData()
		pending.have += want
	}
	if pending.have < pending.size {
		return nil, nil
	}
	delete(t.partial, part.GetMessageId())
	message := make([]byte, size)
	for index := int32(0); int64(index)*adapterChunkSize < int64(size); index++ {
		chunk, exists := pending.parts[index]
		if !exists {
			return nil, errors.New("fragment gap")
		}
		copy(message[int(index)*adapterChunkSize:], chunk)
	}
	if len(message) < 8 || binary.BigEndian.Uint32(message[:4]) != 18 {
		return nil, errors.New("invalid reassembled frame")
	}
	kind := int32(binary.BigEndian.Uint32(message[4:8]))
	allowed := (t.policy.operation == "getMedia" && (kind == frameo.TypeMedia || kind == frameo.TypeMediaDataSegment)) ||
		((t.policy.operation == "listMedia" || t.policy.operation == "deleteMedia") && kind == frameo.TypeAllMediaMetaData)
	if !allowed {
		return nil, sdg.ErrMessageTooLarge
	}
	return message, nil
}

func countMetadataItems(payload []byte) error {
	count := 0
	for len(payload) > 0 {
		number, wireType, n := protowire.ConsumeTag(payload)
		if n < 0 || wireType == protowire.StartGroupType || wireType == protowire.EndGroupType {
			return errors.New("invalid metadata wire format")
		}
		payload = payload[n:]
		if number == 1 {
			if wireType != protowire.BytesType {
				return errors.New("invalid metadata item")
			}
			item, used := protowire.ConsumeBytes(payload)
			if used < 0 {
				return errors.New("invalid metadata length")
			}
			count++
			if count > maxGalleryItems || len(item) > 512 {
				return sdg.ErrMessageTooLarge
			}
			n = used
		} else {
			n = protowire.ConsumeFieldValue(number, wireType, payload)
			if n < 0 {
				return errors.New("invalid metadata field")
			}
		}
		payload = payload[n:]
	}
	return nil
}

func (t *boundedTransport) validateMessage(message []byte) error {
	kind := int32(binary.BigEndian.Uint32(message[4:8]))
	payload := message[8:]
	if (t.policy.operation == "listMedia" || t.policy.operation == "deleteMedia") && kind == frameo.TypeAllMediaMetaData {
		return countMetadataItems(payload)
	}
	if t.policy.operation != "getMedia" {
		return nil
	}
	if kind == frameo.TypeMedia {
		if len(payload) > 64<<10 {
			return sdg.ErrMessageTooLarge
		}
		var media pb.Media
		if err := proto.Unmarshal(payload, &media); err != nil {
			return errors.New("invalid media header")
		}
		if media.GetError().GetCode() != pb.Error_NONE {
			return nil // Let GetMedia preserve a typed missing-photo/permission refusal.
		}
		if media.GetId() != t.policy.mediaID {
			return errors.New("wrong media identifier")
		}
		total := int64(media.GetSize())
		if total <= 0 || total > maxPreviewBytes || len(media.GetExtra()) > 8 {
			return sdg.ErrMessageTooLarge
		}
		for _, extra := range media.GetExtra() {
			if extra.GetSize() < 0 {
				return errors.New("invalid extra stream")
			}
			total += int64(extra.GetSize())
		}
		if total > maxPreviewBytes {
			return sdg.ErrMessageTooLarge
		}
		t.declaredMediaBytes, t.receivedMediaBytes = int(total), 0
	} else if kind == frameo.TypeMediaDataSegment {
		if t.declaredMediaBytes <= 0 {
			return errors.New("media data has no header")
		}
		var segment pb.MediaDataSegment
		if err := proto.Unmarshal(payload, &segment); err != nil {
			return errors.New("invalid media segment")
		}
		t.receivedMediaBytes += len(segment.GetData())
		if t.receivedMediaBytes > t.declaredMediaBytes {
			return sdg.ErrMessageTooLarge
		}
	}
	return nil
}

func newFrameClient(p frameo.Transport, cfg *config.Config, policy inboundPolicy) *frameo.Client {
	return frameo.NewClient(&boundedTransport{Transport: p, policy: policy}, &frameo.Options{Logger: quietLog, Name: cfg.ClientName})
}

func gridOptions() *sdg.Options {
	return &sdg.Options{
		Logger: quietLog, Dialer: &net.Dialer{Timeout: 8 * time.Second},
		StepTimeout: 8 * time.Second, MaxMessage: sdg.FrameoMaxMessage,
		ServerKeys: []sdg.Key{sdg.FrameoServerKey},
	}
}

func dialGrid(ctx context.Context, cfg *config.Config) (*sdg.Grid, error) {
	id, err := cfg.Identity()
	if err != nil {
		return nil, err
	}
	return sdg.Dial(ctx, sdg.FrameoServers, id, gridOptions())
}

func pairOnGrid(ctx context.Context, cfg *config.Config, code string) (sdg.PeerID, error) {
	g, err := dialGrid(ctx, cfg)
	if err != nil {
		return sdg.PeerID{}, err
	}
	defer g.Close()
	return g.Pair(ctx, code)
}

func connectFrame(ctx context.Context, cfg *config.Config, peer sdg.PeerID, network string) (frameSession, string, error) {
	id, err := cfg.Identity()
	if err != nil {
		return nil, "", err
	}
	if network != "relay" {
		look, stopLook := context.WithTimeout(ctx, 2*time.Second)
		found, localErr := mdns.Lookup(look, sdg.LocalService, func(instance string) bool {
			return sdg.IsLocalInstance(instance, peer)
		}, &mdns.Options{Logger: quietLog})
		stopLook()
		if localErr == nil {
			if addr, ok := found.Addr(); ok {
				dial, stopDial := context.WithTimeout(ctx, 5*time.Second)
				p, e := sdg.DialLocal(dial, sdg.Endpoint{Host: addr.String(), Port: found.Port}, peer, id, sdg.LocalProtocol, gridOptions())
				stopDial()
				localErr = e
				if e == nil {
					return newFrameClient(p, cfg, policyFromContext(ctx)), "local", nil
				}
			} else {
				localErr = mdns.ErrNotFound
			}
		}
		if network == "local" {
			return nil, "", localErr
		}
	}
	g, err := dialGrid(ctx, cfg)
	if err != nil {
		return nil, "", err
	}
	p, err := g.Connect(ctx, peer, sdg.FrameoProtocol)
	if err != nil {
		_ = g.Close()
		return nil, "", err
	}
	go func() { <-p.Done(); _ = g.Close() }()
	return newFrameClient(p, cfg, policyFromContext(ctx)), "relay", nil
}
