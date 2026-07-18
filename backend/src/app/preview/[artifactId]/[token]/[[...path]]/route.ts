import {
  consumePreviewRequestBudget,
  demoPreviewDocument,
  loadVerifiedPreviewFile,
  previewResponseHeaders,
  rewritePreviewAssetPaths,
  verifyPreviewAccess,
} from "@/server/preview";

type Context = { params: Promise<{ artifactId: string; token: string; path?: string[] }> };

export const dynamic = "force-dynamic";

export async function GET(request: Request, { params }: Context) {
  try {
    const { artifactId, token, path } = await params;
    const forwarded = request.headers.get("x-forwarded-for")?.split(",", 1)[0]?.trim();
    const clientAddress = (forwarded || request.headers.get("x-real-ip") || "unknown").slice(0, 200);
    if (!consumePreviewRequestBudget({ artifactId, token, clientAddress })) {
      return new Response("Preview request limit exceeded", {
        status: 429,
        headers: {
          ...previewResponseHeaders({ contentType: "text/plain; charset=utf-8" }),
          "retry-after": "60",
        },
      });
    }
    const { payload } = verifyPreviewAccess({ artifactId, token, requestUrl: request.url });
    if (payload.mode === "demo") {
      if (path?.length && !(path.length === 1 && path[0] === "index.html")) throw new Error("Demo preview file was not found.");
      const html = demoPreviewDocument(payload);
      return new Response(html, {
        status: 200,
        headers: {
          ...previewResponseHeaders({ contentType: "text/html; charset=utf-8", html }),
          "x-reddone-preview-mode": "demo-simulation",
        },
      });
    }

    const file = await loadVerifiedPreviewFile({
      artifactId,
      artifactHash: payload.artifactHash,
      ...(path ? { pathSegments: path } : {}),
    });
    const prefix = `/preview/${encodeURIComponent(artifactId)}/${encodeURIComponent(token)}/`;
    const body = rewritePreviewAssetPaths({ body: file.body, contentType: file.contentType, prefix });
    const html = file.contentType.startsWith("text/html") ? body.toString("utf8") : undefined;
    return new Response(body, {
      status: 200,
      headers: {
        ...previewResponseHeaders({ contentType: file.contentType, ...(html ? { html } : {}), sourceSha256: file.sourceSha256 }),
        "content-length": String(body.byteLength),
        "x-reddone-preview-mode": "verified-static",
      },
    });
  } catch {
    return new Response("Preview unavailable", {
      status: 404,
      headers: {
        "cache-control": "private, no-store, max-age=0",
        "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
        "content-type": "text/plain; charset=utf-8",
        "referrer-policy": "no-referrer",
        "x-content-type-options": "nosniff",
        "x-frame-options": "DENY",
        "x-robots-tag": "noindex, nofollow, noarchive",
      },
    });
  }
}
