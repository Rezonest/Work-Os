# Going live on Hostinger KVM 1

Step-by-step setup for Rezonest Work OS on one Hostinger KVM 1 server (1 CPU, 4 GB memory, 50 GB disk),
for about 7 users. It uses the Docker files already in this project (`Dockerfile`, `docker-compose.prod.yml`,
`deploy/Caddyfile`, `deploy/jobs.sh`). Allow about 1–2 hours the first time.

> These Docker files haven't been run on a real server yet. If a step fails, copy the error message and
> ask your developer (or Claude) to fix it. Nothing here touches the copy on your PC.

---

## Before you start, have these ready

| What | Example | Where to get it |
|---|---|---|
| Your code on GitHub | `rezonestdevelopers/rezonest-worky` | Run `git push` on your PC first |
| A web address for the app | `app.rezonest.com` | Wherever rezonest.com's DNS is managed |
| SMTP email details | Google Workspace or Zoho | Your email provider's "SMTP / app password" page |
| Cloud storage for files and backups (recommended) | Cloudflare R2 bucket | cloudflare.com → R2 (free up to 10 GB) |

**Why cloud storage:** uploads (logos, documents, creatives) and the daily database backups are then kept
**off the server**. If the server ever fails, nothing is lost. Without it, they sit on the same server.

---

## Step 1: Create the server (Hostinger panel)

1. hPanel → **VPS** → your KVM 1 → **Operating system**: choose **Ubuntu 24.04** (plain, no control panel).
2. **Location**: India, if offered; otherwise the closest one.
3. Set a strong **root password** and save it in your password manager.
4. Note the server's **IP address** (for example `187.xx.xx.xx`).
5. Turn on Hostinger's **automatic backups / snapshots** for this VPS if your plan offers them.

## Step 2: Point your web address at the server

At your DNS provider for rezonest.com, add a record:

| Type | Name | Value | TTL |
|---|---|---|---|
| A | `app` | your server IP | 300 (or lowest) |

It can take from a few minutes up to a few hours to work. The secure (https) certificate is only issued once it does.

## Step 3: Connect to the server

On your PC, open **PowerShell** and type (use your IP):

```bash
ssh root@187.xx.xx.xx
```

Type `yes` the first time, then the root password. Every command from here on is typed **in this window, on the server**.

## Step 4: Update and add swap (needed on KVM 1)

Swap is extra "memory" on disk. Building the app needs more memory than KVM 1 has, so without swap the build can fail.

```bash
apt update && apt upgrade -y
fallocate -l 4G /swapfile
chmod 600 /swapfile
mkswap /swapfile
swapon /swapfile
echo '/swapfile none swap sw 0 0' >> /etc/fstab
free -h
```

`free -h` should now show **Swap: 4.0Gi**.

## Step 5: Firewall

Only allow logins (22) and the website (80, 443):

```bash
ufw allow 22/tcp
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable
ufw status
```

The database is never opened to the internet; `docker-compose.prod.yml` keeps it private.

## Step 6: Install Docker

```bash
curl -fsSL https://get.docker.com | sh
docker --version
docker compose version
```

Both commands should print a version number.

## Step 7: Get the code (private repository)

Create a read-only key so the server can download your code from GitHub:

```bash
ssh-keygen -t ed25519 -C "rezonest-server" -f ~/.ssh/github -N ""
cat ~/.ssh/github.pub
```

Copy the line it prints. On GitHub: your repository → **Settings → Deploy keys → Add deploy key**, paste it,
title it "Hostinger server", leave **Allow write access** unticked, and save. Then on the server:

```bash
printf 'Host github.com\n  IdentityFile ~/.ssh/github\n' >> ~/.ssh/config
git clone git@github.com:rezonestdevelopers/rezonest-worky.git /opt/rezonest
cd /opt/rezonest
```

Type `yes` if it asks about GitHub's fingerprint.

## Step 8: Create the settings file (.env)

Make three random secrets first and copy each one somewhere safe:

```bash
openssl rand -base64 32   # → AUTH_SECRET
openssl rand -hex 32      # → CRON_SECRET
openssl rand -hex 32      # → POSTGRES_PASSWORD
```

Then create the file and open it:

```bash
cp .env.example .env
nano .env
```

Set these lines (leave anything not listed as it is). **Don't copy the `.env` from your PC**; it points at your PC's database.

```bash
APP_DOMAIN=app.rezonest.com
APP_URL=https://app.rezonest.com
AUTH_SECRET="paste the first secret"
CRON_SECRET="paste the second secret"
POSTGRES_PASSWORD="paste the third secret"

SEED_ADMIN_EMAIL="yogeshwar@rezonest.com"
SEED_ADMIN_PASSWORD="a strong password for your first login"

# Email (example: Google Workspace, use an App Password, not your normal password)
SMTP_HOST="smtp.gmail.com"
SMTP_PORT=587
SMTP_USER="yogeshwar@rezonest.com"
SMTP_PASSWORD="your app password"
SMTP_FROM="Rezonest Work OS <yogeshwar@rezonest.com>"

# Files and backups in Cloudflare R2 (recommended). Skip this block to keep them on the server.
STORAGE_DRIVER="s3"
S3_ENDPOINT="https://<your-account-id>.r2.cloudflarestorage.com"
S3_REGION="auto"
S3_BUCKET="rezonest-workos"
S3_ACCESS_KEY_ID="from R2 → Manage API tokens"
S3_SECRET_ACCESS_KEY="from R2 → Manage API tokens"
```

Save with **Ctrl+O**, **Enter**, then exit with **Ctrl+X**.

**Keep a copy of `AUTH_SECRET`** in your password manager. If it ever changes, offer and content links already
sent to clients stop working, and everyone has to log in again.

## Step 9: Build and start

```bash
docker compose -f docker-compose.prod.yml up -d --build
```

On KVM 1 the first build takes a while (roughly 10–20 minutes). When it finishes, check that all four parts are running:

```bash
docker compose -f docker-compose.prod.yml ps
```

You should see `db`, `app`, `web` and `jobs` with status **Up** (`app` says *healthy* after a minute or two).

## Step 10: Create your login and settings (no sample data)

```bash
docker compose -f docker-compose.prod.yml exec app pnpm db:seed --no-sample
```

This creates the agency settings, departments, sectors, lead sources, the service catalogue, and your admin login.
**Don't** run the plain `db:seed`; that adds the sample Pune clients.

## Step 11: Open it and check

1. Open **https://app.rezonest.com** and log in with `SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD`.
2. Run the built-in checklist. It only reads, and lists what's still missing:

   ```bash
   docker compose -f docker-compose.prod.yml exec app pnpm go-live-check
   ```

3. Then, in the app:
   - **My account**: change your password.
   - **Settings → GST & Bank**: your real GSTIN, PAN, bank, UPI, logo and signature.
   - **Settings → Service catalogue**: add SAC codes (needed to issue GST invoices).
   - **Settings → Email templates**: send yourself a test email.
   - **Settings → Backups**: click **Back up now**, and check it says Done.
   - **Team**: add your 6 employees. Each gets an email link to set their own password.
   - Import your clients and leads (Clients → Import).
   - Create one real invoice as a **draft** and check its PDF before issuing.
4. Remove `SEED_ADMIN_PASSWORD` from `.env` now that you've changed it (`nano .env`, delete the value, save).

---

## Backups: what's covered

| What | How | Where it ends up |
|---|---|---|
| Database | Automatic daily backup by the app (scheduled job), last 30 days kept | R2 (off-server) if you set it up; otherwise on the server |
| Uploaded files | Stored as they're uploaded | R2, or on the server |
| Whole server | Hostinger snapshots / weekly backups | Hostinger |

**Monthly:** download one backup from Settings → Backups and keep it on your PC or Google Drive.
**Every few months:** practise a restore (README, section 5), so you know it works.

If you **didn't** set up R2, also copy the server's files off now and then:

```bash
docker run --rm -v rezonest_storage:/data -v /root:/out alpine tar czf /out/storage-backup.tgz -C /data .
```

Then download `/root/storage-backup.tgz` to your PC (for example with WinSCP). The volume name may differ;
`docker volume ls` shows it.

---

## Updating to a new version later

1. In the app: **Settings → Backups → Back up now**.
2. On the server:

   ```bash
   cd /opt/rezonest
   git pull
   docker compose -f docker-compose.prod.yml up -d --build
   ```

Database changes apply by themselves when the app starts. The app stays up while the new version builds, then
restarts (a minute of downtime). Update outside working hours, since the build makes KVM 1 slow for 10–20 minutes.

## Keeping the server healthy

- **Monthly:** `apt update && apt upgrade -y`, then `reboot` if it says a restart is needed. Everything comes back up by itself.
- **Disk space:** `df -h` (keep below 80%). Old Docker build files can be cleared with `docker system prune -f`.
- **Weekly:** glance at Settings → Backups for failures.

## If something goes wrong

| Problem | What to do |
|---|---|
| Build stops with "killed" or out of memory | Check swap is on (`free -h`). Run the build again. |
| The website doesn't open / no https | Check DNS points at the IP (`ping app.rezonest.com`), ports 80 and 443 are open, then `docker compose -f docker-compose.prod.yml logs web` |
| Page shows an error | `docker compose -f docker-compose.prod.yml logs --tail=100 app` |
| Daily jobs / backups not running | `docker compose -f docker-compose.prod.yml logs --tail=50 jobs`; each job should show `200` |
| Emails not arriving | Check the SMTP lines in `.env`, then restart: `docker compose -f docker-compose.prod.yml up -d` |
| Everything after a reboot | `cd /opt/rezonest && docker compose -f docker-compose.prod.yml ps` (they restart automatically) |

Send the output of the relevant `logs` command to your developer if you're stuck.

## When to move up from KVM 1

Upgrade to **KVM 2** in hPanel (no reinstall needed) if pages get slow during the working day, builds keep
failing even with swap, or the team grows past about 20 people.
