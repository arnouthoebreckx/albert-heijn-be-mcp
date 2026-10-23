# albert-heijn-be-mcp

An MCP server for Albert Heijn Belgium (TypeScript, ESM, Node 24, Apache-2.0). It starts from the code of
`olekpuchka/albert-heijn-mcp` v1.7.1 (see `NOTICE`) and does not follow upstream. The product spec is the
`spec` document on TOU-42; where it and this file disagree, the spec wins.

## Commands

| Command | What it does |
|---|---|
| `make setup` | `npm ci --ignore-scripts` |
| `make check` | the one gate: type check (`npm run lint`), build, tests (`node --test`), `mcpb validate` |
| `make audit` | `npm audit --omit=dev --audit-level=high` |

CI runs `make check` and `make audit`. Run both before every commit.

## Layout

- `src/` is the server: `ahapi/` (AH's API), `auth/`, `server/` (HTTP and OAuth), `tools/` (one file per tool group).
- `test/` holds the tests, run with Node's built-in runner (`node --test`). `test/tools.test.ts` pins the tool names.
- `manifest.json` (the `.mcpb` bundle), `server.json` (MCP Registry) and `package.json` carry the same name and
  version. `test/identity.test.ts` checks that they agree.
- `deploy/` holds the systemd unit; `.github/workflows/` holds CI and the release.

## Rules

1. Test first: a failing test, then the code. A test is never deleted, skipped or weakened to get green.
2. No new dependency without a reason in the pull request. Dev dependencies count.
3. The tool contract (names, inputs, outputs, annotations) changes only through a change to the spec.
4. No secrets and no tokens in the repository. `npm ci` always runs with `--ignore-scripts`.
5. Nothing is merged from upstream. A fix from upstream is ported by hand when the household asks for it.
6. The household merges, tags and releases. Nobody else does.
