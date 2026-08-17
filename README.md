# Jack Night Repository

Recordings from the Jack Night DJ nights — <https://night.jackhogan.me>

```sh
bun install
bun run dev      # local dev
bun run deploy   # transcode + build + rsync
```

The audio itself is not in this repo; it lives on the server and is probed at
build time, so `ssh server` needs to work. See [AGENTS.md](./AGENTS.md) for how
the pieces fit together and how to add a new Jack Night.
