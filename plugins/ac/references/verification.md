# Verification: scope, commands, diagnostics, fast tests

Shared by the plan workers, `ac:execute`, `ac:flow` and `ac:qa`. A full lint and test suite can take minutes on a real project, and running it after every step multiplies that by the step count while proving nothing a narrower run does not. So each layer checks what it changed, and the whole project is checked once, in the background, while the final review runs.

## Who runs what

| Layer | Runs | Never runs |
|---|---|---|
| A worker, or you on a single step | format check, lint and the single-file analyzer on the files you touched; the tests of those files (the test you wrote or edited, plus the tests that cover the changed source by the project's naming convention or a related-tests command) | the full suite, a repo-wide lint, the project build, a project-wide typecheck (parallel workers would read each other's half-written files) |
| The orchestrator, after a wave or a group of edits | the same per-file checks on the union of touched files, their related tests, the build, and one project-wide static analysis (PHPStan, `tsc -b` or `tsc --noEmit`, `flutter analyze`), because a per-file analyzer cannot see a caller broken by a changed signature; with no project-wide analyzer, the tests of the callers of every modified public symbol (`LSP findReferences`), or the full suite for that wave | the full suite otherwise |
| The orchestrator, at the final review | the full test suite and the repo-wide lint, started with `run_in_background: true` in the same message that spawns the reviewer; the report waits for both | |

After review fixes, re-run the per-file checks and related tests on what the fixes touched. Run the full suite again only when a fix touched code that other modules call.

Run independent checks together: several Bash calls in one message, or one call joining them with `&` and `wait`. Format, lint, analyzer and tests do not depend on each other's output.

Admit only what you need into context: pipe a passing run through `tail -20` or use the runner's quiet flag; on a failure keep the failing cases and drop the rest.

A failure in a test you did not touch is not "pre-existing" until it is seen failing without the change, or the project records it as a known failure. Name it either way. A worker reports it and leaves the check to the orchestrator, because `git stash` in a tree that other workers share would pull their files out from under them; the orchestrator checks at the barrier, when no worker is running.

## Commands by ecosystem

Use the project's own scripts (`composer`, `package.json`, `Makefile`, CLAUDE.md) when they exist; these are the underlying tools. Versions checked 2026-10-31.

| Ecosystem | Touched files | Related tests | Parallel | Project-wide (orchestrator only) |
|---|---|---|---|---|
| Laravel, PHP | `vendor/bin/pint --test <files>`; `php -l <file>`; `vendor/bin/phpstan analyse --no-progress <files>` | `vendor/bin/pest <test file>`, `--filter=<name>`; `php artisan test <file>` | `--parallel --processes=N` (Pest, `artisan test` with paratest); Pint `--parallel` 1.23+ | `vendor/bin/phpstan analyse --no-progress`; `vendor/bin/pint --test` |
| Dart, Flutter | `dart format -o none --set-exit-if-changed <files>`; `dart analyze <files>` | `flutter test test/<x>_test.dart`, `--plain-name <name>` (map `lib/x.dart` to `test/x_test.dart`; Flutter has no related-tests selector) | `flutter test -j <n>` | `flutter analyze` or `dart analyze` |
| TypeScript, JS | `eslint --cache --max-warnings 0 <files>` (drop `--cache` with type-aware rules); `prettier --check <files>`; `biome check <files>` | `vitest related --run <src files>`; `jest --findRelatedTests <files>`; `bun test ./<file>` | Vitest and Jest run files in parallel by default; `bun test --parallel` | `tsc -b` or `tsc --noEmit -p <tsconfig>`; there is no per-file type check |

Caveats: Pest `--dirty` picks changed test files, not the tests of changed source. A PHPStan run on a path list starts with a cold result cache, and reports only errors in the listed files. Vitest `related` follows static imports only.

## Diagnostics are a hint; the CLI is the ground truth

Claude Code's LSP client tells the server only about changes made through Edit and Write. A change made by Bash, git, a formatter or another session never reaches it, so the server keeps analysing old content. Its diagnostics also arrive a turn late, so they can describe a half-finished edit you have since completed, and each one is shown only once: dismiss it and it does not come back until the file is edited again. Several sessions on one repository each run their own server, and none sees the others' writes.

So before you act on a diagnostic, and before you call one stale, run the CLI analyzer on that file:

| Language | Ground truth for one file | What it covers |
|---|---|---|
| Dart | `dart analyze --fatal-infos <file>` | errors, warnings and lints |
| PHP | `vendor/bin/phpstan analyse --no-progress <file>` when the project ships PHPStan | types and symbols, at the project's level |
| PHP without PHPStan | `php -l <file>` | syntax only: it cannot confirm or refute a type or symbol diagnostic, so read the code the diagnostic names |
| TypeScript | none per file | a worker trusts the LSP on files it changed with Edit or Write (the client syncs those) and leaves everything else to the orchestrator's one `tsc` |

The CLI reports it: it is real, fix it. The CLI is clean and covers that kind of diagnostic: it is stale, say so in one line and move on. Never dismiss a diagnostic as an old index without that run. After every Write or Edit on a `.dart` or `.php` file, the `ac` PostToolUse hook already runs this check and puts the result next to the tool result; read that line before you reach for the CLI yourself.

## Writing tests that stay fast and CI-safe

- No real network. Laravel: `Http::preventStrayRequests()` then `Http::fake([...])`. Flutter: the test binding already fails real `HttpClient` calls; inject a fake client.
- Fake the side effects you are not testing: `Queue::fake()`, `Bus::fake()`, `Mail::fake()`, `Notification::fake()`, `Event::fake()` (after factories that need model events), `Storage::fake()`.
- No sleeps and no wall clock. Laravel: `freezeTime()`, `travelTo()`, `Sleep::fake()`. Dart: `fakeAsync((async) { async.elapse(...); })`.
- Flutter: `pumpAndSettle` never settles on an endless animation such as a spinner and fails after its timeout; use `pump(Duration)` there. Use `runAsync` only for real asynchronous IO.
- Each test owns its data and runs in any order. Laravel: `RefreshDatabase` (migrates once, wraps each test in a transaction). Check the order with a shuffled run before you finish: `--order-by=random`, `--test-randomize-ordering-seed=random`, `--sequence.shuffle.tests`, `bun test --randomize`.
- Test behaviour through the public surface the code already exposes. A test that needs a sleep, a retry or a fixed port is flaky by construction; restructure it instead of retrying it.
- Keep a new test's runtime in the same range as its neighbours. One slow test runs on every later wave and every CI run.
