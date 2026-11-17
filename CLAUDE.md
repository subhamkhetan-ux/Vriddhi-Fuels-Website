# Development workflow

All development in this repo uses two tools, Ponytail and graphify:

1. **Orient with graphify.** Run `graphify query "<question>"` before you grep or read source files (see the rules below). If `graphify-out/` is missing, run `graphify update .` first.
2. **Build the Ponytail way.** The `ponytail@ponytail` plugin is enabled in `.claude/settings.json` and loads its ruleset every session. Before writing code, work down its ladder: is this needed, is it already in the repo, does the stdlib or platform do it, can it be one line. Never cut validation, error handling, security or accessibility. Logic with branches, money or parsing gets one small test (`tests/`).
3. **Review before a PR.** Run `/ponytail-review` on the branch and fix the must-fix findings. Use `/ponytail-audit` for a whole-repo pass.
4. **Keep the graph current.** Git hooks rebuild it on commit, checkout, merge and rebase. Run `graphify update .` yourself after a `git pull` or large edits.

Setup on a new machine: `brew install node uv`, then `uv tool install "graphifyy[sql]"`, then `graphify hook install`, then `graphify update .`. Claude Code offers to install Ponytail the first time it opens the repo. If it doesn't, run `/plugin marketplace add DietrichGebert/ponytail` and then `/plugin install ponytail@ponytail`.

## graphify

This project has a knowledge graph at graphify-out/ with god nodes, community structure, and cross-file relationships.

Rules:
- When graphify-out/graph.json exists, run `graphify query "<question>"` before your first grep, search or source-file read for a codebase question, and put this rule in every subagent prompt that explores code. Read raw files only for lines the graph or an earlier read already located. Use `graphify path "<A>" "<B>"` for relationships and `graphify explain "<concept>"` for focused concepts. When the answer is under a Markdown heading, `graphify section "<heading>"` prints that section's text, so the .md need not be opened. These return a scoped subgraph, usually much smaller than GRAPH_REPORT.md or raw grep output.
- If graphify-out/wiki/index.md exists, use it for broad navigation instead of raw source browsing.
- Read graphify-out/GRAPH_REPORT.md only for broad architecture review or when query/path/explain do not surface enough context.
- After modifying code, run `graphify update .` to keep the graph current (AST-only, no API cost).
- A committed graphify-out/graph.json is rewritten whole on every build, so a large diff to it in a pull request is expected. Do not flag it as churn or suggest skipping the graph rebuild or its hooks.
