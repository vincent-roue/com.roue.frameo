# Privacy

Frameo for Homey is an independent integration that runs on Homey Pro. It uses your paired frames, selected images and authorised media information to send photos, show previews and maintain frame counts. The app’s network requests serve frame pairing, frame communication and the image downloads you request.

## Data kept on Homey

Homey app and device storage keep the pairing identity, frame identifiers and settings, sender and group names, and the latest reported frame information. The inventory keeps a bounded list of media IDs, counts and dates to recognise additions. Activity retains up to 50 transfer jobs with destinations, identifiers, times and outcomes. You can clear completed transfers in Activity.

Homey uses temporary files to prepare photos for transfer. The app removes them after use and checks for eligible leftovers from interrupted work on startup. Gallery and widget views fetch photo previews as needed and use bounded temporary caches. Inventory checks read metadata and leave the media files on the frame.

## Connections and access

Pairing sends the friend code to Frameo’s pairing service. The app can connect to a frame directly on the local network or use Frameo’s relay. Your selected frames receive the photo and any caption you supply. For a photo sent from a URL, Homey contacts the source server, which receives the request and the requesting network address. Homey and Frameo provide their respective platform and connection services. [Homey security and privacy](https://support.homey.app/hc/en-us/articles/360015685913-Security-and-privacy-in-Homey) · [Frameo privacy policy](https://privacy.frameo.com/)

The frame controls viewing and management rights for the Homey sender. Change those rights or remove the Homey friend in **Settings → My friends** on the frame. Homey’s device settings let you change or disable periodic checks.

## Diagnostic export

Activity generates a diagnostic report on request. It contains only selected operational fields, including versions, counters, permissions, connection types, timings and error codes. Frame entries use temporary numbers. You can preview the report, then download or copy it. Sharing the exported report is your choice.
