package main

import (
	"context"
	"errors"
	"testing"

	"github.com/borje/unframeo/internal/frameo"
	"github.com/borje/unframeo/internal/frameo/pb"
)

func TestVideoThumbnailRefusesNonStillOffersBeforeReadingContent(t *testing.T) {
	const id = int64(-1234567890123456789)
	offers := map[string]*pb.Media{
		"whole video":     {Id: id, Type: pb.Media_VIDEO_WITH_THUMB, Size: 1024, FileExtension: "mp4"},
		"movie extension": {Id: id, Type: pb.Media_VIDEO_THUMB, Size: 1024, FileExtension: "mp4"},
		"oversized image": {Id: id, Type: pb.Media_VIDEO_THUMB, Size: maxVideoThumbBytes + 1},
		"extra stream":    {Id: id, Type: pb.Media_VIDEO_THUMB, Size: 1024, Extra: []*pb.Extra{{Size: 1024}}},
	}
	for name, offer := range offers {
		t.Run(name, func(t *testing.T) {
			wire := &sequenceWire{messages: [][]byte{
				adapterFrame(t, frameo.TypeMedia, offer),
				adapterFrame(t, frameo.TypeMediaDataSegment, &pb.MediaDataSegment{Data: []byte("unread")}),
			}}
			policy := policyForOperation("getMedia", id)
			policy.videoThumbnail = true
			transport := &boundedTransport{Transport: wire, policy: policy}
			if _, err := transport.Recv(context.Background()); !errors.Is(err, errVideoThumbnail) || !wire.closed || len(wire.messages) != 1 {
				t.Fatalf("unsafe offer was not rejected before its data: err=%v closed=%t remaining=%d", err, wire.closed, len(wire.messages))
			}
		})
	}
}

func TestVideoThumbnailChecksStillImageSignatureAcrossSegments(t *testing.T) {
	const id = int64(123)
	const webp = "RIFF\x08\x00\x00\x00WEBPVP8L"
	const video = "\x00\x00\x00\x18ftypmp42\x00\x00\x00\x00"
	for _, signature := range []string{webp, video} {
		wire := &sequenceWire{messages: [][]byte{
			adapterFrame(t, frameo.TypeMedia, &pb.Media{Id: id, Type: pb.Media_VIDEO_THUMB, Size: int32(len(signature))}),
			adapterFrame(t, frameo.TypeMediaDataSegment, &pb.MediaDataSegment{Data: []byte(signature[:8])}),
			adapterFrame(t, frameo.TypeMediaDataSegment, &pb.MediaDataSegment{Data: []byte(signature[8:])}),
		}}
		policy := policyForOperation("getMedia", id)
		policy.videoThumbnail = true
		transport := &boundedTransport{Transport: wire, policy: policy}
		for range 2 {
			if _, err := transport.Recv(context.Background()); err != nil {
				t.Fatalf("failed before the split image signature was available: %v", err)
			}
		}
		_, err := transport.Recv(context.Background())
		if signature == webp && (err != nil || wire.closed) {
			t.Fatalf("valid WebP signature refused: %v", err)
		}
		if signature == video && (!errors.Is(err, errVideoThumbnail) || !wire.closed) {
			t.Fatalf("a video advertised as a still image was accepted: %v", err)
		}
	}
}
