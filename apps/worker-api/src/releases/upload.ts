// Owner: WT-18. Package upload → R2 (agent-notes cloudflare-workers #18: "uploads stream through
// the Worker"; cap by type, generate the object key server-side, never take it from the filename).
//
// A multipart body must be materialised by the platform's `Request.formData()` before any part is
// usable (Workers has no incremental multipart parser), so the byte cap below is enforced twice:
// once cheaply against `Content-Length` before that parse even runs (routes/v1/releases.ts), and
// again here against the parsed `File`'s size. From that point on this function does single-pass
// I/O: `file.stream()` is teed once into a `crypto.DigestStream` (SHA-256, computed as bytes flow)
// and once into `R2Bucket.put`, so the already-materialised bytes are never copied a second time.
export const MAX_PACKAGE_BYTES = 200 * 1024 * 1024; // 200 MB, per the brief's cap.

export class UploadRefusal extends Error {
  constructor(
    readonly status: 400 | 413,
    readonly code: string,
    readonly detail?: string,
  ) {
    super(detail ?? code);
  }
}

const UNSAFE_FILENAME_CHARS = /[^A-Za-z0-9._-]/g;

/** Only used to pick a readable suffix for the R2 key; the key's directory structure never comes
 * from user input, so unicode/traversal characters in the original name cannot reach storage. */
function safeFileName(name: string): string {
  const trimmed = name.trim().replace(UNSAFE_FILENAME_CHARS, "_").slice(-128);
  return trimmed.length > 0 ? trimmed : "package.bin";
}

export type StoredPackage = { r2Key: string; sha256: string; sizeBytes: number };

function toHex(digest: ArrayBuffer): string {
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Streams `file` into R2 under `releases/<component>/<version>/<file>` (the key is generated here,
 * never from `file.name`), hashing while it writes. Refuses anything over `MAX_PACKAGE_BYTES` or an
 * empty file before touching R2.
 */
export async function storePackage(
  artifacts: R2Bucket,
  input: { component: string; version: string; file: File },
): Promise<StoredPackage> {
  const sizeBytes = input.file.size;
  if (sizeBytes <= 0) throw new UploadRefusal(400, "invalid_request", "package is empty");
  if (sizeBytes > MAX_PACKAGE_BYTES) {
    throw new UploadRefusal(413, "package_too_large", `cap is ${MAX_PACKAGE_BYTES} bytes`);
  }

  const key = `releases/${input.component}/${input.version}/${safeFileName(input.file.name)}`;
  // `crypto.DigestStream` is a Cloudflare Workers runtime extension (WritableStream<ArrayBuffer>)
  // that exposes the running digest once every chunk written to it has been consumed. Not on the
  // `Crypto` type here (it resolves to lib.dom's, via tsconfig.base's "lib": ["DOM", …], which
  // every other Bindings type needs) and not a bare global either (only a runtime property of the
  // `crypto` singleton) — cast at the one call site rather than widen the ambient `Crypto` type.
  const digestStream = new (
    crypto as unknown as { DigestStream: typeof DigestStream }
  ).DigestStream("SHA-256");
  const [forHash, forR2] = input.file.stream().tee();
  const hashDone = forHash.pipeTo(digestStream);
  await artifacts.put(key, forR2, {
    httpMetadata: { contentType: input.file.type || "application/octet-stream" },
  });
  await hashDone;
  const sha256 = toHex(await digestStream.digest);
  return { r2Key: key, sha256, sizeBytes };
}
