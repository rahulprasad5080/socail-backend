const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const dotenv = require("dotenv");
const ytDlp = require("yt-dlp-exec");

dotenv.config();

const app = express();
const port = Number(process.env.PORT || 5000);
const apiToken = process.env.API_TOKEN || "dev-socialhub-token";

app.use(helmet());
app.use(cors());
app.use(express.json({ limit: "64kb" }));

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "socialhub-resolver-api" });
});

app.post(["/api/resolve", "/api/download"], async (req, res) => {
  try {
    const { url, token } = req.body || {};

    if (!token || token !== apiToken) {
      return res.status(401).json({ error: "Invalid API token" });
    }

    if (!isSupportedHttpUrl(url)) {
      return res.status(400).json({ error: "A valid http/https URL is required" });
    }

    const info = await ytDlp(url, {
      dumpSingleJson: true,
      noWarnings: true,
      noCallHome: true,
      skipDownload: true,
      preferFreeFormats: true,
      addHeader: ["user-agent:Mozilla/5.0 SocialHubDownloader/1.0"]
    });

    const medias = extractMediaOptions(info);

    if (medias.length === 0) {
      return res.status(404).json({ error: "No downloadable media formats found" });
    }

    res.json({
      url: info.webpage_url || info.original_url || url,
      title: info.title || "Social media download",
      thumbnail: info.thumbnail || "",
      duration: formatDuration(info.duration),
      source: info.extractor_key || info.extractor || "",
      sid: info.id || "",
      medias
    });
  } catch (error) {
    const message = error && error.message ? error.message : "Unable to resolve media";
    const status = /unsupported url|not supported/i.test(message) ? 400 : 502;
    res.status(status).json({ error: message });
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
        requiresRendering: false
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

const audioExtensions = new Set(["mp3", "m4a", "aac", "wav", "ogg", "opus"]);
