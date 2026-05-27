import os
import re
import time
import tempfile
import base64
import secrets
import httpx
import asyncio
import json
import math
from typing import Optional, Union, Dict, Any, List
from urllib.parse import urlparse, urlunparse, parse_qsl, urlencode, quote

from dotenv import load_dotenv
from fastapi import FastAPI, Request, HTTPException
from fastapi.responses import JSONResponse, StreamingResponse
from fastapi.exceptions import RequestValidationError
from starlette.exceptions import HTTPException as StarletteHTTPException
from pydantic import BaseModel

# Load environment variables
load_dotenv()

app = FastAPI(title="SocialHub Resolver API")

# API Configuration
api_token = os.getenv("API_TOKEN", "dev-socialhub-token")
MEDIA_PROXY_TTL = 30 * 60  # 30 minutes in seconds

# Global Store for Proxy Links
media_store: Dict[str, Dict[str, Any]] = {}

# Custom Exception Handlers to match Express JSON error format exactly: {"error": "..."}
@app.exception_handler(StarletteHTTPException)
async def http_exception_handler(request: Request, exc: StarletteHTTPException):
    return JSONResponse(
        status_code=exc.status_code,
        content={"error": exc.detail}
    )

@app.exception_handler(RequestValidationError)
async def validation_exception_handler(request: Request, exc: RequestValidationError):
    # Retrieve the first validation error message or a generic one
    errors = exc.errors()
    error_msg = "Invalid request format"
    if errors:
        loc = " -> ".join(str(x) for x in errors[0].get("loc", []))
        msg = errors[0].get("msg", "validation error")
        error_msg = f"Validation failed at {loc}: {msg}"
    return JSONResponse(
        status_code=400,
        content={"error": error_msg}
    )

# --- Helper Functions ---

def is_netscape_cookie_file(text: str) -> bool:
    trimmed = text.strip()
    if trimmed.startswith("# Netscape HTTP Cookie File"):
        return True
    for line in trimmed.splitlines():
        if not line or line.startswith("#"):
            continue
        if len(line.split("\t")) >= 7:
            return True
    return False

def prepare_yt_dlp_cookies() -> Dict[str, str]:
    cookies_path = os.getenv("YT_DLP_COOKIES_PATH")
    if cookies_path:
        if os.path.exists(cookies_path):
            return {"path": cookies_path, "error": ""}
        else:
            print(f"YT_DLP_COOKIES_PATH is set, but the file does not exist: {cookies_path}")
            return {"path": "", "error": f"YT_DLP_COOKIES_PATH file not found at {cookies_path}"}

    cookies_b64 = os.getenv("YT_DLP_COOKIES_B64")
    cookie_text = ""
    if cookies_b64:
        encoded = cookies_b64.strip().replace(" ", "").replace("\n", "").replace("\r", "")
        try:
            decoded_bytes = base64.b64decode(encoded)
            cookie_text = decoded_bytes.decode("utf-8", errors="replace")
        except Exception:
            return {
                "path": "",
                "error": "YT_DLP_COOKIES_B64 is invalid. Paste a base64 encoded Netscape cookies.txt export."
            }
    else:
        cookie_text = os.getenv("YT_DLP_COOKIES") or ""

    if not cookie_text:
        return {"path": "", "error": ""}

    # Normalize literal \n or \\n characters
    cookie_text = cookie_text.replace("\\n", "\n")

    if not is_netscape_cookie_file(cookie_text):
        return {
            "path": "",
            "error": "YT_DLP_COOKIES_B64 is invalid. Paste a base64 encoded Netscape cookies.txt export."
        }

    dest_path = os.path.join(tempfile.gettempdir(), "yt-dlp-cookies.txt")
    try:
        with open(dest_path, "w", encoding="utf-8") as f:
            f.write(cookie_text)
        if os.name != "nt":
            os.chmod(dest_path, 0o600)
        return {"path": dest_path, "error": ""}
    except Exception as e:
        return {"path": "", "error": f"Failed to write cookie file: {e}"}

# Initialize cookies config once at startup
cookies_config = prepare_yt_dlp_cookies()

def is_supported_http_url(url: Optional[str]) -> bool:
    if not url or not isinstance(url, str):
        return False
    try:
        parsed = urlparse(url)
        return parsed.scheme in ["http", "https"]
    except Exception:
        return False

def is_youtube_host(hostname: str) -> bool:
    host = hostname.lower()
    return host == "youtu.be" or host == "youtube.com" or host.endswith(".youtube.com")

def is_youtube_url(url: str) -> bool:
    try:
        return is_youtube_host(urlparse(url).netloc)
    except Exception:
        return False

def normalize_resolve_url(value: str) -> str:
    try:
        parsed = urlparse(value)
        if is_youtube_host(parsed.netloc):
            query_params = parse_qsl(parsed.query)
            filtered_params = [
                (k, v) for k, v in query_params
                if k not in ["feature", "si", "app", "pp", "embeds_referring_euri", "embeds_referring_origin"]
            ]
            new_query = urlencode(filtered_params)
            parsed = parsed._replace(query=new_query)
        return urlunparse(parsed)
    except Exception:
        return value

def clean_extension(value: str) -> str:
    ext = str(value or "mp4").lstrip(".").lower()
    return ext if re.match(r"^[a-z0-9]{2,5}$", ext) else "mp4"

def guess_extension(url: str) -> str:
    try:
        path = urlparse(url).path
        ext = path.split(".")[-1]
        return ext if ext else "mp4"
    except Exception:
        return "mp4"

def normalize_size(value) -> Optional[int]:
    try:
        if value is None:
            return None
        val = float(value)
        if math.isfinite(val):
            return round(val)
    except (ValueError, TypeError):
        pass
    return None

def format_bytes(value) -> Optional[str]:
    bytes_val = normalize_size(value)
    if not bytes_val or bytes_val <= 0:
        return None
    kb = bytes_val / 1024
    mb = kb / 1024
    gb = mb / 1024
    if gb >= 1:
        return f"{gb:.1f} GB"
    if mb >= 1:
        return f"{mb:.1f} MB"
    return f"{kb:.1f} KB"

def format_duration(seconds) -> str:
    try:
        total_seconds = float(seconds)
        if not math.isfinite(total_seconds) or total_seconds <= 0:
            return "--:--"
        minutes = int(total_seconds // 60)
        remaining_seconds = int(total_seconds % 60)
        return f"{minutes}:{remaining_seconds:02d}"
    except (ValueError, TypeError):
        return "--:--"

def sanitize_request_headers(headers: dict) -> dict:
    if not headers or not isinstance(headers, dict):
        return {}
    sanitized = {}
    for k, v in headers.items():
        if isinstance(k, str) and isinstance(v, str):
            k_strip, v_strip = k.strip(), v.strip()
            if k_strip and v_strip:
                if k_strip.lower() not in ["cookie", "authorization"]:
                    sanitized[k_strip] = v_strip
    return sanitized

def get_public_base_url(request: Request) -> str:
    public_url = os.getenv("PUBLIC_BASE_URL")
    if public_url:
        return public_url.rstrip("/")

    protocol = request.headers.get("x-forwarded-proto") or request.url.scheme or "http"
    host = request.headers.get("x-forwarded-host") or request.headers.get("host")
    if not host:
        host = f"{request.url.hostname}:{request.url.port}" if request.url.port else request.url.hostname
    return f"{protocol}://{host}"

def create_media_proxy_url(request: Request, media: dict) -> str:
    media_id = secrets.token_urlsafe(18)
    media_store[media_id] = {
        **media,
        "expires_at": time.time() + MEDIA_PROXY_TTL
    }
    base_url = get_public_base_url(request)
    token_escaped = quote(api_token)
    return f"{base_url}/api/media/{media_id}?token={token_escaped}"

def cleanup_media_store():
    now = time.time()
    expired = [k for k, v in list(media_store.items()) if v["expires_at"] <= now]
    for k in expired:
        media_store.pop(k, None)

def quality_label(format_info: dict) -> str:
    if format_info.get("format_note"):
        return str(format_info["format_note"])
    if format_info.get("resolution") and format_info["resolution"] != "audio only":
        return str(format_info["resolution"])
    if format_info.get("height"):
        return f"{format_info['height']}p"
    if format_info.get("abr"):
        try:
            return f"{round(float(format_info['abr']))}kbps"
        except (ValueError, TypeError):
            pass
    if format_info.get("format_id"):
        return f"Format {format_info['format_id']}"
    return "Media"

AUDIO_EXTENSIONS = {"mp3", "m4a", "aac", "wav", "ogg", "opus"}

def extract_media_options(info: dict, request: Request) -> List[Dict[str, Any]]:
    formats = info.get("formats", [])
    if not isinstance(formats, list):
        formats = []

    direct_entries = formats if len(formats) > 0 else [info]
    seen = set()
    medias = []

    for format_entry in direct_entries:
        url = format_entry.get("url")
        if not url or not is_supported_http_url(url):
            continue

        key = f"{url}|{format_entry.get('format_id') or ''}"
        if key in seen:
            continue
        seen.add(key)

        ext = clean_extension(format_entry.get("ext") or info.get("ext") or guess_extension(url))
        vcodec = format_entry.get("vcodec")
        acodec = format_entry.get("acodec")

        has_video = vcodec and vcodec != "none"
        has_audio = acodec and acodec != "none"

        video_available = bool(has_video or (not has_audio and ext not in AUDIO_EXTENSIONS))
        audio_available = bool(has_audio or ext in AUDIO_EXTENSIONS)

        protocol = str(format_entry.get("protocol") or "")
        chunked = "m3u8" in protocol

        http_headers = format_entry.get("http_headers") or info.get("http_headers") or {}
        sanitized_headers = sanitize_request_headers(http_headers)

        filesize = format_entry.get("filesize") or format_entry.get("filesize_approx")
        size = normalize_size(filesize)
        formatted_size = format_bytes(filesize)

        proxy_url = create_media_proxy_url(request, {
            "url": url,
            "extension": ext,
            "headers": sanitized_headers
        })

        medias.append({
            "url": url,
            "proxyUrl": proxy_url,
            "quality": quality_label(format_entry),
            "extension": ext,
            "size": size,
            "formattedSize": formatted_size,
            "videoAvailable": video_available,
            "audioAvailable": audio_available,
            "chunked": chunked,
            "cached": False,
            "requiresRendering": False,
            "headers": sanitized_headers
        })

    def sort_key(item):
        combined = 1 if (item["videoAvailable"] and item["audioAvailable"]) else 0
        video = 1 if item["videoAvailable"] else 0
        size = item["size"] or 0
        return (-combined, -video, -size)

    medias.sort(key=sort_key)
    return medias[:12]

def create_request_id() -> str:
    return f"{int(time.time() * 1000):x}-{secrets.token_hex(3)}"

def safe_log_url(value: str) -> str:
    if not isinstance(value, str) or not value.strip():
        return ""
    try:
        parsed = urlparse(value)
        return f"{parsed.scheme}://{parsed.netloc}{parsed.path}"
    except Exception:
        return value[:120]

# --- Error Normalization ---

def normalize_yt_dlp_error(error: Exception) -> Dict[str, Any]:
    raw_message = str(error)
    log_message = raw_message.strip()

    if re.search(r"does not look like a netscape format cookies file|skipping cookie file entry", log_message, re.IGNORECASE):
        return {
            "status": 500,
            "log_message": log_message,
            "client_message": "YT_DLP_COOKIES_B64 is invalid. Use a base64 encoded Netscape cookies.txt export."
        }

    if re.search(r"sign in to confirm|not a bot|cookies", log_message, re.IGNORECASE):
        return {
            "status": 403,
            "log_message": log_message,
            "client_message": "YouTube blocked this server. Add YouTube cookies in YT_DLP_COOKIES_B64 or try another video."
        }

    if re.search(r"this video is not available|video unavailable|private video|removed by", log_message, re.IGNORECASE):
        return {
            "status": 404,
            "log_message": log_message,
            "client_message": "This video is not available."
        }

    if re.search(r"unsupported url|not supported", log_message, re.IGNORECASE):
        return {
            "status": 400,
            "log_message": log_message,
            "client_message": "Unsupported URL."
        }

    return {
        "status": 502,
        "log_message": log_message,
        "client_message": "Unable to resolve media."
    }

def is_bot_check_error(error: Exception) -> bool:
    message = str(error)
    return bool(re.search(r"sign in to confirm|not a bot", message, re.IGNORECASE))

# --- yt-dlp Subprocess Runner (if custom path set) ---

async def resolve_via_subprocess(binary_path: str, url: str, ydl_opts: dict) -> dict:
    args = [binary_path, "--dump-single-json", "--no-warnings", "--skip-download", "--prefer-free-formats"]
    args += ["--add-header", "user-agent:Mozilla/5.0 SocialHubDownloader/1.0"]

    if ydl_opts.get("cookiefile"):
        args += ["--cookies", ydl_opts["cookiefile"]]

    args.append(url)

    try:
        proc = await asyncio.create_subprocess_exec(
            *args,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE
        )
        stdout, stderr = await proc.communicate()

        if proc.returncode != 0:
            err_msg = stderr.decode("utf-8", errors="replace")
            raise Exception(err_msg)

        return json.loads(stdout.decode("utf-8", errors="replace"))
    except Exception as error:
        if not is_youtube_url(url) or not is_bot_check_error(error):
            raise error

        print("youtube bot check in subprocess; retrying with alternate player clients")
        retry_args = args[:-1] + ["--extractor-args", "youtube:player_client=android,web", url]

        proc = await asyncio.create_subprocess_exec(
            *retry_args,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE
        )
        stdout, stderr = await proc.communicate()

        if proc.returncode != 0:
            err_msg = stderr.decode("utf-8", errors="replace")
            raise Exception(err_msg)

        return json.loads(stdout.decode("utf-8", errors="replace"))

# --- yt-dlp python-native Threaded Runner ---

def _yt_dlp_extract_sync(url: str, ydl_opts: dict) -> dict:
    import yt_dlp
    with yt_dlp.YoutubeDL(ydl_opts) as ydl:
        return ydl.extract_info(url, download=False)

async def resolve_with_yt_dlp(url: str, request_id: str) -> dict:
    ydl_opts = {
        'nowarnings': True,
        'skip_download': True,
        'prefer_free_formats': True,
        'http_headers': {
            'User-Agent': 'Mozilla/5.0 SocialHubDownloader/1.0'
        }
    }

    if cookies_config["path"]:
        ydl_opts['cookiefile'] = cookies_config["path"]

    custom_path = os.getenv("YOUTUBE_DL_PATH")
    if custom_path:
        return await resolve_via_subprocess(custom_path, url, ydl_opts)

    try:
        return await asyncio.to_thread(_yt_dlp_extract_sync, url, ydl_opts)
    except Exception as error:
        if not is_youtube_url(url) or not is_bot_check_error(error):
            raise error

        print(f"[download:{request_id}] youtube bot check; retrying with alternate player clients")
        ydl_opts['extractor_args'] = {
            'youtube': {
                'player_client': ['android', 'web']
            }
        }
        return await asyncio.to_thread(_yt_dlp_extract_sync, url, ydl_opts)

# --- Routes ---

class ResolveRequest(BaseModel):
    url: Optional[str] = None
    token: Optional[str] = None

@app.get("/health")
async def health_endpoint():
    custom_path = os.getenv("YOUTUBE_DL_PATH")
    yt_dlp_ready = os.path.exists(custom_path) if custom_path else True

    return {
        "ok": True,
        "service": "socialhub-resolver-api",
        "ytDlpReady": yt_dlp_ready,
        "cookiesReady": bool(cookies_config["path"]),
        "cookiesError": cookies_config["error"] or ""
    }

@app.post("/api/resolve")
@app.post("/api/download")
async def resolve_endpoint(req_body: ResolveRequest, request: Request):
    request_id = create_request_id()
    started_at = time.time()

    url = req_body.url
    token = req_body.token

    print(f"[download:{request_id}] incoming POST {request.url.path} url: {safe_log_url(url)}")

    if not token or token != api_token:
        print(f"[download:{request_id}] rejected invalid token")
        raise HTTPException(status_code=401, detail="Invalid API token")

    if not is_supported_http_url(url):
        print(f"[download:{request_id}] rejected invalid url: {safe_log_url(url)}")
        raise HTTPException(status_code=400, detail="A valid http/https URL is required")

    try:
        resolve_url = normalize_resolve_url(url)
        info = await resolve_with_yt_dlp(resolve_url, request_id)

        print(f"[download:{request_id}] yt-dlp success - title: {info.get('title', '')}")

        medias = extract_media_options(info, request)

        if not medias:
            print(f"[download:{request_id}] no media formats found")
            raise HTTPException(status_code=404, detail="No downloadable media formats found")

        payload = {
            "url": info.get("webpage_url") or info.get("original_url") or url,
            "title": info.get("title") or "Social media download",
            "thumbnail": info.get("thumbnail") or "",
            "duration": format_duration(info.get("duration")),
            "source": info.get("extractor_key") or info.get("extractor") or "",
            "sid": info.get("id") or "",
            "medias": medias
        }

        return payload
    except HTTPException:
        raise
    except Exception as e:
        failure = normalize_yt_dlp_error(e)
        print(f"[download:{request_id}] failed - status: {failure['status']}, message: {failure['log_message']}")
        raise HTTPException(status_code=failure["status"], detail=failure["client_message"])

@app.get("/api/media/{media_id}")
async def proxy_media(media_id: str, request: Request, token: Optional[str] = None):
    if token != api_token:
        raise HTTPException(status_code=401, detail="Invalid API token")

    cleanup_media_store()
    media = media_store.get(media_id)
    if not media or media["expires_at"] <= time.time():
        media_store.pop(media_id, None)
        raise HTTPException(status_code=404, detail="Download link expired. Resolve the URL again.")

    url = media["url"]
    headers = media.get("headers", {})

    client_range = request.headers.get("range")
    if client_range:
        headers["Range"] = client_range

    client_ua = request.headers.get("user-agent")
    headers["User-Agent"] = client_ua or headers.get("User-Agent") or "Mozilla/5.0 SocialHubDownloader/1.0"

    print(f"[media] proxying {safe_log_url(url)} - extension: {media.get('extension')}")

    client = httpx.AsyncClient(follow_redirects=True)

    try:
        req = client.build_request("GET", url, headers=headers)
        resp = await client.send(req, stream=True)

        if resp.status_code < 200 or resp.status_code >= 300:
            await resp.aclose()
            await client.aclose()
            raise HTTPException(status_code=502, detail=f"Media upstream returned {resp.status_code}")

        async def stream_generator():
            try:
                async for chunk in resp.iter_bytes(chunk_size=65536):
                    yield chunk
            finally:
                await resp.aclose()
                await client.aclose()

        response_headers = {}
        for h in ["content-type", "content-length", "content-range", "accept-ranges"]:
            val = resp.headers.get(h)
            if val:
                response_headers[h] = val

        ext = media.get("extension", "mp4")
        response_headers["Content-Disposition"] = f'attachment; filename="socialhub.{ext}"'

        return StreamingResponse(
            stream_generator(),
            status_code=resp.status_code,
            headers=response_headers
        )
    except Exception as e:
        await client.aclose()
        print(f"[media] proxy failed: {e}")
        raise HTTPException(status_code=502, detail="Unable to download media.")

if __name__ == "__main__":
    import uvicorn
    port = int(os.getenv("PORT", 5000))
    uvicorn.run("main:app", host="0.0.0.0", port=port, reload=True)
