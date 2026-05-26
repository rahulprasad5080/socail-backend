const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const dotenv = require("dotenv");
const fs = require("fs");
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

    if (cookiesConfig.error && isYouTubeUrl(url)) {
      return res.status(500).json({ error: cookiesConfig.error });
    }

    const resolveUrl = normalizeResolveUrl(url);
    const info = await ytDlp(resolveUrl, createYtDlpOptions());

    console.log(`[download:${requestId}] yt-dlp success`, {
      title: info.title || "",
      extractor: info.extractor_key || info.extractor || "",
      formatCount: Array.isArray(info.formats) ? info.formats.length : 0,
      elapsedMs: Date.now() - startedAt
    });

    const medias = extractMediaOptions(info);

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

function extractMediaOptions(info) {
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

function prepareYtDlpCookies() {
  if (process.env.YT_DLP_COOKIES_PATH) {
    return fs.existsSync(process.env.YT_DLP_COOKIES_PATH)
      ? { path: process.env.YT_DLP_COOKIES_PATH, error: "" }
      : { path: "", error: "YT_DLP_COOKIES_PATH is set, but the file does not exist." };
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
        error: "YT_DLP_COOKIES_B64 is not valid base64. Use YT_DLP_COOKIES for raw cookies or encode cookies.txt first."
      };
    }

    return { text: Buffer.from(encoded, "base64").toString("utf8"), error: "" };
  }

  return { text: process.env.YT_DLP_COOKIES || "", error: "" };
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
