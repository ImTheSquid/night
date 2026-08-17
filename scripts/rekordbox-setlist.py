#!/usr/bin/env python3
"""Turn a Rekordbox playlist export into a `setlist:` block for a night's YAML.

    python3 scripts/rekordbox-setlist.py ~/Downloads/"Mix 14-08-2026.txt"

Prints the block to stdout; paste it under the track it belongs to. Rekordbox
exports UTF-16 tab-separated text with a header row, so columns are located by
name rather than position -- the column order differs between versions and
depending on what you have shown in the browser pane.
"""

import argparse
import sys
from pathlib import Path

# Rekordbox names these differently across versions/locales.
TITLE_COLUMNS = ("Track Title", "Title", "Track")
ARTIST_COLUMNS = ("Artist", "Artists")


def decode(raw: bytes) -> str:
    """Rekordbox writes UTF-16 LE with a BOM; be tolerant of UTF-8 exports."""
    for bom, encoding in (
        (b"\xff\xfe", "utf-16"),
        (b"\xfe\xff", "utf-16"),
        (b"\xef\xbb\xbf", "utf-8-sig"),
    ):
        if raw.startswith(bom):
            return raw.decode(encoding)
    return raw.decode("utf-8", errors="replace")


def column(header: list[str], names: tuple[str, ...]) -> int | None:
    lookup = {h.strip().casefold(): i for i, h in enumerate(header)}
    for name in names:
        if name.casefold() in lookup:
            return lookup[name.casefold()]
    return None


def quote(value: str) -> str:
    """Double-quoted YAML: entries routinely start with ! @ # or contain colons."""
    return '"' + value.replace("\\", "\\\\").replace('"', '\\"') + '"'


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("export", type=Path, nargs="?",
                    help="Rekordbox .txt export; omit to read stdin")
    ap.add_argument("--indent", type=int, default=4,
                    help="spaces before `setlist:` (default 4, matching a track entry)")
    ap.add_argument("--bare", action="store_true",
                    help="just the entries, without the `setlist:` key")
    args = ap.parse_args()

    raw = args.export.read_bytes() if args.export else sys.stdin.buffer.read()
    lines = [l for l in decode(raw).splitlines() if l.strip()]
    if not lines:
        print("empty export", file=sys.stderr)
        return 1

    header = lines[0].split("\t")
    title_at = column(header, TITLE_COLUMNS)
    artist_at = column(header, ARTIST_COLUMNS)
    if title_at is None:
        print(f"no title column in: {', '.join(h.strip() for h in header if h.strip())}",
              file=sys.stderr)
        return 1

    entries = []
    for line in lines[1:]:
        fields = [f.strip() for f in line.split("\t")]
        if title_at >= len(fields):
            continue
        title = fields[title_at]
        if not title:
            continue
        artist = fields[artist_at] if artist_at is not None and artist_at < len(fields) else ""
        entries.append(f"{artist} - {title}" if artist else title)

    if not entries:
        print("no tracks found", file=sys.stderr)
        return 1

    pad = " " * args.indent
    out = [] if args.bare else [f"{pad}setlist:"]
    item_pad = pad if args.bare else pad + "  "
    out += [f"{item_pad}- {quote(e)}" for e in entries]
    print("\n".join(out))

    print(f"{len(entries)} tracks", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
