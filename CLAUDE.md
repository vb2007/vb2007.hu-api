# Must-follow rules

These rules apply to every change, however small.

## Workflow

1. **Every change needs its own issue first.** Reuse an open issue if one already covers it. Otherwise create a minimal issue describing the work, using the matching template in `.github/ISSUE_TEMPLATE/` (`bug.yml`, `feature.yml` or `documentation.yml`). Fill in the template's fields as `###` headings, and apply its label and assignee.
2. **Move the issue to "In Progress" when you start working on it.** This is mandatory for every issue you work on, new or existing. The issues live in the project "vb2007.hu API development progress tracking" (`vb2007` project 5), and GitHub's automation adds each one there as "Todo". Wait until it has, then set the status with `gh` (this needs the token's `project` scope: `gh auth refresh -h github.com -s project`):

   ```bash
   issue=<issue>
   for _ in $(seq 30); do
     status=$(gh issue view "$issue" -R vb2007/vb2007.hu-api --json projectItems --jq '.projectItems[] | select(.title == "vb2007.hu API development progress tracking") | .status.name')
     [ -n "$status" ] && break
     sleep 10
   done
   [ "$status" = "In Progress" ] || gh project item-edit 5 --owner vb2007 --field Status --value "In Progress" \
     --url "https://github.com/vb2007/vb2007.hu-api/issues/$issue"
   ```

   Never set an issue to "Done", or any other status that ends the work, yourself: the project's "Auto-close issue" workflow would close it before `dev` reaches `main`. Closing needs no handling, since the issue closes on its own once its PR reaches `main`.

3. **Work from `dev`.** Branch off `dev`, named `dev-<short-topic>` (e.g. `dev-email-leak-fix`).
4. **PRs only target `dev`.** Never open a PR to `main`: the owner merges `dev` into `main` afterwards, usually in batches. Merging to `main` releases and deploys.
5. **Assign and label every PR.** Assignee `vb2007`, and at least one label, usually the issue's; add more if they fit.
6. **Link the issue with a closing keyword** on its own line at the end of the PR description, before the footer: `Resolves: #<issue>`. Use one line per issue if there are several. It closes the issue once `dev` reaches `main`, but on a PR into `dev` it doesn't link the issue under the PR's "Development". So as soon as the PR is open, link each issue through GraphQL's `addCloseIssueReferences`. This is mandatory: don't leave it to the owner. Run it once per issue, then check that the PR lists the issue:

   ```bash
   id() { gh api graphql -F n="$1" --jq '.data.repository.issueOrPullRequest.id' \
     -f query='query($n:Int!){repository(owner:"vb2007",name:"vb2007.hu-api"){issueOrPullRequest(number:$n){... on Issue{id} ... on PullRequest{id}}}}'; }
   gh api graphql -f i="$(id <issue>)" -f p[]="$(id <pr>)" \
     -f query='mutation($i:ID!,$p:[ID!]!){addCloseIssueReferences(input:{issueId:$i,pullRequestIds:$p}){clientMutationId}}'
   gh pr view <pr> -R vb2007/vb2007.hu-api --json closingIssuesReferences --jq '[.closingIssuesReferences[].number]'
   ```

   `removeCloseIssueReferences` takes the same input and undoes a wrong link.

7. **Commit frequently**, one logical step per commit, so the history is easy to trace.
8. **Check CI and leave the PR merge-ready.** Watch `gh pr checks` after every push and fix failures until every check is green and the PR has no conflicts. The work isn't finished before that.

## Database

- **Never touch the production database.** Local development and `yarn test` use `vb2007hu-dev` from `.env`; never point anything at `vb2007hu-api` unless the owner explicitly says so. If `.env` points anywhere else, stop and ask.

## API docs

- **Every new or changed endpoint updates its `src/docs/paths/<router>.ts` in the same PR**: every status code with its `error` strings (from `Responses`), request bodies, query and path parameters with their limits, response bodies, auth (session only, or the API key scope it takes) and rate limits with their `429`s. Shared answers and schemes live in `src/docs/components.ts`.
- Admin routes and admin-only schemas go only in `src/docs/paths/admin.ts`, which is served only on the superuser-only `/docs/admin`. The public docs may say that the superuser passes owner checks and may list the `admin:*` scope names in the API key schema, but never document an `/admin` route or admin-only schema.
- `src/tests/docs.test.ts` checks coverage and structure only: every route documented and every documented route real, required fields, the auth scheme and `401`/`403`/`429` answers a route's middlewares imply, both specs valid. The status codes, `error` strings, bodies and limits are the author's job to get right.

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

- **Stack:** Express + TypeScript + Prisma ORM 8 on MongoDB (an external LAN host), yarn 1. Routes live in `src/router/`, handlers in `src/controllers/`, queries in `src/database/`, the Prisma contract and client in `src/prisma/` (see `docs/prisma.md`). The frontend is `vb2007/vb2007.hu-vue`.
- **Checks before a PR:** `yarn build`, `yarn test` (Jest + supertest against a running API, so it needs a filled-in `.env`, see `docs/dotenv-setup.md`; it includes the docs coverage test `src/tests/docs.test.ts`) and `docker build .`. Put what you ran in `## Tested locally`.
- **Deploy:** the API ships as `ghcr.io/vb2007/vb2007.hu-api` and runs from `compose.yaml` (API + cloudflared tunnel, API also on `127.0.0.1:3000` for the cdn's nginx). `.github/workflows/release.yml` versions, releases and deploys on push to `main` only; see README. `archive/` holds the old systemd deploy, kept for reference only.
