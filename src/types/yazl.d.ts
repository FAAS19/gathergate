declare module "yazl" {
  import type { Readable } from "node:stream";
  export class ZipFile {
    outputStream: Readable;
    addReadStream(input: Readable, metadataPath: string, options?: { compress?: boolean; forceZip64Format?: boolean }): void;
    addBuffer(buffer: Buffer, metadataPath: string, options?: { compress?: boolean }): void;
    end(finalSizeCallback?: (finalSize: number) => void): void;
  }
}
