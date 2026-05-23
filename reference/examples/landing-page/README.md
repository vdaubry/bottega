# Bottega Landing Page (sample project)

A single-page Next.js (App Router) landing page for [Bottega](https://github.com/vdaubry/bottega).

This is the sample project that ships with Bottega's open-source release.
When you run `pnpm onboarding` after installing Bottega, this folder is
copied to `~/bottega-examples/landing-page/`, `git init`-ed, and added to
your dashboard with a sample task asking you to add a dark-mode toggle to
the page. The idea is to give you something concrete to point Claude at on
your very first conversation.

## Run it standalone

```bash
pnpm install
pnpm dev
```

Then open http://localhost:3000.

## Stack

- Next.js 15 (App Router)
- TypeScript
- Tailwind CSS 3
