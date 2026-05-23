const FEATURES = [
  {
    title: 'Task-driven',
    body:
      'Organise work as tasks under projects. Each task gets its own markdown brief that becomes context for the agent.',
  },
  {
    title: 'Resumable conversations',
    body:
      'Every Claude session is captured, browsable, and resumable from any device — no lost context after a tab close.',
  },
  {
    title: 'Mobile-friendly',
    body:
      'Driven from a phone over an SSH tunnel or a reverse proxy. Touch-first UI for kicking off agents on the go.',
  },
];

export default function Page() {
  return (
    <main className="mx-auto max-w-5xl px-6 py-16">
      <header className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="inline-block h-8 w-8 rounded-md bg-ink-900" aria-hidden />
          <span className="text-lg font-semibold">Bottega</span>
        </div>
        <a
          className="text-sm font-medium text-ink-900 underline-offset-4 hover:underline"
          href="https://github.com/vdaubry/bottega"
        >
          GitHub →
        </a>
      </header>

      <section className="mt-24 max-w-3xl">
        <p className="text-sm font-semibold uppercase tracking-wider text-ink-900/60">
          Open source · MIT
        </p>
        <h1 className="mt-3 text-5xl font-bold leading-tight tracking-tight md:text-6xl">
          A web UI for Claude Code.
        </h1>
        <p className="mt-6 text-lg text-ink-900/80 md:text-xl">
          Bottega turns Claude Code into a multi-project workspace you can drive
          from any browser. Organise tasks, kick off agents, and pick up
          conversations from your laptop or your phone.
        </p>
        <div className="mt-10 flex flex-wrap gap-3">
          <a
            href="https://github.com/vdaubry/bottega"
            className="rounded-md bg-ink-900 px-5 py-3 text-sm font-semibold text-white hover:bg-ink-900/90"
          >
            Star on GitHub
          </a>
          <a
            href="https://github.com/vdaubry/bottega#installation"
            className="rounded-md border border-ink-900/15 bg-white px-5 py-3 text-sm font-semibold text-ink-900 hover:border-ink-900/30"
          >
            Installation
          </a>
        </div>
      </section>

      <section className="mt-24 grid gap-6 md:grid-cols-3">
        {FEATURES.map(f => (
          <article
            key={f.title}
            className="rounded-lg border border-ink-900/10 bg-white p-6 shadow-sm"
          >
            <h2 className="text-base font-semibold">{f.title}</h2>
            <p className="mt-2 text-sm text-ink-900/70">{f.body}</p>
          </article>
        ))}
      </section>

      <section className="mt-24 rounded-xl border border-ink-900/10 bg-white p-8 md:p-12">
        <h2 className="text-2xl font-semibold">Get started in two commands</h2>
        <p className="mt-3 text-ink-900/70">
          After cloning the repo and installing dependencies, run the
          onboarding wizard to create your first admin user and seed a sample
          project.
        </p>
        <pre className="mt-6 overflow-x-auto rounded-md bg-ink-900 p-4 text-sm text-white">
          {`pnpm install\npnpm onboarding\npnpm dev`}
        </pre>
      </section>

      <footer className="mt-24 border-t border-ink-900/10 pt-8 text-sm text-ink-900/60">
        <p>
          This page is the sample project that ships with Bottega&apos;s
          open-source release. Edit it through Bottega itself — that&apos;s the
          point.
        </p>
      </footer>
    </main>
  );
}
