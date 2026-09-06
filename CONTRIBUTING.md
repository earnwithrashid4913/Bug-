# Contributing to GOATVERSE MD

Thank you for improving GOATVERSE MD. Keep contributions focused, tested, and safe for deployers.

## Development flow

1. Use Node.js 20.9+ and install dependencies with `npm ci`.
2. Set a non-production `BOT_NUMBER` and run `npm run start:dry`.
3. Run `npm run check` and `npm test` before submitting changes.
4. Describe any deployment, storage, or authorization impact in the pull request.

## Security and identity rules

Do not weaken or bypass `system/security.js`, the protected identity manifest verification, sender normalization, or group/bot-admin checks. Never commit `.env`, session files, private keys, API keys, trusted identity manifests, or HMAC secrets.

`BOT_NUMBER`, `INSTANCE_OWNER_NAME`, `INSTANCE_OWNER_NUMBER`, and `THEME` are deployer instance settings. They must not become Global Owner or Developer identity. New themes must remain data-only and must not duplicate core authorization or command logic.

## Scope and tests

Avoid destructive WhatsApp payloads and unrelated dependency upgrades. Add a regression test when changing configuration validation, authorization, storage, parsing, or media handling.
