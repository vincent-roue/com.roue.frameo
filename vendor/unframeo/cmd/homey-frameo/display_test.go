package main

import (
	"context"
	"errors"
	"testing"

	"github.com/borje/unframeo/internal/frameo/pb"
)

type displaySession struct {
	*fakeSession
	requested []int64
	err       error
}

func (f *displaySession) DisplayMedia(_ context.Context, id int64) error {
	f.requested = append(f.requested, id)
	return f.err
}

func TestDisplaySelectsOneStoredPhotoWithCurrentManageGrant(t *testing.T) {
	const id int64 = -9223372036854775808
	photo := &pb.MediaMetaData{MediaId: id}
	video := &pb.MediaMetaData{MediaId: id, Type: pb.MediaMetaData_Type_MEDIAMETADATA_TYPE_VIDEO}
	for _, tc := range []struct {
		name       string
		grant      bool
		items      []*pb.MediaMetaData
		writeError error
		wantCode   string
		wantSent   bool
	}{
		{name: "exact signed ID", grant: true, items: []*pb.MediaMetaData{{MediaId: 12}, photo}, wantSent: true},
		{name: "missing grant", items: []*pb.MediaMetaData{photo}, wantCode: "PERMISSION_REQUIRED"},
		{name: "missing photo", grant: true, items: []*pb.MediaMetaData{{MediaId: 12}}, wantCode: "MEDIA_NOT_FOUND"},
		{name: "video", grant: true, items: []*pb.MediaMetaData{video}, wantCode: "MEDIA_TYPE_UNSUPPORTED"},
		{name: "uncertain write", grant: true, items: []*pb.MediaMetaData{photo}, writeError: errors.New("write interrupted"), wantCode: "DISPLAY_UNVERIFIED", wantSent: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			client := &displaySession{fakeSession: &fakeSession{info: galleryInfo(tc.grant), lists: [][]*pb.MediaMetaData{tc.items}}, err: tc.writeError}
			result := execute(request{Operation: "displayMedia", Config: fixtureConfig(), MediaID: "-9223372036854775808"}, visibilityDependencies(t, client))
			if tc.wantCode == "" {
				public, _ := result.Result.(map[string]any)
				if !result.OK || public["mediaId"] != "-9223372036854775808" || public["requested"] != true || len(public) != 3 {
					t.Fatalf("display claimed more than a request or changed the selected ID: %#v", result)
				}
			} else if result.OK || result.Error.Code != tc.wantCode {
				t.Fatalf("display result = %#v, wanted %s", result, tc.wantCode)
			}
			if len(client.requested) > 1 || (len(client.requested) == 1) != tc.wantSent || (tc.wantSent && client.requested[0] != id) ||
				client.sendCalls != 0 || client.getCalls != 0 || client.deleteCalls != 0 || client.permissionCalls != 0 || client.listCalls > 1 {
				t.Fatalf("unexpected operations for display: %+v", client)
			}
		})
	}
}
