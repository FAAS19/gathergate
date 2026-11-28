declare module "yazl" {
  import type { Readable } from "node:stream";
  export class ZipFile {
    outputStream: Readable;
    addReadStream(input: Readable, metadataPath: string, options?: { compress?: boolean; forceZip64Format?: boolean }): void;
    addReadStreamLazy(
      metadataPath: string,
      options: { compress?: boolean; forceZip64Format?: boolean } | undefined,
      getReadStream: (cb: (err: Error | null, input?: Readable) => void) => void
    ): void;
    addBuffer(buffer: Buffer, metadataPath: string, options?: { compress?: boolean }): void;
    end(finalSizeCallback?: (finalSize: number) => void): void;
    on(event: "error", listener: (err: Error) => void): this;
  }
}
