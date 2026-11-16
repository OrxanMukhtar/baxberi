# Baxberi

Baxberi is an Azerbaijani-language Node.js live streaming and social app using WebSockets and WebRTC.

## Included

- Username/password accounts with scrypt password hashes and HttpOnly sessions
- Live stream discovery, WebSocket chat and WebRTC signaling
- Editable profiles: avatar, cover, display name, bio, age, city, interests, status
- Follows, profile visitors, emoji reactions, virtual gifts, and chat quiz prompts
- Responsive small-screen layout
- Supabase PostgreSQL persistence and Supabase Storage image uploads for production
- TURN REST credentials signed for one hour when `TURN_SECRET` is configured

XP, levels, daily tasks, achievements, and leaderboards are intentionally excluded.

## Local development

Requires Node.js 18+. Local mode uses `data/db.json` and `uploads/` only when `SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY` are absent. Do not use this fallback as a multi-instance production store.

```sh
npm ci
npm start
```

Open http://localhost:3000. The archive's runtime database is not included in the repository because it contained account and session data. Create new accounts after launching the clean project.

## Production deployment

Recommended trial host: a small, always-on Google Compute Engine VM. See [deploy/gcp/README.md](deploy/gcp/README.md) for the 30-day trial setup, persistent VM disk, HTTPS, coturn, and environment variables. The VM runs the Node.js app and WebRTC TURN relay; Supabase remains the durable database and image store. Google Cloud's trial is credit-based and stops trial resources if the billing account is not upgraded before the trial closes. The first month is a test period; review the actual usage and price before choosing a paid plan.

Use Supabase managed PostgreSQL for the durable relational store. Create a Supabase project and run [supabase-schema.sql](supabase-schema.sql) in its SQL Editor. In Project Settings → API Keys, copy the project URL and a server-side `sb_secret_...` key. Keep that key only in the VM's root-protected `/etc/baxberi/baxberi.env`; never add it to the browser, VM startup metadata, or repository. The server sends the modern secret key in the `apikey` header only. A legacy `service_role` JWT is supported as a migration fallback. Supabase is deprecating legacy keys by the end of 2026, so use the new secret key for a fresh deployment. The Node server uses Supabase's REST interface, with no added npm dependencies. [Supabase API keys](https://supabase.com/docs/guides/getting-started/api-keys), [Postgres connection options](https://supabase.com/docs/guides/database/connecting-to-postgres).

The same Supabase project stores profile photos. The SQL file creates a 2 MB public-read bucket named `baxberi-profiles`; writes are made only by the Node server using the private Supabase secret key. The app checks image signatures and size before storing PNG/JPEG/WEBP/GIF objects. Public read is intentional because profile photos are visible to other users.

Configure coturn (or a managed TURN service) with the REST authentication secret. For coturn, enable `use-auth-secret` and set `static-auth-secret` to the same value as `TURN_SECRET`. The server provides per-user TURN credentials that expire after one hour. `TURN_URL` accepts comma-separated `turn:` and `turns:` endpoints. The public Google STUN endpoint remains configured as a fallback.

### Production environment variables

Create `/etc/baxberi/baxberi.env` on the VM and restrict it to root (`chmod 600`). Do not put secrets in Git or startup metadata.

| Variable | Value |
| --- | --- |
| `NODE_ENV` | `production` |
| `SUPABASE_URL` | Your Supabase project URL |
| `SUPABASE_SECRET_KEY` | Supabase `sb_secret_...` server key; keep private |
| `SUPABASE_STORAGE_BUCKET` | Bucket created by the SQL script (`baxberi-profiles`) |
| `TURN_URL` | Comma-separated TURN/TURNS endpoints |
| `TURN_SECRET` | coturn shared secret; keep private |
| `PORT` | `3000`, behind Nginx |

The service deliberately exits at startup in production when the database, object store, or TURN settings are missing. Test registration, login, profile editing, image uploads, WebSocket chat, and video signaling on the deployed HTTPS URL.

## Data and migration

The new Supabase schema stores accounts, sessions, follows, visitors, chats, gifts, and reactions in separate tables with indexes and foreign keys. Run the SQL file first. To migrate the old private JSON database, copy the original `data/db.json` to a protected local location and run `SUPABASE_URL=... SUPABASE_SECRET_KEY=... node tools/import-json.js /protected/path/db.json` (set those variables in your shell or use PowerShell environment variables). The importer copies account hashes and chat history where sender names match, and intentionally invalidates every old session. Do not put the JSON file or secrets in Git. The referenced archive's database and session hashes are deliberately excluded from the repository.

## Security and capacity notes

- The Supabase secret key is server-only; SQL enables row-level security and revokes public client roles.
- Cookies are HttpOnly and SameSite=Lax; HTTPS enables Secure cookies. Login/registration have basic in-memory IP rate limits.
- Upload size is capped at 2 MB and the byte signature must match PNG, JPEG, WEBP, or GIF. Upload moderation and image re-encoding are not included.
- Age is limited to 13+ as profile input, not age verification.
- TURN REST credentials expire after one hour. Keep all provider secrets in the root-protected VM environment file.
- This removes the JSON-database and local-image bottlenecks, but the app's online presence, WebSocket routing, and WebRTC signaling state are still process-local. Keep one app instance until shared presence/signaling (for example Redis pub/sub) is implemented. A 10,000+ user production claim requires shared presence/signaling, load testing, monitoring/alerts, backups and recovery drills, abuse moderation, and a production TURN capacity plan.
