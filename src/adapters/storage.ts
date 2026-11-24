import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { AwsClient } from "aws4fetch";
import type { AppConfig } from "../config.js";

export interface StorageAdapter {
  put(key: string, data: Buffer): Promise<void>;
  getStream(key: string): Promise<Readable>;
  delete(key: string): Promise<void>;
}

class LocalStorageAdapter implements StorageAdapter {
  private readonly root: string;

  constructor(dataDir: string) {
    this.root = path.resolve(dataDir, "blobs");
    fs.mkdirSync(this.root, { recursive: true });
  }

  private resolveSafePath(key: string): string {
    const clean = key.replace(/^\/+/, "");
    const target = path.resolve(this.root, clean);
    if (!target.startsWith(this.root + path.sep)) {
      throw new Error("Invalid storage key path");
    }
    return target;
  }

  async put(key: string, data: Buffer): Promise<void> {
    const target = this.resolveSafePath(key);
    await fs.promises.mkdir(path.dirname(target), { recursive: true });
    await fs.promises.writeFile(target, data, { mode: 0o600 });
  }

  async getStream(key: string): Promise<Readable> {
    const target = this.resolveSafePath(key);
    await fs.promises.access(target, fs.constants.R_OK);
    return fs.createReadStream(target);
  }

  async delete(key: string): Promise<void> {
    const target = this.resolveSafePath(key);
    try {
      await fs.promises.unlink(target);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }
}

class S3StorageAdapter implements StorageAdapter {
  private readonly aws: AwsClient;
  private readonly endpoint: string;
  private readonly bucket: string;

  constructor(cfg: NonNullable<AppConfig["s3"]>) {
    this.aws = new AwsClient({
      accessKeyId: cfg.accessKeyId,
      secretAccessKey: cfg.secretAccessKey,
      region: cfg.region,
      service: "s3",
    });
    this.endpoint = cfg.endpoint;
    this.bucket = cfg.bucket;
  }

  private objectUrl(key: string): string {
    const encodedKey = key
      .replace(/^\/+/, "")
      .split("/")
      .map(encodeURIComponent)
      .join("/");
    return `${this.endpoint}/${encodeURIComponent(this.bucket)}/${encodedKey}`;
  }

  async put(key: string, data: Buffer): Promise<void> {
    const res = await this.aws.fetch(this.objectUrl(key), {
      method: "PUT",
      headers: {
        "content-type": "application/octet-stream",
        "content-length": String(data.byteLength),
      },
      body: new Uint8Array(data),
    });
    if (!res.ok) {
      throw new Error(`S3 PUT failed (${res.status}): ${await res.text()}`);
    }
  }

  async getStream(key: string): Promise<Readable> {
    const res = await this.aws.fetch(this.objectUrl(key), { method: "GET" });
    if (!res.ok || !res.body) {
      throw new Error(`S3 GET failed (${res.status})`);
    }
    return Readable.fromWeb(res.body as unknown as import("node:stream/web").ReadableStream);
  }

  async delete(key: string): Promise<void> {
    const res = await this.aws.fetch(this.objectUrl(key), { method: "DELETE" });
    if (!res.ok && res.status !== 404) {
      throw new Error(`S3 DELETE failed (${res.status})`);
    }
  }
}

export function createStorageAdapter(config: AppConfig): StorageAdapter {
  if (config.storageBackend === "s3" && config.s3) {
    return new S3StorageAdapter(config.s3);
  }
  return new LocalStorageAdapter(config.dataDir);
}
