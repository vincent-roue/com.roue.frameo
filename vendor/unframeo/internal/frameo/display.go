// SPDX-License-Identifier: GPL-3.0-or-later

package frameo

import (
	"context"
	"encoding/binary"

	"google.golang.org/protobuf/encoding/protowire"
)

// DisplayMedia requests that the frame show one stored photo. The protocol
// does not return a receipt for this request.
func (c *Client) DisplayMedia(ctx context.Context, id int64) error {
	// Frameo Local documents message 35 and sends the signed ID in field 1.
	// https://github.com/yasoob/frameo-client/blob/master/internal/protocol/client.go
	message := make([]byte, frameHeader, frameHeader+1+protowire.SizeVarint(protowire.EncodeZigZag(id)))
	binary.BigEndian.PutUint32(message[:4], framePrefix)
	binary.BigEndian.PutUint32(message[4:8], TypeDisplayMedia)
	message = protowire.AppendTag(message, 1, protowire.VarintType)
	message = protowire.AppendVarint(message, protowire.EncodeZigZag(id))
	return c.t.Send(ctx, message)
}
