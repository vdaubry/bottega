// Slug helpers shared by the entities whose git branch names are derived from
// a user-supplied title (tasks -> `task/{id}-{slug}`, epics ->
// `epic/{id}-{slug}`). Lowercase, alphanumerics only, dash-separated, capped at
// 30 characters so branch names stay readable.

export function sanitizeSlug(value: string | null | undefined, fallback: string): string {
  const slug = (value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 30)
    // A 30-char cut can land on a dash; trim again so the slug never ends in one.
    .replace(/-+$/g, '');
  return slug || fallback;
}

/** Slug stamped on an epic at creation — the stable half of `epic/{id}-{slug}`. */
export function slugifyEpicName(name: string | null | undefined): string {
  return sanitizeSlug(name, 'epic');
}
