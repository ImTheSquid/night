# Jack Night Repository

Static Astro site archiving recordings from the Jack Night DJ nights, served at
<https://night.jackhogan.me>.

## Layout

| Path | What it is |
| --- | --- |
| `src/data/<series>/*.yaml` | The only hand-authored content: titles, track names, labels, setlists, ordering. |
| `src/content.config.ts` | One collection per series. |
| `src/lib/sets.ts` | Fetches and sorts each series into the shape `<Set>` renders. |
| `src/lib/audio.ts` | Bridges the YAML to the server audio manifest. |
| `src/lib/albums.ts` | Maps a night onto its album download: files, tags, cover. |
| `src/pages/albums.json.ts` | Emits every album for the album server. |
| `src/components/SetList.astro` | Renders a whole page of nights. |
| `src/components/Set.astro` | Renders one night. |
| `src/pages/*.astro` | One page per series: a heading and a `<SetList>`. |
| `src/scripts/player.ts` | Media Session, single-playback, resume-position. |
| `src/scripts/album.ts` | Progress beside each album download while its zip is built. |
| `scripts/audio-sync.py` | Runs **on the server**: probes the library, builds streamable encodes, prints the manifest. |
| `scripts/album-server.py` | Runs **on the server**: zips tagged albums on request. |
| `scripts/rekordbox-setlist.py` | Turns a Rekordbox export into a `setlist:` block. |
| `scripts/deploy.mjs` | The one command. |

## Setlists from Rekordbox

Export the playlist from Rekordbox (right-click → Export → as a text file), then:

```sh
python3 scripts/rekordbox-setlist.py ~/Downloads/"Mix 14-08-2026.txt"
```

It prints a ready-to-paste `setlist:` block, indented to sit under a track entry:

```yaml
    setlist:
      - "Wire One - Scared of Silence (2026 Re-Wire)"
      - "gaszia2 - Wannacry x Destiny Mash"
```

Columns are found by name, so it survives Rekordbox reordering them, and the
export's UTF-16 encoding is handled. Entries are double-quoted and escaped —
track names in this genre routinely start with `!`, `@` or `#` and contain
quotes and colons, all of which are YAML syntax if left bare.

`--indent N` changes the leading indent; `--bare` omits the `setlist:` key.

## Series

Each night series is its own collection, because they are not ordered the same
way: Jack Nights have an authored `order`, Green Light nights are dated.

A Green Light night without a `title` is headed by its date. One with a title
(`Green Light 001`, …) gets the date as a subheading. Either can have a `note`,
an italic line below that.

```astro
---
import Base from "../layouts/Base.astro";
import SetList from "../components/SetList.astro";
import { greenLight } from "../lib/sets";
const sets = await greenLight();
---
<Base title="Green Light Repository">
  <h1 id="top"><a class="anchor" href="#top">GREEN LIGHT REPOSITORY</a></h1>
  <SetList sets={sets} />
</Base>
```

To add a series: a collection in `src/content.config.ts`, a getter in
`src/lib/sets.ts` returning `Night[]`, and a page like the above. `<Set>` needs
no changes — it only ever sees `{ title, date?, note?, numbered, tracks }`.

Every heading and track name is an `.anchor` linking to itself, marked with a
faint `#`. Ids are slugs of the text, so renaming a night or track changes its
link.

Files whose names start with `_` are skipped by the loaders, so drafts and
templates can live beside real entries. See `src/data/green-light/_example.yaml`
for an annotated template.

## Commands

Run these inside `nix-shell`, which provides bun.

```
bun run dev      # local dev
bun run build    # static build into dist/
bun run deploy   # transcode + build + rsync, in that order
```

`bun run deploy` is the only one you need to remember. It fixes the ordering
internally, so there is no sequence to get wrong.

Override the target with `JACK_NIGHT_HOST` / `JACK_NIGHT_WEB_ROOT`.

## Audio

The audio is **not in this repo** — it lives on the server under `/var/www/audio`,
mostly as symlinks into `/mnt/gamma`. Nothing here should ever try to commit it.

Durations, sizes and channel counts are therefore *probed*, never authored.
`audio-sync.py` runs over ssh (piped to `python3 -`, never installed on the box)
and prints a manifest to `.audio-manifest.json`, which is gitignored and refetched
whenever it is missing. So `bun run dev` on a fresh clone just works, provided
`ssh server` does.

Each source file gets its encodes in `/var/www/audio/_stream/`:

| Format | Bitrate | For |
| --- | --- | --- |
| Opus in Ogg (`.ogg`) | 96k | Chrome, Firefox, Android. Smallest. |
| AAC in MP4 (`.m4a`) | 128k | Safari and iOS. Plays correctly everywhere. |

The markup lists the AAC with the original as a last resort, so playback never
depends on a transcode having happened and never depends on JS. The Opus is
carried as `data-opus` and `player.ts` prepends it as a `<source>` only where it
is known good — `canPlayType(...) === "probably"` *and* a non-Apple
`navigator.vendor`.

Safari cannot simply be offered the Opus. Since 18.4 it reports Ogg/Opus as
playable and then misreports the duration of an hour-long file and stalls on
seek; listing Opus first is what made the player unusable there. The vendor
check rather than a UA string is deliberate: iOS Chrome and Firefox are WebKit
too and share the bug.

`_stream/` sits under `/var/www/audio/` for two reasons: nginx's existing
`location /audio/` already serves it with correct MIME types, so no nginx change
and no root is needed; and it is outside the rsync target, so `--delete` can
never reach it. Everything in it is derived — delete it and re-run `deploy` to
rebuild.

## Adding a night

1. Put the audio in `/var/www/audio/<set>/` on the server, and optionally a
   cover photo (JPEG or PNG) beside it.
2. Add a `src/data/<series>/<name>.yaml` referencing those files by path, the
   photo as `cover:`.
3. `bun run deploy`.

The build fails on a `file:` or `cover:` that the server doesn't have, and warns
about audio the server has that no page references — so a typo or a forgotten
track surfaces at build time rather than as a broken player.

## Album downloads

Every night has two album downloads, each a zipped folder of tagged tracks ready
to drag into Apple Music. Each source is one track. Album
artist is the series, the setlist goes in as lyrics, and the cover, if there is
one, is embedded and also included as `cover.jpg`.

| Link | URL | Lossless sources become |
| --- | --- | --- |
| Download Album (Lossless) | `/albums/<night-id>.zip` | ALAC (Apple Music imports ALAC, not FLAC) |
| Download Album (Compressed) | `/albums/<night-id>.aac.zip` | AAC 256k, via `libfdk_aac` |

Lossy sources (AAC, MP3) go into both as they are. The page's sizes are
estimates, since nothing is encoded until it's asked for.

The zips are built on request, not ahead of time, by `scripts/album-server.py`.
It runs as the `jack-night-albums` systemd **user** unit on 127.0.0.1:8787;
`bun run deploy` installs and restarts it. The build writes `dist/albums.json`
and the server reads it from the web root. That file is its only source of
paths: the request's album id and variant are just keys.

A build encodes the tracks with ffmpeg, four at a time, and stores them
uncompressed in a zip in `/var/tmp/jack-night-albums/`. On the server ALAC runs
at ~130x realtime and FDK AAC at ~50x, so a build takes about as long as its
longest track: ~1 min lossless, ~2.5 min compressed for the 127-minute one. The
name is a hash of the album, variant and inputs, so editing the YAML or
replacing audio gets a fresh zip. Cached zips are served by nginx via `X-Accel-Redirect`, so
downloads resume. A request that would wait more than 2 s gets a 202 instead,
which keeps it well under Cloudflare's 100 s timeout. `src/scripts/album.ts`
polls through those with HEAD, showing elapsed time beside the link, and starts
the download in place; without JS the 202 is a page that refreshes itself. The cache is capped at 20 GB (`JACK_NIGHT_ALBUM_CACHE_GB`), and
`/var/tmp` ages out anything older than 30 days. All of it is derived, so it is
safe to delete.

nginx needs this in the `night.jackhogan.me` block. It is a one-off and the
only part that needs root:

```nginx
location /albums/ {
    proxy_pass http://127.0.0.1:8787;
    proxy_read_timeout 30s;
}
location /_album-cache/ {
    internal;
    alias /var/tmp/jack-night-albums/;
    types { application/zip zip; }
}
```

Logs: `ssh server journalctl --user -u jack-night-albums`.

## Durations are rendered, not measured

Every duration and elapsed time on the page comes from the manifest, not from
the `<audio>` element. This is not a stylistic choice, and there are two
independent reasons for it:

- A page with 31 players that all preload metadata hits a browser cap on
  concurrent media loads, and **none** of them resolve — every player sits at
  `0:00 / 0:00` forever. Measured directly: 31 concurrent loads → 0 succeeded,
  with no error event fired.
- Even when metadata does load, an engine's own duration for an hour-long
  progressive stream is not reliable. Safari's is wrong.

So `player.ts` replaces the native controls with its own bar, timed from
`data-duration`. Players are `preload="none"` and **nothing** on the page loads
audio until a play button is pressed — a saved position is drawn from
localStorage and applied on `loadedmetadata`, so resuming costs no requests
either. `play()` is called straight out of the click handler so the user gesture
survives the load, and the bar shows `...` until playback actually starts,
because a cold start on an hour-long file is not instant.

The native controls stay in the markup and are only removed once `player.ts`
runs, so the page still plays with JS disabled.

## Development

Start the dev server in background mode:

```
astro dev --background
```

Manage it with `astro dev stop`, `astro dev status`, `astro dev logs`.

## Documentation

- [Content collections](https://docs.astro.build/en/guides/content-collections/)
- [Astro components](https://docs.astro.build/en/basics/astro-components/)
- [Routing](https://docs.astro.build/en/guides/routing/)
- [Styling](https://docs.astro.build/en/guides/styling/)
