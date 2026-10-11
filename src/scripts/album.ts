/**
 * Album downloads are zipped on first request, which can take a minute. Rather
 * than leave a click looking dead, poll the album here, show how long it has
 * been preparing, and start the download in place once it is ready.
 *
 * Without JS the link still works: the server answers with its own
 * self-refreshing "preparing" page.
 */

const POLL_EVERY = 3_000;

for (const link of document.querySelectorAll<HTMLAnchorElement>("a[data-album]")) {
  const status = link.parentElement?.querySelector<HTMLElement>("[data-album-status]");
  let busy = false;

  link.addEventListener("click", async (event) => {
    event.preventDefault();
    if (busy) return;
    busy = true;

    const started = Date.now();
    const show = (text: string) => {
      if (status) status.textContent = text;
    };
    const tick = () => show(` · preparing… ${Math.round((Date.now() - started) / 1000)}s`);
    tick();
    const timer = setInterval(tick, 1000);

    try {
      // HEAD starts the build and reports 202 until the zip exists.
      for (;;) {
        const res = await fetch(link.href, { method: "HEAD", cache: "no-store" });
        if (res.status === 200) break;
        if (res.status !== 202) throw new Error(`HTTP ${res.status}`);
        await new Promise((resolve) => setTimeout(resolve, POLL_EVERY));
      }
      show(" · downloading");
      // An attachment, so the page stays put. The browser's own download UI
      // takes over from here.
      location.href = link.href;
      setTimeout(() => show(""), 5_000);
    } catch {
      show(" · couldn't prepare the album, try again");
    } finally {
      clearInterval(timer);
      busy = false;
    }
  });
}
