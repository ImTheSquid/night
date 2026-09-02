#!/usr/bin/env python3
"""Probe the Jack Night audio library, build streamable copies, emit a manifest.

Runs on the server, where the audio actually lives. Never installed there --
scripts/deploy.mjs pipes it over ssh to `python3 -`.

Outputs land in <audio-root>/_stream/, which nginx's existing `location /audio/`
already serves with the right MIME types, so this needs no nginx change and no
root. Two formats, because no single one plays everywhere:

  .ogg   Opus 96k  -- Chrome, Firefox, Android. Smallest.
  .m4a   AAC 128k  -- Safari and iOS. Plays correctly everywhere.

The page ships the AAC and lets player.ts opt in to the Opus, because Safari
reports Ogg/Opus as playable and then misreports the duration of an hour-long
file and stalls on seek.
Everything here is derived: delete _stream/ and re-run to rebuild it.
"""

import argparse
import json
import os
import signal
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path

FFMPEG = "/usr/lib/jellyfin-ffmpeg/ffmpeg"
FFPROBE = "/usr/lib/jellyfin-ffmpeg/ffprobe"
AUDIO_EXTS = {".flac", ".m4a", ".mp3", ".wav", ".ogg", ".aac"}
STREAM_DIR = "_stream"

# suffix -> (ffmpeg args, manifest key). Order is the <source> order.
FORMATS = {
    ".ogg": (["-c:a", "libopus", "-b:a", "96k", "-vbr", "on",
              "-application", "audio", "-f", "opus"], "opus"),
    ".m4a": (["-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart",
              "-f", "mp4"], "aac"),
}


def log(*a):
    print(*a, file=sys.stderr, flush=True)


def tame_encoders() -> None:
    """Keep ffmpeg from being a nuisance on a shared box: run at low priority,
    and die together. Without the group kill, a cancelled deploy or a dropped
    ssh session leaves hour-long encodes running unattended."""
    # The box also serves Jellyfin; encodes should yield to anything interactive.
    try:
        os.nice(15)
    except OSError:
        pass
    try:
        os.setpgrp()
    except OSError:
        return

    def stop(signum, _frame):
        signal.signal(signum, signal.SIG_IGN)  # don't re-enter via our own group kill
        os.killpg(0, signal.SIGTERM)
        sys.exit(128 + signum)

    for sig in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP):
        signal.signal(sig, stop)


def probe(path: Path) -> dict:
    out = subprocess.run(
        [FFPROBE, "-v", "error", "-select_streams", "a:0",
         "-show_entries", "stream=codec_name,channels",
         "-show_entries", "format=duration",
         "-of", "json", str(path)],
        capture_output=True, text=True, check=True,
    )
    data = json.loads(out.stdout)
    stream = (data.get("streams") or [{}])[0]
    return {
        "duration": round(float(data["format"]["duration"])),
        "bytes": path.stat().st_size,  # stat() follows symlinks
        "channels": stream.get("channels"),
        "codec": stream.get("codec_name"),
    }


def encode(src: Path, targets: list[tuple[Path, list[str]]]) -> None:
    """Produce every requested format in one pass. ffmpeg takes several outputs
    per input, so the FLAC is decoded once rather than once per format.

    Each output goes to a temp file first, so a killed run never leaves a
    truncated file that a later run would mistake for a finished one."""
    command = [FFMPEG, "-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-i", str(src)]
    for dst, args in targets:
        dst.parent.mkdir(parents=True, exist_ok=True)
        command += ["-map", "0:a:0", *args, str(dst.with_name(dst.name + ".part"))]
    subprocess.run(command, check=True)
    for dst, _ in targets:
        dst.with_name(dst.name + ".part").replace(dst)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--audio-root", type=Path, default=Path("/var/www/audio"))
    ap.add_argument("--manifest", default="-", help="output path, or - for stdout")
    ap.add_argument("--jobs", type=int, default=4)
    ap.add_argument("--probe-only", action="store_true",
                    help="refresh metadata without encoding")
    args = ap.parse_args()
    tame_encoders()

    for tool in (FFMPEG, FFPROBE):
        if not Path(tool).exists():
            log(f"missing {tool}")
            return 1

    stream_root = args.audio_root / STREAM_DIR
    sources = sorted(
        p for p in args.audio_root.rglob("*")
        if p.is_file()
        and p.suffix.lower() in AUDIO_EXTS
        and STREAM_DIR not in p.relative_to(args.audio_root).parts  # skip our own output
    )
    if not sources:
        log(f"no audio under {args.audio_root}")
        return 1

    def handle(src: Path) -> tuple[str, dict]:
        rel = src.relative_to(args.audio_root)
        info = probe(src)
        info["src"] = "/audio/" + str(rel)

        stale = [
            (stream_root / rel.with_suffix(suffix), ffargs)
            for suffix, (ffargs, _) in FORMATS.items()
            if not (stream_root / rel.with_suffix(suffix)).exists()
            or src.stat().st_mtime > (stream_root / rel.with_suffix(suffix)).stat().st_mtime
        ]
        if stale and not args.probe_only:
            log(f"  encode {rel} -> {', '.join(d.suffix for d, _ in stale)}")
            encode(src, stale)

        for suffix, (_, key) in FORMATS.items():
            dst = stream_root / rel.with_suffix(suffix)
            if dst.exists():
                info[key] = {
                    "url": f"/audio/{STREAM_DIR}/" + str(rel.with_suffix(suffix)),
                    "bytes": dst.stat().st_size,
                }
        return str(rel), info

    log(f"{len(sources)} files under {args.audio_root}")
    with ThreadPoolExecutor(max_workers=args.jobs) as pool:
        entries = dict(pool.map(handle, sources))

    # Encodes whose source is gone would otherwise outlive the library.
    if not args.probe_only and stream_root.exists():
        keep = {
            stream_root / Path(rel).with_suffix(suffix)
            for rel in entries for suffix in FORMATS
        }
        for orphan in stream_root.rglob("*"):
            if orphan.is_file() and orphan not in keep:
                log(f"  prune {orphan.relative_to(stream_root)}")
                orphan.unlink()

    payload = json.dumps({
        "generated": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "tracks": entries,
    }, indent=2, ensure_ascii=False, sort_keys=True) + "\n"

    if args.manifest == "-":
        sys.stdout.write(payload)
    else:
        out = Path(args.manifest)
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(payload)

    src_total = sum(e["bytes"] for e in entries.values())
    log(f"{len(entries)} tracks, "
        f"{sum(e['duration'] for e in entries.values()) / 3600:.1f}h, "
        f"source {src_total / 1e9:.2f} GB")
    for key in ("opus", "aac"):
        total = sum(e[key]["bytes"] for e in entries.values() if key in e)
        if total:
            log(f"{key:4} {total / 1e9:.2f} GB ({100 - total / src_total * 100:.0f}% smaller)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
