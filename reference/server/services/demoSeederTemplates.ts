export const DEMO_PROJECT_NAME = 'Bottega Landing Page';

export const DEMO_TASK_TITLE = 'Add a dark-mode toggle to the landing page';

export const TASK_DOC_TEMPLATE = `# Add a dark-mode toggle to the landing page

This sample task ships with the Bottega open-source release so you can see the
full workflow end-to-end: project → task → conversation → real code change.

The repo on disk is a small Next.js (App Router) landing page for Bottega
itself. Your job is to add a dark-mode toggle to the top-right of the header.

## Goal

Add a button in the header that switches the page between light and dark
themes. The choice should persist across page reloads.

## Suggested approach

1. Use Tailwind's \`dark:\` variant. Add \`darkMode: 'class'\` to
   \`tailwind.config.ts\` so the variant is driven by a CSS class on \`<html>\`.
2. Build a small client component (\`'use client'\`) that toggles
   \`document.documentElement.classList\` between \`light\` and \`dark\`, and
   reads/writes the chosen mode to \`localStorage\` under a key like
   \`bottega-theme\`.
3. Pick a small icon set (e.g. inline SVG) for the sun/moon button. No new
   dependencies are needed.
4. Pass an audit: refresh the page, the theme persists. No flash of wrong
   theme on first paint (use an inline \`<script>\` in \`layout.tsx\` to set
   the class before React hydrates).

## What "done" looks like

- A button in the header that toggles the theme.
- Dark-mode styles applied across the whole page (background, text, cards,
  buttons).
- The choice survives a page reload.
- No console warnings about hydration mismatches.

## Tips for working with Bottega

- Start a new conversation from this task. Bottega will inject this doc as
  context so Claude knows what to build.
- Ask follow-up questions in the chat: "Show me the diff", "Run the dev
  server and check it works", etc.
- If you want to start over, you can delete this project from the Dashboard
  and re-run \`pnpm onboarding\`.
`;
