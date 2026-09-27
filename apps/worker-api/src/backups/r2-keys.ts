// Owner: WT-19. R2 object keys for backup artifacts, under `backups/<tenant>/<device>/...`
// (per-brief namespacing). The key is always server-generated (agent-notes cloudflare-workers #18
// "generate the object key server-side and never take it from the filename"): a device never
// supplies any part of it besides its own (already-authenticated) tenant/device id.
export function backupArtifactKey(
  tenantId: string,
  deviceId: string,
  jobId: string,
  artifactId: string,
): string {
  return `backups/${tenantId}/${deviceId}/${jobId}/${artifactId}.bin`;
}
