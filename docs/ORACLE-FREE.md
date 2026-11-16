# Going live on Oracle Cloud "Always Free"

Rezonest Work OS on one free Oracle ARM server (Ampere A1). It uses the same Docker files as
`docs/HOSTINGER-KVM1.md`; the differences are creating the server, logging in, and opening ports.
Allow 1–2 hours the first time, plus waiting if Oracle says it's out of capacity.

> Free means no support and no guarantee. Keep off-server backups (Cloudflare R2), so you can move to
> Hostinger or anywhere else with a backup and restore if Oracle ever changes the free offer.
> These Docker files haven't been run on a real server yet; send any error to your developer.

---

## Before you start

- Your code pushed to GitHub (`git push` on your PC).
- A web address for the app, e.g. `app.rezonest.com`.
- SMTP details for email.
- **A Cloudflare R2 bucket (strongly recommended here).** Uploads and daily backups then live off the server.
- A debit/credit card for Oracle's identity check. Always Free resources aren't charged.

## Step 1: Sign up, and choose the home region carefully

1. Sign up at **oracle.com/cloud/free**.
2. **Home region:** pick **India West (Mumbai)** or **India South (Hyderabad)**. This **can't be changed later**, and
   Always Free servers only exist in your home region.

**Recommended: upgrade the account to "Pay As You Go"** (Billing → Upgrade). Always Free resources stay free, but:
- free accounts that look idle can have their servers **reclaimed** (a 7-user app looks idle most of the time);
- "out of capacity" errors are much rarer.

If you upgrade, set a **budget alert** (Billing → Budgets, e.g. ₹100) so you're emailed before anything costs money,
and only create the resources in this guide.

## Step 2: Create the server

Menu → **Compute → Instances → Create instance**:

| Setting | Choose |
|---|---|
| Image | **Canonical Ubuntu 24.04** (the aarch64 / ARM build) |
| Shape | **Ampere → VM.Standard.A1.Flex**, **2 OCPU, 12 GB memory** (free up to 4 OCPU / 24 GB in total) |
| Networking | Create new virtual cloud network, **public subnet**, **Assign a public IPv4 address: Yes** |
| SSH keys | **Generate a key pair**, then **Save private key** (a `.key` file). Keep it safe; you can't download it again. |
| Boot volume | Default (about 47 GB) is fine; free up to 200 GB in total |

Click **Create**. If it says **"Out of capacity"**, try another availability domain, or try again later (early morning
often works). Once it's **Running**, note the **Public IP address**.

**Make the IP permanent (recommended):** Networking → **Reserved public IPs** → reserve one, then attach it to the
instance's network interface. Otherwise the address can change if the instance is ever stopped.

## Step 3: Open ports 80 and 443 in Oracle's network

Oracle has its own firewall in front of the server.

Instance page → **Subnet** link → **Security Lists** → *Default Security List* → **Add Ingress Rules**, twice:

| Source CIDR | IP protocol | Destination port |
|---|---|---|
| `0.0.0.0/0` | TCP | `80` |
| `0.0.0.0/0` | TCP | `443` |

(Port 22 for SSH is already open.)

## Step 4: Point your address at the server

At your DNS provider: **A record**, name `app`, value = the server's public IP.

## Step 5: Connect from your PC

Move the downloaded key somewhere safe, e.g. `C:\Users\rezon\.ssh\oracle.key`, then in **PowerShell**:

```bash
ssh -i C:\Users\rezon\.ssh\oracle.key ubuntu@YOUR-SERVER-IP
```

The user is **`ubuntu`**, not root. If Windows says the key's permissions are too open, right-click the file →
Properties → Security → Advanced → Disable inheritance → remove everyone except your own user.

## Step 6: Update, and open ports on the server itself

Oracle's Ubuntu images have their own firewall rules that block web traffic. **Don't use `ufw` here**; it clashes
with Oracle's rules. Instead:

```bash
sudo apt update && sudo apt upgrade -y
sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 80 -j ACCEPT
sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 443 -j ACCEPT
sudo netfilter-persistent save
```

No swap is needed: the server has 12 GB of memory.

## Step 7: Install Docker

```bash
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker ubuntu
exit
```

Log in again (Step 5) so the change takes effect, then check: `docker compose version`.

## Step 8: Get the code

```bash
ssh-keygen -t ed25519 -C "rezonest-oracle" -f ~/.ssh/github -N ""
cat ~/.ssh/github.pub
```

On GitHub: repository → **Settings → Deploy keys → Add deploy key**, paste, leave **write access off**. Then:

```bash
printf 'Host github.com\n  IdentityFile ~/.ssh/github\n' >> ~/.ssh/config
sudo mkdir -p /opt/rezonest && sudo chown ubuntu:ubuntu /opt/rezonest
git clone git@github.com:rezonestdevelopers/rezonest-worky.git /opt/rezonest
cd /opt/rezonest
```

## Step 9: Settings file, build, first login

These are the same as **Steps 8–11 in `docs/HOSTINGER-KVM1.md`**:

1. Make the three secrets (`openssl rand ...`), then `cp .env.example .env && nano .env` and fill in the address,
   secrets, first-login email and password, SMTP, and the R2 (`STORAGE_DRIVER="s3"`, `S3_...`) lines.
2. Build and start (about 5–10 minutes on this server):

   ```bash
   docker compose -f docker-compose.prod.yml up -d --build
   docker compose -f docker-compose.prod.yml ps
   ```

3. Create your settings and login, without sample data:

   ```bash
   docker compose -f docker-compose.prod.yml exec app pnpm db:seed --no-sample
   ```

4. Open **https://app.rezonest.com**, log in, run
   `docker compose -f docker-compose.prod.yml exec app pnpm go-live-check`, and work through its list
   (password, GSTIN, bank, SAC codes, test email, Back up now, team, import).

---

## Backups on Oracle

- **Database and uploads:** with R2 set up, the app's daily backups and all uploads are already off the server.
- **Whole server:** Storage → **Block Storage → Boot Volume Backups**; Always Free includes a few backups. Make one
  after setup, and again every month or before big updates.
- **Monthly:** download one backup from Settings → Backups to your PC or Google Drive.

## Updating later

Settings → Backups → **Back up now**, then:

```bash
cd /opt/rezonest && git pull && docker compose -f docker-compose.prod.yml up -d --build
```

## If something goes wrong

| Problem | What to do |
|---|---|
| "Out of capacity" when creating | Another availability domain, a later time, or upgrade to Pay As You Go |
| Website doesn't open | Check both firewalls: the Security List rules (Step 3) **and** the iptables rules (Step 6). Then `docker compose -f docker-compose.prod.yml logs web` |
| No https certificate | DNS isn't pointing at the server yet (`ping app.rezonest.com` should show your IP) |
| `permission denied` running docker | You skipped logging out and in after Step 7 |
| Page error | `docker compose -f docker-compose.prod.yml logs --tail=100 app` |
| Server disappeared / stopped | Idle reclamation on a free account. Restore from backup on a new instance, and upgrade to Pay As You Go to prevent it |

## Moving to paid hosting later

Back up now → download the backup → set up the new server (e.g. `docs/HOSTINGER-KVM1.md`) → restore the backup
(README, section 5). With R2, your uploaded files are already in place; use the same R2 settings and the **same
`AUTH_SECRET`** so client links keep working.
