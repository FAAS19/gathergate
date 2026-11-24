import crypto from "node:crypto";
import { Readable } from "node:stream";

export const CURRENT_ENC_VERSION = "v1";

export interface EncryptedBlobMeta {
  version: string;
  ivHex: string;
  tagHex: string;
  saltHex: string;
  sha256Hex: string;
  sizeBytes: number;
}

export function generateId(prefix = ""): string {
  const raw = crypto.randomBytes(12).toString("base64url");
  return prefix ? `${prefix}_${raw}` : raw;
}

export function generateMagicToken(): string {
  return crypto.randomBytes(32).toString("base64url");
}

export function sha256Hex(value: string | Buffer): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

export function hmacSha256Hex(secret: string, payload: string | Buffer): string {
  return crypto.createHmac("sha256", secret).update(payload).digest("hex");
}

export function safeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  return bufA.length === bufB.length && crypto.timingSafeEqual(bufA, bufB);
}

function deriveKey(
  masterKey: Buffer,
  salt: Buffer,
  purpose: string,
  version = CURRENT_ENC_VERSION
): Buffer {
  if (version !== CURRENT_ENC_VERSION) {
    throw new Error(`Unsupported encryption version: ${version}`);
  }
  return Buffer.from(
    crypto.hkdfSync("sha256", masterKey, salt, Buffer.from(`gathergate:${purpose}:${version}`, "utf8"), 32)
  );
}

export function encryptField(masterKey: Buffer, plaintext: string, aad = ""): string {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = deriveKey(masterKey, salt, "field");
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  if (aad) cipher.setAAD(Buffer.from(aad, "utf8"));
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${salt.toString("hex")}:${iv.toString("hex")}:${tag.toString("hex")}:${encrypted.toString("base64")}`;
}

export function decryptField(masterKey: Buffer, encoded: string, aad = ""): string {
  const parts = encoded.split(":");
  if (parts.length !== 5 || parts[0] !== "v1") {
    throw new Error("Unsupported encrypted field format");
  }
  const [, saltHex, ivHex, tagHex, dataB64] = parts;
  const key = deriveKey(masterKey, Buffer.from(saltHex, "hex"), "field");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(ivHex, "hex"));
  if (aad) decipher.setAAD(Buffer.from(aad, "utf8"));
  decipher.setAuthTag(Buffer.from(tagHex, "hex"));
  const decrypted = Buffer.concat([decipher.update(Buffer.from(dataB64, "base64")), decipher.final()]);
  return decrypted.toString("utf8");
}

export function encryptBuffer(
  masterKey: Buffer,
  plaintext: Buffer,
  aad = ""
): { ciphertext: Buffer; meta: EncryptedBlobMeta } {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = deriveKey(masterKey, salt, "blob");
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  if (aad) cipher.setAAD(Buffer.from(aad, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    ciphertext,
    meta: {
      version: CURRENT_ENC_VERSION,
      ivHex: iv.toString("hex"),
      tagHex: tag.toString("hex"),
      saltHex: salt.toString("hex"),
      sha256Hex: sha256Hex(plaintext),
      sizeBytes: plaintext.byteLength,
    },
  };
}

export function createDecryptStream(
  masterKey: Buffer,
  encryptedStream: Readable,
  meta: Pick<EncryptedBlobMeta, "ivHex" | "tagHex" | "saltHex"> & { version?: string },
  aad = ""
): Readable {
  const key = deriveKey(masterKey, Buffer.from(meta.saltHex, "hex"), "blob", meta.version ?? CURRENT_ENC_VERSION);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(meta.ivHex, "hex"));
  if (aad) decipher.setAAD(Buffer.from(aad, "utf8"));
  decipher.setAuthTag(Buffer.from(meta.tagHex, "hex"));
  encryptedStream.on("error", (err) => decipher.destroy(err));
  return encryptedStream.pipe(decipher);
}

export async function decryptBuffer(
  masterKey: Buffer,
  ciphertext: Buffer,
  meta: Pick<EncryptedBlobMeta, "ivHex" | "tagHex" | "saltHex"> & { version?: string },
  aad = ""
): Promise<Buffer> {
  const key = deriveKey(masterKey, Buffer.from(meta.saltHex, "hex"), "blob", meta.version ?? CURRENT_ENC_VERSION);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(meta.ivHex, "hex"));
  if (aad) decipher.setAAD(Buffer.from(aad, "utf8"));
  decipher.setAuthTag(Buffer.from(meta.tagHex, "hex"));
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}
