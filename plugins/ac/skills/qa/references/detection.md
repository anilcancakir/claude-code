# QA tool detection

Read by `ac:qa` (to fill `Tool` and `Viewports` in `brief.md`) and by `ac:qa-tester` (to run cases). Pick the project's own browser or test tool first; playwright-cli is the fallback, not the default. Any preflight failure below ends the run as `could-not-run` with the reason in the report; it never becomes a question to the user.

## Choosing the tool

Check markers in this order and take the first match, unless the project's `CLAUDE.md` or `.ac/qa/learnings.md` names another tool for QA.

1. `Playwright Test`
2. `Cypress`
3. `Laravel Dusk`
4. `Pest browser`
5. `Flutter integration_test`
6. `Unit runners only`, when a test runner exists but no browser tool does
7. `Static site`, when there is no runner either and the output is plain HTML
8. `playwright-cli fallback`, when the matched tool fails preflight or an out-of-tree run fails, and for any case the matched tool cannot express (responsive emulation, security probes)

Record the result in `brief.md` as the tool name plus the exact boot, suite and throwaway invocations from the section below.

## Boot and readiness

Boot the app only when `Target` is a URL and nothing already answers on it. Start the server in the background with output sent to `<run dir>/server.log`, keep its PID, and stop it when the run ends. Probe readiness with curl until HTTP 200, capped at 60 seconds:

```bash
URL=http://127.0.0.1:8000
for i in $(seq 1 60); do
  [ "$(curl -s -o /dev/null -w '%{http_code}' "$URL")" = "200" ] && break
  sleep 1
done
[ "$(curl -s -o /dev/null -w '%{http_code}' "$URL")" = "200" ] || echo "app did not become ready"
```

No 200 after 60 seconds is an environment failure: `could-not-run`, add the boot command and the last lines of `server.log` to the report, and add a bullet to `## Known gaps`.

## Viewports

Read the project's own breakpoints before choosing sizes: Tailwind `theme.screens` in `tailwind.config.*`, `--breakpoint-*` variables under `@theme` (Tailwind v4), or the `@media (min-width: ...)` and `(max-width: ...)` values in the main stylesheet. Test each breakpoint and one pixel below it. When the project defines none, use these four:

| Width x height | Role |
|---|---|
| 375x812 | phone, run with device emulation |
| 768x1024 | tablet portrait |
| 1024x768 | tablet landscape, small laptop |
| 1440x900 | desktop |

Device emulation (user agent, touch, `isMobile`) and a bare resize are different tests: resize only changes the viewport, so only CSS media queries react. Use emulation for the phone size and resize for the rest (https://playwright.dev/docs/emulation). With playwright-cli that is `open --device="iPhone 15"` for the phone and `resize <w> <h>` for the others.

## Tools

### Playwright Test

- Marker: `playwright.config.ts`, `.js` or `.mjs` at the project root, or `@playwright/test` in `package.json`.
- Boot: usually the config's `webServer` block starts the app. If the config has none, use the dev command from `package.json` or `CLAUDE.md`, then the readiness probe.
- Existing suite: `npx playwright test`.
- Throwaway spec: a positional path does not widen discovery (tests are collected from `testDir`), so write a temp config in the run dir at `<run dir>/playwright.config.ts` and point `-c` at it. Playwright resolves `testDir`, `outputDir` and `webServer.cwd` against the config file's directory (`config.ts` L174, `webServerPlugin.ts` L76), so each must be reset:

  ```ts
  import { defineConfig } from '@playwright/test';
  import base from '<absolute path to the project playwright.config.ts>';

  export default defineConfig({
    ...base,
    testDir: './specs',
    testMatch: '**/*.spec.ts',
    outputDir: './evidence/pw-output',
    webServer: base.webServer
      ? { ...base.webServer, cwd: '<absolute project root>' }
      : undefined,
    projects: base.projects?.map((project) => ({ ...project, testDir: './specs' })),
  });
  ```

  Run it from the project root: `npx playwright test -c <run dir>/playwright.config.ts`. Setting `testDir` also turns off gitignore filtering, which is what lets specs under the ignored `.ac/` directory run. Keep any `storageState` path absolute (not verified). A `webServer` given as an array needs the `cwd` reset on each entry; a config that exports a function cannot be spread, so fall back to playwright-cli.
- Preflight: `npx playwright test --list` exits 0 (config loads, browsers present); the project's `testing.quirks` in `CLAUDE.md` read for required env vars.

### Cypress

- Marker: `cypress.config.ts`, `.js` or `.mjs`, or `cypress` in `package.json`.
- Boot: the dev command from `package.json` or `CLAUDE.md`, then the readiness probe. Cypress does not start the app.
- Existing suite: `npx cypress run`.
- Throwaway spec: unverified out of tree. Try once with an absolute spec path and a `specPattern` override, `npx cypress run --spec <run dir>/specs/<name>.cy.ts --config specPattern=<run dir>/specs/**/*.cy.ts`. If Cypress reports no spec found or fails to load the support file, record the attempt under `### Could not run` for that tool and fall back to playwright-cli. Do not retry variations.
- Preflight: `npx cypress verify` exits 0.

### Laravel Dusk

- Marker: `laravel/dusk` in `composer.json` `require-dev`, plus `tests/Browser/` or `phpunit.dusk.xml`.
- Boot: Dusk does not start a server (https://laravel.com/docs/12.x/dusk). Start one yourself, `php artisan serve --no-reload --port=8000 &`, on the host and port that `APP_URL` names, then the readiness probe. `APP_URL` has to match the served URL exactly or Dusk's requests miss the app.
- Existing suite: `php artisan dusk`.
- Throwaway spec: `php artisan dusk <path>` forwards the path to PHPUnit and always loads `phpunit.dusk.xml` (`DuskCommand.php` L139). Whether a file outside `tests/Browser` is picked up is unverified, so try once with `<run dir>/specs/<name>Test.php`; on "no tests executed" or a class-not-found error, fall back to playwright-cli. Dusk still writes its own screenshots to `tests/Browser/screenshots`; name that stray path in the report.
- Preflight, all of which have to hold:
  - Chrome and ChromeDriver share a major version: run `php artisan dusk:chrome-driver --detect`.
  - The test environment does not use `RefreshDatabase` and does not point at an `:memory:` SQLite database, because the browser process and the test process are separate and cannot share either.
  - No leftover `.env.dusk.*` swap: Dusk copies `.env.dusk.<env>` over `.env` and a crashed run leaves the stale copy behind. If `.env` differs from what `git status` and the project's docs expect, report it and stop; do not repair it.

### Pest browser

- Marker: `pestphp/pest-plugin-browser` in `composer.json`.
- Boot: as the project documents it; the plugin drives Playwright, so `node_modules` needs `playwright` and its browsers. Use the readiness probe for any URL you need yourself.
- Existing suite: `./vendor/bin/pest tests/Browser`.
- Throwaway spec: a file path argument works in-tree. Out of tree, the `Pest.php` `in()` bindings do not apply, so the spec has to carry its own `pest()->extend(...)`. That path is unverified: try once with `./vendor/bin/pest <run dir>/specs/<name>.php`, then fall back to playwright-cli on any failure.
- Preflight: `composer show pestphp/pest-plugin-browser` and record the version in the report; the plugin has had heavy API churn (PRs #275 and #284), so a case written against another version may not run. `npx playwright --version` exits 0.

### Flutter integration_test

- Marker: `integration_test` under `dev_dependencies` (with `sdk: flutter`) in `pubspec.yaml`, and an `integration_test/` directory.
- Boot: no server. A device or browser target is needed: list with `flutter devices`. For a web build that playwright-cli can reach, serve it with `flutter run -d web-server --web-port 8080 &` and use the readiness probe against `http://127.0.0.1:8080`.
- Existing suite: `flutter test integration_test -d <device id>`. For web, `flutter drive --driver=test_driver/integration_test.dart --target=integration_test/<name>_test.dart -d chrome` with ChromeDriver on port 4444.
- Throwaway spec: unverified out of tree. Try once with `flutter test <run dir>/specs/<name>_test.dart -d <device id>`; a package-resolution error means fall back, which is only possible for a served web build. With no web target, the cases are `BLOCKED` and the reason goes under `### Could not run`.
- Preflight: `flutter doctor -v` shows no error for the chosen platform, and the device id appears in `flutter devices`.

### Unit runners only

- Marker: a test runner is present (`package.json` `test` script, `vitest.config.*`, `jest.config.*`, `bun` tests, `pytest.ini`, `go test`, `phpunit.xml`, `cargo test`) and no browser tool above matched. This is the same detection `ac:plan` runs in its test infrastructure stage (`plugins/ac/skills/plan/SKILL.md:281-289`); prefer the `testing: {command, single, quirks}` values in `CLAUDE.md` (the shape `/ac:init-project` writes) over re-deriving them.
- Boot: none for a library or CLI; for a web app with no browser tool, boot it as in the section above and test it with the playwright-cli fallback.
- Existing suite: `testing.command`, falling back to the detected test command. Run it first as the regression case.
- Throwaway spec: write the file under `<run dir>/specs/` and run it with the `testing.single` form for one file. Whether the runner discovers files outside its configured roots varies; if it reports no tests found, run the case as a shell command against the CLI or function entry point instead and record the output as evidence.
- Preflight: the test command exits 0 on the unchanged suite or its failures are recorded as pre-existing before any case runs.

### Static site

- Marker: no server code and no runner; an `index.html` at the root, or a build output directory (`dist/`, `public/`, `_site/`, `build/`) from a static generator (Astro, Eleventy, Hugo, Jekyll).
- Boot: build first if the generator's build command is in `package.json` or `CLAUDE.md`, then serve the output over HTTP: `python3 -m http.server 8080 --directory <output dir> &`, then the readiness probe. Do not open `file://` URLs: root-relative links and fetches break there and produce false failures.
- Existing suite: none; the page checks are the cases.
- Throwaway spec: use the playwright-cli fallback below for every case.
- Preflight: the output directory exists and contains the page under test.

### playwright-cli fallback

- Marker: `command -v playwright-cli` succeeds; otherwise `npx @playwright/cli` (a project with `playwright` installed locally can also use `npx playwright cli`). Neither available is `could-not-run`.
- Boot: the server steps above for `Target`; playwright-cli opens pages, it does not start apps.
- Existing suite: not applicable; this is the exploratory path.
- Throwaway spec: none. Drive the page with commands, one named session per run (`-s=<run id>`), so parallel runs and leftovers do not collide:

  ```bash
  playwright-cli -s=<run id> open <url>                  # phone case: add --device="iPhone 15"
  playwright-cli -s=<run id> snapshot --filename=<run dir>/evidence/<case-id>-<slug>.yaml
  playwright-cli -s=<run id> fill <ref> "<text>"
  playwright-cli -s=<run id> click <ref>
  playwright-cli -s=<run id> resize 768 1024
  playwright-cli -s=<run id> screenshot --filename=<run dir>/evidence/<case-id>-<slug>.png
  playwright-cli -s=<run id> console
  playwright-cli -s=<run id> requests
  playwright-cli close-all                               # last command of the run
  ```

  Prefer `snapshot` over `screenshot`: it is text, cheap, and gives the element refs the next command needs. Take a screenshot only for visual evidence (design and responsive cases). Pass `--filename` into `<run dir>/evidence/`; the default location is a `.playwright-cli/` directory in the working directory, outside the run dir. `open --device="<name>"` and `--mobile` emulate a phone; `resize <w> <h>` changes only the viewport.
- Preflight: `playwright-cli --help` exits 0, then `playwright-cli open <url>` returns a page snapshot. A missing browser is fixed with `playwright-cli install-browser`; if that fails, `could-not-run`.
- Cleanup: run `playwright-cli close-all` at the end of every run, including after a failure; use `kill-all` only when `close-all` leaves processes behind.
