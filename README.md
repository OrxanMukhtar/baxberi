# Baxberi

A small Azerbaijani-language live streaming and social app built with Node.js, a single HTML client, WebSockets, and WebRTC.

## Features

- Username/password registration and login with HttpOnly sessions
- Live broadcaster list, WebSocket chat, WebRTC signaling, configurable TURN
- Editable display name, avatar, cover, bio, age, city, interests, and status
- Follow/unfollow, profile visitor list, emoji reactions, virtual gifts, and quiz prompts
- Mobile layout and image uploads limited to 2 MB (PNG/JPEG/WEBP/GIF)

No XP, levels, daily tasks, achievements, or leaderboards are included.

## Run locally

Requires Node.js 18 or newer.

```sh
npm ci
npm start
```

Open http://localhost:3000. Set `DB_FILE` and `UPLOAD_DIR` to writable persistent paths when needed. See `.env.example` for settings. The checked-in archive's `data/db.json` is deliberately excluded because it held user accounts and active session hashes; start with an empty database and create fresh accounts.

## Deployment: always-on Render service

The included `render.yaml` configures a paid always-on Node web service and a persistent disk at `/var/data`, with health check `/healthz`. Connect the GitHub repository to Render and create the service from the Blueprint. Add TURN credentials in the Render environment settings. The free web tier can sleep and has no persistent disk, so it does not satisfy 24/7 operation.

The current app persists the complete database as one JSON file and stores uploaded images on the mounted disk. This is suitable only as a modest single-instance deployment. It is **not** a managed database or object storage, cannot safely scale to multiple instances, and is not ready to claim 10,000+ users. Before public production, migrate accounts/social data to PostgreSQL (managed Render PostgreSQL or another managed PostgreSQL provider) and images to S3-compatible object storage such as Cloudflare R2; add migration/backups, upload moderation, and observability. The app code does not yet integrate those services.

### Environment variables

| Variable | Purpose |
| --- | --- |
| `PORT` | HTTP port, provided by Render automatically |
| `DB_FILE` | JSON database path; use `/var/data/db.json` with the configured disk |
| `UPLOAD_DIR` | Image directory; use `/var/data/uploads` with the configured disk |
| `TURN_URL` | TURN URL, e.g. `turn:turn.example.com:3478` or `turns:...:5349` |
| `TURN_USER` | TURN username |
| `TURN_PASS` | TURN credential |

The app always includes Google's public STUN server. STUN alone cannot relay media when peers are behind restrictive NATs; configure a production TURN service (for example, coturn on a properly secured host or a managed WebRTC provider). TURN credentials are returned to authenticated clients and should be short-lived in a production signaling design. Do not commit secrets.

## Security and operating limits

- Passwords use Node's scrypt; session IDs are random and stored hashed; cookies are HttpOnly and SameSite=Lax.
- Login/registration have basic in-memory IP rate limits. These limits reset on restart and are not distributed.
- Image size/type checks and randomized filenames reduce common upload risks; uploads are not virus-scanned or moderated.
- Profile age is restricted to 13+, but this is not an age verification system.
- The JSON file store is single-process and rewrites the whole database; use a real database before meaningful public growth.
- Use HTTPS in deployment so secure session cookies are enabled.
