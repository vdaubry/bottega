import { describe, it, expect } from 'vitest';
import { GenerateArtifactBodySchema, ArtifactKindParamsSchema } from './atlas.js';

describe('GenerateArtifactBodySchema', () => {
  it('accepts kind=auto (no model — the route resolves it from settings)', () => {
    expect(GenerateArtifactBodySchema.safeParse({ kind: 'auto' }).success).toBe(true);
  });

  it('accepts each concrete artifact kind', () => {
    for (const kind of ['plan', 'flowchart', 'architecture'] as const) {
      expect(GenerateArtifactBodySchema.safeParse({ kind }).success).toBe(true);
    }
  });

  it('rejects an unknown kind', () => {
    expect(GenerateArtifactBodySchema.safeParse({ kind: 'mindmap' }).success).toBe(false);
  });

  it('rejects a missing kind', () => {
    expect(GenerateArtifactBodySchema.safeParse({}).success).toBe(false);
  });
});

describe('ArtifactKindParamsSchema', () => {
  it('accepts each concrete kind', () => {
    for (const kind of ['plan', 'flowchart', 'architecture'] as const) {
      expect(ArtifactKindParamsSchema.safeParse({ kind }).success).toBe(true);
    }
  });

  it('rejects auto (the route param must be concrete)', () => {
    expect(ArtifactKindParamsSchema.safeParse({ kind: 'auto' }).success).toBe(false);
  });

  it('rejects an unknown kind', () => {
    expect(ArtifactKindParamsSchema.safeParse({ kind: 'nope' }).success).toBe(false);
  });
});
