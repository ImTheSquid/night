/**
 * Page-wide audio behaviour:
 *
 *  - Media Session metadata, so the OS lock screen / media keys show which
 *    set is playing and who played it, and can skip between sets.
 *  - One track at a time. The bare page happily played all 31 at once.
 *  - Resume where you left off. Sets run past an hour; losing your place hurts.
 *
 * Elements carry their own metadata via data-* attributes, so this file never
 * needs to know the track list.
 */

const SAVE_EVERY = 5_000;
/** Below this, treat it as "start over" rather than restoring a stale seek. */
const RESUME_FLOOR = 30;
/** Don't resume within this much of the end -- the set is effectively finished. */
const RESUME_TAIL = 15;
/** How many players may fetch metadata at once. See restoreInProgress(). */
const LOAD_CONCURRENCY = 3;
const METADATA_TIMEOUT = 15_000;

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
  const duration = Number.isFinite(el.duration) ? el.duration : Number(el.dataset.duration);
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
  const limit = Number.isFinite(current.duration) ? current.duration : Infinity;
  current.currentTime = Math.max(0, Math.min(limit, current.currentTime + offset));
  updatePositionState(current);
}

/** Media keys skip between sets, which is the useful unit here. */
function step(delta: number): void {
  if (!current) return;
  const next = players[players.indexOf(current) + delta];
  if (!next) return;
  next.scrollIntoView({ block: "center", behavior: "smooth" });
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

for (const el of players) {
  let restored = false;
  let lastSave = 0;

  // preload="none" means metadata is not there yet; the seek has to wait for it.
  const restore = () => {
    if (restored) return;
    restored = true;
    const saved = readProgress(el);
    if (saved > RESUME_FLOOR && saved < el.duration - RESUME_TAIL) {
      el.currentTime = saved;
    }
  };
  el.addEventListener("loadedmetadata", restore, { once: true });

  el.addEventListener("play", () => {
    for (const other of players) {
      if (other !== el) other.pause();
    }
    current = el;
    updateMetadata(el);
    updatePositionState(el);
  });

  el.addEventListener("timeupdate", () => {
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
    if (!el.ended) writeProgress(el, el.currentTime);
  });

  el.addEventListener("ended", () => {
    writeProgress(el, null);
    restored = false;
  });
}

/**
 * Pull in metadata for a single player, so its saved position can be applied.
 * Resolves on failure too -- one dead file must not stall the queue behind it.
 */
function loadMetadata(el: HTMLAudioElement): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      el.removeEventListener("loadedmetadata", done);
      el.removeEventListener("error", done);
      resolve();
    };
    const timer = setTimeout(done, METADATA_TIMEOUT);
    el.addEventListener("loadedmetadata", done);
    el.addEventListener("error", done);
    el.preload = "metadata";
    el.load();
  });
}

/**
 * Anything you have already started comes back showing where you left off,
 * without needing a click first.
 *
 * A few at a time, deliberately: asking every player on the page to load at
 * once trips a browser cap on concurrent media loads and *none* of them
 * resolve -- which is why durations are rendered from the manifest instead.
 */
async function restoreInProgress(): Promise<void> {
  const queue = players.filter((el) => readProgress(el) > 0);
  const workers = Array.from(
    { length: Math.min(LOAD_CONCURRENCY, queue.length) },
    async () => {
      for (let el = queue.shift(); el; el = queue.shift()) {
        // Skip anything the listener already started; load() would reset it.
        if (el.readyState > 0 || !el.paused) continue;
        await loadMetadata(el);
      }
    },
  );
  await Promise.all(workers);
}

bindMediaSession();
void restoreInProgress();

// A tab closed mid-set should still remember its place.
addEventListener("pagehide", () => {
  if (current && !current.paused) writeProgress(current, current.currentTime);
});
