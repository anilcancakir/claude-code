import { expect, test } from "bun:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// The helper is a shell function under the plugin, not TypeScript, but CI only runs `bun test` here,
// so this is where its contract is pinned: quoted spans blank byte for byte, quote characters and
// everything outside quotes stay, and the output has the input's byte length.
const LIB = join(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
    "..",
    "plugins",
    "ac",
    "hooks",
    "lib",
    "blank-quotes.sh",
);

function blank(input: string): string {
    const result = Bun.spawnSync(["sh", "-c", '. "$1"; ac_blank_quotes "$2"', "_", LIB, input]);

    expect(result.exitCode).toBe(0);

    return result.stdout.toString();
}

const cases: Array<[string, string, string]> = [
    ["single-quoted span", "rg -n '=> X' f | head", "rg -n '____' f | head"],
    ["single-quoted span with a digit comparison", "awk 'NR>=150' f", "awk '_______' f"],
    ["double-quoted span with an escaped pipe", 'grep "a\\|black\\|b" f', 'grep "___________" f'],
    ["apostrophe inside double quotes", `echo "it's" > out`, 'echo "____" > out'],
    ["double quote inside single quotes", `echo 'a"b' x`, "echo '___' x"],
    ["escaped double quote inside double quotes", 'printf "a\\"b" > f', 'printf "____" > f'],
    ["escaped quote inside an ANSI-C span", "echo $'a\\'b'", "echo $'____'"],
    ["unterminated double quote blanks to the end", 'echo "open', 'echo "____'],
    ["unterminated single quote blanks to the end", "echo 'open; ls", "echo '________"],
    ["text without quotes is unchanged", "ls -la > /tmp/x", "ls -la > /tmp/x"],
    ["separator inside quotes is hidden, outside kept", "echo 'a; b' ; ls", "echo '____' ; ls"],
    ["escaped quote outside quotes does not open a span", "echo \\' > out", "echo \\' > out"],
    ["empty input", "", ""],
    ["command substitution inside double quotes stays readable", 'echo "$(git log -1 > f)"', 'echo "$(git log -1 > f)"'],
    ["quotes nested in a command substitution are blanked inside it", 'echo "a $(b "c") d"', 'echo "__$(b "_")__"'],
    ["single quotes nested in a command substitution", `echo "$(rg 'a>b' f)"`, `echo "$(rg '___' f)"`],
    ["parentheses inside a command substitution are balanced", 'echo "$(a (b) c) d"', 'echo "$(a (b) c)__"'],
    ["backtick span inside double quotes stays readable", 'echo "x `date > f` y"', 'echo "__`date > f`__"'],
    ["escaped dollar in double quotes is not a substitution", 'rg -n "\\$(foo)" src', 'rg -n "_______" src'],
    ["command substitution inside single quotes stays blanked", "echo '$(x > f)'", "echo '________'"],
    ["unterminated command substitution reads to the end", 'echo "$(a "b', 'echo "$(a "_'],
];

test.each(cases)("%s", (_name, input, expected) => {
    expect(blank(input)).toBe(expected);
});

test("every case keeps the input's byte length", () => {
    for (const [, input] of cases) {
        expect(Buffer.byteLength(blank(input))).toBe(Buffer.byteLength(input));
    }
});

test("a multibyte character inside quotes blanks to one underscore per byte", () => {
    const input = "echo 'é' > f";

    expect(blank(input)).toBe("echo '__' > f");
    expect(Buffer.byteLength(blank(input))).toBe(Buffer.byteLength(input));
});

test("a quote character outside quotes after a closed span opens a new one", () => {
    expect(blank(`a 'x' "y" $'z' b`)).toBe(`a '_' "_" $'_' b`);
});
