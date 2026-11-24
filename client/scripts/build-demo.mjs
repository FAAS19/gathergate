import { execFileSync } from "node:child_process";
import path from "node:path";

const clientDir = path.resolve(import.meta.dirname, "..");
const tscBin = path.resolve(clientDir, "node_modules/typescript/bin/tsc");
const viteBin = path.resolve(clientDir, "node_modules/vite/bin/vite.js");

const env = {
  ...process.env,
  VITE_DEMO: "1",
  VITE_BASE: "./",
  VITE_OUT_DIR: "../site/dist/demo",
};

execFileSync(process.execPath, [tscBin, "-b"], { cwd: clientDir, stdio: "inherit", env });
execFileSync(process.execPath, [viteBin, "build"], { cwd: clientDir, stdio: "inherit", env });
