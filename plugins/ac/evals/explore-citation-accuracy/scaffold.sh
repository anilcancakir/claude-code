#!/bin/sh
# Writes the frozen fixture tree this case is graded against.
#
# The fixture is inlined rather than shipped as files beside the case because `context.add_dirs`
# was measured on 2.1.259 not to place anything in the run's workspace: the key was accepted, no
# copy appeared anywhere in the sandbox, and the subagent correctly reported the file missing.
# Writing the bytes here removes every path assumption.
#
# Line numbers are load-bearing. The graders match `user-service.ts:7` and `admin-service.ts:4`,
# so do not add, remove or reorder lines without updating them together.

set -eu

mkdir -p src/legacy

cat > src/user-service.ts <<'FIXTURE'
// User profile lookups.
export interface Profile {
    id: string;
    displayName: string;
}

export function resolveProfile(id: string): Profile {
    return { id, displayName: id };
}
FIXTURE

# Same function name in a second module. A search that stops at the first hit misses this one,
# which is the completeness half of what this case measures.
cat > src/admin-service.ts <<'FIXTURE'
// Admin profile lookups. Deliberately shares the function name with user-service.ts.
import type { Profile } from "./user-service.ts";

export function resolveProfile(id: string): Profile {
    return { id, displayName: "admin:" + id };
}
FIXTURE

# The decoy. It names the function in a comment and defines something else, so a text search that
# does not distinguish a definition from a mention will cite it. The no-decoy grader fails on that.
cat > src/legacy/profile-helpers.js <<'FIXTURE'
// Legacy helpers. resolveProfile used to live here before the split; it does not any more.
export function formatProfileLabel(label) {
    return String(label).trim();
}
FIXTURE
