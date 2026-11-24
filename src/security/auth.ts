import crypto from "node:crypto";
import { safeEqualHex, sha256Hex } from "./crypto.js";

const ARGON2_MEMORY = 19456; // 19 MiB (OWASP minimum for Argon2id)
const ARGON2_PASSES = 2;
const ARGON2_PARALLELISM = 1;
const ARGON2_TAG_LEN = 32;

type Argon2SyncFn = (
  algorithm: "argon2id",
  parameters: {
    message: string | Buffer;
    nonce: Buffer;
    parallelism: number;
    tagLength: number;
    memory: number;
    passes: number;
  }
) => Buffer;

function getNativeArgon2(): Argon2SyncFn | null {
  const fn = (crypto as unknown as { argon2Sync?: Argon2SyncFn }).argon2Sync;
  return typeof fn === "function" ? fn : null;
}

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16);
  const argon2Sync = getNativeArgon2();
  if (argon2Sync) {
    const hash = argon2Sync("argon2id", {
      message: password,
      nonce: salt,
      parallelism: ARGON2_PARALLELISM,
      tagLength: ARGON2_TAG_LEN,
      memory: ARGON2_MEMORY,
      passes: ARGON2_PASSES,
    });
    return `argon2id$${ARGON2_MEMORY}$${ARGON2_PASSES}$${ARGON2_PARALLELISM}$${salt.toString("hex")}$${hash.toString("hex")}`;
  }
  // Fallback for Node 22 runtimes lacking built-in crypto.argon2Sync
  const hash = crypto.scryptSync(password, salt, 32, { N: 16384, r: 8, p: 1 });
  return `scrypt$16384$8$1$${salt.toString("hex")}$${hash.toString("hex")}`;
}

export function verifyPassword(password: string, encoded: string): boolean {
  const parts = encoded.split("$");
  if (parts.length !== 6) return false;
  const [algo, p1, p2, p3, saltHex, expectedHex] = parts;
  const salt = Buffer.from(saltHex, "hex");

  if (algo === "argon2id") {
    const argon2Sync = getNativeArgon2();
    if (!argon2Sync) return false;
    const derived = argon2Sync("argon2id", {
      message: password,
      nonce: salt,
      memory: Number(p1),
      passes: Number(p2),
      parallelism: Number(p3),
      tagLength: Buffer.from(expectedHex, "hex").byteLength,
    });
    return safeEqualHex(derived.toString("hex"), expectedHex);
  }

  if (algo === "scrypt") {
    const derived = crypto.scryptSync(password, salt, Buffer.from(expectedHex, "hex").byteLength, {
      N: Number(p1),
      r: Number(p2),
      p: Number(p3),
    });
    return safeEqualHex(derived.toString("hex"), expectedHex);
  }

  return false;
}

export function generateOtpCode(): { code: string; hash: string } {
  const num = crypto.randomInt(0, 1_000_000);
  const code = String(num).padStart(6, "0");
  return { code, hash: sha256Hex(`otp:${code}`) };
}

export function verifyOtpCode(code: string, expectedHash: string): boolean {
  const cleaned = code.replace(/\s+/g, "");
  if (!/^\d{6}$/.test(cleaned)) return false;
  return safeEqualHex(sha256Hex(`otp:${cleaned}`), expectedHash);
}
