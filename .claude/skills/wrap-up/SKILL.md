---
name: wrap-up
description: End-of-session notes. Records what this session did, where the project now stands and what comes next in PROJECT.md, commits it, and mirrors it to the project's Notion page and, on Minh's Mac, the Obsidian vault. Run it before closing a session.
disable-model-invocation: true
---

# Wrap up the session

The goal: the next session — maybe weeks from now, maybe on another device —
can start by reading the top of `PROJECT.md` instead of re-reading the code or
this conversation. That is what keeps sessions short and cheap.

## 1. Gather what happened

From this conversation, list:

- what was **done** (files changed, things shipped, accounts set up);
- what was **verified** today, and how (a test, a live check, a screenshot);
- what is **still unknown** or was left half-done;
- any **decision** made, with the reason.

Use `git log --oneline` since the last History entry to catch commits.

## 2. Update PROJECT.md

- **Where we are** — change the date in the heading to today. Move anything
  checked today into "Verified on <date>". Keep the "Last known" table for what
  was not re-checked, each row with the date it was last true. Never present an
  unverified item as current fact.
- **Next** — strike finished items, add new ones, keep it ordered by what
  matters most, and keep the one-line "why" on each.
- **Decisions, and why** — add any new decision with its reason and month.
- **History** — add one dated paragraph for this session, newest last.

Keep the top two sections short enough to read in under a minute.

## 3. Commit

Commit only `PROJECT.md` (plus any notes this skill touched) with a message like
`Update project notes: <one-line summary>`. Push if the session is set up to
push.

## 4. Mirror to Notion

If Notion tools are available in this session, find the page linked as
**Notion** at the top of `PROJECT.md` and replace its "Where we are" and
"Next" sections with the new text, then append the new History paragraph. If
Notion tools aren't connected, say so — `PROJECT.md` is the source of truth.

## 5. Mirror to Obsidian

Minh keeps the same notes in Obsidian, in the vault folder `Nail projects/`
(one note per project, named `NailMind.md`, `NailDesk.md`, `NailBook.md`). If
this session can reach the vault — an Obsidian connection is available, or the
vault folder is on this machine — update that project's note: replace its
"Where we are" and "Next" sections, append the new History paragraph, and set
`updated:` in the properties block at the top to today. Create the note if it is
missing. A cloud session can't reach a vault on Minh's Mac; say so and move on.

## 6. Tell Minh

In plain words, three short parts: what got recorded, the top one or two
"Next" items and why they come first, and anything that needs Minh personally
(an account to log into, a payment, a decision).
