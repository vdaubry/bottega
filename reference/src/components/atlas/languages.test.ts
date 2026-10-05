import { describe, it, expect } from 'vitest';
import { languageFor, languageNameFor } from './languages';

describe('languageFor / languageNameFor', () => {
  it('maps the first-party grammars', () => {
    expect(languageFor('src/index.ts')).toHaveLength(1);
    expect(languageNameFor('src/index.ts')).toBe('typescript');
    expect(languageNameFor('src/App.tsx')).toBe('typescript');
    expect(languageNameFor('lib/util.mjs')).toBe('javascript');
    expect(languageNameFor('package.json')).toBe('json');
    expect(languageNameFor('styles/site.css')).toBe('css');
    expect(languageNameFor('index.html')).toBe('html');
    expect(languageNameFor('README.md')).toBe('markdown');
    expect(languageNameFor('scripts/run.py')).toBe('python');
  });

  it('maps Ruby and the Rails templating DSLs', () => {
    expect(languageNameFor('app/models/user.rb')).toBe('ruby');
    expect(languageFor('app/models/user.rb')).toHaveLength(1);
    expect(languageNameFor('lib/tasks/db.rake')).toBe('ruby');
    expect(languageNameFor('config.ru')).toBe('ruby');
    expect(languageNameFor('bottega.gemspec')).toBe('ruby');
    expect(languageNameFor('app/views/users/index.json.rabl')).toBe('ruby');
    expect(languageNameFor('app/views/api/show.json.jbuilder')).toBe('ruby');
  });

  it('maps extension-less Ruby filenames by basename', () => {
    expect(languageNameFor('Gemfile')).toBe('ruby');
    expect(languageNameFor('repo/Rakefile')).toBe('ruby');
    expect(languageNameFor('Guardfile')).toBe('ruby');
    expect(languageFor('Gemfile')).toHaveLength(1);
  });

  it('labels ERB as erb and highlights by the inner (compound) extension', () => {
    // The label is always "erb" so the UI shows it is a template…
    expect(languageNameFor('app/views/users/show.html.erb')).toBe('erb');
    expect(languageNameFor('app/views/api/index.json.erb')).toBe('erb');
    expect(languageNameFor('app/views/widgets/chart.js.erb')).toBe('erb');
    expect(languageNameFor('app/views/_partial.erb')).toBe('erb');
    // …and each resolves to a real grammar (defaulting to HTML).
    expect(languageFor('app/views/users/show.html.erb')).toHaveLength(1);
    expect(languageFor('app/views/_partial.erb')).toHaveLength(1);
  });

  it('maps YAML, shell, and SQL via the legacy stream parsers', () => {
    expect(languageNameFor('config/database.yml')).toBe('yaml');
    expect(languageNameFor('docker-compose.yaml')).toBe('yaml');
    expect(languageNameFor('bin/deploy.sh')).toBe('shell');
    expect(languageNameFor('db/structure.sql')).toBe('sql');
    expect(languageFor('config/database.yml')).toHaveLength(1);
  });

  it('treats SCSS/Sass/Less as CSS and covers extra Python/JS extensions', () => {
    expect(languageNameFor('app/assets/site.scss')).toBe('css');
    expect(languageNameFor('app/assets/site.sass')).toBe('css');
    expect(languageNameFor('stubs/types.pyi')).toBe('python');
    expect(languageNameFor('lib/worker.cjs')).toBe('javascript');
  });

  it('falls back to plain text for unknown or missing extensions', () => {
    expect(languageFor('Dockerfile')).toEqual([]);
    expect(languageNameFor('Dockerfile')).toBe('plain text');
    expect(languageFor('main.rs')).toEqual([]);
    expect(languageNameFor('main.rs')).toBe('plain text');
  });

  it('uses the basename, not directory dots', () => {
    expect(languageNameFor('v1.2/notes')).toBe('plain text');
    // Dotfiles have no extension (dot at position 0 of the basename).
    expect(languageNameFor('.gitignore')).toBe('plain text');
  });
});
