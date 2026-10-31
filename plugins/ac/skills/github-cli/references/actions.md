# GitHub Actions through gh

Workflows, runs, logs, artifacts, caches, secrets and variables. `SKILL.md` already shows `gh run list` and `gh run view N --log-failed`; this file is the rest. Flags and JSON fields were checked against `gh --help` on gh 2.102.0. Pass `-R OWNER/REPO` outside a checkout. Triggering, rerunning, cancelling, deleting and every secret, variable or cache change are outward actions: run one only when the user asked for it in this conversation.

## Contents

- Find and read runs
- Debug a failing run
- Wait for a run
- Trigger a workflow
- Artifacts and logs
- Caches
- Secrets and variables
- Workflows, scopes and limits

## Find and read runs

```bash
gh run list -w ci.yml -b main -s failure -L 10 --json databaseId,conclusion,headSha,createdAt,url
gh run view 12345 --json status,conclusion,jobs --jq '.jobs[] | {name, databaseId, conclusion}'
gh run view 12345 -v        # steps per job
gh run view 12345 -a 2      # a specific attempt
```

- `run list`: `-w/--workflow`, `-b/--branch`, `-c/--commit SHA`, `-e/--event`, `-u/--user`, `-s/--status`, `--created DATE`, `-a/--all` (include disabled workflows), `-L/--limit` (default 20). `--status` takes run states (`queued`, `in_progress`, `completed`, `waiting`) and conclusions (`success`, `failure`, `cancelled`, `skipped`, `timed_out`, `action_required`, `startup_failure`, `neutral`, `stale`).
- `--json` fields on `run list` and `run view`: `attempt`, `conclusion`, `createdAt`, `databaseId`, `displayTitle`, `event`, `headBranch`, `headSha`, `name`, `number`, `startedAt`, `status`, `updatedAt`, `url`, `workflowDatabaseId`, `workflowName`; `run view` adds `jobs`.
- The run id is `databaseId`. `number` is a per-workflow counter and is not accepted where an id is. A job's `databaseId`, not the number in the browser URL, is what `-j/--job` wants.

## Debug a failing run

```bash
gh run view 12345 --log-failed                 # only the failed steps
gh run view 12345 --log -j 67890               # one job's full log
gh run rerun 12345 --failed                    # failed jobs and their dependents
gh run rerun 12345 -j 67890 --debug            # one job, with debug logging
```

- `run view --log` fetches job logs one by one when the run archive is missing and gives up past 25 missing logs; some lines land under `UNKNOWN STEP`. For one job prefer `gh api repos/OWNER/REPO/actions/jobs/67890/logs`, which redirects to a download that expires after a minute (`gh api` follows it).
- Logs of runs past the retention window (90 days by default) are gone.
- `run rerun`: `--failed`, `-j/--job`, `-d/--debug`. A rerun of a finished run starts a new attempt under the same id.

## Wait for a run

```bash
gh run watch 12345 --exit-status --compact -i 10
```

`--exit-status` exits non-zero for any conclusion other than `success`, cancelled and skipped included, and also for an already finished run. `gh run view N --exit-status` is the one-shot form but exits 0 for a run still pending. `run watch` needs a token with `checks:read`, which fine-grained personal access tokens cannot hold; use the classic token from `gh auth login`.

## Trigger a workflow

```bash
gh workflow run deploy.yml --ref release/v2 -f environment=production
echo '{"env":"staging","dry_run":true}' | gh workflow run deploy.yml --json
```

- The workflow needs an `on.workflow_dispatch` trigger. `-r/--ref` is a branch or tag, `-f/--raw-field key=value` sends a string, `-F/--field key=value` honours `@file`, and `--json` reads all inputs as JSON on stdin, which is the way to send booleans, numbers or more than a few inputs (GitHub caps inputs at 25).
- gh prints the new run's URL when GitHub returns one; piped, the output is just the URL, so the run id is its last path segment: `ID=$(gh workflow run ci.yml -r main | grep -oE '[0-9]+$')`. Empty output (older GitHub Enterprise Server) means look it up: `gh run list -w ci.yml -e workflow_dispatch -b main -u LOGIN -L 5 --json databaseId,createdAt,headSha`, which can race with another dispatch.
- `gh run cancel N` (`--force` when a normal cancel is ignored, for example by `always()` jobs); `gh run delete N` removes a run and its logs.

## Artifacts and logs

```bash
gh run download 12345 -n coverage -D ./out        # one artifact by name
gh run download 12345 -p 'test-*' -D ./out        # by glob
gh api "repos/OWNER/REPO/actions/artifacts?name=coverage&per_page=5" --jq '.artifacts[] | [.id, .name, .expired] | @tsv'
```

`-n/--name` repeats. One named artifact extracts into the target directory and several extract into one subdirectory each. Without a run id gh downloads the latest artifact Actions created; to get a specific run's artifact pass its id, because workflows can delete or overwrite artifacts. Artifacts expire with the retention window; `.expired` says so before a download fails.

## Caches

```bash
gh cache list -k npm- -S size_in_bytes -O desc -L 20 --json id,key,ref,sizeInBytes,lastAccessedAt
gh cache delete 4321                 # by id or by exact key
gh cache delete --all -r refs/heads/feature-x
```

- `cache list`: `-k/--key` (prefix match), `-r/--ref` (full ref such as `refs/heads/x` or `refs/pull/N/merge`), `-S/--sort` (`created_at`, `last_accessed_at`, `size_in_bytes`), `-O/--order`, `-L/--limit` (default 30). JSON: `createdAt`, `id`, `key`, `lastAccessedAt`, `ref`, `sizeInBytes`, `version`.
- `cache delete`: an id, a key, or `--all`; `-r/--ref` limits a key or `--all` to one ref; `--succeed-on-no-caches` (with `--all`) keeps scripts from failing on an empty set.

## Secrets and variables

```bash
gh secret list --json name,visibility,updatedAt
gh secret set API_KEY < secret.txt                     # stdin keeps the value out of shell history and the process list
gh secret set ORG_KEY --org myorg --visibility selected --repos repo1,repo2
gh secret delete API_KEY
gh variable list --json name,value
gh variable get APP_ENV
gh variable set APP_ENV --body production
gh variable delete APP_ENV
```

- Scope flags: `-e/--env`, `-o/--org`; `secret` also takes `-u/--user` and `-a/--app` (`actions`, `agents`, `codespaces`, `dependabot`). Environments: `gh api repos/OWNER/REPO/environments --jq '.environments[].name'`.
- `secret set`: `-b/--body` (stdin when omitted), `-f/--env-file`, `-v/--visibility` (`all`, `private`, `selected`), `-r/--repos`, `--no-repos-selected`, `--no-store`. `secret delete` (alias `remove`): `-e`, `-o`, `-u`, `-a`. Secrets are write-only: there is no `gh secret get`, and `list` shows names only.
- `variable set`: `-b/--body`, `-f/--env-file`, `-e`, `-o`, `-v`, `-r`. `variable delete`: `-e`, `-o`. Variables are readable (`list`, `get`).

Never print a secret value into the conversation, a log or a command line the user did not provide.

## Workflows, scopes and limits

- `gh workflow list` (`-a/--all` includes disabled, `-L`, `--json id,name,path,state`), `gh workflow view ci.yml --yaml` (`-r/--ref`), `gh workflow enable|disable ID-OR-NAME`.
- Not wrapped by gh, so use `gh api`: runners (`repos/OWNER/REPO/actions/runners`, `orgs/ORG/actions/runners`), repository Actions permissions (`repos/OWNER/REPO/actions/permissions/workflow`), OIDC subject claims (`repos/OWNER/REPO/actions/oidc/customization/sub`), per-attempt logs (`repos/OWNER/REPO/actions/runs/ID/attempts/N/logs`), debug rerun of one job (`POST repos/OWNER/REPO/actions/jobs/JOB/rerun -F enable_debug_logging=true`).
- Token scopes: dispatch, rerun, cancel, logs and repository secrets need `repo`; organization secrets and variables need `admin:org`. The `workflow` scope is for pushing workflow files, not for dispatching them. Add one with `gh auth refresh -s workflow`.
- Running workflows locally is the separate tool `act`, not gh. `gh api` shares the 5,000 requests an hour core limit.
