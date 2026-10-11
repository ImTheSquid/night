#!/usr/bin/env python3
"""Serve each night as a zipped, tagged album for Apple Music, built on request.

Runs on the server as a systemd --user unit (jack-night-albums.service), which
scripts/deploy.mjs installs. nginx proxies /albums/ here. A finished zip is
handed back with X-Accel-Redirect, so nginx serves it with Range support.

The build writes albums.json, and that file is the only source of paths. The
request inputs, the album id and the variant, are used only as keys.

Each album comes in two variants: <id>.zip is lossless (ALAC) and <id>.aac.zip
is compressed (AAC 256k). Lossless sources are encoded per variant on request;
lossy ones are copied into both as they are.

Zips are cached under a hash of the album, variant and inputs, so an edit to the
YAML or the audio gets a fresh zip. A build that outlasts WAIT gets a self-refreshing
"preparing" page instead, keeping requests under Cloudflare's 100 s timeout.
"""

import grp
import hashlib
import html
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import traceback
import unicodedata
import zipfile
from concurrent.futures import ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import quote

env = os.environ.get
FFMPEG = env("JACK_NIGHT_FFMPEG", "/usr/lib/jellyfin-ffmpeg/ffmpeg")
AUDIO_ROOT = Path(env("JACK_NIGHT_AUDIO_ROOT", "/var/www/audio"))
ALBUMS_JSON = Path(env("JACK_NIGHT_ALBUMS", "/var/www/html/djhost/albums.json"))
CACHE = Path(env("JACK_NIGHT_ALBUM_CACHE", "/var/tmp/jack-night-albums"))
CACHE_CAP = int(float(env("JACK_NIGHT_ALBUM_CACHE_GB", "20")) * 1e9)
PORT = int(env("JACK_NIGHT_ALBUM_PORT", "8787"))
ACCEL = "/_album-cache/"  # nginx `internal` location aliasing CACHE

WAIT = 2  # seconds a request waits on a build before getting the "preparing" page
RETRY = 60  # seconds before a failed build is attempted again
MAX_BUILDS = 2
TRACK_JOBS = 4  # encodes per build; the encoders are single-threaded

ROUTE = re.compile(r"/albums/([a-z0-9-]{1,100})(\.aac)?\.zip")
# variant -> (audio codec args for lossless sources, name suffix)
VARIANTS = {
    "lossless": (["-c:a", "alac"], ""),
    "compressed": (["-c:a", "libfdk_aac", "-b:a", "256k"], " (Compressed)"),
}
# Tags passed through to ffmpeg. Anything else in albums.json is ignored.
TAGS = {"title", "artist", "album", "album_artist", "date", "track", "lyrics", "compilation"}
# The formats albums.ts lets through: ALAC or AAC in MP4, and MP3.
MUXERS = {".m4a": "ipod", ".mp3": "mp3"}
# Part of every cache key, so a change to how albums are built rebuilds them.
SELF = hashlib.sha256(Path(__file__).read_bytes()).digest()


def log(*a):
    print(*a, file=sys.stderr, flush=True)


def audio_path(rel: str) -> Path:
    """A path from albums.json, held under AUDIO_ROOT. Symlinks out of it are
    fine -- the library is mostly symlinks -- but `..` and absolute paths are not."""
    norm = os.path.normpath(rel)
    if os.path.isabs(norm) or norm in (".", "..") or norm.startswith("../"):
        raise ValueError(f"bad path in albums.json: {rel!r}")
    return AUDIO_ROOT / norm


def safe_name(text: str) -> str:
    """A file name that can't escape the folder it's unzipped into or break a
    header: no separators, no control characters (CR/LF included), no leading dot."""
    text = "".join(
        " " if unicodedata.category(c).startswith("C") or c in '/\\:*?"<>|' else c
        for c in unicodedata.normalize("NFC", text)
    )
    return " ".join(text.split()).lstrip(". ")[:120].rstrip()


def disposition(name: str) -> str:
    """RFC 6266: an ASCII fallback, and the real name percent-encoded."""
    full = (safe_name(name) or "album") + ".zip"
    fallback = full.encode("ascii", "ignore").decode() or "album.zip"
    return f"attachment; filename=\"{fallback}\"; filename*=UTF-8''{quote(full, safe='')}"


_albums: dict = {}
_albums_mtime = None
_albums_lock = threading.Lock()


def albums() -> dict:
    """albums.json, reloaded whenever a deploy replaces it."""
    global _albums, _albums_mtime
    mtime = ALBUMS_JSON.stat().st_mtime_ns
    with _albums_lock:
        if mtime != _albums_mtime:
            _albums = json.loads(ALBUMS_JSON.read_text())
            _albums_mtime = mtime
        return _albums


def inputs(spec: dict) -> list[Path]:
    paths = [audio_path(t["file"]) for t in spec["tracks"]]
    if spec.get("cover"):
        paths.append(audio_path(spec["cover"]))
    return paths


def cache_key(variant: str, spec: dict) -> str:
    h = hashlib.sha256(SELF)
    h.update(variant.encode() + b"\0")
    h.update(json.dumps(spec, sort_keys=True).encode())
    for p in inputs(spec):
        st = p.stat()  # follows symlinks
        h.update(f"\0{p}\0{st.st_size}\0{st.st_mtime_ns}".encode())
    return h.hexdigest()[:32]


def zip_path(key: str) -> Path:
    return CACHE / f"{key}.zip"


def tag(src: Path, dst: Path, tags: dict, cover: Path | None, codec: list[str]) -> None:
    """Copy src to dst with fresh tags and artwork, encoding the audio with
    `codec` if given. Inputs are `file:` URLs under a file-only whitelist, so no
    path is read as an option or a protocol."""
    cmd = [FFMPEG, "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
           "-protocol_whitelist", "file", "-i", f"file:{src}"]
    if cover:
        cmd += ["-protocol_whitelist", "file", "-i", f"file:{cover}"]
    cmd += ["-map", "0:a:0"]
    if cover:
        cmd += ["-map", "1:v:0", "-disposition:v:0", "attached_pic"]
    cmd += ["-c", "copy", *codec, "-map_metadata", "-1"]
    for k, v in tags.items():
        if k in TAGS:
            cmd += ["-metadata", f"{k}={v}"]
    cmd += ["-f", MUXERS[dst.suffix], f"file:{dst}"]
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode:
        raise RuntimeError(f"ffmpeg failed on {src}: {result.stderr.strip()}")


def album_name(variant: str, spec: dict) -> str:
    return spec["name"] + VARIANTS[variant][1]


def build(key: str, variant: str, spec: dict) -> None:
    """Tag and encode the tracks into a temp dir, several at once, and store them
    in order, uncompressed, in a zip -- the audio is already compressed. Written
    to .part and renamed, so a killed build never leaves a truncated zip to be
    served."""
    codec = VARIANTS[variant][0]
    folder = safe_name(album_name(variant, spec)) or "album"
    cover = audio_path(spec["cover"]) if spec.get("cover") else None
    part = CACHE / f"{key}.zip.part"
    work = Path(tempfile.mkdtemp(prefix="build-", dir=CACHE))
    started = time.monotonic()

    def prepare(i: int, track: dict) -> Path:
        src = audio_path(track["file"])
        out = work / f"{i}{'.m4a' if track['lossless'] else src.suffix}"
        tag(src, out, {**spec["tags"], **track["tags"]}, cover,
            codec if track["lossless"] else [])
        return out

    pool = ThreadPoolExecutor(TRACK_JOBS)
    try:
        outs = [pool.submit(prepare, i, t) for i, t in enumerate(spec["tracks"], 1)]
        with zipfile.ZipFile(part, "w", zipfile.ZIP_STORED, allowZip64=True) as zf:
            for i, (track, pending) in enumerate(zip(spec["tracks"], outs), 1):
                out = pending.result()
                title = safe_name(track["tags"].get("title", "")) or "Track"
                zf.write(out, f"{folder}/{i:02d} {title}{out.suffix}")
                out.unlink()
            if cover:
                zf.write(cover, f"{folder}/cover{cover.suffix.lower()}")
        part.replace(zip_path(key))
        log(f"built {folder} ({zip_path(key).stat().st_size / 1e9:.2f} GB) "
            f"in {time.monotonic() - started:.0f}s")
    finally:
        # Running encodes finish before their directory is removed.
        pool.shutdown(cancel_futures=True)
        shutil.rmtree(work, ignore_errors=True)
        part.unlink(missing_ok=True)
    evict()


def evict() -> None:
    """Drop the least recently served zips until the cache fits under the cap."""
    zips = []
    for p in CACHE.glob("*.zip"):
        try:
            st = p.stat()
        except FileNotFoundError:
            continue
        zips.append((st.st_mtime, st.st_size, p))
    zips.sort()
    total = sum(size for _, size, _ in zips)
    for _, size, p in zips:
        if total <= CACHE_CAP:
            break
        log(f"evict {p.name}")
        p.unlink(missing_ok=True)
        total -= size


class Build:
    def __init__(self, key: str, variant: str, spec: dict):
        self.done = threading.Event()
        self.error: Exception | None = None
        self.finished = 0.0
        threading.Thread(target=self.run, args=(key, variant, spec), daemon=True).start()

    def run(self, key: str, variant: str, spec: dict) -> None:
        try:
            with slots:
                if not zip_path(key).exists():
                    build(key, variant, spec)
        except Exception as e:
            self.error = e
            log(f"build {key} failed:\n{traceback.format_exc()}")
        finally:
            self.finished = time.monotonic()
            self.done.set()


slots = threading.BoundedSemaphore(MAX_BUILDS)
builds: dict[str, Build] = {}
builds_lock = threading.Lock()


def ensure(key: str, variant: str, spec: dict) -> Build:
    """The build for key: one already running, one that just failed, or a new one."""
    with builds_lock:
        b = builds.get(key)
        if b and (not b.done.is_set() or (b.error and time.monotonic() - b.finished < RETRY)):
            return b
        b = builds[key] = Build(key, variant, spec)
        return b


PAGE = """<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
{refresh}<title>{title}</title></head>
<body style="font-family: sans-serif; margin: 2em">
<p>{body}</p><p><a href="{back}">Back to the site</a></p>
</body></html>
"""


class Handler(BaseHTTPRequestHandler):
    server_version = "jack-night-albums"
    sys_version = ""

    def do_GET(self):
        self.respond()

    def do_HEAD(self):
        self.respond()

    def respond(self):
        match = ROUTE.fullmatch(self.path.split("?", 1)[0])
        if not match:
            return self.page(404, "Not found", "No such album.")
        variant = "compressed" if match[2] else "lossless"
        try:
            spec = albums().get(match[1])
            if not spec:
                return self.page(404, "Not found", "No such album.")
            key = cache_key(variant, spec)
        except (OSError, ValueError, KeyError):
            log(f"album {match[1]} unavailable:\n{traceback.format_exc()}")
            return self.page(500, "Unavailable", "This album isn't available right now.")

        if not zip_path(key).exists():
            b = ensure(key, variant, spec)
            b.done.wait(WAIT)
            if not zip_path(key).exists():
                if b.error:
                    return self.page(500, "Failed", "This album couldn't be built. Try again in a minute.",
                                     back=spec.get("back", "/"))
                name = html.escape(album_name(variant, spec))
                return self.page(
                    202, f"Preparing {name}",
                    f"Preparing <b>{name}</b>. The download starts on its own once it's ready, "
                    f"which can take a few minutes.",
                    refresh=True,
                    back=spec.get("back", "/"),
                )

        os.utime(zip_path(key))  # marks it recently served, for evict()
        self.send_response(200)
        self.send_header("X-Accel-Redirect", f"{ACCEL}{key}.zip")
        self.send_header("Content-Type", "application/zip")
        self.send_header("Content-Disposition", disposition(album_name(variant, spec)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def page(self, status: int, title: str, body: str, refresh: bool = False, back: str = "/"):
        # Same-site paths only, so the link can't lead off the site.
        if not back.startswith("/") or back.startswith("//"):
            back = "/"
        # no-store: Cloudflare caches .zip URLs, and this is not the zip.
        data = PAGE.format(
            title=title, body=body, back=html.escape(back),
            refresh='<meta http-equiv="refresh" content="5">\n' if refresh else "",
        ).encode()
        self.send_response(status)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        if refresh:
            self.send_header("Retry-After", "5")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(data)


def prepare_cache() -> None:
    """Group www-data and setgid, so nginx can read what we write. Leftovers from
    a killed build are cleared; nothing else can be mid-write at startup."""
    CACHE.mkdir(parents=True, exist_ok=True)
    try:
        os.chown(CACHE, -1, grp.getgrnam("www-data").gr_gid)
    except (KeyError, PermissionError) as e:
        log(f"cannot give {CACHE} to www-data ({e}); nginx may not read it")
    os.chmod(CACHE, 0o2750)
    for p in CACHE.glob("*.part"):
        p.unlink()
    for p in CACHE.glob("build-*"):
        shutil.rmtree(p, ignore_errors=True)


def main() -> int:
    if not Path(FFMPEG).exists():
        log(f"missing {FFMPEG}")
        return 1
    prepare_cache()
    server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    server.daemon_threads = True
    log(f"serving albums on 127.0.0.1:{PORT}, cache {CACHE}")
    server.serve_forever()
    return 0


if __name__ == "__main__":
    sys.exit(main())
