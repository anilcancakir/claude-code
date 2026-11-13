<!-- ported-from: plugins/ac/references/verification.md sha256:3945085400d60105c2762956cec33e10b609752e7f20e66aa78135736458d8c5 -->
# Verification: scope, commands, diagnostics, fast tests

Shared by the plan workers, `ac/execute` and `ac/qa`. A full lint and test suite can take minutes on a real project, and running it after every step multiplies that by the step count while proving nothing a narrower run does not. So each layer checks what it changed, and the whole project is checked once, in the background, while the final review runs.

## Who runs what

| Layer | Runs | Never runs |
|---|---|---|
| A worker, or you on a single step | format check, lint and the single-file analyzer on the files you touched; the tests of those files (the test you wrote or edited, plus the tests that cover the changed source by the project's naming convention or a related-tests command) | the full suite, a repo-wide lint, the project build, a project-wide typecheck (parallel workers would read each other's half-written files) |
| The orchestrator, after a wave or a group of edits | the same per-file checks on the union of touched files, their related tests, the build, and one project-wide static analysis (PHPStan, `tsc -b` or `tsc --noEmit`, `flutter analyze`), because a per-file analyzer cannot see a caller broken by a changed signature; with no project-wide analyzer, the tests of the callers of every modified public symbol (grep the definition name and every import path, then read each hit), or the full suite for that wave | the full suite otherwise |
| The orchestrator, at the final review | the full test suite and the repo-wide lint, started in the background (`background: true` on the shell call) in the same response that spawns the reviewer; the report waits for both | |

After review fixes, re-run the per-file checks and related tests on what the fixes touched. Run the full suite again only when a fix touched code that other modules call.

## Projects that gate on CI

A project opts in with a `## Verification gate: ci` section in its `AGENTS.md` or `CLAUDE.md`, beside its build and test commands. Without that section nothing below applies and the table above holds as written.

The section says the project's CI runs the test suite and the lint on its own runners, so a local run only adds wall time and contention. It also grants one standing permission: push the task's branch and open a pull request for it. A merge, a push to the default branch and a force-push are outside it and need the user's word. When the checkout sits on the default branch, create the task branch before the first commit.

CI rarely covers everything the project checks locally, and only the project knows where the line falls. So the section also names what this file cannot: the checks CI does not run, which stay local and are run as it says; how to read a failed job when it is not a GitHub Actions run; a regex for the checks that are not a gate (a review bot) for `--ignore`; and a bootstrap command to run once in a fresh worktree, when the project's own check script is what creates its untracked files.

The mode is for an interactive run. Under an away marker the push belongs to the away run and its `allowed_outward` list (the `commit` skill skips its push under that marker, and the away guard denies `git push` and `gh pr create` until the list names them), and under coordinator lanes the coordinator owns the push order. Both keep the local full run.

In the mode the last row of the table changes and the rest stays: the per-file layer, the wave layer and the build run as before. The final review becomes:

1. Commit what is still uncommitted with the `commit` skill with `--skip-preflight --no-push`, push with `git push -u origin HEAD`, and open the pull request with `gh pr create` (reuse the one `gh pr view` finds).
2. In the same response that spawns the reviewer, start `timeout 3600 sh references/ci-watch.sh [--ignore <regex>] <number>` with `background: true` on the shell call; the path is relative to the `execute` skill, and the regex comes from the section. The script waits until the PR shows the head you pushed, then polls its checks. Exit 0: green on that head. Exit 1: a check failed or was cancelled, and the check table is printed. Exit 2, or 124 from `timeout`: CI cannot gate this head, because it never started or every check sat queued with no runner.
3. A red check or a confirmed review finding is fixed on the branch, committed and pushed as in step 1, and watched again; the script keys on the head, so a rerun never reads the previous head's result. Read the failing job as the section says; for a GitHub Actions run that is `gh run view <run id> --log-failed`. Stop after three rounds, or the cap the section names, and report what is still red.
4. Report when the watch exits 0 on the head you last pushed and the review is closed. Give the PR URL and the check names, and say what ran in CI and what ran here (the checks the section keeps local); never claim a run that did not happen.

When CI cannot gate (exit 2 or 124, no `gh` or no remote, a push that fails), run the full suite locally as the table says and name the reason in the report. A queued run is not a pass.

## Commands by ecosystem

Use the project's own scripts (`composer`, `package.json`, `Makefile`, AGENTS.md or CLAUDE.md) when they exist; these are the underlying tools. Versions checked 2026-10-31.

| Ecosystem | Touched files | Related tests | Parallel | Project-wide (orchestrator only) |
|---|---|---|---|---|
| Laravel, PHP | `vendor/bin/pint --test <files>`; `php -l <file>`; `vendor/bin/phpstan analyse --no-progress <files>` | `vendor/bin/pest <test file>`, `--filter=<name>`; `php artisan test <file>` | `--parallel --processes=N` (Pest, `artisan test` with paratest); Pint `--parallel` 1.23+ | `vendor/bin/phpstan analyse --no-progress`; `vendor/bin/pint --test` |
| Dart, Flutter | `dart format -o none --set-exit-if-changed <files>`; `dart analyze --fatal-infos <files>` | `flutter test test/<x>_test.dart`, `--plain-name <name>` (map `lib/x.dart` to `test/x_test.dart`; Flutter has no related-tests selector) | `flutter test -j <n>` | `flutter analyze` or `dart analyze --fatal-infos` |
| TypeScript, JS | `eslint --cache --max-warnings 0 <files>` (drop `--cache` with type-aware rules); `prettier --check <files>`; `biome check <files>` | `vitest related --run <src files>`; `jest --findRelatedTests <files>`; `bun test ./<file>` | Vitest and Jest run files in parallel by default; `bun test --parallel` | `tsc -b` or `tsc --noEmit -p <tsconfig>`; there is no per-file type check |

Caveats: Pest `--dirty` picks changed test files, not the tests of changed source. A PHPStan run on a path list starts with a cold result cache, and reports only errors in the listed files. Vitest `related` follows static imports only.

## Diagnostics are a hint; the CLI is the ground truth

There is no language server in opencode. After an `edit`, `write` or `patch`, the ac diagnostics plugin runs a per-file checker on each touched `.php` and `.dart` file and appends a `<diagnostics file="...">` block to that tool's result: `php -l`, the project's PHPStan (`vendor/bin/phpstan analyse --no-progress --error-format=raw`, only when the project ships `vendor/bin/phpstan`; a missing binary is skipped) and `vendor/bin/pint --test` for PHP, `dart analyze --fatal-infos` for Dart. A file that passes every checker gets no block, so no block means clean. A checker is killed after 20 seconds and reported as timed out, and a long block is cut at about 4000 characters with `...[truncated]`.

The block is narrower than the analyzers below. It exists only for edits made through those three tools, so a change made by `shell`, git or a formatter gets none; and in a PHP project without `vendor/bin/phpstan` an absent block means syntax and style are clean, not that types and symbols are. Other languages, TypeScript included, get no block at all.

So before you act on a diagnostic, and before you call one stale (for example because the file changed again by `shell` after the edit), run the CLI analyzer on that file:

| Language | Ground truth for one file | What it covers |
|---|---|---|
| Dart | `dart analyze --fatal-infos <file>` | errors, warnings and lints |
| PHP | `vendor/bin/phpstan analyse --no-progress <file>` when the project ships PHPStan | types and symbols, at the project's level |
| PHP without PHPStan | `php -l <file>` | syntax only: it cannot confirm or refute a type or symbol diagnostic, so read the code the diagnostic names |
| TypeScript | none per file | the typecheck command in the briefing's Runtime Commands, which the orchestrator runs once for the wave |

The CLI reports it: it is real, fix it. The CLI is clean and covers that kind of diagnostic: it is stale, say so in one line and move on. Never dismiss a diagnostic as stale without that run. Read the block an edit returned before you reach for the CLI yourself; run the CLI when you need what the block does not cover.

## Writing tests that stay fast and CI-safe

- No real network. Laravel: `Http::preventStrayRequests()` then `Http::fake([...])`. Flutter: the test binding already fails real `HttpClient` calls; inject a fake client.
- Fake the side effects you are not testing: `Queue::fake()`, `Bus::fake()`, `Mail::fake()`, `Notification::fake()`, `Event::fake()` (after factories that need model events), `Storage::fake()`.
- No sleeps and no wall clock. Laravel: `freezeTime()`, `travelTo()`, `Sleep::fake()`. Dart: `fakeAsync((async) { async.elapse(...); })`.
- Flutter: `pumpAndSettle` never settles on an endless animation such as a spinner and fails after its timeout; use `pump(Duration)` there. Use `runAsync` only for real asynchronous IO.
- Each test owns its data and runs in any order. Laravel: `RefreshDatabase` (migrates once, wraps each test in a transaction). Check the order with a shuffled run before you finish: `--order-by=random`, `--test-randomize-ordering-seed=random`, `--sequence.shuffle.tests`, `bun test --randomize`.
- Test behaviour through the public surface the code already exposes. A test that needs a sleep, a retry or a fixed port is flaky by construction; restructure it instead of retrying it.
- Keep a new test's runtime in the same range as its neighbours. One slow test runs on every later wave and every CI run.
