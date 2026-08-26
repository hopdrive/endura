# Releasing endura

Endura publishes to npmjs as the public, unscoped package `endura`. Releases are
automated with changesets and GitHub Actions. Nobody edits `version` in
`package.json`, and nobody runs `npm publish` from a laptop.

## The normal loop

Add a changeset with your work.

```bash
npm run changeset
```

Pick the bump, write the line you want in the changelog, and commit the generated
file in `.changeset/` alongside your code.

When that merges to `master`, `.github/workflows/release.yml` runs and does one of
two things.

If unreleased changesets exist, it opens or updates a pull request titled "chore:
version packages". That PR consumes the changesets, bumps `version`, and writes
`CHANGELOG.md`. Merging it is the human gate on the next release, so a release is
never a surprise.

If no changesets are left, meaning the version PR was just merged, it runs
`npm run release`, which cleans, builds, and calls `changeset publish`. That
publishes to npm and cuts a matching GitHub Release.

## Auth, and why there is no npm token

The workflow publishes through npm Trusted Publishing over GitHub OIDC. There is no
`NPM_TOKEN` secret in this repo and there should never be one. npmjs verifies the
OIDC token issued to this specific workflow file in this specific repository, so a
leaked secret cannot be used to publish endura from anywhere else.

Because the repository is public, publishes also carry build provenance. Released
versions show the "signed on GitHub Actions" badge on npm, and anyone can verify
which commit and which workflow run produced a given tarball.

## First-time setup, done once

Configuring a trusted publisher requires the package to already exist on npmjs, so
the first publish is manual.

```bash
npm login
npm run clean && npm run build
npm publish --access public
```

`prepublishOnly` cleans and builds again on its own, so a stale `dist/` cannot ship
even if you skip the build above.

Then, on npmjs.com, open the `endura` package settings, go to the trusted publisher
section, and point it at:

- Repository `hopdrive/endura`
- Workflow filename `release.yml`

After that, every release goes through the workflow and no human publishes again.

## Things that will bite you

Do not add `npm install -g npm@latest` to the release workflow. Self-updating npm
over the Node 24 bundled copy drops npm's own bundled `sigstore`, which
`libnpmpublish` loads to build the provenance attestation. That is what broke
eventkit's 0.5.0 publish with "Cannot find module 'sigstore'". The bundled npm ships
it intact.

Do not set `registry-url` on `actions/setup-node` in the release job. It writes an
`.npmrc` with an empty `_authToken`, which shadows trusted publishing and turns the
publish into an authentication error. The registry comes from `publishConfig` in
`package.json` instead.

Node is pinned to 24 in the release job because npm 11 supports OIDC natively. Node
20 ships npm 10, which does not. CI still tests on both 20 and 24, which is about
supporting consumers, not about publishing.

## Consuming endura before a release exists

A plain git dependency does not work. `main` and `types` point into `dist/`, `dist/`
is gitignored, and npm runs `prepare` (not `prepublishOnly`) when installing from
git, so nothing builds and the entry point is missing. Install a published version,
or build a tarball locally with `npm pack` the way `examples/expo-app` does.
