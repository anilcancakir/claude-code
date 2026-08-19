import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";

// Smoke test for the `test:node` runner itself (Step 6): proves an in-memory FTS5 table with the
// `unicode61` tokenizer folds Turkish diacritics, so a diacritic-free prefix query still matches
// diacritic-bearing indexed text. Step 7 fills this file out with the real store suite; this
// assertion exists first so that step has a working harness rather than `Verify: MISSING`.
test("unicode61 tokenizer folds Turkish diacritics for a prefix match", () => {
    const db = new DatabaseSync(":memory:");

    db.exec("CREATE VIRTUAL TABLE turns_fts USING fts5(body, tokenize='unicode61')");
    db.prepare("INSERT INTO turns_fts(body) VALUES (?)").run("gözden geçirildi");

    const row = db
        .prepare("SELECT body FROM turns_fts WHERE turns_fts MATCH ?")
        .get('"gozden"*');

    assert.equal(row?.body, "gözden geçirildi");

    db.close();
});
