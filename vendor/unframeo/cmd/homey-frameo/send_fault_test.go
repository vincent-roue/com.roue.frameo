// SPDX-License-Identifier: GPL-3.0-or-later
package main

import (
	"bytes"
	"context"
	"encoding/binary"
	"io"
	"os"
	"path/filepath"
	"testing"

	"github.com/borje/unframeo/internal/config"
	"github.com/borje/unframeo/internal/frameo"
	"github.com/borje/unframeo/internal/frameo/pb"
	"github.com/borje/unframeo/internal/sdg"
	"google.golang.org/protobuf/proto"
)

// A real upstream client and adapter exchange actual encoded Frameo messages.
// The transport simulates a cut at a deterministic protocol boundary only.
type sendCutWire struct {
	*scriptedWire
	cut        string
	headers    int
	segments   int
	imageID    int64
	imageBytes []byte
}

func (w *sendCutWire) Send(ctx context.Context, message []byte) error {
	kind := int32(binary.BigEndian.Uint32(message[4:8]))
	if kind == frameo.TypeMedia {
		var header pb.Media
		if err := proto.Unmarshal(message[8:], &header); err != nil {
			return err
		}
		w.headers++
		w.imageID = header.GetId()
		if w.cut == "header" {
			_ = w.Close()
			return io.EOF
		}
	}
	if kind == frameo.TypeMediaDataSegment {
		var segment pb.MediaDataSegment
		if err := proto.Unmarshal(message[8:], &segment); err != nil {
			return err
		}
		w.segments++
		w.imageBytes = append(w.imageBytes, segment.GetData()...)
		if segment.GetRequiresAcknowledgeReceiptId() != 0 {
			if w.cut == "accepted" {
				_ = w.Close()
				return nil
			}
			err := w.scriptedWire.Send(ctx, message)
			// The unbuffered reply was already read before the connection disappears.
			// A subsequent EOF must not discard that exact receipt.
			_ = w.Close()
			return err
		}
	}
	return w.scriptedWire.Send(ctx, message)
}
func TestRealClientSendCutsNeverRetryAndDoNotDiscardAnAlreadyReceivedACK(t *testing.T) {
	for _, cut := range []string{"header", "accepted", "after-ack"} {
		t.Run(cut, func(t *testing.T) {
			data := fixturePNG(t)
			filename := filepath.Join(t.TempDir(), "fixture.png")
			if err := os.WriteFile(filename, data, 0600); err != nil {
				t.Fatal(err)
			}
			wire := &sendCutWire{scriptedWire: &scriptedWire{replies: make(chan []byte), done: make(chan struct{})}, cut: cut}
			wire.onSend = func(message []byte) [][]byte {
				kind := int32(binary.BigEndian.Uint32(message[4:8]))
				switch kind {
				case frameo.TypeMedia:
					return nil
				case frameo.TypeMediaDataSegment:
					var segment pb.MediaDataSegment
					if err := proto.Unmarshal(message[8:], &segment); err != nil {
						t.Fatal(err)
					}
					ack := segment.GetRequiresAcknowledgeReceiptId()
					if ack == 0 {
						return nil
					}
					return [][]byte{
						adapterFrame(t, frameo.TypeAcknowledgeReceipt, &pb.AcknowledgeReceipt{AcknowledgeId: ack + 1, Error: &pb.Error{Code: pb.Error_DECLINED}}),
						adapterFrame(t, frameo.TypeAcknowledgeReceipt, &pb.AcknowledgeReceipt{AcknowledgeId: ack}),
					}
				default:
					t.Errorf("unexpected send command %d", kind)
					return nil
				}
			}
			deps := failIfNetwork(t)
			deps.connect = func(ctx context.Context, cfg *config.Config, _ sdg.PeerID, _ string) (frameSession, string, error) {
				return newFrameClient(wire, cfg, policyFromContext(ctx)), "local", nil
			}
			result := execute(request{Operation: "send", Config: fixtureConfig(), Path: filename}, deps)
			if wire.headers != 1 || wire.segments > 1 {
				t.Fatalf("transfer retried: %d headers %d segments", wire.headers, wire.segments)
			}
			if cut == "after-ack" {
				if !result.OK || result.Result.(map[string]any)["confirmed"] != true {
					t.Fatalf("received ACK was lost: %#v", result.Error)
				}
			} else if result.OK || result.Error.Code != "SEND_UNVERIFIED" {
				t.Fatalf("unconfirmed transmitted data was reported as settled: %#v", result)
			}
			if cut != "header" && !bytes.Equal(wire.imageBytes, data) {
				t.Fatal("fake receiver did not accept the exact photo bytes")
			}
		})
	}
}
