# Security policy

Security fixes target the current `main` branch. This is a loopback-only personal app, not a multi-user hosted service. Its local API trusts processes and users with access to the same machine; it still restricts Host to the bound loopback port, checks mutation Origin and cross-site fetch metadata, enforces JSON media type and streamed size caps, constrains static and vault paths, and sends CSP and other security headers. These reduce browser and input attacks; they do not authenticate local processes. An OpenAI-compatible endpoint is a separate trust boundary.

Please report an undisclosed vulnerability privately through [GitHub security advisories](https://github.com/lidge-jun/ocx-dictation-web/security/advisories/new). Include the affected commit, reproduction steps, expected impact, and whether a malicious website, local process, or upstream endpoint is involved. Do not include real recordings, credentials, or personal notes. If private reporting is unavailable, open a public issue requesting a secure coordination channel without exploit details.

Ordinary bugs and already public fixes may use issues or pull requests. The project does not promise remote access, authentication between local users, or protection from a compromised operating-system account.
