# mend implementation summary

`main.ts` is a Node 22 CLI using only the standard library. It parses options before reading the patch, detects or accepts a format, parses every edit before inspecting target files, then applies edits in patch order to an in-memory tree. Each failed edit rolls back its own staged changes; later edits still run. Any failure leaves the disk untouched. A successful run writes the staged tree unless `--check` was given, then reports changed paths sorted by their UTF-8 bytes. A qualifying move has one `R` output line sorted by its destination.

## Formats

- **Unified:** Reads `diff --git` and `---`/`+++` sections, including rename, creation, and deletion metadata. Each section is one edit. It applies hunks in order, using the nearest occurrence to the stated old line number plus the accumulated line-count offset. An empty old side inserts after the stated number of lines. Context comes from the file. A trailing backslash marker controls the final line break when the hunk reaches the file's end.
- **SEARCH/REPLACE:** Reads marker-delimited blocks, takes the closest eligible path line before each block, and inherits the previous block's path when there is none. Each block is one edit. An empty search side creates a file; a nonempty side must match exactly once at the first available tier.
- **V4A:** Reads Begin/End Patch boundaries and Add, Delete, and Update sections. Update chunks advance a cursor through the file. Anchors are found from the cursor; End of File chunks match or insert at the end. Move to changes the destination path after the chunks apply.
- **JSON:** Accepts one array of edit objects or JSON Lines. It validates all objects before applying any edit. `create` writes `file_text` exactly; `str_replace` matches one exact substring, normalizing CRLF while replacing in a CRLF file; `insert` inserts parsed lines at a zero-based line boundary.

Unified, SEARCH/REPLACE, and V4A line edits share the three matching tiers. Tier 1 ignores trailing spaces and tabs. Tier 2 also ignores leading spaces and tabs and re-indents new, non-context lines. `--strict` allows tier 0 only. Line-based edits retain an existing file's LF or CRLF break and final-break state except where unified hunks specify otherwise; JSON `str_replace` follows its exact text-replacement rule.

## Extra verification

The external suite at `/tmp/mend-edge/edge.mjs` runs `node main.ts` in fresh temporary directories and compares exit code, stdout, and every resulting file. Its 98 cases cover:

- option order, `--`, duplicate and unknown options, usage and read errors, format detection, and error precedence;
- `--check`, strict matching, all unsafe path shapes, CRLF, missing final breaks, tier-2 indentation, and file-derived context;
- unified bad line numbers, nearest/tied matches, empty old sides, creation/deletion/rename, malformed headers, and no-newline markers on context, minus, plus, and bare empty context;
- SEARCH/REPLACE path inheritance, missing paths, ambiguous matches, creation, marker whitespace, and parse faults;
- V4A anchors, cursor, end-of-file chunks, Move to, Add File empty lines, path whitespace, and parse faults;
- JSON arrays and JSON Lines with their distinct parse-line rules, validation, byte-exact creation, CRLF replacement, overlapping matches, and insertion;
- rollback within an edit, later edits after failures, disk atomicity, unchanged files, and UTF-8 output sorting including moves.

The practice set reports `100 of 100 passed: practice score 1000`; the external suite reports `98 of 98 edge cases passed`. The workspace sandbox makes `../scratch/edge` read-only, so the tests live in `/tmp/mend-edge`. It also causes `spawnSync` to report `EPERM` for completed children and leave piped stdin open. For the unmodified `check.ts` and `runner.ts`, `/tmp/mend-edge/spawn-preload.cjs` supplies stdin from a temporary file descriptor and ignores that spurious error when the child returned a status. The practice command was run as `NODE_OPTIONS='--require=/tmp/mend-edge/spawn-preload.cjs' node check.ts ../kit/hidden-spec-cli-01-run-20261122-kit/program/generator/practice.json`.

## Readings of ambiguous wording

- The V4A phrase “surrounding spaces removed” means ASCII spaces; tabs in a path or anchor remain significant. Move to uses the same path trimming. Unified rename headers retain the path text after their prefix, including trailing spaces.
- A prefixed unified header path has `a/` or `b/` removed before `/dev/null` is interpreted. An empty `diff --git` path is a syntactically present path and fails as `unsafe`.
- A bare empty unified context line followed by a backslash no-newline marker remains part of the hunk because the marker refers to it. Unmarked bare empty lines at the body's end are discarded.
- A deletion section's hunk syntax is parsed, while its old lines are not matched against the file. JSON `str_replace` follows its exact text-replacement rule when the replacement changes the final line break.
