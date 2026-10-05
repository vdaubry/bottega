# Vendored effective-html style references

These HTML files are a **curated, version-pinned subset** of the reference
corpus from [`plannotator/effective-html`](https://github.com/plannotator/effective-html),
vendored here so the Explore artifact-generation agent can study them offline
(Bottega has no skills runtime — the methodology is ported into the
`atlas-artifact` prompt template, and these files are the gold-standard
exemplars the prompt points the agent at).

## What's here

| File | Source skill / reference | Used for |
|------|--------------------------|----------|
| `architecture-example.html` | `skills/html-diagram/references/architecture-example.html` | `architecture` artifacts — full-screen interactive SVG diagram, clickable nodes, flow chips |
| `13-flowchart-diagram.html` | `skills/html/references/html-effectiveness/13-flowchart-diagram.html` | `flowchart` artifacts — request/logic flow |
| `16-implementation-plan.html` | `skills/html/references/html-effectiveness/16-implementation-plan.html` | `plan` artifacts — a markdown plan rendered as a beautiful HTML page |
| `11-status-report.html` | `skills/html/references/html-effectiveness/11-status-report.html` | detail-rich exemplar (density, click-to-detail, status chrome) |
| `15-research-concept-explainer.html` | `skills/html/references/html-effectiveness/15-research-concept-explainer.html` | detail-rich exemplar (concept explainers, layered detail) |

## Attribution & licensing

The `effective-html` skill set and `architecture-example.html` are **MIT**,
Copyright (c) 2026 plannotator — see `LICENSE-MIT`.

The numbered files under `references/html-effectiveness/` ("The unreasonable
effectiveness of HTML — examples", authored by Thariq Shihipar) are licensed
**Apache-2.0** — see `LICENSE-APACHE`.

All product names, data, and scenarios in the example files are fictional and
used only for illustration.
