---
name: cassie
description: Edit, verify and render Cassie video projects (one master, many localized variants) through the Cassie MCP server. Use when a task touches a Cassie project.json, ad variants, subtitles/CTA per market, or subject replacement.
---

# Cassie

Start the server with `cassie mcp <project.json>` and work only through its tools. Never hand-edit project.json.

## Loop

1. `project_overview` to get the revision, variables and variants. Use `edit_reference` when unsure of an edit shape.
2. Find what is on screen with `select` (`entity:bottle [shot=2]`, `overlay[var=cta]`, `entity#product sf=120..240`) and report how many shots and frames it hits before a broad edit. If nothing is tracked for X yet, run `track_subject` (local, free; reports shots where X was not found). For "don't cover X" use `check_layout` and apply its suggested `set-layer`.
3. Change content with `apply_edit`, always passing `baseRevision`. If it reports a stale revision, re-read and retry. Do not force the edit.
4. Look before claiming success: `preview_frame` at the time the change is visible, for every aspect ratio you touched. Check that text is not clipped or covering the subject.
5. Finish by listing the transaction ids. The human can `rollback` any of them.

## Rules

- Prefer variant values (`set-variant-values`) over editing the master when only some markets change.
- Text, CTA and subtitles are deterministic and free. Changing a subject goes through `subject_sync` and costs money. Call `subject_sync_quote` first, show the price, and pass `confirmed=true` only after the human agrees.
- If `subject_sync` returns `inProgress`, wait and poll `list_variants`. Never call it again for those variants.
- `render_video` only when the human asks for files. Frames are enough for checking.
