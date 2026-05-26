const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const dotenv = require("dotenv");
const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const https = require("https");
const os = require("os");
const path = require("path");
const ytDlpExec = require("yt-dlp-exec");

dotenv.config();
//ff

const app = express();
const port = Number(process.env.PORT || 5000);
const apiToken = process.env.API_TOKEN || "dev-socialhub-token";
const cookiesConfig = prepareYtDlpCookies();
const ytDlp = ytDlpExec.create(resolveYtDlpPath());
const mediaProxyStore = new Map();
const mediaProxyTtlMs = 30 * 60 * 1000;

app.use(helmet());
app.use(cors());
app.use(express.json({ limit: "64kb" }));

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    service: "socialhub-resolver-api",
    ytDlpReady: fs.existsSync(resolveYtDlpPath()),
    cookiesReady: Boolean(cookiesConfig.path),
    cookiesError: cookiesConfig.error || ""
  });
});

app.post(["/api/resolve", "/api/download"], async (req, res) => {
  const requestId = createRequestId();
  const startedAt = Date.now();
  const route = req.originalUrl;

  try {
    const { url, token } = req.body || {};
    console.log(`[download:${requestId}] incoming ${req.method} ${route}`, {
      hasToken: Boolean(token),
      url: safeLogUrl(url)
    });

    if (!token || token !== apiToken) {
      console.warn(`[download:${requestId}] rejected invalid token`, {
        elapsedMs: Date.now() - startedAt
      });
      return res.status(401).json({ error: "Invalid API token" });
    }

    if (!isSupportedHttpUrl(url)) {
      console.warn(`[download:${requestId}] rejected invalid url`, {
        url: safeLogUrl(url),
        elapsedMs: Date.now() - startedAt
      });
      return res.status(400).json({ error: "A valid http/https URL is required" });
    }

    console.log(`[download:${requestId}] yt-dlp start`, {
      url: safeLogUrl(url),
      ytDlpPath: resolveYtDlpPath(),
      ytDlpReady: fs.existsSync(resolveYtDlpPath())
    });

    const resolveUrl = normalizeResolveUrl(url);
    const info = await resolveWithYtDlp(resolveUrl, requestId);

    console.log(`[download:${requestId}] yt-dlp success`, {
      title: info.title || "",
      extractor: info.extractor_key || info.extractor || "",
      formatCount: Array.isArray(info.formats) ? info.formats.length : 0,
      elapsedMs: Date.now() - startedAt
    });

    const medias = extractMediaOptions(info, req);

    if (medias.length === 0) {
      console.warn(`[download:${requestId}] no media formats found`, {
        webpageUrl: safeLogUrl(info.webpage_url || info.original_url || url),
        elapsedMs: Date.now() - startedAt
      });
      return res.status(404).json({ error: "No downloadable media formats found" });
    }

    const payload = {
      url: info.webpage_url || info.original_url || url,
      title: info.title || "Social media download",
      thumbnail: info.thumbnail || "",
      duration: formatDuration(info.duration),
      source: info.extractor_key || info.extractor || "",
      sid: info.id || "",
      medias
    };

    console.log(`[download:${requestId}] response ready`, {
      mediaCount: medias.length,
      firstQuality: medias[0] ? medias[0].quality : "",
      firstExtension: medias[0] ? medias[0].extension : "",
      firstProxyUrl: medias[0] ? safeLogUrl(medias[0].proxyUrl) : "",
      elapsedMs: Date.now() - startedAt
    });

    res.json(payload);
  } catch (error) {
    const failure = normalizeYtDlpError(error);
    console.error(`[download:${requestId}] failed`, {
      status: failure.status,
      message: failure.logMessage,
      stack: error && error.stack ? error.stack : "",
      elapsedMs: Date.now() - startedAt
    });
    res.status(failure.status).json({ error: failure.clientMessage });
  }
});

app.get("/api/media/:id", async (req, res) => {
  const requestId = createRequestId();
  const startedAt = Date.now();

  try {
    if (req.query.token !== apiToken) {
      return res.status(401).json({ error: "Invalid API token" });
    }

    cleanupMediaProxyStore();
    const media = mediaProxyStore.get(req.params.id);
    if (!media || media.expiresAt <= Date.now()) {
      mediaProxyStore.delete(req.params.id);
      return res.status(404).json({ error: "Download link expired. Resolve the URL again." });
    }

    console.log(`[media:${requestId}] proxy start`, {
      url: safeLogUrl(media.url),
      extension: media.extension,
      range: req.headers.range || ""
    });

    await proxyMedia(media, req, res);

    console.log(`[media:${requestId}] proxy complete`, {
      elapsedMs: Date.now() - startedAt
    });
  } catch (error) {
    if (!res.headersSent) {
      res.status(502).json({ error: "Unable to download media." });
    } else {
      res.destroy(error);
    }
    console.error(`[media:${requestId}] proxy failed`, {
      message: error && error.message ? error.message : String(error),
      elapsedMs: Date.now() - startedAt
    });
  }
});

app.use((_req, res) => {
  res.status(404).json({ error: "Not found" });
});

app.listen(port, "0.0.0.0", () => {
  console.log(`SocialHub resolver API running on http://0.0.0.0:${port}`);
});

function isSupportedHttpUrl(value) {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function createYtDlpOptions() {
  const options = {
    dumpSingleJson: true,
    noWarnings: true,
    skipDownload: true,
    preferFreeFormats: true,
    addHeader: ["user-agent:Mozilla/5.0 SocialHubDownloader/1.0"]
  };

  if (cookiesConfig.path) {
    options.cookies = cookiesConfig.path;
  }

  return options;
}

async function resolveWithYtDlp(url, requestId) {
  try {
    return await ytDlp(url, createYtDlpOptions());
  } catch (error) {
    if (!isYouTubeUrl(url) || !isBotCheckError(error)) {
      throw error;
    }

    console.warn(`[download:${requestId}] youtube bot check; retrying with alternate player clients`);
    return ytDlp(url, {
      ...createYtDlpOptions(),
      extractorArgs: ["youtube:player_client=android,web"]
    });
  }
}

function extractMediaOptions(info, req) {
  const formats = Array.isArray(info.formats) ? info.formats : [];
  const directEntries = formats.length > 0 ? formats : [info];
  const seen = new Set();

  return directEntries
    .filter((format) => isSupportedHttpUrl(format.url))
    .filter((format) => {
      const key = `${format.url}|${format.format_id || ""}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map((format) => {
      const extension = cleanExtension(format.ext || info.ext || guessExtension(format.url));
      const hasVideo = format.vcodec && format.vcodec !== "none";
      const hasAudio = format.acodec && format.acodec !== "none";

      return {
        url: format.url,
        proxyUrl: createMediaProxyUrl(req, {
          url: format.url,
          extension,
          headers: sanitizeRequestHeaders(format.http_headers || info.http_headers)
        }),
        quality: qualityLabel(format),
        extension,
        size: normalizeSize(format.filesize || format.filesize_approx),
        formattedSize: formatBytes(format.filesize || format.filesize_approx),
        videoAvailable: hasVideo || (!hasAudio && !audioExtensions.has(extension)),
        audioAvailable: hasAudio || audioExtensions.has(extension),
        chunked: Boolean(format.protocol && String(format.protocol).includes("m3u8")),
        cached: false,
        requiresRendering: false,
        headers: sanitizeRequestHeaders(format.http_headers || info.http_headers)
      };
    })
    .sort((a, b) => {
      const aCombined = a.videoAvailable && a.audioAvailable ? 1 : 0;
      const bCombined = b.videoAvailable && b.audioAvailable ? 1 : 0;
      if (aCombined !== bCombined) return bCombined - aCombined;
      const aVideo = a.videoAvailable ? 1 : 0;
      const bVideo = b.videoAvailable ? 1 : 0;
      if (aVideo !== bVideo) return bVideo - aVideo;
      return (b.size || 0) - (a.size || 0);
    })
    .slice(0, 12);
}

function createMediaProxyUrl(req, media) {
  const id = crypto.randomBytes(18).toString("base64url");
  mediaProxyStore.set(id, {
    ...media,
    expiresAt: Date.now() + mediaProxyTtlMs
  });

  return `${getPublicBaseUrl(req)}/api/media/${id}?token=${encodeURIComponent(apiToken)}`;
}

function getPublicBaseUrl(req) {
  if (process.env.PUBLIC_BASE_URL) {
    return process.env.PUBLIC_BASE_URL.replace(/\/+$/, "");
  }

  const protocol = req.get("x-forwarded-proto") || req.protocol || "http";
  const host = req.get("x-forwarded-host") || req.get("host");
  return `${protocol}://${host}`;
}

function cleanupMediaProxyStore() {
  const now = Date.now();
  for (const [id, media] of mediaProxyStore.entries()) {
    if (media.expiresAt <= now) {
      mediaProxyStore.delete(id);
    }
  }
}

function proxyMedia(media, clientReq, clientRes, redirectCount = 0) {
  if (redirectCount > 5) {
    return Promise.reject(new Error("Too many media redirects"));
  }

  return new Promise((resolve, reject) => {
    const parsed = new URL(media.url);
    const transport = parsed.protocol === "http:" ? http : https;
    const headers = {
      ...media.headers,
      "User-Agent": media.headers["User-Agent"] || media.headers["user-agent"] || "Mozilla/5.0 SocialHubDownloader/1.0"
    };

    if (clientReq.headers.range) {
      headers.Range = clientReq.headers.range;
    }

    const upstreamReq = transport.get(
      media.url,
      {
        headers,
        timeout: 180000
      },
      (upstreamRes) => {
        if (isRedirect(upstreamRes.statusCode) && upstreamRes.headers.location) {
          upstreamRes.resume();
          media.url = new URL(upstreamRes.headers.location, media.url).toString();
          proxyMedia(media, clientReq, clientRes, redirectCount + 1).then(resolve, reject);
          return;
        }

        if (upstreamRes.statusCode < 200 || upstreamRes.statusCode > 299) {
          upstreamRes.resume();
          reject(new Error(`Media upstream returned ${upstreamRes.statusCode}`));
          return;
        }

        clientRes.status(upstreamRes.statusCode);
        copyResponseHeader(upstreamRes, clientRes, "content-type");
        copyResponseHeader(upstreamRes, clientRes, "content-length");
        copyResponseHeader(upstreamRes, clientRes, "content-range");
        copyResponseHeader(upstreamRes, clientRes, "accept-ranges");
        clientRes.setHeader("Content-Disposition", `attachment; filename="socialhub.${media.extension || "mp4"}"`);

        upstreamRes.pipe(clientRes);
        upstreamRes.on("end", resolve);
        upstreamRes.on("error", reject);
      }
    );

    upstreamReq.on("timeout", () => upstreamReq.destroy(new Error("Timed out while downloading media")));
    upstreamReq.on("error", reject);
    clientReq.on("close", () => upstreamReq.destroy());
  });
}

function copyResponseHeader(from, to, headerName) {
  const value = from.headers[headerName];
  if (value) {
    to.setHeader(headerName, value);
  }
}

function isRedirect(statusCode) {
  return [301, 302, 303, 307, 308].includes(statusCode);
}

function qualityLabel(format) {
  if (format.format_note) return String(format.format_note);
  if (format.resolution && format.resolution !== "audio only") return String(format.resolution);
  if (format.height) return `${format.height}p`;
  if (format.abr) return `${Math.round(format.abr)}kbps`;
  return format.format_id ? `Format ${format.format_id}` : "Media";
}

function cleanExtension(value) {
  const ext = String(value || "mp4").replace(/^\./, "").toLowerCase();
  return /^[a-z0-9]{2,5}$/.test(ext) ? ext : "mp4";
}

function guessExtension(url) {
  try {
    const pathname = new URL(url).pathname;
    const ext = pathname.split(".").pop();
    return ext || "mp4";
  } catch {
    return "mp4";
  }
}

function normalizeSize(value) {
  return Number.isFinite(Number(value)) ? Math.round(Number(value)) : null;
}

function formatBytes(value) {
  const bytes = normalizeSize(value);
  if (!bytes || bytes <= 0) return null;
  const kb = bytes / 1024;
  const mb = kb / 1024;
  const gb = mb / 1024;
  if (gb >= 1) return `${gb.toFixed(1)} GB`;
  if (mb >= 1) return `${mb.toFixed(1)} MB`;
  return `${kb.toFixed(1)} KB`;
}

function formatDuration(seconds) {
  const totalSeconds = Number(seconds);
  if (!Number.isFinite(totalSeconds) || totalSeconds <= 0) return "--:--";
  const minutes = Math.floor(totalSeconds / 60);
  const remainingSeconds = Math.floor(totalSeconds % 60);
  return `${minutes}:${String(remainingSeconds).padStart(2, "0")}`;
}

function sanitizeRequestHeaders(headers) {
  if (!headers || typeof headers !== "object") {
    return {};
  }

  return Object.fromEntries(
    Object.entries(headers)
      .filter(([key, value]) => typeof key === "string" && typeof value === "string")
      .filter(([key, value]) => key.trim() && value.trim())
      .filter(([key]) => !["cookie", "authorization"].includes(key.toLowerCase()))
  );
}

const audioExtensions = new Set(["mp3", "m4a", "aac", "wav", "ogg", "opus"]);

function createRequestId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function safeLogUrl(value) {
  if (typeof value !== "string" || value.trim() === "") return "";
  try {
    const parsed = new URL(value);
    return `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
  } catch {
    return String(value).slice(0, 120);
  }
}

function normalizeResolveUrl(value) {
  try {
    const parsed = new URL(value);

    if (isYouTubeHost(parsed.hostname)) {
      ["feature", "si", "app", "pp", "embeds_referring_euri", "embeds_referring_origin"].forEach((key) => {
        parsed.searchParams.delete(key);
      });
    }

    return parsed.toString();
  } catch {
    return value;
  }
}

function normalizeYtDlpError(error) {
  const rawMessage = error && error.message ? error.message : "Unable to resolve media";
  const logMessage = rawMessage.replace(/\s+null\s*$/i, "").trim();

  if (/does not look like a netscape format cookies file|skipping cookie file entry/i.test(logMessage)) {
    return {
      status: 500,
      logMessage,
      clientMessage: "YT_DLP_COOKIES_B64 is invalid. Use a base64 encoded Netscape cookies.txt export."
    };
  }

  if (/sign in to confirm|not a bot|cookies/i.test(logMessage)) {
    return {
      status: 403,
      logMessage,
      clientMessage: "YouTube blocked this server. Add YouTube cookies in YT_DLP_COOKIES_B64 or try another video."
    };
  }

  if (/this video is not available|video unavailable|private video|removed by/i.test(logMessage)) {
    return {
      status: 404,
      logMessage,
      clientMessage: "This video is not available."
    };
  }

  if (/unsupported url|not supported/i.test(logMessage)) {
    return {
      status: 400,
      logMessage,
      clientMessage: "Unsupported URL."
    };
  }

  return {
    status: 502,
    logMessage,
    clientMessage: "Unable to resolve media."
  };
}

function isBotCheckError(error) {
  const message = error && error.message ? error.message : "";
  return /sign in to confirm|not a bot/i.test(message);
}

function prepareYtDlpCookies() {
  if (process.env.YT_DLP_COOKIES_PATH) {
    return fs.existsSync(process.env.YT_DLP_COOKIES_PATH)
      ? { path: process.env.YT_DLP_COOKIES_PATH, error: "" }
      : warnAndSkipCookies("YT_DLP_COOKIES_PATH is set, but the file does not exist.");
  }

  const cookieResult = readCookieTextFromEnv();
  if (!cookieResult.text) {
    return { path: "", error: cookieResult.error || "" };
  }

  const cookieText = cookieResult.text.replace(/\\n/g, "\n");
  if (!isNetscapeCookieFile(cookieText)) {
    return {
      path: "",
      error: "YT_DLP_COOKIES_B64 is invalid. Paste a base64 encoded Netscape cookies.txt export."
    };
  }

  const destination = path.join(os.tmpdir(), "yt-dlp-cookies.txt");
  fs.writeFileSync(destination, cookieText, { mode: 0o600 });
  return { path: destination, error: "" };
}

function readCookieTextFromEnv() {
  if (process.env.YT_DLP_COOKIES_B64) {
    const encoded = process.env.YT_DLP_COOKIES_B64.trim().replace(/\s/g, "");

    if (!isBase64Text(encoded)) {
      return {
        text: "",
        error: "YT_DLP_COOKIES_B64 is not valid base64, so cookies were skipped. Use YT_DLP_COOKIES for raw cookies or encode cookies.txt first."
      };
    }

    return { text: Buffer.from(encoded, "base64").toString("utf8"), error: "" };
  }

  return { text: process.env.YT_DLP_COOKIES || "", error: "" };
}

function warnAndSkipCookies(error) {
  console.warn(error);
  return { path: "", error };
}

function isBase64Text(value) {
  if (!value || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    return false;
  }

  return Buffer.from(value, "base64").toString("base64") === value;
}

function isNetscapeCookieFile(value) {
  const text = value.trim();
  return text.startsWith("# Netscape HTTP Cookie File") || text.split(/\r?\n/).some((line) => {
    if (!line || line.startsWith("#")) return false;
    return line.split("\t").length >= 7;
  });
}

function isYouTubeUrl(value) {
  try {
    return isYouTubeHost(new URL(value).hostname);
  } catch {
    return false;
  }
}

function isYouTubeHost(hostname) {
  const host = hostname.toLowerCase();
  return host === "youtu.be" || host === "youtube.com" || host.endsWith(".youtube.com");
}

function resolveYtDlpPath() {
  const binaryName = process.platform === "win32" ? "yt-dlp.exe" : "yt-dlp";
  return process.env.YOUTUBE_DL_PATH || `${__dirname}/../node_modules/yt-dlp-exec/bin/${binaryName}`;
}
