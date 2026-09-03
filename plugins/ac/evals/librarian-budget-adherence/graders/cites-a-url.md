---
type: regex
pattern: 'https?://'
target: last_message
match: contains
weight: 1
---

The answer carries a URL the caller can open. `ac:librarian` treats internal knowledge as
unverified, so an answer with no reachable source fails its own contract however correct it reads.
