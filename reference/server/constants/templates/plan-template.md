# Task {{ task title — replace with the real task title }}

## Original Request

<!--
Quote the user's original request verbatim, as a Markdown blockquote. The source is the
EXISTING content of the task doc at {{taskDocPath}} as you read it BEFORE rewriting it
(plus the task title, if the doc is empty or only contains the title). Do not paraphrase,
summarize, or omit any part of it. This section is mandatory.
-->

> {{ original task doc content, quoted line-by-line }}

## Overview

{{ Problem statement, scope, and any key architectural decisions you made.
   For non-technical users, surface the technical decisions you made silently here so
   future-you and reviewers can audit them. }}

## Implementation Plan

### Phase 1: {{ phase title }}

**Files to modify / create:**
- `path/to/file.ext` — {{ what changes }}

{{ Step-by-step changes, with code snippets, before/after, or rationale where useful. }}

### Phase 2: {{ phase title }}

{{ … repeat as needed. Order phases logically: infrastructure → models → controllers →
   views → helpers/utilities. Each phase should be a logical chunk a reviewer can verify
   in isolation. }}

## Testing Strategy

### Unit tests
- {{ spec/test files and what each one covers }}

### Manual / Playwright MCP testing
- {{ scenarios with steps and expected results, or an explicit "not needed because …" }}

## To-Do List

### Implementation
- [ ] {{ implementation step 1 }}
- [ ] {{ implementation step 2 }}

### Testing
- [ ] {{ unit tests }}
- [ ] {{ manual testing }}

## Project Docs Update

{{ Note any updates required to .bottega/project.md (architecture, new patterns, new
   files), or write "Not needed for this change." }}
