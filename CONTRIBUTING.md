# Contributing to ANIME MD

Thank you for improving ANIME MD. Keep contributions focused, tested, and safe for deployers.

## Development flow

1. Use Node.js 20.9+ and install dependencies with `npm ci`.
2. Run `npm run start:dry` to validate the configuration without opening WhatsApp.
3. Run `npm run check` and `npm test` before submitting changes.
4. Describe any deployment, storage, or authorization impact in the pull request.

## Security and identity rules

Do not weaken or bypass `system/security.js`, the protected identity manifest verification, sender normalization, or group/bot-admin checks. Never commit `.env`, session files, private keys, API keys, trusted identity manifests, or HMAC secrets.

`OWNER_NAME` is a deployer display setting. The linked WhatsApp account is selected only through the authorized Telegram pairing flow. This setting must not become Global Owner or Developer identity.

## Scope and tests

Avoid destructive WhatsApp payloads and unrelated dependency upgrades. Add a regression test when changing configuration validation, authorization, storage, parsing, or media handling.
