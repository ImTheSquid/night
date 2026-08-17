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
| `src/components/SetList.astro` | Renders a whole page of nights. |
| `src/components/Set.astro` | Renders one night. |
| `src/pages/*.astro` | One page per series, two lines each. |
| `src/scripts/player.ts` | Media Session, single-playback, resume-position. |
| `scripts/audio-sync.py` | Runs **on the server**: probes the library, builds streamable encodes, prints the manifest. |
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
way: Jack Nights are numbered, Second Fridays are dated.

```astro
---
import SetList from "../components/SetList.astro";
import { secondFridays } from "../lib/sets";
const sets = await secondFridays();
---
<SetList sets={sets} />
```

To add a series: a collection in `src/content.config.ts`, a getter in
`src/lib/sets.ts` returning `Night[]`, and a page like the above. `<Set>` needs
no changes — it only ever sees `{ title, note?, numbered, tracks }`.

Files whose names start with `_` are skipped by the loaders, so drafts and
templates can live beside real entries. See `src/data/second-fridays/_example.yaml`
for an annotated template.

## Commands

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

Each source file gets two encodes in `/var/www/audio/_stream/`:

| Format | Bitrate | For |
| --- | --- | --- |
| Opus in Ogg (`.ogg`) | 96k | Chrome, Firefox, Android. Smallest. |
| AAC in MP4 (`.m4a`) | 128k | Safari and older iOS, whose Ogg/Opus support varies. |

The page lists both as `<source>`s with the original as a last resort, so the
browser picks the first it can play and playback never depends on a transcode
having happened.

`_stream/` sits under `/var/www/audio/` for two reasons: nginx's existing
`location /audio/` already serves it with correct MIME types, so no nginx change
and no root is needed; and it is outside the rsync target, so `--delete` can
never reach it. Everything in it is derived — delete it and re-run `deploy` to
rebuild.

## Adding a night

1. Put the audio in `/var/www/audio/<set>/` on the server.
2. Add a `src/data/<series>/<name>.yaml` referencing those files by path.
3. `bun run deploy`.

The build fails on a `file:` that the server doesn't have, and warns about files
the server has that no page references — so a typo or a forgotten track surfaces
at build time rather than as a broken player.

## Durations are rendered, not measured

Every duration on the page comes from the manifest, not from the `<audio>`
element. This is not a stylistic choice: a page with 31 players that all preload
metadata hits a browser cap on concurrent media loads, and **none** of them
resolve — every player sits at `0:00 / 0:00` forever. Measured directly:
31 concurrent loads → 0 succeeded, with no error event fired.

So players are `preload="none"` and load nothing until pressed. The one
exception is a track with a saved position, which loads on page open so it can
show where you left off — a few at a time (`LOAD_CONCURRENCY` in `player.ts`),
for the same reason.

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
