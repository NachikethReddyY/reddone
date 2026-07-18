export const dynamic = "force-dynamic";

export function GET() {
  const artifactHash = process.env.REDDONE_ARTIFACT_HASH;
  if (!artifactHash || !/^[a-f0-9]{64}$/.test(artifactHash)) {
    return Response.json({ status: "error" }, { status: 503 });
  }
  return Response.json({ status: "ok", artifactHash });
}
