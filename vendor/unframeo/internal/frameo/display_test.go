package frameo

import (
	"bytes"
	"context"
	"testing"
)

type displayWire struct {
	Transport
	sent [][]byte
}

func (w *displayWire) Send(_ context.Context, message []byte) error {
	w.sent = append(w.sent, message)
	return nil
}

func TestDisplayMediaWire(t *testing.T) {
	for _, tc := range []struct {
		id      int64
		payload []byte
	}{
		{id: -64, payload: []byte{0x08, 0x7f}},
		{id: 0, payload: []byte{0x08, 0x00}},
		{id: 9223372036854775807, payload: []byte{0x08, 0xfe, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x01}},
	} {
		wire := &displayWire{}
		client := &Client{t: wire}
		if err := client.DisplayMedia(context.Background(), tc.id); err != nil {
			t.Fatal(err)
		}
		if len(wire.sent) != 1 {
			t.Fatalf("display sent %d packets", len(wire.sent))
		}
		want := append([]byte{0, 0, 0, 18, 0, 0, 0, 35}, tc.payload...)
		if !bytes.Equal(wire.sent[0], want) {
			t.Fatalf("display request = %x, want %x", wire.sent[0], want)
		}
	}
}
