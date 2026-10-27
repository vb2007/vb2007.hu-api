# Must-follow rules

These rules apply to every change, however small.

## Workflow

1. **Every change needs its own issue first.** Reuse an open issue if one already covers it. Otherwise create a minimal issue describing the work, using the matching template in `.github/ISSUE_TEMPLATE/` (`bug.yml`, `feature.yml` or `documentation.yml`). Fill in the template's fields as `###` headings, and apply its label and assignee.
2. **Work from `dev`.** Branch off `dev`, named `dev-<short-topic>` (e.g. `dev-email-leak-fix`).
3. **PRs only target `dev`.** Never open a PR to `main`: the owner merges `dev` into `main` afterwards, usually in batches. Merging to `main` releases and deploys.
4. **Assign and label every PR.** Assignee `vb2007`, and at least one label, usually the issue's; add more if they fit.
5. **Link the issue with a closing keyword** on its own line at the end of the PR description, before the footer: `Resolves: #<issue>`. Use one line per issue if there are several. GitHub only shows the link under "Development" for PRs into `main`, and `gh` can't set it; the owner links it by hand once the PR is open.
6. **Commit frequently**, one logical step per commit, so the history is easy to trace.
7. **Check CI and leave the PR merge-ready.** Watch `gh pr checks` after every push and fix failures until every check is green and the PR has no conflicts. The work isn't finished before that.

## Code style

- Follow the existing minimal coding style, file and folder structure. Match the surrounding code's naming and idioms; don't add new layers or patterns when an existing one fits.
- **No comments where possible.** Clean code should be understandable without them; prefer clear names and small functions. Only comment what the code can't say (a non-obvious external constraint).
- Format with the repo's prettier config (`npx prettier --write <files>`).

## Issue schema

- Title: the template's prefix plus a short sentence: `[Bug] …`, `[Feature] …` or `[Docs] …`.
- Body: only the template's fields, kept minimal (a few bullets, see #77). A bug fills in all four: Version (latest release tag), Description, Repro steps + Actual behavior, Expected behavior.

## PR schema

- Title: `Merge <branch-name> To dev`.
- Description, in this order:
  1. Bullets describing what changed and why.
  2. `## Tested locally`: what was actually run and checked.
  3. `## Notes`: caveats, follow-ups, anything outside this repo. Omit if there are none.
  4. `Resolves: #<issue>`
  5. The footer `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.
- Commits: conventional prefixes (`feat:`, `fix:`, `docs:`, `test:`, `ci:`, `chore:`), ending with the `Co-Authored-By` line given in the session.

# Project context

- **Stack:** Express + TypeScript + Mongoose (MongoDB on an external LAN host), yarn 1. Routes live in `src/router/`, handlers in `src/controllers/`, models in `src/database/`. The frontend is `vb2007/vb2007.hu-vue`.
- **Checks before a PR:** `yarn build`, `yarn test` (Jest + supertest against a running API, so it needs a filled-in `.env`, see `docs/dotenv-setup.md`) and `docker build .`. Put what you ran in `## Tested locally`.
- **Deploy:** the API ships as `ghcr.io/vb2007/vb2007.hu-api` and runs from `compose.yaml` (API + cloudflared tunnel, API also on `127.0.0.1:3000` for the cdn's nginx). `.github/workflows/release.yml` versions, releases and deploys on push to `main` only; see README. `archive/` holds the old systemd deploy, kept for reference only.
