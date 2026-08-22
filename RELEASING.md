# Releasing & maintaining pi-agent-protocol

A short maintainer log — how to change the plugin and ship a new version, plus the
account/auth setup this repo uses (so future-you doesn't re-figure it).

## Make a change → ship it

1. Edit source under `src/` (+ tests under `test/`).
2. `npm run typecheck && npm test` — must be green (the tests are the spec).
3. Add a `CHANGELOG.md` entry under a new `## [x.y.z]` heading (what changed + why).
4. Bump `version` in `package.json` (semver: patch = fix, minor = feature, major = breaking).
5. Commit, tag, push (see the identity note below):

   ```sh
   git add -A
   git commit -m "…"
   git tag vX.Y.Z && git push && git push --tags
   ```

6. Publish to npm (optional): `npm publish` — `prepublishOnly` runs typecheck + tests first.
7. `/reload` any running pi session to pick up the new code (installed-package users pull the new tag).

## Git identity / auth for this repo (multi-account)

This repo pushes as **igorrize** without touching the machine's default (work) git account:

- **Commit identity is repo-local** — `user.name = igorrize`, `user.email = igor.lobazoff@gmail.com`
  (set via `git config user.email …` in this repo only; the global/work config is untouched).
- **Push auth is via an SSH host alias**, so no `gh auth switch` is needed:
  - remote: `git@github.com-igorrize:igorrize/pi-agent-protocol.git`
  - `~/.ssh/config` alias: `Host github.com-igorrize` → `IdentityFile ~/.ssh/igorrize_ed25519`
  - verify: `ssh -T git@github.com-igorrize` → should print `Hi igorrize!`
- `igor.lobazoff@gmail.com` must stay **verified** on the `igorrize` GitHub account, else commits show the email but don't attribute to the account.
- Quick pre-push check: `git log -1 --format='%an <%ae>'` → `igorrize <igor.lobazoff@gmail.com>`.

## Install channels

- **git:** `pi install git:github.com/igorrize/pi-agent-protocol` (works from the pushed repo).
- **npm:** after `npm publish`, `pi install npm:pi-agent-protocol`.
- Install globally (a `packages` entry in `~/.pi/agent/settings.json`) so it runs in every session.
  Don't also keep a local-dev `extensions` path to the checkout — that double-loads the extension.

## Runtime logs / observability

- `AP_AUDIT_FILE=1` (or an explicit path) → contract events appended to `~/.pi/agent/agent-protocol/audit.jsonl`.
- `ap_audit({ n })` → recent events in the current session.
- The extension logs load counts and handler errors to stderr (`[agent-protocol] …`).
- `AP_MODE=warn` (default) surfaces every bypass in the audit without blocking — the intended way to observe how agents route around contracts before tightening to `block`.
