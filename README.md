# JDrop (unofficial)

A small, dependency-free browser extension (Chrome/Brave/Edge, Manifest V3) that
sends links and **Click'N'Load** to your JDownloader through the public
[MyJDownloader](https://my.jdownloader.org) cloud API — so it works even when
JDownloader runs on a **different machine** (Docker, NAS, server), where classic
`127.0.0.1:9666` Click'N'Load can't reach it.

> **Unofficial.** This is an independent client for the public MyJDownloader
> API. It is not affiliated with or endorsed by AppWork GmbH. "JDownloader" and
> "MyJDownloader" are trademarks of AppWork GmbH.

## Why it exists

It's an independent reimplementation, informed by reading the official
extension's source (for the wire protocol and the CNL forwarding technique —
see License) and rewritten from scratch in modern vanilla JavaScript, without
the Angular 1 / jQuery / RequireJS / CryptoJS stack. **No build step** and
**no runtime dependencies**:

- All cryptography uses the browser-native **Web Crypto API** (`crypto.subtle`).
- The cloud API client runs **directly in the service worker** (`fetch` only) —
  no offscreen document, no message hops.
- Everything is ES modules you can read top-to-bottom.

## Features (current)

- Sign in with your MyJDownloader account; list online devices.
- Right-click → **Send to JDownloader** for links, pages, selections, media.
- **Click'N'Load** capture on hoster pages, forwarded to the selected device via
  a `dummycnl.jdownloader.org` URL that JDownloader decrypts locally.
- An in-page panel to pick the target device and options (package name,
  download password, destination folder, autostart).
- **CAPTCHA solving** for reCAPTCHA v2/v3/Enterprise and hCaptcha: polls
  connected devices every minute and opens a tab on the real hoster page to
  solve it, since site keys are domain-locked and won't render from an
  extension page.

  > **Not yet verified end-to-end.** The one API call this depends on for the
  > site key (`/captcha/get` with `format: "rawtoken"`) has an undocumented
  > response shape - the code's best-effort guess at its fields is marked
  > `UNVERIFIED` in `lib/captcha.js`, `lib/api.js`, and the solver content
  > script. Everything else (polling, job de-duplication, the solve/skip API
  > calls) is unit-tested against a protocol-verifying fake server; the
  > widget-rendering step itself needs confirming against a real pending
  > CAPTCHA job before it can be trusted.
- **Clipboard link observer**, off by default. When enabled (popup setting),
  copying a link (or a list of links) adds it to the same review panel used
  for right-click and CNL - it never sends automatically, even if auto-send
  is also on, since a copy is far more incidental than an explicit click.
  Detects link-shaped selections at the moment of the native `copy` event
  rather than reading the OS clipboard, so it needs no extra permission.

Not included yet (deliberately — easy to add later thanks to the module split):
autograbber, and the many hoster-specific CAPTCHA types JDownloader handles
itself outside a browser (KeyCaptcha, GeeTest, SolveMedia, and similar) -
those never route through a browser tab in the first place.

## Install (unpacked)

1. Open `chrome://extensions` (or `brave://extensions`, `edge://extensions`).
2. Enable **Developer mode**.
3. **Load unpacked** → select this project's folder.
4. Click the toolbar icon, sign in, and you're ready.

## Permissions

The manifest requests broad host access (`<all_urls>`) and `webRequest`. Both
are wide, so here's why:

| Permission | Why it's needed |
|------------|------------------|
| `<all_urls>` + `webRequest` | Click'N'Load can be triggered from *any* hoster page, and the browser only lets an extension read a request's body (the encrypted CNL payload) if it has host access to the page that made it. Without this, CNL capture would silently fail on most sites. |
| `declarativeNetRequest` | Fakes the local `jdcheck.js` / `crossdomain.xml` / `flash/add*` responses so hoster pages believe a local JDownloader answered — necessary since a real one usually isn't reachable (see "Why it exists"). |
| `scripting` | Injects the in-page panel's content script into a tab on demand (context-menu "Send to JDownloader"). |
| `contextMenus` | Adds the right-click "Send to JDownloader" entry. |
| `storage` | Stores your (encrypted-token) session and settings locally — never your password, which is discarded right after deriving the login secrets. |

Nothing here calls home anywhere except `api.jdownloader.org` (the official
MyJDownloader cloud API) and whatever hoster page you're already on. Read
`lib/api.js` and `background.js` end-to-end if you want to verify that yourself
— that's the point of keeping this dependency-free and readable.

## Development

This project was built with AI assistance ([Claude](https://claude.com/claude-code)),
under human direction and review — the protocol implementation was verified against
the official extension's source and a real MyJDownloader account before anything
was considered done. See the tests below for how that verification is reproducible.

No build, no `npm install`. Tests use Node's built-in runner (Node ≥ 18):

```
npm test        # or: node --test
```

The tests cross-check the Web Crypto implementation against Node's `node:crypto`
and drive the API client against a fake MyJDownloader server that verifies every
signature and decrypts every request body — so the handshake is proven correct,
not just shaped right.

### Layout

| Path | Responsibility |
|------|----------------|
| `lib/crypto.js` | Web Crypto primitives + MyJD token derivation (pure, tested) |
| `lib/api.js` | Cloud API client: connect, listDevices, addLinks (pure, tested) |
| `lib/cnl.js` | Click'N'Load parsing + dummycnl encoding (pure, tested) |
| `lib/captcha.js` | CAPTCHA job de-duplication, skip-type validation, rawtoken parsing (pure, tested; rawtoken parsing is UNVERIFIED, see above) |
| `lib/clipboard.js` | Clipboard-observer URL detection (pure, tested) |
| `lib/storage.js` | `chrome.storage` wrappers |
| `background.js` | Service worker: context menu, CNL faking, queue, CAPTCHA polling, routing |
| `content/` | CNL interceptor (MAIN + bridge), the panel host, the CAPTCHA solver, and the clipboard observer |
| `popup/`, `panel/` | The two UIs |
| `tests/` | `node --test` suites |

## License

Licensed under **GPL-3.0-or-later** (see `LICENSE`). This project reuses ideas
and small portions of code from the GPLv3
[MyJDownloader MV3 extension](https://github.com/magnetgrouplabs/myjdownloader-extension-mv3)
(itself derived from AppWork GmbH's original), so it stays GPLv3.
