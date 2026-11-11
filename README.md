<p align="center">
  <img src="apps/vieploy/public/logo.svg" alt="Vieploy" width="440" />
</p>

Vieploy is a self-hosted platform for deploying and managing applications, databases, and Docker Swarm workloads. It is based on the Dokploy project and retains its original license notices.

## Install on a VPS

On a fresh AMD64 or ARM64 Linux VPS, run the installer after the GitHub Actions build has published the public Vieploy image. The script installs Docker Engine on Ubuntu or Debian when needed. For other distributions, install Docker Engine first. It sets up Docker Swarm, PostgreSQL, Traefik, and the panel. It generates separate PostgreSQL and authentication secrets and stores them in Docker Swarm.

```bash
curl -fsSLo install.sh https://raw.githubusercontent.com/alexec0de/dokploy/vieploy/install.sh
sudo bash install.sh
```

The panel uses TCP port 3000. Traefik uses TCP ports 80 and 443 and UDP port 443. Before installation, restrict public access to port 3000 using the VPS provider firewall while you create the first owner account. You can connect through SSH from your computer.

```bash
ssh -L 3000:127.0.0.1:3000 user@VPS_IP
```

Open [the panel over the SSH tunnel](http://localhost:3000), create the owner account, and configure 2FA. To install a specific published build, pass its full commit SHA in `VIEPLOY_TAG`. If Swarm cannot select the VPS network interface, pass its local IP address in `ADVERTISE_ADDR`.

## Run from source

Use Node.js 24.22.1, pnpm 10.22.0 and Docker. Run these commands from the Vieploy checkout.

```bash
pnpm install --frozen-lockfile
cp apps/vieploy/.env.example apps/vieploy/.env
pnpm run vieploy:setup
pnpm run vieploy:dev
```

Open [the local panel](http://localhost:3000). The [contributing guide](CONTRIBUTING.md) covers local development and Docker builds.

## Two-factor authentication

Every user must configure a TOTP authenticator app and verify each interactive session. This includes administrators and users who sign in through SSO, social providers or a passkey. Save the recovery codes during setup. Each recovery code can be used once.

Existing accounts without 2FA enter setup before the dashboard. Existing sessions for enrolled users must complete a new challenge. API keys used by automation require an active account with 2FA enabled. An operator with host access can use the `reset-2fa` command to revoke the owner's sessions and require enrollment again.

## Production credentials

Configure `BETTER_AUTH_SECRET` or `BETTER_AUTH_SECRET_FILE` with a unique secret of at least 32 characters. Configure private PostgreSQL credentials through `DATABASE_URL` or `POSTGRES_PASSWORD_FILE`. For an existing instance that uses the old default auth secret, migrate the stored authenticator secrets and recovery codes with the included `migrate-auth-secret` command before changing the secret.

## Existing installations

For an existing Swarm installation, back up PostgreSQL and `/etc/dokploy`, and verify that its authentication and PostgreSQL secrets meet the requirements above. Then switch the existing service to the published Vieploy image from the Swarm manager.

```bash
sudo docker service update --image ghcr.io/alexec0de/vieploy:vieploy dokploy
```

The service retains its mounts and environment and applies the included database migration during startup.

## Manual updates

The server settings check the `vieploy` branch of [alexec0de/dokploy](https://github.com/alexec0de/dokploy/tree/vieploy). GitHub Actions builds the branch for AMD64 and ARM64 and publishes each image to `ghcr.io/alexec0de/vieploy` under its commit SHA. The panel installs the published image by digest after an administrator confirms the update.

After the first successful publish, set the [container package](https://github.com/users/alexec0de/packages/container/package/vieploy) visibility to Public so Docker Swarm can pull it.
