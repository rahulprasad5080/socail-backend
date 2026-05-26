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
