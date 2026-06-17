# Arnon

Encrypted conversations that leave no trace. No account. No app required. No history.

A complete encrypted messenger — app + relay — in a single browser file plus a small Node relay. The whole thing is about 600 lines, small enough to read and audit yourself.

## How it works

1. One person opens the app and taps "New conversation" — gets a link
2. They send the link to someone
3. The other person opens the link — encrypted chat starts instantly
4. Both sides compare a **safety number** to confirm no one is in the middle
5. Close the tab — everything is destroyed

## Features

- **End-to-end encrypted** — ECDH P-256 → HKDF → AES-256-GCM (Web Crypto API)
- **Safety number** — both sides compare a short code to rule out a relay-in-the-middle (MITM)
- **Text + voice notes** (30s max) — no photos, videos, or file sharing, by design
- **Self-destruct timer** — 5min / 15min / 30min / 1hr; destroys the whole room on both sides
- **No account** — no phone number, email, or registration
- **No app required** — works in any modern browser
- **Close tab = destroyed** — keys, messages, identity all gone
- **Blind relay** — sees only encrypted blobs in memory; nothing written to disk
- **Relay hardened** — non-root user, per-IP rate limits, per-IP connection cap, global room ceiling, message-rate token bucket, idle timeout, heartbeat, 1 MB message limit, 96-bit room IDs
- **Content Security Policy** — restricts scripts, connections, and media sources
- **Accessible** — ARIA labels, keyboard nav, live regions, status shown by shape + color, AA-targeted contrast
- **Tor Browser compatible** (voice notes may not work)

## What it protects against — and what it doesn't

Arnon is built for low-friction privacy. Against data collection, a curious provider, mass surveillance, or anyone who cannot reach the server, it does its job.

Because the app loads fresh in the browser each time, you trust whoever serves it. Against an adversary who can compromise the server, DNS, or TLS and target you specifically, an installed and independently verified client (Signal, SimpleX) is stronger. Arnon is **not** built to survive a targeted server compromise.

The relay can never read messages (they are E2E encrypted, keys never leave the browsers) but it can see that two addresses are talking, when, and roughly how much. To hide that too, use Tor.

## Structure

```
arnon/
├── index.html              # Landing page (GitHub Pages)
├── privacy.html
├── accessibility.html
├── terms.html
├── CNAME                   # custom domain for GitHub Pages
├── LICENSE                 # AGPL-3.0
├── Dockerfile
├── .gitignore
├── .well-known/
│   └── security.txt
├── pwa/
│   └── app.html            # the entire app — single file
└── relay/
    ├── server.js           # hardened blind relay (Node + ws)
    ├── package.json
    ├── package-lock.json   # generate with `npm install` (required by npm ci)
    ├── Caddyfile           # TLS termination + trusted proxy
    └── arnon-relay.service # systemd unit
```

## Deploy

The relay runs plain `ws` on localhost; **Caddy** sits in front for automatic TLS
(`wss://`) and supplies a trustworthy client IP. The relay only trusts
`X-Forwarded-For` when `TRUST_PROXY=1`, so per-IP limits cannot be forged.

### Relay (VPS)

```bash
useradd -r -s /usr/sbin/nologin arnon
mkdir -p /opt/arnon/relay
cp relay/server.js relay/package.json /opt/arnon/relay/
cd /opt/arnon/relay && npm install        # generates package-lock.json + installs ws
chown -R arnon:arnon /opt/arnon

cp relay/arnon-relay.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now arnon-relay

# Caddy in front (handles TLS automatically)
cp relay/Caddyfile /etc/caddy/Caddyfile
systemctl reload caddy
```

### Docker

The relay binds to `127.0.0.1` **inside** the container, so it is only reachable from
within the container's own network namespace — by design. On Linux, use `--network host`
so the host's Caddy can reach it on loopback (or run Caddy as a sidecar in the same
namespace). A plain `-p` publish will **not** reach it.

```bash
cd relay && npm install   # create package-lock.json first (npm ci needs it)
cd ..
docker build -t arnon-relay .
docker run -d --name arnon-relay --network host \
  -e TRUST_PROXY=1 --restart always arnon-relay
# put Caddy (on the host) in front for TLS -> proxies wss to 127.0.0.1:9444
```

> ⚠ **Never expose the relay directly while `TRUST_PROXY=1`.** That flag trusts the
> last `X-Forwarded-For` hop; if any client can reach the relay without going through
> your proxy (e.g. `HOST=0.0.0.0`, or publishing the port on a public interface), it
> can forge that header and bypass every per-IP limit. Keep the default loopback bind.

### App + landing page

Host on GitHub Pages. Update the `RELAY` and `BASE` constants at the top of
`pwa/app.html`, and the domain in `relay/Caddyfile`, to match your domain.

## License

AGPL-3.0 — running a public relay built on this code requires publishing your
changes. See `LICENSE` for the full text.

Built by Particular Ltd.
