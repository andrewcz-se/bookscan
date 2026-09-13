# Bookscan

A static, mobile-first ISBN scanner and personal book catalog. No build, API key, account, backend, or npm install is needed to run the application. `package.json` exists only to run development tests.

## Run and host

Serve this directory with any static HTTP server, for example `python -m http.server 8080`, then open `http://localhost:8080`. Opening `index.html` with `file://` is not supported: JavaScript modules, camera permissions, and service workers need a web origin.

For GitHub Pages, commit these files to a repository. In **Settings → Pages**, select **Deploy from a branch**, the desired branch, and **/(root)**. Enable HTTPS and open the resulting Pages address. All asset, module, manifest, and worker paths are relative, so repository subpaths work without configuration. No build action is needed.

On iPhone, use Safari, allow camera access, and optionally choose **Share → Add to Home Screen**. Android browsers can install the app using their install menu. A phone visiting a computer's LAN HTTP address cannot use the camera: use the HTTPS Pages URL.

## Use

- Tap **Start scanning**, hold the full book barcode inside the library-drawn frame, and adjust distance until sharp. The rear camera is requested. When camera labels are already available, a recognizable standard rear lens is chosen before opening the stream. On the first permission grant the browser's chosen rear camera stays open; use the camera selector when another lens focuses better. Torch appears only when the active camera reports support.
- Valid EAN-13 book barcodes (978/979) have a two-second capture cooldown. Lookups queue while you scan. ISBN-10 can be entered manually, including a terminal X. Both forms are checksum-validated and stored as the same canonical ISBN-13, preventing equivalent duplicates.
- Metadata queries run sequentially: Open Library Books (both ISBN forms together), Open Library Search, Google Books. Each tier has a 6.5-second timeout. Search results may contain work-level rather than edition-specific dates/page counts; their source is shown in the editor and CSV. If none succeeds, enter the title and any known details. Offline additions go directly to this form.
- Tap a card or **Edit** to change metadata, reading status, shelf, rating, or notes. Camera decoding pauses while a form is open and resumes automatically when it closes. Switching away from the app turns off the camera; use **Resume camera** on return.
- Description, subjects, binding/format, and edition are saved when available and can be edited. Enter one subject per line; commas within a subject are preserved. Google descriptions are converted to plain text and categories become subjects. Open Library matches make an additional edition request, plus a linked work request if description or subjects are missing. Each extra request has the same 6.5-second timeout; failures keep the initial match. Binding and edition come only from the scanned edition, never an arbitrary edition of the work. Google matches leave binding/edition blank for manual entry.
- Existing saved books remain compatible and can have these fields filled in manually; they are not automatically looked up again. All four fields are included in CSV exports, with subjects separated by line breaks inside one quoted cell.
- Search title, author, subject, or location, and filter by reading status. Deleting requires confirmation.
- **Export CSV** opens file sharing on compatible devices. On iOS choose **Save to Files**. Otherwise the browser downloads the CSV. Canceling the share sheet does not force a download. The CSV includes all books regardless of current filters, a UTF-8 BOM, escaped multiline fields, and protection against spreadsheet formula injection.

## Local data and offline behavior

Books live in the `BookscanCatalog` IndexedDB database using Dexie, with a unique ISBN index and transactional duplicate checks. Data is local to this browser and origin; it does not sync across devices. Clearing website data or browser eviction can remove it. Export regularly. CSV import is not included.

Open the app online initially and leave it open while the service worker installs. Local app files and the pinned Dexie/scanner libraries are cached for offline launches. A failed runtime-library download prevents installing an incomplete offline worker. Covers need a connection; the local book SVG is used if unavailable. The full interface has local CSS even if the Tailwind CDN is unavailable. APIs can impose rate limits or CORS restrictions; failures fall through to the next provider, then manual entry.

Close all Bookscan tabs and reopen after publishing an update. Increment `CACHE` in `sw.js` whenever shipped files change. Service workers intentionally avoid activating new code over a currently open app. Keep the directory/hostname stable to retain access to the same local catalog.

Camera access, autofocus, torch, iOS file sharing, and install menus vary by browser and hardware. The scan frame comes directly from `qrbox`, with no mismatched decorative overlay or video cropping. The capture loop is 10 fps and requests no mandatory resolution or zoom, to accommodate older phones. Physical iPhone/Android testing is required before claiming hardware compatibility.

## Development and verification

### Standalone barcode diagnostic

Successful scans briefly turn the camera border and output panel green, show a success message, and play a short beep when browser audio is available. Repeated detections of the same barcode trigger feedback at most once every two seconds; a different barcode triggers feedback immediately. The camera-control tap enables audio for iPhone Safari. The full visible video is scanned, so the barcode need not be centered, but must be fully visible and in focus.

Open `scanner-test.html` beside the hosted app, for example `https://your-site/bookscan/scanner-test.html`, in iPhone Safari. Allow camera access, select a rear camera, and use the scanner's Start/Stop controls. The page displays the latest raw barcode value, format, and detection time; it keeps scanning after a result. It supports EAN-13 (book barcodes), EAN-8, UPC-A/E, Code 128/39, ITF, and Codabar, preserving leading zeros without ISBN validation or book lookups.

This is a single standalone HTML file using the same pinned html5-qrcode 2.3.8 CDN library as the app. It uses the library's [built-in scanner UI](https://scanapp.org/html5-qrcode-docs/docs/apis/classes/Html5QrcodeScanner) and scans the full video rather than a cropped region. It does not load app scripts or register a service worker. Upload it alongside the app or serve it separately over HTTPS; no build is needed. An iPhone cannot access the camera through a computer's LAN HTTP address. Internet access is needed for the CDN library. Camera permission/startup errors appear in the scanner controls; missing-library and insecure-context errors appear below them. Actual scanning and focus still need testing on the physical iPhone.

`npm test` runs Node's built-in test runner for ISBN normalization/checksums, metadata waterfall and timeouts, CSV encoding, scan geometry, and camera startup/lifecycle regressions. There are no development dependencies to install.

### Camera startup update (v2)

The scanner now waits for the video and decode canvas to initialize before enabling camera controls. It keeps the first rear-camera stream open instead of immediately switching lenses after permission is granted. Missing optional camera settings do not abort scanning, failed engines are discarded before retrying, and startup errors include the underlying error text.

After uploading the changed files, open the hosted page online to let the new offline cache install. Then close all Bookscan browser tabs and any installed Bookscan app window, and reopen. Do not clear website data: that removes the locally stored catalog. If startup still fails, report the full **Details:** text shown under the Start scanning button.

For device acceptance: test a 978 barcode, 979 barcode, repeated scan, multiple consecutive books, a damaged barcode via manual entry, denied camera permission, switching lenses, torch where supported, autofocus at different distances, portrait/landscape, background/resume, duplicate ISBN-10/13, offline reload after installation, edit/delete persistence after reload, and **Save to Files** with Unicode/quoted/multiline notes. Also verify modal keyboard focus and narrow-screen controls.

Source references: [html5-qrcode camera API](https://scanapp.org/html5-qrcode-docs/docs/apis/classes/Html5Qrcode), [scan configuration](https://scanapp.org/html5-qrcode-docs/docs/apis/interfaces/Html5QrcodeCameraScanConfig), [Dexie](https://dexie.org/docs/API-Reference), [Open Library Books](https://openlibrary.org/dev/docs/api/books), [Open Library Search](https://openlibrary.org/dev/docs/api/search), [Google Books](https://developers.google.com/books/docs/v1/using), [file sharing](https://developer.mozilla.org/en-US/docs/Web/API/Navigator/share).
