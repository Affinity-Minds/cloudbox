// Owner: WT-3. Small pieces shared by the Fleet list and detail screens.
import type { DeviceStatus, KeyProtection, LicenseState } from "@cloudbox/contracts";
import { StatusPill, type Tone } from "@/components/status-pill";

export function OnlinePill({ online, status }: { online: boolean; status: DeviceStatus }) {
  if (status === "revoked") return <StatusPill tone="neutral">Revoked</StatusPill>;
  if (status === "transferred") return <StatusPill tone="neutral">Transferred</StatusPill>;
  return (
    <StatusPill tone={online ? "success" : "neutral"}>{online ? "Online" : "Offline"}</StatusPill>
  );
}

/** `keyProtection: "software"` means the device key isn't hardware-backed — a degraded posture,
 * not an outage, so it gets its own pill next to Online/Offline rather than replacing it. */
export function KeyProtectionPill({ keyProtection }: { keyProtection: KeyProtection }) {
  return keyProtection === "tpm" ? (
    <StatusPill tone="info">TPM</StatusPill>
  ) : (
    <StatusPill tone="warning">Degraded key</StatusPill>
  );
}

const LICENSE_TONE: Record<LicenseState, Tone> = {
  none: "neutral",
  active: "success",
  expired: "danger",
};
const LICENSE_LABEL: Record<LicenseState, string> = {
  none: "No license",
  active: "Licensed",
  expired: "License expired",
};

export function LicenseStatePill({ state }: { state: LicenseState }) {
  return <StatusPill tone={LICENSE_TONE[state]}>{LICENSE_LABEL[state]}</StatusPill>;
}
