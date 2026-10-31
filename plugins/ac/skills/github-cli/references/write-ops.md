# gh write operations

Every command here changes state on GitHub and is visible to other people, so each one needs the user's request in this conversation. Pass the title, body and flags explicitly: a prompt in a non-interactive shell hangs. Pass `-R OWNER/REPO` when the working directory is not the target repository. Use `--body-file` (or `-F -` for stdin) for anything longer than a line, so quoting cannot mangle it. Flags below were checked against `gh --help` on gh 2.102.0.

## Contents

- Issues
- Pull requests
- Releases
- Workflows and runs
- Secrets and variables
- Labels
- Repositories
- gh api writes
- Bulk operations

## Issues

```bash
gh issue create --title "Bug: login fails" --body-file body.md --label bug --assignee @me
gh issue comment 123 --body "Working on this"
gh issue edit 123 --add-label in-progress --remove-label needs-triage
gh issue close 123 --reason "not planned" --comment "Out of scope"
gh issue reopen 123 --comment "Reproduced again"
```

- `create`: `-t/--title`, `-b/--body`, `-F/--body-file`, `-l/--label`, `-a/--assignee` (`@me` allowed), `-m/--milestone`, `-p/--project`, `-T/--template`, `--type`, `--parent`, `--blocked-by`, `--blocking`, `--attach file#alt`, `-e/--editor`, `-w/--web`, `--recover`.
- `comment`: `-b/--body`, `-F/--body-file`, `--edit-last` (with `--create-if-none`), `--delete-last` (with `--yes`), `--attach`, `-e/--editor`, `-w/--web`.
- `edit` (accepts several numbers): `-t`, `-b`, `-F`, `-m`, `--type`, `--remove-type`, `--remove-milestone`, `--add-label` and `--remove-label`, `--add-assignee` and `--remove-assignee` (`@me`, `@copilot`), `--add-project` and `--remove-project`, `--parent` and `--remove-parent`, `--add-sub-issue` and `--remove-sub-issue`, `--add-blocked-by` and `--remove-blocked-by`, `--add-blocking` and `--remove-blocking`, `--attach`.
- `close`: `-r/--reason` (`completed`, `not planned`, `duplicate`), `-c/--comment`, `--duplicate-of`. `reopen`: `-c/--comment`.

Reference an issue from a PR body with `Fixes #123` and GitHub closes it on merge.

## Pull requests

```bash
gh pr create --title "feat: add auth" --body-file pr.md --base main --draft
gh pr create --fill --reviewer user1,org/team --label feature
gh pr review 42 --approve --body "Tested locally"
gh pr merge 42 --squash --delete-branch
gh pr edit 42 --add-reviewer user1 --add-label reviewed
gh pr ready 42
```

- `create`: `-t`, `-b`, `-F`, `-B/--base`, `-H/--head`, `-d/--draft`, `-f/--fill`, `--fill-first`, `--fill-verbose`, `-r/--reviewer` (people or `org/team`), `-a`, `-l`, `-m`, `-p`, `-T/--template file`, `--no-maintainer-edit`, `--dry-run` (may still push), `--attach`, `-e`, `-w`, `--recover`.
- `review`: exactly one of `-a/--approve`, `-r/--request-changes`, `-c/--comment`; plus `-b/--body`, `-F/--body-file`.- `merge`: one of `-s/--squash`, `-m/--merge`, `-r/--rebase`; `--auto` (merge once requirements pass), `--disable-auto`, `-d/--delete-branch`, `--admin` (bypasses requirements, only on an explicit ask), `--match-head-commit SHA`, `-t/--subject`, `-b`, `-F`, `-A/--author-email`.
- `edit`: `-t`, `-b`, `-F`, `-B/--base`, `-m`, `--remove-milestone`, `--add-label` and `--remove-label`, `--add-assignee` and `--remove-assignee`, `--add-reviewer` and `--remove-reviewer` (`@copilot` allowed), `--add-project` and `--remove-project`, `--attach`.
- `comment`: same flags as `gh issue comment`. `close`: `-c/--comment`, `-d/--delete-branch`. `ready`: `--undo` converts back to draft. `update-branch`: `--rebase`. `checkout` (`co`): `-b`, `--detach`, `-f`, `--worktree path`, `--recurse-submodules`; it changes the local checkout, not GitHub.

## Releases

```bash
gh release create v1.0.0 --title "v1.0.0" --generate-notes
gh release create v1.0.0 ./dist/*.tar.gz --notes-file CHANGELOG.md --draft
gh release edit v1.0.0 --draft=false
gh release delete v1.0.0 --yes --cleanup-tag
```

- `create` (alias `new`): `-t/--title`, `-n/--notes`, `-F/--notes-file`, `--generate-notes`, `--notes-from-tag`, `--notes-start-tag`, `-d/--draft`, `-p/--prerelease`, `--latest[=false]`, `--target branch-or-sha`, `--verify-tag`, `--fail-on-no-commits`, `--discussion-category`. Trailing arguments are files or patterns uploaded as assets.
- `edit`: `-t`, `-n`, `-F`, `--draft[=false]`, `--prerelease`, `--latest`, `--tag`, `--target`, `--verify-tag`, `--discussion-category`.
- `delete`: `-y/--yes`, `--cleanup-tag` (also deletes the tag).

## Workflows and runs

```bash
gh workflow run deploy.yml --ref release/v2 -f environment=production
echo '{"env":"staging"}' | gh workflow run deploy.yml --json
gh run rerun 12345 --failed
gh run cancel 12345
```

- `workflow run`: `-r/--ref`, `-f/--raw-field key=value`, `-F/--field key=value` (honours `@file`), `--json` (inputs as JSON on stdin). The workflow needs a `workflow_dispatch` trigger.
- `run rerun`: `--failed`, `-j/--job id`, `-d/--debug`. `run cancel`: `--force`.
- Read-only companions: `gh run watch 12345 --exit-status --compact`, `gh run download 12345 --name coverage --dir ./out`, `gh workflow list`, `gh workflow view ci.yml --yaml`.

## Secrets and variables

```bash
gh secret set API_KEY < secret.txt                     # stdin keeps the value out of shell history and the process list
gh secret set ORG_KEY --org myorg --visibility selected --repos repo1,repo2
gh secret delete API_KEY
gh variable set APP_ENV --body production
gh variable delete APP_ENV
```

- `secret set`: `-b/--body` (stdin when omitted), `-f/--env-file` (dotenv file), `-e/--env`, `-o/--org`, `-u/--user`, `-a/--app` (`actions`, `agents`, `codespaces`, `dependabot`), `-v/--visibility` (`all`, `private`, `selected`), `-r/--repos`, `--no-repos-selected`, `--no-store`. `secret delete` (alias `remove`): `-e`, `-o`, `-u`, `-a`. Secrets are write-only; `gh secret list` shows names, never values.
- `variable set`: `-b/--body`, `-f/--env-file`, `-e`, `-o`, `-v`, `-r`. `variable delete`: `-e`, `-o`. Variables are readable with `gh variable list`.

Never print a secret value into the conversation, a log or a command line the user did not provide.

## Labels

```bash
gh label create "priority:high" --color FF0000 --description "High priority" --force
gh label edit bug --color 00FF00 --name defect
gh label delete old-label --yes
gh label clone source-owner/source-repo --force
```

- `create`: `-c/--color` (hex without `#`), `-d/--description`, `-f/--force` (update when it exists). `edit`: `-c`, `-d`, `-n/--name`. `delete`: `--yes`. `clone`: `-f/--force` overwrites labels in the destination.

## Repositories

```bash
gh repo create my-project --private --description "Internal tool" --clone
gh repo edit OWNER/REPO --default-branch main --add-topic cli --enable-squash-merge
gh repo fork OWNER/REPO --clone
gh repo sync --branch main
gh repo delete OWNER/REPO --yes
```

- `create` (alias `new`): `--public` or `--private` or `--internal`, `-d`, `-h/--homepage`, `-c/--clone`, `-s/--source` with `-r/--remote` and `--push`, `-p/--template`, `--include-all-branches`, `-g/--gitignore`, `-l/--license`, `--add-readme`, `--disable-issues`, `--disable-wiki`, `-t/--team`.
- `edit`: `-d`, `-h`, `--default-branch`, `--visibility` (needs `--accept-visibility-change-consequences`), `--template`, `--add-topic` and `--remove-topic`, `--enable-issues`, `--enable-wiki`, `--enable-projects`, `--enable-discussions`, `--enable-merge-commit`, `--enable-squash-merge`, `--enable-rebase-merge`, `--enable-auto-merge`, `--delete-branch-on-merge`, `--allow-update-branch`, `--allow-forking`, `--squash-merge-commit-message`, `--enable-advanced-security`, `--enable-secret-scanning`, `--enable-secret-scanning-push-protection`.
- `fork`: `--clone`, `--remote`, `--remote-name`, `--org`, `--fork-name`, `--default-branch-only`. `sync`: `-b/--branch`, `-s/--source`, `--force` (hard reset). `delete`: `--yes`; irreversible, so confirm the exact repository with the user first.

## gh api writes

```bash
gh api repos/OWNER/REPO/issues/42/comments -f body="Automated comment"
gh api repos/OWNER/REPO/issues/123 -X PATCH -f state=closed
gh api graphql -F id="I_kwDOxxx" -f query='mutation($id: ID!) { closeIssue(input: {issueId: $id}) { issue { number state } } }'
```

Fields switch the method to POST; set `-X PATCH`, `-X PUT` or `-X DELETE` for the others. Use `-F` for integers and booleans, `-f` for strings, `--input file.json` for a full JSON body.

## Bulk operations

Feed numbers from a read command into a write loop only after the user has approved the list, and pause between calls so secondary rate limits do not trip.

```bash
gh issue list --label wontfix --json number --jq '.[].number' | while read -r n; do
  gh issue close "$n" --reason "not planned"; sleep 1
done
```
