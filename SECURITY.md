# Vieploy security policy

Report Vieploy vulnerabilities privately through the repository's Security tab. Include the affected version, steps to reproduce, and the impact. Remove credentials, backup codes and real user data from reports.

[Report a vulnerability](https://github.com/alexec0de/dokploy/security/advisories/new)

Every account must enroll a TOTP authenticator and verify each interactive session. Host operators can recover the owner account with `reset-2fa`, which revokes existing sessions and requires fresh enrollment.

Production startup requires a private authentication secret and private PostgreSQL credentials. See the [configuration guide](README.md#production-credentials).
