/**
 * Page-wide audio behaviour:
 *
 *  - A control bar per player, timed from the manifest. Nothing is loaded until
 *    a player is pressed, so there is no duration to read from the element --
 *    and an engine's own idea of the length of an hour-long progressive stream
 *    is not to be trusted anyway. Safari gets it wrong.
 *  - Media Session metadata, so the OS lock screen / media keys show which
 *    set is playing and who played it, and can skip between sets.
 *  - One track at a time. The bare page happily played all 31 at once.
 *  - Resume where you left off. Sets run past an hour; losing your place hurts.
 *
 * The native controls stay in the markup and are only replaced once this runs,
 * so a browser without JS still gets a working player.
 *
 * Elements carry their own metadata via data-* attributes, so this file never
 * needs to know the track list.
 */

const SAVE_EVERY = 5_000;
/** Below this, treat it as "start over" rather than restoring a stale seek. */
const RESUME_FLOOR = 30;
/** Don't resume within this much of the end -- the set is effectively finished. */
const RESUME_TAIL = 15;

const players = Array.from(document.querySelectorAll<HTMLAudioElement>("audio[data-key]"));

const storageKey = (el: HTMLAudioElement) => `audio-progress:${el.dataset.key}`;
/** The old page keyed on the absolute FLAC URL. Sets run past an hour, so it is
 *  worth carrying those positions over rather than resetting everyone. */
const legacyKey = (el: HTMLAudioElement) =>
  `audio-progress:${location.origin}/audio/${el.dataset.key}`;

/** localStorage throws in private mode / when full; progress is not worth failing over. */
function readProgress(el: HTMLAudioElement): number {
  try {
    const current = localStorage.getItem(storageKey(el));
    if (current !== null) return Number(current) || 0;
    const legacy = localStorage.getItem(legacyKey(el));
    if (legacy === null) return 0;
    localStorage.setItem(storageKey(el), legacy);
    localStorage.removeItem(legacyKey(el));
    return Number(legacy) || 0;
  } catch {
    return 0;
  }
}

function writeProgress(el: HTMLAudioElement, seconds: number | null): void {
  try {
    // Below the resume floor there is nothing worth restoring, so drop the key
    // rather than leaving one behind for every track that got a stray pause.
    if (seconds === null || seconds < RESUME_FLOOR) localStorage.removeItem(storageKey(el));
    else localStorage.setItem(storageKey(el), String(Math.floor(seconds)));
  } catch {
    /* ignore */
  }
}

/** "1:02:45" / "24:17". Mirrors formatDuration in lib/audio.ts, which reads the
 *  manifest off disk and so cannot be imported into the browser bundle. */
function fmt(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const pad = (n: number) => String(n).padStart(2, "0");
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/** Length in seconds, from the manifest. The element's own duration is the
 *  fallback, never the source of truth. */
function lengthOf(el: HTMLAudioElement): number {
  return Number(el.dataset.duration) || (Number.isFinite(el.duration) ? el.duration : 0);
}

/**
 * Opus is ~40% smaller, but Safari 18.4+ reports it as playable and then
 * misreports the duration of a long file and stalls on seek. So it is opt-in:
 * a confident yes *and* a non-Apple engine, because iOS Chrome and Firefox are
 * WebKit too and share the bug. Anything unsure keeps the AAC in the markup.
 */
function opusIsSafe(): boolean {
  return (
    document.createElement("audio").canPlayType("audio/ogg; codecs=opus") === "probably" &&
    navigator.vendor !== "Apple Computer, Inc."
  );
}

function updateMetadata(el: HTMLAudioElement): void {
  if (!("mediaSession" in navigator)) return;
  navigator.mediaSession.metadata = new MediaMetadata({
    title: el.dataset.title ?? "",
    artist: el.dataset.artist ?? "",
    album: el.dataset.album ?? "",
  });
}

/** Feeds the lock-screen scrubber. Throws if the numbers are inconsistent. */
function updatePositionState(el: HTMLAudioElement): void {
  if (!("mediaSession" in navigator) || !navigator.mediaSession.setPositionState) return;
  const duration = lengthOf(el);
  if (!duration || el.currentTime > duration) return;
  try {
    navigator.mediaSession.setPositionState({
      duration,
      position: el.currentTime,
      playbackRate: el.playbackRate,
    });
  } catch {
    /* ignore */
  }
}

let current: HTMLAudioElement | null = null;

function seekBy(offset: number): void {
  if (!current) return;
  current.currentTime = Math.max(0, Math.min(lengthOf(current), current.currentTime + offset));
  updatePositionState(current);
}

/** Swaps in the Opus source. Deferred to the first press -- see prepare(). */
const prepares = new WeakMap<HTMLAudioElement, () => void>();

/** Media keys skip between sets, which is the useful unit here. */
function step(delta: number): void {
  if (!current) return;
  const next = players[players.indexOf(current) + delta];
  if (!next) return;
  next.scrollIntoView({ block: "center", behavior: "smooth" });
  prepares.get(next)?.();
  void next.play();
}

function bindMediaSession(): void {
  if (!("mediaSession" in navigator)) return;
  const actions: [MediaSessionAction, MediaSessionActionHandler][] = [
    ["play", () => void current?.play()],
    ["pause", () => current?.pause()],
    ["seekbackward", (d) => seekBy(-(d.seekOffset ?? 10))],
    ["seekforward", (d) => seekBy(d.seekOffset ?? 10)],
    ["seekto", (d) => {
      if (current && d.seekTime != null) {
        current.currentTime = d.seekTime;
        updatePositionState(current);
      }
    }],
    ["previoustrack", () => step(-1)],
    ["nexttrack", () => step(1)],
  ];
  for (const [action, handler] of actions) {
    // Unsupported actions throw rather than no-op.
    try {
      navigator.mediaSession.setActionHandler(action, handler);
    } catch {
      /* ignore */
    }
  }
}

const withOpus = opusIsSafe();

for (const el of players) {
  const length = lengthOf(el);
  /** Where to jump once metadata arrives. Set before anything is loaded, by a
   *  saved position or by dragging the scrubber on an untouched player. */
  let pendingSeek: number | null = null;
  let lastSave = 0;

  /**
   * Prepending the Opus source needs a load() for selection to re-run, and
   * load() fetches whatever preload says -- measured: doing this to all 31 at
   * boot leaves 29 stuck mid-load and 2 resolved. So it waits for the press,
   * where exactly one player can be loading. Synchronous, so the gesture that
   * follows it still counts.
   */
  let prepared = !(withOpus && el.dataset.opus);
  const prepare = () => {
    if (prepared) return;
    prepared = true;
    const source = document.createElement("source");
    source.src = el.dataset.opus!;
    source.type = "audio/ogg; codecs=opus";
    el.prepend(source);
    el.load();
  };
  prepares.set(el, prepare);

  const bar = document.createElement("div");
  bar.className = "bar";

  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "toggle";

  const scrub = document.createElement("input");
  scrub.type = "range";
  scrub.className = "scrub";
  scrub.min = "0";
  scrub.max = String(Math.max(1, Math.round(length)));
  scrub.step = "1";
  scrub.setAttribute("aria-label", "Seek");

  const time = document.createElement("span");
  time.className = "time";

  bar.append(toggle, scrub, time);
  el.after(bar);
  el.controls = false;

  /** Rendered from the manifest, so it is right before anything has loaded. */
  const render = (at: number) => {
    time.textContent = `${fmt(at)} / ${fmt(lengthOf(el))}`;
    scrub.setAttribute("aria-valuetext", time.textContent);
    const playing = !el.paused && !el.ended;
    toggle.textContent = playing ? "⏸" : "▶";
    toggle.setAttribute("aria-label", playing ? "Pause" : "Play");
  };

  /** Before metadata there is nothing to seek; remember it and apply on load. */
  const seekTo = (at: number) => {
    if (el.readyState > 0) el.currentTime = at;
    else pendingSeek = at;
    render(at);
  };

  const saved = readProgress(el);
  if (saved > RESUME_FLOOR && saved < length - RESUME_TAIL) pendingSeek = saved;
  render(pendingSeek ?? 0);
  scrub.value = String(Math.round(pendingSeek ?? 0));

  toggle.addEventListener("click", () => {
    if (!el.paused) {
      el.pause();
      return;
    }
    // prepare() and play() run straight out of the click so the user gesture
    // survives: loading happens after, which is what preload="none" costs.
    prepare();
    void el.play();
  });

  // While the thumb is held, the drag owns the display -- timeupdate must not
  // yank it back to where playback actually is.
  let dragging = false;
  scrub.addEventListener("pointerdown", () => (dragging = true));
  scrub.addEventListener("input", () => render(Number(scrub.value)));
  scrub.addEventListener("change", () => {
    dragging = false;
    seekTo(Number(scrub.value));
  });

  el.addEventListener("loadedmetadata", () => {
    scrub.max = String(Math.max(1, Math.round(lengthOf(el))));
    if (pendingSeek !== null) {
      el.currentTime = pendingSeek;
      pendingSeek = null;
    }
  });

  el.addEventListener("play", () => {
    for (const other of players) {
      if (other !== el) other.pause();
    }
    current = el;
    // A cold start on an hour-long file is not instant; say so rather than
    // looking like the press did nothing.
    if (el.readyState < 3) bar.dataset.loading = "";
    // pendingSeek first, or resuming would flash 0:00 until metadata lands.
    render(pendingSeek ?? el.currentTime);
    updateMetadata(el);
    updatePositionState(el);
  });

  el.addEventListener("playing", () => delete bar.dataset.loading);
  el.addEventListener("waiting", () => (bar.dataset.loading = ""));

  el.addEventListener("timeupdate", () => {
    if (!dragging) {
      render(el.currentTime);
      scrub.value = String(Math.round(el.currentTime));
    }
    if (el !== current) return;
    const now = Date.now();
    if (now - lastSave < SAVE_EVERY) return;
    lastSave = now;
    writeProgress(el, el.currentTime);
    updatePositionState(el);
  });

  el.addEventListener("seeked", () => updatePositionState(el));
  el.addEventListener("ratechange", () => updatePositionState(el));

  // Some browsers fire pause alongside ended; don't resurrect the key we just cleared.
  el.addEventListener("pause", () => {
    delete bar.dataset.loading;
    render(el.currentTime);
    if (!el.ended) writeProgress(el, el.currentTime);
  });

  el.addEventListener("ended", () => {
    writeProgress(el, null);
    pendingSeek = null;
    render(el.currentTime);
  });

  // <source> fallback only runs during initial selection, so an error partway
  // through leaves a dead player. Drop the Opus source and pick up where it
  // failed -- the AAC below it plays everywhere.
  el.addEventListener("error", () => {
    delete bar.dataset.loading;
    const opus = el.querySelector<HTMLSourceElement>('source[type^="audio/ogg"]');
    if (!opus) return;
    const at = el.currentTime;
    const wasPlaying = !el.paused;
    opus.remove();
    el.load();
    pendingSeek = at || pendingSeek;
    if (wasPlaying) void el.play();
  });
}

bindMediaSession();

// A tab closed mid-set should still remember its place.
addEventListener("pagehide", () => {
  if (current && !current.paused) writeProgress(current, current.currentTime);
});
