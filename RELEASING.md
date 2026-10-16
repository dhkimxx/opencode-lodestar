# Releasing

## Versions

- Versions follow [Semantic Versioning](https://semver.org).
- While the version is `0.x`, a minor release (`0.2.0`) may include breaking changes. A patch release (`0.1.1`) only fixes bugs.
- Every release is an annotated git tag named `vX.Y.Z`, made on `main`. A tag is never moved or reused.
- Pre-releases use `vX.Y.Z-beta.N`, for example `v0.2.0-beta.1`.

## Channels

| Channel     | GitHub                                                        | npm (later)        |
| ----------- | ------------------------------------------------------------- | ------------------ |
| Latest      | `main`, and the newest `vX.Y.Z` release, marked **Latest**     | dist-tag `latest`  |
| Pre-release | `vX.Y.Z-beta.N` tags, published as pre-releases                | dist-tag `next`    |
| Pinned      | any `vX.Y.Z` tag, for example `github:dhkimxx/opencode-lodestar#v0.1.0` | an exact version |

- `main` is always ready to release. Work happens on branches and merges into `main` when it is ready.
- `opencode plugin add github:dhkimxx/opencode-lodestar` follows `main`, and `opencode plugin update` picks up new commits.
- There is no `latest` git tag. Moving a tag breaks pinned installs and caches. "Latest" means the default branch, the GitHub release marked Latest, and npm's `latest` dist-tag.

## Steps

1. Update `version` in `package.json` and add a section for it to `CHANGELOG.md`.
2. Run `bun run check` and commit the rebuilt `dist/` with the version change, for example `Release v0.2.0`.
3. Tag and push:

   ```sh
   git tag -a v0.2.0 -m "v0.2.0"
   git push origin main v0.2.0
   ```

4. The Release workflow checks that the tag matches `package.json` and creates a GitHub release with the notes from `CHANGELOG.md`. Tags with a `-`, like `v0.2.0-beta.1`, become pre-releases.

## Publishing to npm

The package is named `@dhkimxx/opencode-lodestar`, under the same scope as the author's other OpenCode plugins.

1. Sign in with `npm login`.
2. Publish a release with `npm publish`, which uses the `latest` dist-tag. Publish a pre-release with `npm publish --tag next`.
3. Users can then install with `opencode plugin add @dhkimxx/opencode-lodestar`.

To publish automatically, add an `NPM_TOKEN` repository secret and a `npm publish --provenance` step to the Release workflow.
