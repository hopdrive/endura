# Changesets

Every change that should reach npm needs a changeset. Run `npm run changeset`, pick
the bump, and write the line you want users to read in the changelog. Commit the
generated file in `.changeset/` with your work.

You never edit `version` in `package.json` and you never run `npm publish`. The
release workflow does both. See [`docs/RELEASING.md`](../docs/RELEASING.md) for how
that works and what the two-step release actually looks like.

The full tool documentation lives at
https://github.com/changesets/changesets.
