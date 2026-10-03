# Contributing

Open pull requests against `main`. Keep changes focused and include regression
tests for bug fixes. Use synthetic names, addresses, paths, and conversations in
tests and screenshots; do not copy private workspace data into fixtures.

## Desktop validation

Use Node.js 24 and the pnpm version declared in `electron/package.json`:

```sh
cd electron
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build
```

These commands compile and test source; they do not publish an application.
Official signing and release publishing are managed separately. Source CI has
read-only repository permissions and no signing or deployment credentials.

## Team Hub validation

The Team Hub package source is `server/agentsdock_team_hub`; its tests are part
of the server suite. From `server/`:

```sh
PYTHONDONTWRITEBYTECODE=1 uv run --python 3.13 python -m unittest tests.test_team_hub_foundation tests.test_team_hub_host
```

See the component READMEs for server and mobile development instructions.

## Before submitting

- Keep secrets, certificates, local configuration, logs, and generated build
  output out of Git.
- Do not attach private chats, internal URLs, or real research artifacts to bug
  reports. Redact logs and use a minimal synthetic reproduction.
- Preserve third-party license notices and dependency integrity data.
- Do not turn a build or test into an automatic release or deployment.

## Licensing

Unless explicitly stated otherwise, contributions to Apache-licensed project
code are submitted under the [Apache License 2.0](LICENSE), as described in
section 5 of the license. Only contribute material you have the right to submit.
Preserve separate component licenses and attribution notices; see [NOTICE](NOTICE).
