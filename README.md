# SocialHub Resolver API

Node.js backend for resolving social media page links into downloadable media URLs.

## Setup

```bash
cd backend
npm install
copy .env.example .env
npm run dev
```

## Render deploy

Use these settings on Render:

```text
Build Command: npm install && npm run build
Start Command: npm start
```

Set the same API token that the Android app uses:

```text
API_TOKEN=dev-socialhub-token
```

Optional deploy knobs:

```text
YT_DLP_VERSION=2026.05.22
YOUTUBE_DL_PATH=/usr/local/bin/yt-dlp
YT_DLP_COOKIES_B64=<base64 encoded Netscape cookies.txt>
```

`YT_DLP_VERSION` pins the binary download to a specific yt-dlp release. `YOUTUBE_DL_PATH` uses an already-installed binary instead of downloading one during build.
`YT_DLP_COOKIES_B64` lets yt-dlp use exported YouTube cookies when Render gets "Sign in to confirm you're not a bot" from YouTube.

Create `YT_DLP_COOKIES_B64` from a Netscape-format `cookies.txt` file:

```powershell
[Convert]::ToBase64String([IO.File]::ReadAllBytes("C:\path\to\cookies.txt"))
```

The cookies file must start with `# Netscape HTTP Cookie File` or contain tab-separated Netscape cookie rows.

After deploy, open `/health`. It should return `"ytDlpReady": true`.

The Android emulator can reach this backend at:

```text
http://10.0.2.2:5000/
```

For a real phone, replace `socialDownloaderBaseUrl` in the root `gradle.properties` with your computer LAN IP, for example:

```properties
socialDownloaderBaseUrl=http://192.168.1.10:5000/
```

## API

```http
POST /api/resolve
Content-Type: application/json

{
  "url": "https://www.youtube.com/watch?v=...",
  "token": "dev-socialhub-token"
}
```

This uses `yt-dlp` under the hood, so supported platforms depend on the extractor support available in `yt-dlp`.
# socail-backend
