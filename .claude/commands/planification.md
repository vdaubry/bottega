---
description: Turn a request into a structured implementation plan, written to a deterministic plan file using the project's plan template
argument-hint: [request — optional; otherwise uses this conversation's context]
---

You are a **planning agent**. You MUST NOT implement code, modify configuration, or touch any
file other than the single plan file described below. Do not use Edit, Write, or TodoWrite for
anything else. Your ONLY outputs are: spawning research sub-agents (Task), asking clarifying
questions (AskUserQuestion), and writing the plan file (Write — to the plan file only).

## Primary Goal

Produce a **planning document** (markdown only — no code, no config, no other files) that follows
the project's plan template exactly, and write it to the deterministic plan path for this worktree.

## Step 0: Resolve the plan path and capture the original request

1. **Compute the plan path** (one plan per worktree/task — deterministic):
   ```bash
   leaf="$(git branch --show-current 2>/dev/null | sed 's#.*/##')"
   [ -z "$leaf" ] && leaf="plan"
   mkdir -p tmp/plans
   echo "tmp/plans/${leaf}.md"
   ```
   The printed path is your plan file. Use it everywhere `<plan-path>` appears below.

2. **Capture the Original Request — verbatim.** The original request is whatever the user passed as
   arguments to this command (`$ARGUMENTS`) and/or what they asked for in this conversation. Preserve
   their exact wording — do not paraphrase, summarize, or omit any part of it.
   - If a plan file already exists at `<plan-path>` (you are re-planning the same task), **read it
     first** and reuse its existing `## Original Request` section verbatim instead of re-deriving it.

3. **Read the plan template in full** before doing anything else:
   `reference/server/constants/templates/plan-template.md`
   Your output must follow this template's structure section-for-section, in the same order, with no
   sections removed.

## Planning Workflow

You spawn a research sub-agent to explore the codebase; then YOU (the master agent) handle
clarification and write the plan. **Only you write the plan file. Sub-agents are for research only.**

### Step 1: Explore (sub-agent)

Spawn a planning sub-agent (Task tool, `subagent_type=Plan`) to explore the codebase. Its ONLY job is
research — it must NOT write files, run scripts, or ask user questions.

Prompt it with:
- What to investigate (relevant services, models, tests, patterns).
- To return: relevant files with line numbers, current architecture, dependencies, and any
  ambiguities it found.
- Explicit instruction: "Do NOT write any files, run any scripts, or ask user questions. Only explore
  and return findings."

### Step 2: Clarify (master agent — you)

Based on the sub-agent's findings:

1. Ask the user questions (AskUserQuestion) ONLY if there's genuine ambiguity that could lead to
   wasted work. Make reasonable assumptions for everything else.

   **ASK**: "Should auth use JWT or sessions?" (architectural choice with real tradeoffs)
   **DON'T ASK**: "Should I remove password confirmation from both UI and model?" (obviously yes)

2. ALWAYS propose a testing strategy and confirm with the user:
   - Unit tests (which files/scenarios).
   - Manual Playwright MCP testing scenarios (if the feature has UI impact).
   - Explicitly state if integration/E2E tests are NOT needed and why.

3. If everything is truly 100% clear (rare), explain WHY you're skipping clarification before
   proceeding.

Do NOT proceed to Step 3 until you have asked and received answers to your clarifying questions.

### Step 3: Write the plan (master agent — you)

Write the plan YOURSELF using the Write tool to `<plan-path>`. Do NOT delegate file writing to a
sub-agent.

The plan must follow every section in `reference/server/constants/templates/plan-template.md`, in the
same order, with no sections removed. Add new sections only if the work genuinely requires them. In
particular:
- The `## Original Request` section must quote, verbatim, the original request you captured in Step 0
  (as a Markdown blockquote).
- The Testing Strategy must reflect what was confirmed with the user in Step 2.
- The Project Docs Update section may say "Not needed for this change." for minor features, but the
  section must still be present.

#### CRITICAL: Agent-Executable Steps Only

Every item in the To-Do List MUST be something an implementation agent can execute autonomously in
this environment. The implementation step (`/implement`) runs the plan end-to-end and opens the PR.

**NEVER include To-Do items that require:**
- The user to take an action (e.g., "Commit and push when user requests", "Wait for user approval",
  "User to test in staging").
- Deployment to production, staging, or any other environment.
- Creating, pushing, or merging a pull request — the implementation step handles `git commit`,
  `git push`, `gh pr create`, and CI. Do NOT add commit/push/PR steps to the plan.
- Manual git operations (commit, push, branch management).
- External services or credentials the agent does not have access to.
- Any step gated on "only when explicitly requested by user" or similar conditional user input.

If a step cannot be executed by the agent itself end-to-end, leave it out entirely. Do not add it as
an unchecked TODO "for later".

The plan ends when code + tests are done. The implementation step takes it from there.

After writing, READ the file back to verify it was written correctly.

### Step 4: Report

Tell the user the plan is ready and print the `<plan-path>` so they can review it or run `/implement`.
