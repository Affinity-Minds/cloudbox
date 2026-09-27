// Owner: WT-19. Streaming upload helpers. Every byte still passes through the Worker on its way
// to R2 (agent-notes cloudflare-workers #18), so hashing happens *while* streaming — never by
// buffering the whole artifact in memory first — using the runtime's `DigestStream`
// (`@cloudflare/workers-types`, a `WritableStream` that exposes a running digest), teed against
// the same body that goes to `R2Bucket.put`.
//
// `DigestStream` is a real global in production Workers, but `@cloudflare/vitest-pool-workers`'s
// bundled `workerd` binary can lag the types package (agent-notes cloudflare-workers #15 — "the
// pool often ships an older binary than the Vite plugin"), so `typeof DigestStream` is checked at
// runtime rather than assumed; the fallback buffers once via `crypto.subtle.digest`, which is
// correct everywhere, just not constant-memory. `typeof` on an undeclared global never throws —
// the one safe way to feature-detect this without a try/catch around every call.
function toHex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const hasDigestStream = typeof DigestStream !== "undefined";

export type StreamedUpload = { sha256: string; sizeBytes: number; etag: string };

/**
 * Single-shot upload (§23.6, ≤5 GiB — R2's own single-PUT ceiling; `MAX_SINGLE_SHOT_UPLOAD_BYTES`
 * in contracts). Tees the request body: one branch goes straight to R2, the other is hashed, so
 * the object lands in R2 and its hash is known by the time this resolves.
 */
export async function streamUploadWithHash(
  bucket: R2Bucket,
  key: string,
  body: ReadableStream<Uint8Array>,
  options: { httpMetadata?: R2HTTPMetadata } = {},
): Promise<StreamedUpload> {
  const [toR2, toDigest] = body.tee();

  if (!hasDigestStream) {
    const [buffer, putResult] = await Promise.all([
      new Response(toDigest).arrayBuffer(),
      bucket.put(key, toR2, { httpMetadata: options.httpMetadata }),
    ]);
    const sha256 = toHex(await crypto.subtle.digest("SHA-256", buffer));
    return { sha256, sizeBytes: buffer.byteLength, etag: putResult?.etag ?? "" };
  }

  const digestStream = new DigestStream("SHA-256");
  let sizeBytes = 0;
  const counter = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      sizeBytes += chunk.byteLength;
      controller.enqueue(chunk);
    },
  });

  const digestDone = toDigest.pipeThrough(counter).pipeTo(digestStream);
  const putResult = await bucket.put(key, toR2, { httpMetadata: options.httpMetadata });
  await digestDone;
  const sha256 = toHex(await digestStream.digest);

  return { sha256, sizeBytes, etag: putResult?.etag ?? "" };
}

/**
 * Post-multipart-complete integrity check: R2's multipart `complete()` finalises the object but
 * does not hand back a whole-object hash (each part has its own ETag, not a content hash), so the
 * only way to verify the *assembled* object's sha256 is to read it back and hash while reading.
 * Known cost, documented in the handoff: one extra full read per multipart-completed artifact.
 */
export async function hashExistingObject(
  bucket: R2Bucket,
  key: string,
): Promise<StreamedUpload | null> {
  const object = await bucket.get(key);
  if (!object) return null;

  if (!hasDigestStream) {
    const buffer = await object.arrayBuffer();
    const sha256 = toHex(await crypto.subtle.digest("SHA-256", buffer));
    return { sha256, sizeBytes: buffer.byteLength, etag: object.httpEtag };
  }

  const digestStream = new DigestStream("SHA-256");
  let sizeBytes = 0;
  const counter = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      sizeBytes += chunk.byteLength;
      controller.enqueue(chunk);
    },
  });
  await object.body.pipeThrough(counter).pipeTo(digestStream);
  const sha256 = toHex(await digestStream.digest);
  return { sha256, sizeBytes, etag: object.httpEtag };
}
