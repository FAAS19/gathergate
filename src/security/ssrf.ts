import dns from "node:dns";
import net from "node:net";

function parseIpv4Parts(ip: string): [number, number, number, number] | null {
  const m = ip.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return null;
  const parts = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])] as [
    number,
    number,
    number,
    number,
  ];
  if (parts.some((n) => n < 0 || n > 255)) return null;
  return parts;
}

export function isNonPublicIpv4(ip: string): boolean {
  const parts = parseIpv4Parts(ip);
  if (!parts) return false;
  const [a, b, c] = parts;
  return (
    a === 0 || // 0.0.0.0/8 "this network"
    a === 10 || // 10.0.0.0/8 RFC 1918
    a === 127 || // 127.0.0.0/8 loopback
    (a === 100 && b >= 64 && b <= 127) || // 100.64.0.0/10 CGNAT
    (a === 169 && b === 254) || // 169.254.0.0/16 link-local / cloud metadata
    (a === 172 && b >= 16 && b <= 31) || // 172.16.0.0/12 RFC 1918
    (a === 192 && b === 0 && c === 0) || // 192.0.0.0/24 IETF protocol assignments
    (a === 192 && b === 0 && c === 2) || // 192.0.2.0/24 TEST-NET-1
    (a === 192 && b === 168) || // 192.168.0.0/16 RFC 1918
    (a === 198 && (b === 18 || b === 19)) || // 198.18.0.0/15 benchmarking
    (a === 198 && b === 51 && c === 100) || // 198.51.100.0/24 TEST-NET-2
    (a === 203 && b === 0 && c === 113) || // 203.0.113.0/24 TEST-NET-3
    a >= 224 // 224.0.0.0/4 multicast + 240.0.0.0/4 reserved + 255.255.255.255 broadcast
  );
}

function expandIpv6(ip: string): number[] | null {
  const clean = ip.toLowerCase().split("%")[0];
  if (!clean.includes(":")) return null;
  let work = clean;
  // Convert trailing embedded IPv4 (e.g. ::ffff:127.0.0.1 or ::127.0.0.1 or 64:ff9b::10.0.0.1)
  const lastColon = work.lastIndexOf(":");
  const tail = work.slice(lastColon + 1);
  if (tail.includes(".")) {
    const v4 = parseIpv4Parts(tail);
    if (!v4) return null;
    const hi = ((v4[0] << 8) | v4[1]).toString(16);
    const lo = ((v4[2] << 8) | v4[3]).toString(16);
    work = `${work.slice(0, lastColon)}:${hi}:${lo}`;
  }
  const halves = work.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":").filter(Boolean) : [];
  const right = halves[1] ? halves[1].split(":").filter(Boolean) : [];
  const missing = 8 - (left.length + right.length);
  if (halves.length === 1 && missing !== 0) return null;
  if (halves.length === 2 && missing < 1) return null;
  const full = [...left, ...Array(Math.max(0, missing)).fill("0"), ...right];
  if (full.length !== 8) return null;
  const groups = full.map((g) => (/^[0-9a-f]{1,4}$/.test(g) ? parseInt(g, 16) : NaN));
  return groups.some(Number.isNaN) ? null : groups;
}

export function isNonPublicIp(rawIp: string): boolean {
  const ip = rawIp.replace(/^\[|\]$/g, "").trim();
  const kind = net.isIP(ip);
  if (kind === 4) return isNonPublicIpv4(ip);
  if (kind === 6) {
    const g = expandIpv6(ip);
    if (!g) return true;
    const isZeroPrefix6 = g[0] === 0 && g[1] === 0 && g[2] === 0 && g[3] === 0 && g[4] === 0;
    // :: and ::1
    if (isZeroPrefix6 && g[5] === 0 && g[6] === 0 && (g[7] === 0 || g[7] === 1)) return true;
    // ::ffff:0:0/96 (IPv4-mapped) or ::/96 (IPv4-compatible)
    if (isZeroPrefix6 && (g[5] === 0xffff || g[5] === 0)) {
      const embeddedV4 = `${g[6] >> 8}.${g[6] & 0xff}.${g[7] >> 8}.${g[7] & 0xff}`;
      if (isNonPublicIpv4(embeddedV4)) return true;
    }
    // ::ffff:0:0:0/96 (IPv4-translated)
    if (g[0] === 0 && g[1] === 0 && g[2] === 0 && g[3] === 0 && g[4] === 0xffff && g[5] === 0) {
      const embeddedV4 = `${g[6] >> 8}.${g[6] & 0xff}.${g[7] >> 8}.${g[7] & 0xff}`;
      if (isNonPublicIpv4(embeddedV4)) return true;
    }
    // 64:ff9b::/96 (NAT64 well-known) and 64:ff9b:1::/48 (NAT64 local-use)
    if (g[0] === 0x0064 && g[1] === 0xff9b) {
      if (g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0) {
        const embeddedV4 = `${g[6] >> 8}.${g[6] & 0xff}.${g[7] >> 8}.${g[7] & 0xff}`;
        if (isNonPublicIpv4(embeddedV4)) return true;
      }
      if (g[2] === 0x0001) return true;
    }
    // fc00::/7 ULA, fe80::/10 link-local, ff00::/8 multicast, 2001:db8::/32 documentation
    if ((g[0] & 0xfe00) === 0xfc00) return true;
    if ((g[0] & 0xffc0) === 0xfe80) return true;
    if ((g[0] & 0xff00) === 0xff00) return true;
    if (g[0] === 0x2001 && g[1] === 0x0db8) return true;
    return false;
  }
  return false;
}

export function isPrivateOrLocalHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase().replace(/\.$/, "").trim();
  if (!host) return true;
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal")
  ) {
    return true;
  }
  if (net.isIP(host)) return isNonPublicIp(host);
  // Reject single-label internal service names (e.g. "redis", "metadata", "db") in multi-tenant mode
  if (!host.includes(".")) return true;
  return false;
}

export function validateWebhookEndpoint(rawUrl: string, multiTenant: boolean): string | null {
  try {
    const parsed = new URL(rawUrl);
    if (multiTenant) {
      if (parsed.protocol !== "https:" || isPrivateOrLocalHost(parsed.hostname)) {
        return "Webhook URL must target a public https endpoint in multi-tenant mode.";
      }
    } else if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      return "Webhook URL must be valid http or https.";
    }
    return null;
  } catch {
    return "Webhook URL must be valid http or https.";
  }
}

export type LookupAllFn = (hostname: string) => Promise<Array<{ address: string; family: number }>>;

export async function assertPublicHostname(
  hostname: string,
  lookupImpl?: LookupAllFn
): Promise<string | null> {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase().replace(/\.$/, "").trim();
  if (isPrivateOrLocalHost(host)) {
    return "Target host must be a public hostname.";
  }
  if (net.isIP(host)) {
    return isNonPublicIp(host) ? "Target IP must be a public address." : null;
  }
  try {
    const records = lookupImpl
      ? await lookupImpl(host)
      : await dns.promises.lookup(host, { all: true });
    if (!records || records.length === 0) {
      return "Target hostname could not be resolved.";
    }
    for (const rec of records) {
      if (isNonPublicIp(rec.address)) {
        return "Target hostname resolves to a private or non-public address.";
      }
    }
    return null;
  } catch {
    return "Target hostname could not be resolved.";
  }
}

export type WebhookEndpointResolution =
  | { ok: true; resolvedAddresses?: Array<{ address: string; family: 4 | 6 }> }
  | { ok: false; kind: "policy" | "transient_dns"; error: string };

export async function resolveWebhookEndpointRuntime(
  rawUrl: string,
  multiTenant: boolean,
  options?: { skipDns?: boolean; lookupImpl?: LookupAllFn }
): Promise<WebhookEndpointResolution> {
  const basicErr = validateWebhookEndpoint(rawUrl, multiTenant);
  if (basicErr) return { ok: false, kind: "policy", error: basicErr };
  if (!multiTenant || options?.skipDns) return { ok: true };

  const parsed = new URL(rawUrl);
  const host = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase().replace(/\.$/, "").trim();
  if (isPrivateOrLocalHost(host)) {
    return {
      ok: false,
      kind: "policy",
      error: "Webhook URL must target a public https endpoint in multi-tenant mode.",
    };
  }
  const ipKind = net.isIP(host);
  if (ipKind === 4 || ipKind === 6) {
    if (isNonPublicIp(host)) {
      return {
        ok: false,
        kind: "policy",
        error: "Webhook URL must target a public https endpoint in multi-tenant mode.",
      };
    }
    return { ok: true, resolvedAddresses: [{ address: host, family: ipKind }] };
  }

  try {
    const records = options?.lookupImpl
      ? await options.lookupImpl(host)
      : await dns.promises.lookup(host, { all: true });
    if (!records || records.length === 0) {
      return { ok: false, kind: "transient_dns", error: "Webhook hostname could not be resolved." };
    }
    const validated: Array<{ address: string; family: 4 | 6 }> = [];
    for (const rec of records) {
      if (isNonPublicIp(rec.address)) {
        return {
          ok: false,
          kind: "policy",
          error: "Webhook URL must target a public https endpoint in multi-tenant mode.",
        };
      }
      const family: 4 | 6 = rec.family === 6 || net.isIP(rec.address) === 6 ? 6 : 4;
      validated.push({ address: rec.address, family });
    }
    return { ok: true, resolvedAddresses: validated };
  } catch (err) {
    // Node dns.lookup can emit ENOTFOUND/EAI_AGAIN transiently (e.g. FD exhaustion); retry within budget.
    const code = (err as NodeJS.ErrnoException | undefined)?.code || "lookup error";
    return {
      ok: false,
      kind: "transient_dns",
      error: `Webhook DNS lookup failed (${code}).`,
    };
  }
}

export async function validateWebhookEndpointRuntime(
  rawUrl: string,
  multiTenant: boolean,
  options?: { skipDns?: boolean; lookupImpl?: LookupAllFn }
): Promise<string | null> {
  const res = await resolveWebhookEndpointRuntime(rawUrl, multiTenant, options);
  return res.ok ? null : res.error;
}
