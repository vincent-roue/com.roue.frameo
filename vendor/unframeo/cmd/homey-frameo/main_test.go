// SPDX-License-Identifier: GPL-3.0-or-later
package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"hash/crc32"
	"image"
	"image/jpeg"
	"image/png"
	"io"
	"os"
	"path/filepath"
	"reflect"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/borje/unframeo/internal/config"
	"github.com/borje/unframeo/internal/frameo"
	"github.com/borje/unframeo/internal/frameo/pb"
	"github.com/borje/unframeo/internal/sdg"
	"google.golang.org/protobuf/proto"
)

type fakeSession struct {
	infoCalls, sendCalls             int
	permissionCalls                  int
	requestedPermission              frameo.Permission
	onPermission                     func(context.Context, frameo.Permission) error
	info                             *pb.FrameInfo
	infoErr, sendErr                 error
	lastPhoto                        frameo.Photo
	closed                           bool
	mediaID                          int64
	listCalls, getCalls, deleteCalls int
	lists                            [][]*pb.MediaMetaData
	listErrors                       []error
	download                         *frameo.Download
	getErr, deleteErr                error
	lastFetch                        frameo.Fetch
	deletedIDs                       []int64
}

func (f *fakeSession) GetInfo(context.Context) (*pb.FrameInfo, error) {
	f.infoCalls++
	if f.info != nil {
		return f.info, f.infoErr
	}
	return &pb.FrameInfo{Name: "Living room", ScreenWidth: 2000, ScreenHeight: 1200}, f.infoErr
}
func (f *fakeSession) SendPhoto(_ context.Context, photo frameo.Photo) (int64, error) {
	f.sendCalls++
	f.lastPhoto = photo
	return f.mediaID, f.sendErr
}
func (f *fakeSession) RequestPermission(ctx context.Context, permission frameo.Permission) error {
	f.permissionCalls++
	f.requestedPermission = permission
	if f.onPermission != nil {
		return f.onPermission(ctx, permission)
	}
	return nil
}
func (f *fakeSession) ListMedia(context.Context) ([]*pb.MediaMetaData, error) {
	index := f.listCalls
	f.listCalls++
	var items []*pb.MediaMetaData
	var err error
	if index < len(f.lists) {
		items = f.lists[index]
	}
	if index < len(f.listErrors) {
		err = f.listErrors[index]
	}
	return items, err
}
func (f *fakeSession) GetMedia(_ context.Context, fetch frameo.Fetch) (*frameo.Download, error) {
	f.getCalls++
	f.lastFetch = fetch
	return f.download, f.getErr
}
func (f *fakeSession) DeleteMedia(_ context.Context, ids []int64) error {
	f.deleteCalls++
	f.deletedIDs = append([]int64(nil), ids...)
	return f.deleteErr
}
func (f *fakeSession) SetMediaVisible(context.Context, []int64, bool) error {
	return errors.New("unexpected visibility mutation")
}
func (f *fakeSession) DisplayMedia(context.Context, int64) error {
	return errors.New("unexpected display request")
}
func (f *fakeSession) Close() error { f.closed = true; return nil }

func fixtureIdentity() *sdg.Identity {
	// Synthetic fixture, not an identity used by a person or a real frame.
	return sdg.IdentityFromPrivate(sdg.Key{1, 2, 3, 4})
}
func fixturePeer() sdg.PeerID { return sdg.Key{9, 8, 7, 6} }
func fixtureConfig() *config.Config {
	key := fixturePeer().String()
	return &config.Config{
		PrivateKey: fixtureIdentity().Private.String(), ClientName: "Homey",
		DefaultFrame: key,
		Frames:       map[string]config.Frame{key: {PeerID: key, Name: "Fixture"}},
	}
}
func failIfNetwork(t *testing.T) dependencies {
	t.Helper()
	return dependencies{
		identity: func() (*sdg.Identity, error) { t.Fatal("unexpected identity generation"); return nil, nil },
		pair: func(context.Context, *config.Config, string) (sdg.PeerID, error) {
			t.Fatal("unexpected pairing")
			return sdg.Key{}, nil
		},
		connect: func(context.Context, *config.Config, sdg.PeerID, string) (frameSession, string, error) {
			t.Fatal("unexpected network connection")
			return nil, "", nil
		},
	}
}

func TestOfflineRequestsNeverReachNetwork(t *testing.T) {
	deps := failIfNetwork(t)
	if r := run(strings.NewReader(`{"operation":"probe"}`), deps); !r.OK || r.Config != nil {
		t.Fatal("offline probe failed")
	}
	for _, operation := range []string{"info", "send", "listFrames"} {
		r := execute(request{Operation: operation}, deps)
		if r.OK || r.Error.Code != "MISSING_CONFIG" {
			t.Fatalf("%s created or accepted a missing identity", operation)
		}
	}
	r := execute(request{Operation: "listFrames", Config: fixtureConfig()}, deps)
	if !r.OK || r.Config != nil {
		t.Fatal("offline list failed or exposed config")
	}
}

func TestInvalidInputFailsBeforeIdentityOrNetwork(t *testing.T) {
	deps := failIfNetwork(t)
	for _, input := range []string{
		`{"operation":"pair","code":"not-a-code"}`,
		`{"operation":"pair","code":"12345678","unknown":"secret"}`,
		`{"operation":"probe"} {"operation":"pair","code":"12345678"}`,
		`null`,
		strings.Repeat(" ", maxRequestBytes+1),
	} {
		if r := run(strings.NewReader(input), deps); r.OK {
			t.Fatal("invalid request accepted")
		}
	}
	bad := fixtureConfig()
	bad.PrivateKey = "this is not a key"
	if r := execute(request{Operation: "info", Config: bad}, deps); r.Error.Code != "INVALID_CONFIG" {
		t.Fatal("invalid configuration accepted")
	}
	unknown := sdg.Key{55}.String()
	if r := execute(request{Operation: "info", Config: fixtureConfig(), Peer: unknown}, deps); r.Error.Code != "UNKNOWN_FRAME" {
		t.Fatal("unpaired peer accepted")
	}
}

func TestPairUsesOnlyFriendAndInfoProtocol(t *testing.T) {
	client := &fakeSession{}
	identityCalls, pairCalls := 0, 0
	deps := dependencies{
		identity: func() (*sdg.Identity, error) { identityCalls++; return fixtureIdentity(), nil },
		pair: func(_ context.Context, cfg *config.Config, code string) (sdg.PeerID, error) {
			pairCalls++
			if cfg.ClientName != "Homey family" || code != "1234567890" {
				t.Fatal("pair request was changed")
			}
			return fixturePeer(), nil
		},
		connect: func(_ context.Context, _ *config.Config, peer sdg.PeerID, mode string) (frameSession, string, error) {
			if peer != fixturePeer() || mode != "auto" {
				t.Fatal("wrong peer or mode")
			}
			return client, "relay", nil
		},
	}
	r := execute(request{Operation: "pair", Code: "1234567890", Name: "Homey family"}, deps)
	if !r.OK || r.Config == nil || identityCalls != 1 || pairCalls != 1 || client.infoCalls != 1 || client.sendCalls != 0 || client.permissionCalls != 0 || !client.closed {
		t.Fatal("pairing did not use exactly pairing and information without sending a photo")
	}
	publicJSON, _ := json.Marshal(r.Result)
	if strings.Contains(string(publicJSON), r.Config.PrivateKey) || strings.Contains(string(publicJSON), "1234567890") {
		t.Fatal("public result exposed identity or code")
	}
}

func TestPairPartialFailurePreservesIdentityAndDoesNotExposeRawError(t *testing.T) {
	client := &fakeSession{infoErr: errors.New("sensitive upstream details")}
	deps := dependencies{
		identity: func() (*sdg.Identity, error) { return fixtureIdentity(), nil },
		pair:     func(context.Context, *config.Config, string) (sdg.PeerID, error) { return fixturePeer(), nil },
		connect: func(context.Context, *config.Config, sdg.PeerID, string) (frameSession, string, error) {
			return client, "local", nil
		},
	}
	r := execute(request{Operation: "pair", Code: "12345678"}, deps)
	if r.OK || r.Error.Code != "PAIR_CONFIRMATION_FAILED" || r.Config == nil || r.Config.PrivateKey != fixtureIdentity().Private.String() || client.sendCalls != 0 {
		t.Fatal("partial pairing lost identity or sent an image")
	}
	errJSON, _ := json.Marshal(r.Error)
	if strings.Contains(string(errJSON), "sensitive upstream") {
		t.Fatal("raw error was exposed")
	}
	result := r.Result.(map[string]any)
	if result["paired"] != true || result["confirmed"] != false {
		t.Fatal("incorrect partial-pair state")
	}
}

func TestSendAcknowledgementPreservesInt64AndTransientSender(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "photo.png")
	if err := os.WriteFile(path, []byte("\x89PNG\r\n\x1a\nfixture-data"), 0o600); err != nil {
		t.Fatal(err)
	}
	saved := fixtureConfig()
	client := &fakeSession{mediaID: -9223372036854775807}
	deps := failIfNetwork(t)
	deps.connect = func(_ context.Context, cfg *config.Config, _ sdg.PeerID, _ string) (frameSession, string, error) {
		if cfg.ClientName != "Different sender" {
			t.Fatal("sender override absent")
		}
		return client, "local", nil
	}
	r := execute(request{Operation: "send", Config: saved, Path: path, Name: "Different sender", Caption: "Weather", Fit: true}, deps)
	if !r.OK || r.Config != nil || client.sendCalls != 1 || client.infoCalls != 0 || client.permissionCalls != 0 || saved.ClientName != "Homey" {
		t.Fatal("send operation changed identity or used unexpected operations")
	}
	result := r.Result.(map[string]any)
	if result["mediaId"] != "-9223372036854775807" || result["confirmed"] != true {
		t.Fatal("lost exact ID or receipt status")
	}
	if client.lastPhoto.Extension != "png" || !client.lastPhoto.Fit || client.lastPhoto.Caption != "Weather" {
		t.Fatal("photo options lost")
	}
}

func TestSendForwardsAnExplicitCropFocus(t *testing.T) {
	file := filepath.Join(t.TempDir(), "photo.png")
	if err := os.WriteFile(file, []byte("\x89PNG\r\n\x1a\nfixture-data"), 0o600); err != nil {
		t.Fatal(err)
	}
	client := &fakeSession{mediaID: 3}
	deps := failIfNetwork(t)
	deps.connect = func(context.Context, *config.Config, sdg.PeerID, string) (frameSession, string, error) {
		return client, "local", nil
	}
	req := request{Operation: "send", Config: fixtureConfig(), Path: file, Center: []float32{0, 0.75}}
	if r := execute(req, deps); !r.OK || client.lastPhoto.Center == nil || *client.lastPhoto.Center != [2]float32{0, 0.75} {
		t.Fatalf("explicit crop focus was lost: %#v", r)
	}
	req.Fit = true
	if r := execute(req, failIfNetwork(t)); r.OK || r.Error.Code != "INVALID_REQUEST" {
		t.Fatal("whole-image fit accepted a crop focus")
	}
	req.Fit, req.Center = false, []float32{1.25, 0.5}
	if r := execute(req, failIfNetwork(t)); r.OK || r.Error.Code != "INVALID_REQUEST" {
		t.Fatal("an out-of-image crop focus was accepted")
	}
}

func TestSendRejectsUnreadableOversizeAndNonImageBeforeNetwork(t *testing.T) {
	deps := failIfNetwork(t)
	dir := t.TempDir()
	file := filepath.Join(dir, "not-image.png")
	if err := os.WriteFile(file, []byte("not an image"), 0o600); err != nil {
		t.Fatal(err)
	}
	large := filepath.Join(dir, "large.png")
	if err := os.WriteFile(large, []byte("\x89PNG\r\n\x1a\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Truncate(large, maxPhotoBytes+1); err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{"relative.jpg", dir, file, large, filepath.Join(dir, "missing.jpg")} {
		r := execute(request{Operation: "send", Config: fixtureConfig(), Path: path}, deps)
		if r.OK || r.Error.Code != "INVALID_IMAGE" {
			t.Fatal("unsafe image accepted")
		}
	}
}

func TestNetworkErrorsNeverEchoPrivateRequestData(t *testing.T) {
	secret := fixtureIdentity().Private.String()
	deps := failIfNetwork(t)
	deps.connect = func(context.Context, *config.Config, sdg.PeerID, string) (frameSession, string, error) {
		return nil, "", errors.New("private-key=" + secret + " code=1234567890")
	}
	r := execute(request{Operation: "info", Config: fixtureConfig()}, deps)
	data, _ := json.Marshal(r)
	if r.OK || strings.Contains(string(data), secret) || strings.Contains(string(data), "1234567890") {
		t.Fatal("private error leaked")
	}
}

func TestInfoExposesDeclaredMetadataWithoutUnknownStatesOrAccountIdentifiers(t *testing.T) {
	client := &fakeSession{info: &pb.FrameInfo{
		Name: "Salon", Placement: "  Maison é😀  ", ScreenWidth: 2000, ScreenHeight: 1200,
		HasPermissionSharePairing: true, HasPermissionToBackup: true,
		HasPermissionViewPhotos: true, HasPermissionManagePhotos: false,
		FrameCapabilities: &pb.FrameCapabilities{MaxVideoWidth: 1920, MaxVideoHeight: 1080},
		// These values deliberately have no public mapping: their meanings are
		// incomplete or they contain an account/service identifier.
		HasBackup: pb.FrameInfo_HasBackup(73), CurrentState: 81, ApiEnvironment: 92,
		AsyncInformation: &pb.AsyncInformation{ChiaId: "private-account-fixture", HasActiveSession: true},
	}}
	deps := failIfNetwork(t)
	deps.connect = func(context.Context, *config.Config, sdg.PeerID, string) (frameSession, string, error) {
		return client, "local", nil
	}
	r := execute(request{Operation: "info", Config: fixtureConfig()}, deps)
	if !r.OK || r.Config != nil || client.infoCalls != 1 || client.sendCalls != 0 || client.permissionCalls != 0 || !client.closed {
		t.Fatal("information must use one GetInfo, close the session, and never mutate identity or send a photo")
	}
	got := r.Result.(map[string]any)
	want := map[string]any{
		"peer": fixturePeer().String(), "name": "Salon", "placement": "Maison é😀",
		"width": int32(2000), "height": int32(1200),
		"maySharePairing": true, "mayBackup": true, "mayView": true, "mayManage": false,
		"maxVideoWidth": int32(1920), "maxVideoHeight": int32(1080),
		"protocolConfirmed": true, "route": "local",
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("incorrect public information mapping: %#v", got)
	}
	data, err := json.Marshal(r)
	if err != nil {
		t.Fatal(err)
	}
	for _, forbidden := range []string{"private-account-fixture", "chia", "currentState", "current_state", "hasBackup", "apiEnvironment", "hasActiveSession", fixtureIdentity().Private.String()} {
		if strings.Contains(string(data), forbidden) {
			t.Fatalf("public information leaked an excluded field: %s", forbidden)
		}
	}
}

func TestExplicitPermissionRequestsUsePairedIdentityWithoutPhotosOrAccount(t *testing.T) {
	for _, access := range []string{"view", "manage"} {
		t.Run(access, func(t *testing.T) {
			client := &fakeSession{info: &pb.FrameInfo{Name: "Salon", ScreenWidth: 2000, ScreenHeight: 1200,
				HasPermissionViewPhotos: true, HasPermissionManagePhotos: access == "manage"}}
			client.onPermission = func(ctx context.Context, permission frameo.Permission) error {
				deadline, bounded := ctx.Deadline()
				if !bounded || time.Until(deadline) <= 0 || time.Until(deadline) > 75*time.Second {
					t.Fatal("permission wait has no bounded deadline")
				}
				want := frameo.PermissionView
				if access == "manage" {
					want = frameo.PermissionManage
				}
				if permission != want {
					t.Fatal("incorrect permission requested")
				}
				return nil
			}
			saved := fixtureConfig()
			originalKey := saved.PrivateKey
			deps := failIfNetwork(t)
			deps.connect = func(_ context.Context, cfg *config.Config, peer sdg.PeerID, mode string) (frameSession, string, error) {
				if cfg.PrivateKey != originalKey || peer != fixturePeer() || mode != "local" {
					t.Fatal("permission must use the selected paired identity")
				}
				return client, "local", nil
			}
			r := execute(request{Operation: "permission", Access: access, Config: saved, Peer: fixturePeer().String(), Network: "local"}, deps)
			if !r.OK || r.Config != nil || client.permissionCalls != 1 || client.infoCalls != 1 || client.sendCalls != 0 || !client.closed {
				t.Fatal("permission operation used unexpected side effects or failed to verify the grant")
			}
			result := r.Result.(map[string]any)
			if result["access"] != access || result["granted"] != true || result["mayView"] != true || result["mayManage"] != (access == "manage") {
				t.Fatal("confirmed permission result is incorrect")
			}
			data, _ := json.Marshal(r)
			if strings.Contains(string(data), originalKey) || strings.Contains(string(data), "private_key") {
				t.Fatal("permission response exposed the private identity")
			}
			if saved.PrivateKey != originalKey {
				t.Fatal("permission request replaced identity")
			}
		})
	}
}

func TestPermissionAccessIsExplicitAndValidatedBeforeConnection(t *testing.T) {
	for _, access := range []string{"", "admin", "VIEW", "view,manage"} {
		r := execute(request{Operation: "permission", Access: access, Config: fixtureConfig()}, failIfNetwork(t))
		if r.OK || r.Error.Code != "INVALID_ACCESS" {
			t.Fatal("invalid permission access was accepted")
		}
	}
	r := execute(request{Operation: "permission", Access: "view"}, failIfNetwork(t))
	if r.OK || r.Error.Code != "MISSING_CONFIG" {
		t.Fatal("permission request must not create an identity or pair a frame")
	}
	r = execute(request{Operation: "permission", Access: "manage", Config: fixtureConfig(), Peer: sdg.Key{55}.String()}, failIfNetwork(t))
	if r.OK || r.Error.Code != "UNKNOWN_FRAME" {
		t.Fatal("permission request accepted an unpaired frame")
	}
}

func TestPermissionSuccessRequiresFinalGrantIncludingViewForManage(t *testing.T) {
	for _, flags := range [][2]bool{{false, false}, {true, false}, {false, true}} {
		client := &fakeSession{info: &pb.FrameInfo{Name: "Salon", ScreenWidth: 2000, ScreenHeight: 1200,
			HasPermissionViewPhotos: flags[0], HasPermissionManagePhotos: flags[1]}}
		deps := failIfNetwork(t)
		deps.connect = func(context.Context, *config.Config, sdg.PeerID, string) (frameSession, string, error) {
			return client, "relay", nil
		}
		r := execute(request{Operation: "permission", Access: "manage", Config: fixtureConfig()}, deps)
		if r.OK || r.Error.Code != "PERMISSION_NOT_GRANTED" || client.sendCalls != 0 || !client.closed {
			t.Fatal("management must not be reported granted without both view and manage flags")
		}
	}
}

func TestPermissionRefusalAndTimeoutUseControlledErrorsWithoutRawDetails(t *testing.T) {
	for _, sample := range []struct {
		err  error
		code string
	}{
		{&frameo.FrameError{What: "private request trace", Code: pb.Error_DECLINED}, "PERMISSION_DENIED"},
		{&frameo.FrameError{What: "private request trace", Code: pb.Error_MISSING_PERMISSION}, "PERMISSION_DENIED"},
		{context.DeadlineExceeded, "PERMISSION_TIMEOUT"},
		{sdg.ErrPeerTimeout, "PERMISSION_TIMEOUT"},
		{context.Canceled, "ABORTED"},
		{errors.New("private request trace"), "CONNECTION_FAILED"},
	} {
		client := &fakeSession{onPermission: func(context.Context, frameo.Permission) error { return sample.err }}
		deps := failIfNetwork(t)
		deps.connect = func(context.Context, *config.Config, sdg.PeerID, string) (frameSession, string, error) {
			return client, "local", nil
		}
		r := execute(request{Operation: "permission", Access: "view", Config: fixtureConfig()}, deps)
		if r.OK || r.Error.Code != sample.code || r.Config != nil || client.infoCalls != 0 || client.sendCalls != 0 || !client.closed {
			t.Fatalf("incorrect permission error handling for %s", sample.code)
		}
		data, _ := json.Marshal(r)
		if strings.Contains(string(data), "private request trace") || strings.Contains(string(data), fixtureIdentity().Private.String()) {
			t.Fatal("raw permission error exposed request details")
		}
	}
}

func TestInfoUnknownCapabilitiesStayUnknownAndUntrustedTextIsBounded(t *testing.T) {
	for _, placement := range []string{"Salon\x00secret", "Salon\nsecret", "Salon\x7fsecret", strings.Repeat("暖", 257)} {
		info := &pb.FrameInfo{Name: "Frameo", Placement: placement, ScreenWidth: 2000, ScreenHeight: 1200,
			FrameCapabilities: &pb.FrameCapabilities{MaxVideoWidth: -1, MaxVideoHeight: 16385}}
		got := infoResult(fixturePeer(), info, "untrusted address or transport detail")
		if got["placement"] != "" || got["maxVideoWidth"] != nil || got["maxVideoHeight"] != nil {
			t.Fatal("invalid placement or capability was exposed")
		}
		if _, exists := got["route"]; exists {
			t.Fatal("an unrecognized route must not be exposed")
		}
	}
	info := &pb.FrameInfo{Name: "Frameo", ScreenWidth: 2000, ScreenHeight: 1200}
	got := infoResult(fixturePeer(), info, "relay")
	if got["placement"] != "" || got["maxVideoWidth"] != nil || got["maxVideoHeight"] != nil {
		t.Fatal("missing optional values must remain empty or unknown")
	}
	for _, permission := range []string{"maySharePairing", "mayBackup", "mayView", "mayManage"} {
		if got[permission] != false {
			t.Fatal("missing proto3 permission flag must not be promoted to granted")
		}
	}
	data, err := json.Marshal(got)
	if err != nil || !strings.Contains(string(data), `"maxVideoWidth":null`) || !strings.Contains(string(data), `"maxVideoHeight":null`) {
		t.Fatal("unknown video limits must serialize as null rather than zero or unsupported")
	}
}

func TestUnicodeLimitsAcceptAccentsAndBoundByCodePoints(t *testing.T) {
	deps := failIfNetwork(t)
	client := &fakeSession{}
	name := strings.Repeat("é", 80)
	deps.connect = func(_ context.Context, cfg *config.Config, _ sdg.PeerID, _ string) (frameSession, string, error) {
		if cfg.ClientName != name {
			t.Fatal("Unicode sender name was changed")
		}
		return client, "local", nil
	}
	saved := fixtureConfig()
	saved.ClientName = name
	r := execute(request{Operation: "info", Config: saved, Name: name, Caption: strings.Repeat("暖", 1000)}, deps)
	if !r.OK {
		t.Fatal("valid international name or caption was rejected")
	}
	for _, req := range []request{
		{Operation: "info", Config: saved, Name: strings.Repeat("é", 81)},
		{Operation: "info", Config: saved, Caption: strings.Repeat("暖", 1001)},
	} {
		if r := execute(req, failIfNetwork(t)); r.OK || r.Error.Code != "INVALID_REQUEST" {
			t.Fatal("Unicode limit was not enforced")
		}
	}
}

type fakeWire struct {
	message []byte
	closed  bool
}

func (w *fakeWire) Send(context.Context, []byte) error   { return nil }
func (w *fakeWire) Recv(context.Context) ([]byte, error) { return w.message, nil }
func (w *fakeWire) Close() error                         { w.closed = true; return nil }

func TestInboundMultipartCannotReachReassembler(t *testing.T) {
	message := make([]byte, 8)
	binary.BigEndian.PutUint32(message[:4], 18)
	binary.BigEndian.PutUint32(message[4:8], uint32(frameo.TypeMultiPartMessage))
	wire := &fakeWire{message: message}
	transport := &boundedTransport{Transport: wire}
	if _, err := transport.Recv(context.Background()); !errors.Is(err, sdg.ErrMessageTooLarge) || !wire.closed {
		t.Fatal("unsolicited multipart response was not refused")
	}
}

func TestInboundTrafficHasCumulativeMemoryBudget(t *testing.T) {
	message := make([]byte, 16384)
	binary.BigEndian.PutUint32(message[:4], 18)
	binary.BigEndian.PutUint32(message[4:8], uint32(frameo.TypeFrameInfo))
	wire := &fakeWire{message: message}
	transport := &boundedTransport{Transport: wire}
	for i := 0; i < maxInboundBytes/len(message); i++ {
		if _, err := transport.Recv(context.Background()); err != nil {
			t.Fatal("normal traffic refused before budget was reached")
		}
	}
	if _, err := transport.Recv(context.Background()); !errors.Is(err, sdg.ErrMessageTooLarge) || !wire.closed {
		t.Fatal("unbounded unsolicited traffic accepted")
	}
}

func galleryDependencies(t *testing.T, client *fakeSession) dependencies {
	deps := failIfNetwork(t)
	deps.connect = func(ctx context.Context, _ *config.Config, _ sdg.PeerID, _ string) (frameSession, string, error) {
		if _, ok := ctx.Deadline(); !ok {
			t.Fatal("gallery request has no deadline")
		}
		return client, "local", nil
	}
	return deps
}

func galleryInfo(manage bool) *pb.FrameInfo {
	return &pb.FrameInfo{Name: "Fixture", ScreenWidth: 2000, ScreenHeight: 1200, HasPermissionViewPhotos: true, HasPermissionManagePhotos: manage}
}

func TestGalleryListingUsesExactIDsAndOnlyReportedMetadata(t *testing.T) {
	client := &fakeSession{info: galleryInfo(false), lists: [][]*pb.MediaMetaData{{
		{MediaId: -9223372036854775808, Type: pb.MediaMetaData_Type_MEDIAMETADATA_TYPE_PICTURE, IsVisible: true, CaptureDate: 1793718000000, ReceiveDate: 0},
		{MediaId: 9223372036854775807, Type: pb.MediaMetaData_Type_MEDIAMETADATA_TYPE_VIDEO, IsVisible: false, CaptureDate: -1, ReceiveDate: 1793718000000},
		{MediaId: 7, Type: pb.MediaMetaData_Type(99)},
	}}}
	r := execute(request{Operation: "listMedia", Config: fixtureConfig()}, galleryDependencies(t, client))
	if !r.OK || r.Config != nil || client.listCalls != 1 || client.sendCalls != 0 || client.permissionCalls != 0 || client.deleteCalls != 0 || !client.closed {
		t.Fatal("listing has unexpected side effects")
	}
	listing := r.Result.(map[string]any)
	items := listing["items"].([]map[string]any)
	if listing["count"] != 3 || items[0]["mediaId"] != "-9223372036854775808" || items[1]["mediaId"] != "9223372036854775807" {
		t.Fatal("listing lost exact int64 identifiers")
	}
	if items[0]["type"] != "photo" || items[1]["type"] != "video" || items[2]["type"] != "unknown" || items[0]["receiveDate"] != nil || items[1]["captureDate"] != nil {
		t.Fatal("listing invented a kind or missing date")
	}
	encoded, _ := json.Marshal(r)
	if strings.Contains(string(encoded), "private_key") || strings.Contains(string(encoded), fixtureIdentity().Private.String()) {
		t.Fatal("listing exposed private identity")
	}
}

func TestGalleryRequiresExistingPermissionWithoutRequestingItAutomatically(t *testing.T) {
	for _, operation := range []string{"listMedia", "getMedia", "deleteMedia"} {
		client := &fakeSession{}
		req := request{Operation: operation, Config: fixtureConfig(), MediaID: "123"}
		if operation == "getMedia" {
			req.Path = emptyPreviewFile(t)
		}
		r := execute(req, galleryDependencies(t, client))
		if r.OK || r.Error.Code != "PERMISSION_REQUIRED" || client.permissionCalls != 0 || client.listCalls != 0 || client.getCalls != 0 || client.deleteCalls != 0 || client.sendCalls != 0 {
			t.Fatal("gallery operation escalated permissions or bypassed the frame grant")
		}
	}
	client := &fakeSession{info: galleryInfo(false)}
	r := execute(request{Operation: "deleteMedia", Config: fixtureConfig(), MediaID: "123"}, galleryDependencies(t, client))
	if r.OK || r.Error.Code != "PERMISSION_REQUIRED" || client.deleteCalls != 0 {
		t.Fatal("view-only permission allowed deletion")
	}
}

func TestInvalidMediaIDsAndFullDownloadsFailBeforeAnyConnection(t *testing.T) {
	for _, operation := range []string{"getMedia", "deleteMedia"} {
		for _, id := range []string{"", "all", "*", "1,2", "+1", "01", "-0", "9223372036854775808", "-9223372036854775809"} {
			r := execute(request{Operation: operation, Config: fixtureConfig(), MediaID: id}, failIfNetwork(t))
			if r.OK || r.Error.Code != "INVALID_MEDIA_ID" {
				t.Fatal("invalid exact photo ID accepted")
			}
		}
	}
	r := execute(request{Operation: "getMedia", Config: fixtureConfig(), MediaID: "123", Size: "full"}, failIfNetwork(t))
	if r.OK || r.Error.Code != "INVALID_REQUEST" {
		t.Fatal("full-resolution fetch must remain unavailable")
	}
	for _, encoding := range []string{"png", "webp", "JPEG", "all"} {
		r := execute(request{Operation: "getMedia", Config: fixtureConfig(), MediaID: "123", Encoding: encoding}, failIfNetwork(t))
		if r.OK || r.Error.Code != "INVALID_REQUEST" {
			t.Fatal("invalid explicit encoding reached output or network handling")
		}
	}
}

func emptyPreviewFile(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	if err := os.Chmod(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	filename := filepath.Join(dir, "preview")
	if err := os.WriteFile(filename, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	return filename
}

func fixturePNG(t *testing.T) []byte {
	t.Helper()
	var data bytes.Buffer
	if err := png.Encode(&data, image.NewNRGBA(image.Rect(0, 0, 1, 1))); err != nil {
		t.Fatal(err)
	}
	return data.Bytes()
}

func TestPreviewWritesOnlyTheExactSelectedImageIntoPrecreatedPrivateFile(t *testing.T) {
	data := fixturePNG(t)
	client := &fakeSession{info: galleryInfo(false), download: &frameo.Download{Media: &pb.Media{Id: 123, Size: int32(len(data))}, Data: data}}
	output := emptyPreviewFile(t)
	r := execute(request{Operation: "getMedia", Config: fixtureConfig(), MediaID: "123", Path: output}, galleryDependencies(t, client))
	if !r.OK || r.Config != nil || client.getCalls != 1 || client.lastFetch.ID != 123 || client.lastFetch.Size != frameo.SizePreview || client.lastFetch.Attempts != 1 || client.listCalls != 0 || client.deleteCalls != 0 || client.sendCalls != 0 || client.permissionCalls != 0 {
		t.Fatal("preview used unsupported fetch settings or side effects")
	}
	actual, err := os.ReadFile(output)
	if err != nil || !bytes.Equal(actual, data) {
		t.Fatal("preview file differs from verified media")
	}
	result := r.Result.(map[string]any)
	if result["mediaId"] != "123" || result["mime"] != "image/png" || result["width"] != 1 || result["height"] != 1 || result["bytes"] != len(data) {
		t.Fatal("preview metadata is incorrect")
	}
	encoded, _ := json.Marshal(r)
	if strings.Contains(string(encoded), output) || strings.Contains(string(encoded), "base64") || strings.Contains(string(encoded), "private_key") {
		t.Fatal("preview response exposed paths, binary data or identity")
	}
}

func TestPreviewRejectsUnsafeTargetsWrongIDsAndRenderingBombs(t *testing.T) {
	data := fixturePNG(t)
	nonempty := emptyPreviewFile(t)
	if err := os.WriteFile(nonempty, []byte("do not overwrite"), 0o600); err != nil {
		t.Fatal(err)
	}
	r := execute(request{Operation: "getMedia", Config: fixtureConfig(), MediaID: "123", Path: nonempty}, failIfNetwork(t))
	if r.OK || r.Error.Code != "INVALID_OUTPUT" {
		t.Fatal("nonempty output accepted")
	}
	for _, sample := range []struct {
		data []byte
		id   int64
		code string
	}{
		{data, 124, "INVALID_FRAME_RESPONSE"},
		{[]byte("<html>not an image</html>"), 123, "IMAGE_FORMAT_UNSUPPORTED"},
		{append([]byte(nil), data...), 123, "MEDIA_TOO_LARGE"},
	} {
		if sample.code == "MEDIA_TOO_LARGE" {
			binary.BigEndian.PutUint32(sample.data[16:20], 2001)
			binary.BigEndian.PutUint32(sample.data[20:24], 2001)
			binary.BigEndian.PutUint32(sample.data[29:33], crc32.ChecksumIEEE(sample.data[12:29]))
		}
		client := &fakeSession{info: galleryInfo(false), download: &frameo.Download{Media: &pb.Media{Id: sample.id, Size: int32(len(sample.data))}, Data: sample.data}}
		output := emptyPreviewFile(t)
		r := execute(request{Operation: "getMedia", Config: fixtureConfig(), MediaID: "123", Path: output}, galleryDependencies(t, client))
		if r.OK || r.Error.Code != sample.code {
			t.Fatalf("unsafe preview not rejected with %s", sample.code)
		}
		stat, err := os.Stat(output)
		if err != nil || stat.Size() != 0 {
			t.Fatal("failed preview changed output bytes")
		}
	}
	actual, _ := os.ReadFile(nonempty)
	if string(actual) != "do not overwrite" {
		t.Fatal("unsafe output contents changed")
	}
}

func webpTestChunk(kind string, payload []byte) []byte {
	chunk := binary.LittleEndian.AppendUint32([]byte(kind), uint32(len(payload)))
	chunk = append(chunk, payload...)
	if len(payload)%2 != 0 {
		chunk = append(chunk, 0)
	}
	return chunk
}

func webpTestContainer(chunks ...[]byte) []byte {
	data := append([]byte("RIFF\x00\x00\x00\x00"), "WEBP"...)
	for _, chunk := range chunks {
		data = append(data, chunk...)
	}
	binary.LittleEndian.PutUint32(data[4:8], uint32(len(data)-8))
	return data
}

// The compressed pixels are deliberately absent: this boundary reads config
// headers only and must not allocate an image from a declared canvas size.
func fixtureWebP(width, height int, kind string) []byte {
	keyframe := []byte{0x10, 0, 0, 0x9d, 0x01, 0x2a, byte(width), byte(width >> 8), byte(height), byte(height >> 8)}
	image := webpTestChunk("VP8 ", keyframe)
	if kind == "VP8L" {
		bits := uint32(width-1) | uint32(height-1)<<14
		return webpTestContainer(webpTestChunk("VP8L", binary.LittleEndian.AppendUint32([]byte{0x2f}, bits)))
	}
	if kind == "VP8X" {
		canvas := []byte{0x20, 0, 0, 0, byte(width - 1), byte((width - 1) >> 8), byte((width - 1) >> 16), byte(height - 1), byte((height - 1) >> 8), byte((height - 1) >> 16)}
		// Odd metadata sizes exercise the required RIFF padding, without decoding
		// or trusting the profile while reading the image dimensions.
		return webpTestContainer(webpTestChunk("VP8X", canvas), webpTestChunk("ICCP", []byte{1, 2, 3}), image)
	}
	return webpTestContainer(image)
}

func TestPreviewAcceptsFrameoWebPHeadersAndUsesContentDimensions(t *testing.T) {
	for _, kind := range []string{"VP8", "VP8L", "VP8X"} {
		t.Run(kind, func(t *testing.T) {
			data := fixtureWebP(570, 380, kind)
			client := &fakeSession{info: galleryInfo(false), download: &frameo.Download{
				Media: &pb.Media{Id: 123, Size: int32(len(data)), FileExtension: "jpg"},
				Data:  data, Width: 1, Height: 90000,
			}}
			output := emptyPreviewFile(t)
			r := execute(request{Operation: "getMedia", Config: fixtureConfig(), MediaID: "123", Path: output}, galleryDependencies(t, client))
			if !r.OK {
				t.Fatalf("valid WebP header rejected: %#v", r.Error)
			}
			result := r.Result.(map[string]any)
			if result["mime"] != "image/webp" || result["extension"] != "webp" || result["width"] != 570 || result["height"] != 380 {
				t.Fatal("WebP result trusted advertised extension or upstream dimensions")
			}
			actual, err := os.ReadFile(output)
			if err != nil || !bytes.Equal(actual, data) || client.getCalls != 1 || client.sendCalls != 0 || client.deleteCalls != 0 || client.permissionCalls != 0 {
				t.Fatal("WebP preview changed content or caused an additional operation")
			}
		})
	}
}

func TestWebPRejectsEveryContainerTruncationAndMalformedChunkBounds(t *testing.T) {
	for _, kind := range []string{"VP8", "VP8L", "VP8X"} {
		data := fixtureWebP(570, 380, kind)
		for length := 0; length < len(data); length++ {
			if _, err := webpPreviewConfig(data[:length]); err == nil {
				t.Fatalf("%s container truncated at %d accepted", kind, length)
			}
		}
	}
	good := fixtureWebP(570, 380, "VP8")
	cases := map[string][]byte{}
	copyMutated := func(name string, data []byte, mutate func([]byte)) {
		copy := append([]byte(nil), data...)
		mutate(copy)
		cases[name] = copy
	}
	copyMutated("declared RIFF overflow", good, func(data []byte) { binary.LittleEndian.PutUint32(data[4:8], 0xffffffff) })
	copyMutated("chunk overflow", good, func(data []byte) { binary.LittleEndian.PutUint32(data[16:20], 0xffffffff) })
	copyMutated("short chunk", good, func(data []byte) { binary.LittleEndian.PutUint32(data[16:20], 2) })
	copyMutated("interframe", good, func(data []byte) { data[20] |= 1 })
	copyMutated("bad VP8 signature", good, func(data []byte) { data[23] = 0 })
	copyMutated("zero VP8 dimension", good, func(data []byte) { data[26], data[27] = 0, 0 })
	copyMutated("bad VP8L signature", fixtureWebP(570, 380, "VP8L"), func(data []byte) { data[20] = 0 })
	copyMutated("future VP8L version", fixtureWebP(570, 380, "VP8L"), func(data []byte) { data[24] |= 0x20 })
	copyMutated("VP8L nonzero padding", fixtureWebP(570, 380, "VP8L"), func(data []byte) { data[len(data)-1] = 1 })
	copyMutated("animated VP8X", fixtureWebP(570, 380, "VP8X"), func(data []byte) { data[20] |= 0x02 })
	copyMutated("VP8X conceals larger bitstream", fixtureWebP(570, 380, "VP8X"), func(data []byte) { data[24], data[25], data[26] = 0, 0, 0 })
	cases["trailing bytes"] = append(append([]byte(nil), good...), 0, 0)
	cases["two images"] = webpTestContainer(good[12:], good[12:])
	cases["no image bitstream"] = webpTestContainer(webpTestChunk("VP8X", make([]byte, 10)))
	cases["animation chunk"] = webpTestContainer(good[12:], webpTestChunk("ANMF", nil))
	for name, data := range cases {
		t.Run(name, func(t *testing.T) {
			if _, err := webpPreviewConfig(data); err == nil {
				t.Fatal("invalid WebP container accepted")
			}
		})
	}
}

func TestWebPPreviewKeepsByteAndPixelLimitsWithoutWritingRejectedContent(t *testing.T) {
	for _, sample := range []struct {
		name string
		data []byte
	}{
		{"VP8 side", fixtureWebP(2049, 1, "VP8")},
		{"VP8L side", fixtureWebP(1, 2049, "VP8L")},
		{"VP8X side", fixtureWebP(2049, 1, "VP8X")},
		{"VP8 total pixels", fixtureWebP(2001, 2001, "VP8")},
		{"VP8L total pixels", fixtureWebP(2001, 2001, "VP8L")},
		{"VP8X total pixels", fixtureWebP(2001, 2001, "VP8X")},
		{"bytes", webpTestContainer(webpTestChunk("VP8 ", make([]byte, maxPreviewBytes)))},
	} {
		t.Run(sample.name, func(t *testing.T) {
			client := &fakeSession{info: galleryInfo(false), download: &frameo.Download{Media: &pb.Media{Id: 123, Size: int32(len(sample.data))}, Data: sample.data}}
			output := emptyPreviewFile(t)
			r := execute(request{Operation: "getMedia", Config: fixtureConfig(), MediaID: "123", Path: output}, galleryDependencies(t, client))
			if r.OK || r.Error.Code != "MEDIA_TOO_LARGE" {
				t.Fatalf("oversized WebP was not rejected: %#v", r.Error)
			}
			stat, err := os.Stat(output)
			if err != nil || stat.Size() != 0 {
				t.Fatal("oversized WebP changed the temporary output")
			}
		})
	}
}

func TestExplicitJPEGPreviewConversionProducesValidJPEGWithoutChangingDefaultGalleryBytes(t *testing.T) {
	// Trivial one-pixel lossy WebP, with no personal or frame-derived content.
	webp, err := base64.StdEncoding.DecodeString("UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA")
	if err != nil {
		t.Fatal(err)
	}
	for _, source := range []struct {
		name string
		data []byte
	}{
		{"WebP", webp}, {"PNG with alpha", fixturePNG(t)},
	} {
		t.Run(source.name, func(t *testing.T) {
			for _, encoding := range []string{"", "jpeg"} {
				client := &fakeSession{info: galleryInfo(false), download: &frameo.Download{
					Media: &pb.Media{Id: 123, Size: int32(len(source.data))}, Data: source.data,
				}}
				output := emptyPreviewFile(t)
				r := execute(request{Operation: "getMedia", Config: fixtureConfig(), MediaID: "123", Path: output, Encoding: encoding}, galleryDependencies(t, client))
				if !r.OK {
					t.Fatalf("encoding %q failed: %#v", encoding, r.Error)
				}
				actual, err := os.ReadFile(output)
				if err != nil {
					t.Fatal(err)
				}
				result := r.Result.(map[string]any)
				digest := sha256.Sum256(actual)
				if result["bytes"] != len(actual) || result["sha256"] != hex.EncodeToString(digest[:]) || r.Config != nil || client.getCalls != 1 || client.sendCalls != 0 || client.deleteCalls != 0 || client.permissionCalls != 0 {
					t.Fatal("conversion changed another operation or reported input-byte metadata")
				}
				if encoding == "" {
					if !bytes.Equal(actual, source.data) {
						t.Fatal("default gallery preview was re-encoded")
					}
					continue
				}
				decoded, err := jpeg.Decode(bytes.NewReader(actual))
				if err != nil || result["mime"] != "image/jpeg" || result["extension"] != "jpg" || decoded.Bounds().Dx() != 1 || decoded.Bounds().Dy() != 1 || result["width"] != 1 || result["height"] != 1 || len(actual) > maxPreviewBytes {
					t.Fatal("converted result is not a bounded JPEG with the actual dimensions")
				}
				if source.name == "PNG with alpha" {
					r, g, b, _ := decoded.At(0, 0).RGBA()
					if r < 0xf000 || g < 0xf000 || b < 0xf000 {
						t.Fatal("transparent preview was not composited against white")
					}
				}
			}
		})
	}
}

func TestJPEGPreviewConversionChecksPixelLimitsAndRejectsInvalidPixelsBeforeWriting(t *testing.T) {
	for _, sample := range []struct {
		name string
		data []byte
		code string
	}{
		{"oversize side", fixtureWebP(2049, 1, "VP8"), "MEDIA_TOO_LARGE"},
		{"oversize pixels", fixtureWebP(2001, 2001, "VP8X"), "MEDIA_TOO_LARGE"},
		{"corrupt compressed image", fixtureWebP(570, 380, "VP8"), "IMAGE_FORMAT_UNSUPPORTED"},
	} {
		t.Run(sample.name, func(t *testing.T) {
			client := &fakeSession{info: galleryInfo(false), download: &frameo.Download{Media: &pb.Media{Id: 123, Size: int32(len(sample.data))}, Data: sample.data}}
			output := emptyPreviewFile(t)
			r := execute(request{Operation: "getMedia", Config: fixtureConfig(), MediaID: "123", Path: output, Encoding: "jpeg"}, galleryDependencies(t, client))
			if r.OK || r.Error.Code != sample.code {
				t.Fatalf("unsafe conversion was not rejected before writing: %#v", r.Error)
			}
			stat, err := os.Stat(output)
			if err != nil || stat.Size() != 0 {
				t.Fatal("failed conversion left partial image output")
			}
		})
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := encodePreviewJPEG(ctx, fixturePNG(t), "image/png", image.Config{Width: 1, Height: 1}, maxPreviewBytes); !errors.Is(err, context.Canceled) {
		t.Fatal("cancelled conversion began decoding")
	}
}

func TestJPEGPreviewWriterNeverAccumulatesBytesBeyondItsOutputLimit(t *testing.T) {
	writer := &previewJPEGWriter{limit: 4}
	if n, err := writer.Write([]byte{1, 2, 3}); n != 3 || err != nil {
		t.Fatal("bounded writer refused bytes within its allowance")
	}
	if n, err := writer.Write([]byte{4, 5}); n != 0 || !errors.Is(err, sdg.ErrMessageTooLarge) || writer.buffer.Len() != 3 {
		t.Fatal("bounded writer retained bytes exceeding its allowance")
	}
}

func TestDeleteRequiresKnownExactIDAndConfirmsAbsenceAfterAcknowledgement(t *testing.T) {
	keep := &pb.MediaMetaData{MediaId: 7}
	remove := &pb.MediaMetaData{MediaId: -9223372036854775808}
	client := &fakeSession{info: galleryInfo(true), lists: [][]*pb.MediaMetaData{{keep, remove}, {keep}}}
	r := execute(request{Operation: "deleteMedia", Config: fixtureConfig(), MediaID: "-9223372036854775808"}, galleryDependencies(t, client))
	if !r.OK || r.Config != nil || client.deleteCalls != 1 || client.listCalls != 2 || len(client.deletedIDs) != 1 || client.deletedIDs[0] != remove.MediaId || client.sendCalls != 0 || client.getCalls != 0 || client.permissionCalls != 0 {
		t.Fatal("delete did not target exactly one known ID with post-verification")
	}
	result := r.Result.(map[string]any)
	if result["acknowledged"] != true || result["deleted"] != true || result["mediaId"] != "-9223372036854775808" {
		t.Fatal("delete result is not a verified exact-ID confirmation")
	}
	unknown := &fakeSession{info: galleryInfo(true), lists: [][]*pb.MediaMetaData{{keep}}}
	r = execute(request{Operation: "deleteMedia", Config: fixtureConfig(), MediaID: "123"}, galleryDependencies(t, unknown))
	if r.OK || r.Error.Code != "MEDIA_NOT_FOUND" || unknown.deleteCalls != 0 {
		t.Fatal("delete accepted an ID absent from the current listing")
	}
}

func TestDeleteFailureAfterInvocationIsAlwaysUnverifiedAndNeverRetried(t *testing.T) {
	for _, sample := range []struct {
		deleteErr, errorAfter error
		after                 []*pb.MediaMetaData
		acknowledged          bool
	}{
		{deleteErr: context.DeadlineExceeded},
		{errorAfter: context.DeadlineExceeded, acknowledged: true},
		{after: []*pb.MediaMetaData{{MediaId: 123}}, acknowledged: true},
	} {
		client := &fakeSession{info: galleryInfo(true), lists: [][]*pb.MediaMetaData{{{MediaId: 123}}, sample.after}, listErrors: []error{nil, sample.errorAfter}, deleteErr: sample.deleteErr}
		r := execute(request{Operation: "deleteMedia", Config: fixtureConfig(), MediaID: "123"}, galleryDependencies(t, client))
		if r.OK || r.Error.Code != "DELETE_UNVERIFIED" || client.deleteCalls != 1 {
			t.Fatal("uncertain mutation was misreported or retried")
		}
		result := r.Result.(map[string]any)
		if result["acknowledged"] != sample.acknowledged || result["deleted"] != nil {
			t.Fatal("uncertain delete claimed a settled outcome")
		}
	}
	client := &fakeSession{info: galleryInfo(true), listErrors: []error{context.DeadlineExceeded}}
	r := execute(request{Operation: "deleteMedia", Config: fixtureConfig(), MediaID: "123"}, galleryDependencies(t, client))
	if r.OK || r.Error.Code != "TIMEOUT" || client.deleteCalls != 0 {
		t.Fatal("pre-mutation timeout was not kept separate from uncertain deletion")
	}
}

type sequenceWire struct {
	messages [][]byte
	closed   bool
}

func (w *sequenceWire) Send(context.Context, []byte) error { return nil }
func (w *sequenceWire) Close() error                       { w.closed = true; return nil }
func (w *sequenceWire) Recv(context.Context) ([]byte, error) {
	if len(w.messages) == 0 {
		return nil, io.EOF
	}
	message := w.messages[0]
	w.messages = w.messages[1:]
	return message, nil
}

func adapterFrame(t *testing.T, kind int32, message proto.Message) []byte {
	t.Helper()
	payload, err := proto.Marshal(message)
	if err != nil {
		t.Fatal(err)
	}
	result := make([]byte, 8, len(payload)+8)
	binary.BigEndian.PutUint32(result[:4], 18)
	binary.BigEndian.PutUint32(result[4:8], uint32(kind))
	return append(result, payload...)
}
func adapterParts(t *testing.T, message []byte, id int64) [][]byte {
	t.Helper()
	var parts [][]byte
	for offset, index := 0, int32(0); offset < len(message); offset, index = offset+adapterChunkSize, index+1 {
		end := min(len(message), offset+adapterChunkSize)
		parts = append(parts, adapterFrame(t, frameo.TypeMultiPartMessage, &pb.MultiPartMessage{MessageId: id, MessageSize: int32(len(message)), DataIndex: index, MessageData: message[offset:end]}))
	}
	return parts
}

func TestGalleryMultipartIsReassembledBeforeTheUpstreamClient(t *testing.T) {
	items := make([]*pb.MediaMetaData, 2000)
	for i := range items {
		items[i] = &pb.MediaMetaData{MediaId: int64(i + 1), CaptureDate: 1793718000000, ReceiveDate: 1793718000000}
	}
	message := adapterFrame(t, frameo.TypeAllMediaMetaData, &pb.AllMediaMetaData{MediaMetaDataItems: items})
	if len(message) <= frameo.MaxMessage {
		t.Fatal("fixture is not multipart")
	}
	parts := adapterParts(t, message, 1)
	// Out-of-order pieces are supported while staying within the two-message bound.
	parts[0], parts[1] = parts[1], parts[0]
	wire := &sequenceWire{messages: parts}
	transport := &boundedTransport{Transport: wire, policy: policyForOperation("listMedia", 0)}
	actual, err := transport.Recv(context.Background())
	if err != nil || !bytes.Equal(actual, message) || len(transport.partial) != 0 {
		t.Fatal("valid metadata fragments did not reassemble exactly")
	}
	if binary.BigEndian.Uint32(actual[4:8]) == uint32(frameo.TypeMultiPartMessage) {
		t.Fatal("upstream reassembler must never receive multipart")
	}
}

func TestPreviewMultipartAndHeaderBudgetAllowOnlyTheSelectedBoundedMedia(t *testing.T) {
	data := append(fixturePNG(t), bytes.Repeat([]byte{0}, 30000)...)
	header := adapterFrame(t, frameo.TypeMedia, &pb.Media{Id: 123, Size: int32(len(data)), FileExtension: "png"})
	segment := adapterFrame(t, frameo.TypeMediaDataSegment, &pb.MediaDataSegment{Data: data})
	wire := &sequenceWire{messages: append([][]byte{header}, adapterParts(t, segment, 1)...)}
	transport := &boundedTransport{Transport: wire, policy: policyForOperation("getMedia", 123)}
	if _, err := transport.Recv(context.Background()); err != nil {
		t.Fatal(err)
	}
	actual, err := transport.Recv(context.Background())
	if err != nil || !bytes.Equal(actual, segment) {
		t.Fatal("valid preview fragments did not reassemble")
	}
	for _, size := range []int32{maxPreviewBytes + 1, 256 << 20} {
		wire := &sequenceWire{messages: [][]byte{adapterFrame(t, frameo.TypeMedia, &pb.Media{Id: 123, Size: size})}}
		transport := &boundedTransport{Transport: wire, policy: policyForOperation("getMedia", 123)}
		if _, err := transport.Recv(context.Background()); !errors.Is(err, sdg.ErrMessageTooLarge) || !wire.closed {
			t.Fatal("oversized media header reached the upstream accumulator")
		}
	}
}

func TestGalleryWireRefusesExcessiveItemsAndAbandonedPartialMessages(t *testing.T) {
	items := make([]*pb.MediaMetaData, maxGalleryItems+1)
	for i := range items {
		items[i] = &pb.MediaMetaData{MediaId: int64(i + 1)}
	}
	message := adapterFrame(t, frameo.TypeAllMediaMetaData, &pb.AllMediaMetaData{MediaMetaDataItems: items})
	wire := &sequenceWire{messages: adapterParts(t, message, 1)}
	transport := &boundedTransport{Transport: wire, policy: policyForOperation("listMedia", 0)}
	if _, err := transport.Recv(context.Background()); !errors.Is(err, sdg.ErrMessageTooLarge) || !wire.closed {
		t.Fatal("excessive repeated metadata fields reached protobuf allocation")
	}
	var beginnings [][]byte
	for id := int64(1); id <= 3; id++ {
		beginnings = append(beginnings, adapterFrame(t, frameo.TypeMultiPartMessage, &pb.MultiPartMessage{MessageId: id, MessageSize: 30000, DataIndex: 0, MessageData: make([]byte, adapterChunkSize)}))
	}
	wire = &sequenceWire{messages: beginnings}
	transport = &boundedTransport{Transport: wire, policy: policyForOperation("listMedia", 0)}
	if _, err := transport.Recv(context.Background()); !errors.Is(err, sdg.ErrMessageTooLarge) || !wire.closed {
		t.Fatal("more than two partial messages were retained")
	}
}

// Drive the real upstream client as well as the boundary tests above. Replies
// are emitted only in answer to the corresponding request, like a frame, but
// neither a socket nor a real paired identity is involved.
type scriptedWire struct {
	replies chan []byte
	done    chan struct{}
	onSend  func([]byte) [][]byte
	once    sync.Once
}

func (w *scriptedWire) Send(ctx context.Context, message []byte) error {
	for _, reply := range w.onSend(message) {
		select {
		case w.replies <- reply:
		case <-ctx.Done():
			return ctx.Err()
		case <-w.done:
			return io.EOF
		}
	}
	return nil
}

func (w *scriptedWire) Recv(ctx context.Context) ([]byte, error) {
	select {
	case reply := <-w.replies:
		return reply, nil
	case <-ctx.Done():
		return nil, ctx.Err()
	case <-w.done:
		return nil, io.EOF
	}
}

func (w *scriptedWire) Close() error {
	w.once.Do(func() { close(w.done) })
	return nil
}

func TestGalleryAdapterAndUpstreamClientUseOnlyTheRequestedReadOperations(t *testing.T) {
	items := make([]*pb.MediaMetaData, 2000)
	for i := range items {
		items[i] = &pb.MediaMetaData{MediaId: int64(i + 1), CaptureDate: 1793718000000, ReceiveDate: 1793718000000}
	}
	data := append(fixturePNG(t), bytes.Repeat([]byte{0}, 30000)...)
	for _, operation := range []string{"listMedia", "getMedia"} {
		t.Run(operation, func(t *testing.T) {
			var requests []int32
			wire := &scriptedWire{replies: make(chan []byte, 64), done: make(chan struct{})}
			wire.onSend = func(message []byte) [][]byte {
				kind := int32(binary.BigEndian.Uint32(message[4:8]))
				requests = append(requests, kind)
				switch kind {
				case frameo.TypeGetInfo:
					return [][]byte{adapterFrame(t, frameo.TypeFrameInfo, galleryInfo(false))}
				case frameo.TypeGetAllMediaMetaData:
					return adapterParts(t, adapterFrame(t, frameo.TypeAllMediaMetaData, &pb.AllMediaMetaData{MediaMetaDataItems: items}), 1)
				case frameo.TypeGetMedia:
					var fetch pb.GetMedia
					if err := proto.Unmarshal(message[8:], &fetch); err != nil || fetch.GetMediaId() != 123 || fetch.GetWidth() != 256 || fetch.GetHeight() != 256 {
						t.Error("preview wire request differs from the exact ID and stored-preview bound")
					}
					header := adapterFrame(t, frameo.TypeMedia, &pb.Media{Id: 123, Size: int32(len(data)), FileExtension: "png"})
					segment := adapterFrame(t, frameo.TypeMediaDataSegment, &pb.MediaDataSegment{Data: data})
					return append([][]byte{header}, adapterParts(t, segment, 2)...)
				default:
					t.Errorf("read-only operation sent unexpected protocol command %d", kind)
					return nil
				}
			}
			deps := failIfNetwork(t)
			deps.connect = func(ctx context.Context, cfg *config.Config, _ sdg.PeerID, _ string) (frameSession, string, error) {
				return newFrameClient(wire, cfg, policyFromContext(ctx)), "local", nil
			}
			req := request{Operation: operation, Config: fixtureConfig(), MediaID: "123"}
			if operation == "getMedia" {
				req.Path = emptyPreviewFile(t)
			}
			r := execute(req, deps)
			if !r.OK || r.Config != nil {
				t.Fatalf("layered gallery operation failed: %#v", r.Error)
			}
			want := []int32{frameo.TypeGetInfo, frameo.TypeGetAllMediaMetaData}
			if operation == "getMedia" {
				want[1] = frameo.TypeGetMedia
				actual, err := os.ReadFile(req.Path)
				if err != nil || !bytes.Equal(actual, data) {
					t.Fatal("layered preview differs from verified protocol bytes")
				}
			} else if r.Result.(map[string]any)["count"] != 2000 {
				t.Fatal("layered multipart metadata was not decoded by the upstream client")
			}
			if !reflect.DeepEqual(requests, want) {
				t.Fatalf("unexpected protocol requests: got %v want %v", requests, want)
			}
		})
	}
}

func TestDeleteThroughUpstreamClientCorrelatesAcknowledgementAndRelistsExactID(t *testing.T) {
	const selected int64 = -9223372036854775808
	var requests []int32
	lists := 0
	wire := &scriptedWire{replies: make(chan []byte, 64), done: make(chan struct{})}
	wire.onSend = func(message []byte) [][]byte {
		kind := int32(binary.BigEndian.Uint32(message[4:8]))
		requests = append(requests, kind)
		switch kind {
		case frameo.TypeGetInfo:
			return [][]byte{adapterFrame(t, frameo.TypeFrameInfo, galleryInfo(true))}
		case frameo.TypeGetAllMediaMetaData:
			lists++
			items := []*pb.MediaMetaData{{MediaId: 7}}
			if lists == 1 {
				items = append(items, &pb.MediaMetaData{MediaId: selected})
			}
			return [][]byte{adapterFrame(t, frameo.TypeAllMediaMetaData, &pb.AllMediaMetaData{MediaMetaDataItems: items})}
		case frameo.TypeDeleteMedia:
			var deletion pb.DeleteMedia
			if err := proto.Unmarshal(message[8:], &deletion); err != nil || !reflect.DeepEqual(deletion.GetMediaIds(), []int64{selected}) {
				t.Error("native command did not preserve the one exact selected signed int64 ID")
			}
			id := deletion.GetRequiresAcknowledgeReceiptId()
			// A refusal for a different command must not settle this operation.
			return [][]byte{
				adapterFrame(t, frameo.TypeAcknowledgeReceipt, &pb.AcknowledgeReceipt{AcknowledgeId: id + 1, Error: &pb.Error{Code: pb.Error_DECLINED}}),
				adapterFrame(t, frameo.TypeAcknowledgeReceipt, &pb.AcknowledgeReceipt{AcknowledgeId: id}),
			}
		default:
			t.Errorf("deletion sent an unexpected protocol command %d", kind)
			return nil
		}
	}
	deps := failIfNetwork(t)
	deps.connect = func(ctx context.Context, cfg *config.Config, _ sdg.PeerID, _ string) (frameSession, string, error) {
		return newFrameClient(wire, cfg, policyFromContext(ctx)), "local", nil
	}
	r := execute(request{Operation: "deleteMedia", Config: fixtureConfig(), MediaID: strconv.FormatInt(selected, 10)}, deps)
	if !r.OK || r.Config != nil || r.Result.(map[string]any)["deleted"] != true {
		t.Fatalf("exact deletion was not independently acknowledged and verified: %#v", r.Error)
	}
	want := []int32{frameo.TypeGetInfo, frameo.TypeGetAllMediaMetaData, frameo.TypeDeleteMedia, frameo.TypeGetAllMediaMetaData}
	if !reflect.DeepEqual(requests, want) {
		t.Fatalf("unexpected deletion protocol commands: got %v want %v", requests, want)
	}
}
