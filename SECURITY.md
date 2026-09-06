# Security Policy

## Supported version

Security fixes are applied to the current default branch.

## Reporting a vulnerability

Do not open a public issue for a vulnerability involving credentials, session files, authorization bypasses, trusted identity manifests, or HMAC verification. Contact the maintainer privately through the repository owner's preferred GitHub contact method and include a minimal reproduction without real secrets or personal data.

## Deployment guidance

Keep `.env`, `AUTH_DIR`, `DATA_DIR`, session credentials, trusted identity manifests, HMAC keys, and AI API keys private. The project intentionally rejects protected owner/developer environment overrides and locks privileged functionality if configured identity verification fails.
