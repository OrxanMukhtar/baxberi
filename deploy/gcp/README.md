# Google Cloud Compute Engine deployment

This deployment uses one always-running Compute Engine VM for the Node.js app and coturn. PostgreSQL and profile images remain in Supabase. The VM boot disk is persistent; no user data should be stored on the VM.

## Trial and plan

Google Cloud's new-customer trial currently provides $300 for up to 90 days. For the first 30-day test, create the app VM from the trial account and keep it running. Before the trial expires, upgrade the billing account to keep resources running; upgrading earlier than day 90 is not necessary for the trial period. If the trial closes without an upgrade, Google stops the trial resources. The exact trial eligibility and offer are shown in the Cloud Console.

Use a small standard VM near the audience (for example, `e2-small` in a European region) with a persistent 20 GB boot disk. The trial credits cover eligible usage during the trial. After the test, check the Cost table and select a paid machine/disk/IP size before upgrading. Do not rely on the US-only always-free `e2-micro` for this Azerbaijani audience: it has 1 GB outbound traffic/month and can add latency.

## Create the VM

1. In the Google Cloud Console, start the Free Trial and create a project. The account owner must accept Google Cloud's terms and enter payment details for identity verification; Google says it does not bill during the trial.
2. Enable Compute Engine, then create a Debian 12 VM in a European region close to the audience. Start with `e2-small`, a persistent 20 GB boot disk, and an external IPv4 address. Reserve a static IPv4 address if you plan to point a domain at the VM; keep the expected IP charge in mind after the credit period.
3. Create a network firewall rule for TCP `22` (restrict source to your own IP), TCP `80,443`, TCP/UDP `3478`, TCP/UDP `5349`, and UDP `49160-49200`. Apply it only to the Baxberi VM using a network tag.
4. Add `deploy/gcp/startup.sh` as the VM's startup script, create the VM, and wait for the startup log to report that Nginx is active. The script pulls the public GitHub `main` branch and installs Node.js 22, Nginx, Certbot, and coturn. It does not start Baxberi until the secrets are configured.
5. Point a domain's DNS `A` record to the VM's public IPv4 address. HTTPS is required for camera/microphone access. SSH into the VM and run `sudo certbot --nginx -d YOUR_DOMAIN --redirect`; use an email address you control for Let's Encrypt renewal notices.

## Add secrets and start Baxberi

Create `/etc/baxberi/baxberi.env` as root with mode `600`. Do not put secrets in Git, VM startup metadata, or a screenshot. Add the values below:

```dotenv
NODE_ENV=production
PORT=3000
SUPABASE_URL=https://YOUR_PROJECT.supabase.co
SUPABASE_SECRET_KEY=YOUR_SERVER_ONLY_SB_SECRET_KEY
SUPABASE_STORAGE_BUCKET=baxberi-profiles
TURN_URL=turn:YOUR_DOMAIN:3478?transport=udp,turn:YOUR_DOMAIN:3478?transport=tcp,turns:YOUR_DOMAIN:5349?transport=tcp
TURN_SECRET=YOUR_LONG_RANDOM_SHARED_SECRET
```

Run the schema in `supabase-schema.sql` once in the Supabase SQL Editor before starting the app. Copy [turnserver.conf.example](turnserver.conf.example) to `/etc/turnserver.conf` and replace every placeholder. Make `static-auth-secret` exactly match `TURN_SECRET`; the certificate/key paths must match the domain certificate from Certbot. On a VM behind Google Cloud NAT, set coturn's `external-ip` to `PUBLIC_IP/PRIVATE_IP`, and both `listening-ip` and `relay-ip` to the VM's private IP. Protect `/etc/turnserver.conf` with mode `600`, enable coturn, then start Baxberi:

```sh
sudo chmod 600 /etc/baxberi/baxberi.env /etc/turnserver.conf
sudo systemctl enable --now coturn baxberi
```

Check `sudo systemctl status baxberi coturn nginx` and `curl -f https://YOUR_DOMAIN/readyz`. Test account creation, profile updates, image uploads, chat WebSockets, and video calls.

## Updating the app

```sh
cd /opt/baxberi/app
sudo git fetch origin main
sudo git reset --hard origin/main
sudo npm ci --omit=dev
sudo systemctl restart baxberi
```

The service automatically restarts after a VM reboot. Keep Supabase backups enabled and retain the server-only Supabase/TURN keys outside the repository.
