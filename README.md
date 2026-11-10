<p align="center">
  <img src="apps/vieploy/public/logo.svg" alt="Vieploy" width="440" />
</p>

Vieploy is a self-hosted platform for deploying and managing applications, databases, and Docker Swarm workloads. It is based on the Dokploy project and retains its original license notices.

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

The application still recognizes the original Docker service, network and volume names, storage paths, database identifiers and environment variables. Apply the included database migration when deploying the Vieploy build. To enable in-panel updates, configure `VIEPLOY_IMAGE` with the Docker Hub namespace and repository of your Vieploy builds.
