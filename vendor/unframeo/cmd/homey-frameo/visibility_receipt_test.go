package main

import (
	"context"
	"encoding/binary"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"sync/atomic"
	"testing"

	"github.com/borje/unframeo/internal/config"
	"github.com/borje/unframeo/internal/frameo"
	"github.com/borje/unframeo/internal/frameo/pb"
	"github.com/borje/unframeo/internal/sdg"
)

type visibilitySession struct {
	*fakeSession
	visibilityCalls int
	visible         bool
	ids             []int64
	visibilityErr   error
}

func (f *visibilitySession) SetMediaVisible(_ context.Context, ids []int64, visible bool) error {
	f.visibilityCalls++
	f.ids = append([]int64(nil), ids...)
	f.visible = visible
	return f.visibilityErr
}
func visibilityDependencies(t *testing.T, client frameSession) dependencies {
	deps := failIfNetwork(t)
	deps.connect = func(context.Context, *config.Config, sdg.PeerID, string) (frameSession, string, error) {
		return client, "local", nil
	}
	return deps
}
func visibilityRequest(visible bool) request {
	return request{Operation: "setMediaVisible", Config: fixtureConfig(), MediaID: "9223372036854775807", Visible: &visible}
}
func TestVisibilityExactIDACKAndRelistingAreRequired(t *testing.T) {
	for _, visible := range []bool{false, true} {
		client := &visibilitySession{fakeSession: &fakeSession{info: galleryInfo(true), lists: [][]*pb.MediaMetaData{
			{{MediaId: 9223372036854775807, IsVisible: !visible}, {MediaId: 9, IsVisible: true}},
			{{MediaId: 9223372036854775807, IsVisible: visible}, {MediaId: 9, IsVisible: true}},
		}}}
		result := execute(visibilityRequest(visible), visibilityDependencies(t, client))
		if !result.OK || result.Config != nil || client.visibilityCalls != 1 || client.listCalls != 2 || client.permissionCalls != 0 || client.sendCalls != 0 || client.getCalls != 0 || client.deleteCalls != 0 {
			t.Fatalf("unexpected visibility operations: %#v", result.Error)
		}
		if !reflect.DeepEqual(client.ids, []int64{9223372036854775807}) || client.visible != visible {
			t.Fatal("wrong photo or direction")
		}
		public := result.Result.(map[string]any)
		if public["visible"] != visible || public["acknowledged"] != true || public["verified"] != true || public["mediaId"] != "9223372036854775807" || public["peer"] != fixturePeer().String() {
			t.Fatal("unverified result")
		}
	}
}
func TestVisibilityRequiresExplicitBooleanAndCurrentManageGrant(t *testing.T) {
	invalid := visibilityRequest(false)
	invalid.Visible = nil
	if r := execute(invalid, failIfNetwork(t)); r.OK || r.Error.Code != "INVALID_REQUEST" {
		t.Fatal("absent boolean accepted")
	}
	for _, info := range []*pb.FrameInfo{galleryInfo(false), {ScreenWidth: 1, ScreenHeight: 1, HasPermissionManagePhotos: true}} {
		client := &visibilitySession{fakeSession: &fakeSession{info: info}}
		r := execute(visibilityRequest(false), visibilityDependencies(t, client))
		if r.OK || r.Error.Code != "PERMISSION_REQUIRED" || client.visibilityCalls != 0 || client.listCalls != 0 || client.permissionCalls != 0 {
			t.Fatal("visibility bypassed grants")
		}
	}
	client := &visibilitySession{fakeSession: &fakeSession{info: galleryInfo(true)}}
	r := execute(visibilityRequest(false), visibilityDependencies(t, client))
	if r.OK || r.Error.Code != "MEDIA_NOT_FOUND" || client.visibilityCalls != 0 {
		t.Fatal("missing selected ID was mutated")
	}
}
func TestVisibilityAmbiguityNeverRetriesOrClaimsSuccess(t *testing.T) {
	for _, failure := range []string{"write", "relist", "unchanged", "gone", "malformed"} {
		before := []*pb.MediaMetaData{{MediaId: 9223372036854775807, IsVisible: true}}
		after := []*pb.MediaMetaData{{MediaId: 9223372036854775807, IsVisible: false}}
		client := &visibilitySession{fakeSession: &fakeSession{info: galleryInfo(true), lists: [][]*pb.MediaMetaData{before, after}}}
		switch failure {
		case "write":
			client.visibilityErr = errors.New("sensitive upstream")
		case "relist":
			client.listErrors = []error{nil, context.DeadlineExceeded}
		case "unchanged":
			client.lists[1] = before
		case "gone":
			client.lists[1] = nil
		case "malformed":
			client.lists[1] = append(after, after[0])
		}
		r := execute(visibilityRequest(false), visibilityDependencies(t, client))
		if r.OK || r.Error.Code != "VISIBILITY_UNVERIFIED" || client.visibilityCalls != 1 {
			t.Fatalf("%s repeated or confirmed uncertain change", failure)
		}
	}
}

type attemptedSendSession struct {
	*fakeSession
	attempted bool
}

func (f *attemptedSendSession) SendPhoto(ctx context.Context, _ frameo.Photo) (int64, error) {
	if f.attempted {
		policyFromContext(ctx).sendAttempt.Store(true)
	}
	return 0, context.DeadlineExceeded
}
func TestSendErrorsDistinguishPreflightFromAttemptedTransfer(t *testing.T) {
	filename := filepath.Join(t.TempDir(), "fixture.png")
	if err := os.WriteFile(filename, []byte("\x89PNG\r\n\x1a\nfixture-data"), 0600); err != nil {
		t.Fatal(err)
	}
	for _, attempted := range []bool{false, true} {
		client := &attemptedSendSession{fakeSession: &fakeSession{}, attempted: attempted}
		r := execute(request{Operation: "send", Config: fixtureConfig(), Path: filename}, visibilityDependencies(t, client))
		expected := "TIMEOUT"
		if attempted {
			expected = "SEND_UNVERIFIED"
		}
		if r.OK || r.Error.Code != expected {
			t.Fatalf("attempted=%t got %v", attempted, r.Error)
		}
	}
}
func TestOnlyPhotoWireWritesMarkAnAttemptBeforeTheWrite(t *testing.T) {
	for _, kind := range []int32{frameo.TypeGetInfo, frameo.TypeClientInfo, frameo.TypeMedia, frameo.TypeMediaDataSegment, frameo.TypeMultiPartMessage} {
		marker := &atomic.Bool{}
		policy := policyForOperation("send", 0)
		policy.sendAttempt = marker
		transport := &boundedTransport{Transport: &fakeWire{}, policy: policy}
		message := make([]byte, 8)
		binary.BigEndian.PutUint32(message[:4], 18)
		binary.BigEndian.PutUint32(message[4:], uint32(kind))
		if err := transport.Send(context.Background(), message); err != nil {
			t.Fatal(err)
		}
		want := kind == frameo.TypeMedia || kind == frameo.TypeMediaDataSegment || kind == frameo.TypeMultiPartMessage
		if marker.Load() != want {
			t.Fatalf("message %d incorrect attempted flag", kind)
		}
	}
}
