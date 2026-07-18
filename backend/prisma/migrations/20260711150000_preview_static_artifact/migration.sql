-- Existing installations gain a separately typed, preview-only artifact.
-- The release approval remains bound to VERCEL_OUTPUT.
ALTER TYPE "ArtifactKind" ADD VALUE IF NOT EXISTS 'PREVIEW_STATIC';
