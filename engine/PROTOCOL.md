# Embedded Frameo engine protocol, version 1

The Homey app launches one engine process per operation, with no shell. It sends
one UTF-8 JSON object to stdin, closes stdin, and reads one JSON response from
stdout. No diagnostic output belongs on stdout or stderr. The engine never reads
or writes a configuration file and never contacts the user's NAS.

Requests are limited to 512 KiB. Supported operations are `probe`, `pair`, `info`,
`send`, `permission`, `listMedia`, `getMedia`, `deleteMedia`, and `listFrames`.
Unknown fields and operations are rejected. `network`
accepts `auto` (default), `local`, or `relay`. All operations have deadlines;
the wrapper also enforces a process deadline.

`config` is the opaque upstream configuration object, containing a private
identity. Only private app settings may persist it. Never include it in logs,
diagnostics, public settings, Flow tokens, errors, or pairing UI responses.

`pair` takes a 7–31 digit friend `code` and optional sender `name` (default
`Homey`). Pairing proves the protocol exchange using `GetInfo`. It never calls
`SendPhoto` and never asks for a test photo. Its public result includes
`peer`, `name`, `width`, `height`, `protocolConfirmed`, `paired`, and `confirmed`.
The response also contains `config` for private persistence. If pairing succeeds
but the information request fails, `PAIR_CONFIRMATION_FAILED` returns that
configuration with `result.paired: true` and `result.confirmed: false`. Persist
the identity privately and retry `info`; do not present an unconfirmed device as
ready.

`info` and `send` require a valid saved `config`. They never generate an identity.
`peer` is the paired frame's 64-character public-key identifier; when omitted,
the saved default is used. `info` returns only a bounded, public projection of
the frame's `GetInfo` response:

* `name`, `placement`, `width` and `height` are the frame's declared name,
  placement text and screen dimensions. Missing, excessive or control-bearing
  placement text becomes an empty string; it is never inferred from Homey zones.
* `maySharePairing`, `mayBackup`, `mayView` and `mayManage` are the protocol's
  permission booleans for the Homey client identity. A false flag means the frame
  did not report that permission as granted; it does not establish that the frame
  hardware lacks the feature or that a Frameo subscription is inactive.
* `maxVideoWidth` and `maxVideoHeight` are positive advertised video capability
  limits, independently bounded to 16,384 pixels. A missing, zero, negative or
  implausible value is JSON `null` (unknown), not a claim of unsupported video.
  Exposing these limits does not add video transmission to this app.
* `protocolConfirmed` records the successful information exchange. `route` is
  included only for the actual `local` or `relay` connection used for that request.

These fields are also included in a successful `pair` result. Unreconstructed
`has_backup`, `current_state` and `api_environment` enum values are not exposed or
translated into backup, screen or power states. Async service/account identifiers
and the ambiguously scoped active-session flag are omitted. This operation does
not enumerate photos or issue any screen, backup or management command.

`name` on `info` and `send` overrides the sender name for that connection without
changing the saved identity or requiring a new pairing.
Sender names are limited to 80 Unicode code points, and captions to 1,000.

`permission` is an explicit request using the existing paired identity. It requires
saved `config`, a paired `peer`, and `access: "view"` or `access: "manage"`.
`manage` includes viewing and is confirmed only when the frame reports both the
view and management flags. This operation never creates an account or identity,
pairs a frame, enumerates media, sends a photo, or deletes anything. No permission
request is issued automatically during pairing, startup, `info`, or `send`.

The upstream `RequestPermission` helper checks whether the grant already exists.
If missing it asks the frame to display its authorization prompt, then checks
`GetInfo` at two-second intervals. The complete operation, including connection,
has a 75-second deadline; the parent should allow 80 seconds for process cleanup.
A final valid `GetInfo` response must confirm the requested permission. Successful
output contains the normal public information fields plus `access` and
`granted: true`; no private configuration is returned or modified.

Invalid access is `INVALID_ACCESS`. A known permission refusal is
`PERMISSION_DENIED`; a wait that expires without confirmation is
`PERMISSION_TIMEOUT`, which does not prove that the owner pressed Deny. The
upstream implementation cannot identify every possible refusal encoding, so an
unrecognized or silent refusal can time out. A final response missing the
requested flags is `PERMISSION_NOT_GRANTED`. Cancellation is `ABORTED` and other
connection/protocol failures retain their existing controlled error codes. Errors
never include the code, private identity, raw frame response, or upstream details.

`send` takes an absolute local `path`, optional `caption` and boolean `fit`.
The caller downloads and validates network images. The engine accepts only a
regular, non-symlink JPEG, PNG, or WebP file of at most 20 MiB. Successful output
contains `peer`, decimal-string `mediaId`, `bytes`, `confirmed: true`, and `route`.
Success means the frame acknowledged delivery; it does not prove on-screen
display or wake the screen.
The upstream sender reads the whole image into memory, bounded here by the
20 MiB input limit. Operations other than the three explicit gallery operations
reject incoming multipart replies and limit incoming session traffic to 1 MiB
before the upstream reassembler sees it.

`listMedia`, `getMedia`, and `deleteMedia` require the existing saved identity and
paired frame. They first obtain valid frame information and check the existing
permission flags. Listing and preview retrieval require view permission; deletion
requires both view and management permission. Missing permission returns
`PERMISSION_REQUIRED`. These operations never ask for permission automatically,
pair a frame, create an identity, send a photo, or return private configuration.

`listMedia` has a 20-second overall deadline, including connection. It returns
`{ peer, items, count }`, with at most 10,000 items and a response smaller than
2 MiB. Each item has only the frame-reported `mediaId`, `type`, `visible`,
`captureDate`, and `receiveDate`. Identifiers are canonical signed 64-bit decimal
**strings**, preserving every digit in JavaScript. Types are `photo`, `video`,
`greeting`, or `unknown`; dates are UTC ISO strings or JSON `null` when missing or
out of range. Duplicate identifiers, excessive lists, and malformed responses
are rejected. No sender, owner, caption, or association with Homey is inferred.

`getMedia` takes one exact `mediaId`, `size: "preview"` (also the default), an
optional `encoding: "jpeg"`, and an absolute local output `path`. Omitting
encoding preserves the original preview format; other encoding values are
rejected. Full-resolution downloads are unavailable. The
caller must precreate an empty regular file with mode 0600 inside a private
directory with mode 0700. The engine rejects symlinks, nonempty files and paths
whose file changes between inspection and opening. It opens without creation or
truncation, and never returns the path. The caller removes the temporary file
after use or failure; it must never place it in Homey's public `/userdata`.

The preview request uses upstream `SizePreview` (256), makes one attempt, and
has a 25-second overall deadline including connection, with a maximum 20-second
fetch wait. The frame chooses a stored copy rather than promising 256 pixels.
The response header must identify the selected media exactly. Both the complete
declared transfer and the resulting image are limited to 4 MiB. Actual image
signatures identify JPEG, PNG, or static WebP, including the WebP format into which
Frameo re-encodes real stored previews. JPEG/PNG use `image.DecodeConfig`; WebP
uses a bounded RIFF/header reader for VP8, VP8L, and VP8X without an additional
dependency. The latter checks the declared container and chunk lengths, padding,
keyframe/lossless headers, and matching canvas/bitstream dimensions. Multiple
image bitstreams, animation, truncation, and conflicting dimensions are rejected.
Dimensions must be positive and no greater than 2,048 pixels per side and
4,000,000 pixels total. Without an explicit encoding request no full image decode
is performed. No advertised upstream dimensions or extension substitute for
inspecting the actual bytes.

Only the native device image requests `encoding: "jpeg"`, because Homey's native
image service rejected actual WebP previews during live testing. After all byte
and dimension limits pass, WebP is independently checked with the pinned
golang.org/x/image v0.47.0 DecodeConfig, then decoded. PNG can also be converted;
JPEG input retains its original bytes. Decoded dimensions must match the verified
headers. Transparency is composited on white, and JPEG quality 85 is encoded
through a writer limited to 4 MiB. Cancellation is checked around decoding and
encoding. Only one selected preview is processed; gallery requests keep their
existing original-format behavior. Result MIME, extension, byte count and SHA256
describe the converted output. There is no external converter or runtime service.

Success writes only the verified preview bytes
to the temporary file and returns
`{ peer, mediaId, bytes, extension, mime, width, height, sha256 }`.
There is no base64 or image data in JSON.

`deleteMedia` takes one exact canonical `mediaId`. Wildcards, arrays, additional
identifiers, and out-of-range numbers are rejected. With a 25-second overall
deadline, it obtains the current listing, requires that exact identifier to be
present, sends one deletion command, waits for its correlated acknowledgement,
then obtains a new listing. Only acknowledgement plus absence of the identifier
returns `{ peer, mediaId, acknowledged: true, deleted: true }`.

There are no automatic deletion retries. Once the native deletion call starts,
any failure, refusal, cancellation, timeout, malformed verification, or identifier
still present returns `DELETE_UNVERIFIED`, with
`result: { peer, mediaId, acknowledged: boolean, deleted: null }`. This means the
frame may have applied the command; it does not claim that nothing changed.
Refresh the listing before deciding on any further action. Failures before the
deletion call keep their normal error, such as `TIMEOUT` or `MEDIA_NOT_FOUND`.

Gallery transport reassembly occurs in this adapter before upstream sees any
multipart frame. At most two messages may be partial at once. Each metadata
message is limited to 2 MiB; preview messages to 4 MiB plus 64 KiB of framing;
cumulative inbound wire traffic is limited to 6 MiB per gallery connection.
Fragment positions and lengths are checked, conflicting duplicates rejected,
and only the response types needed for that operation can be reassembled.
Metadata entries are counted directly on the protobuf wire before allocating
upstream's repeated message objects. Preview headers are checked before
upstream's larger media accumulator sees them, and segment bytes cannot exceed
the bounded declaration. Original upstream source files are unchanged.

Gallery errors include `INVALID_MEDIA_ID`, `MEDIA_NOT_FOUND`, `PERMISSION_REQUIRED`,
`MEDIA_TOO_LARGE`, `IMAGE_FORMAT_UNSUPPORTED`, `INVALID_FRAME_RESPONSE`,
`INVALID_OUTPUT`, `MEDIA_WRITE_FAILED`, and `DELETE_UNVERIFIED`. The parent should
allow 25 seconds for listing and 30 seconds for preview or deletion process
cleanup, while still treating an interrupted deletion as uncertain.

`probe` is entirely offline and returns engine/IPC version, OS, architecture,
and the pinned upstream revision. `listFrames` is also offline and returns only
public paired-frame metadata.

Semantic errors use `{ "ok": false, "error": { "code": "...", "message": "..." } }`.
Messages are fixed, do not interpolate request data or upstream errors, and
never include a pairing code, key, or private configuration. Processes exit
normally after writing such a response. A malformed/missing process response
is a wrapper error.
