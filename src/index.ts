#!/usr/bin/env node

function checkNodeVersion(): void {
  const [major = 0, minor = 0] = process.versions.node
    .split(".")
    .map((part) => Number.parseInt(part, 10) || 0);
  if (major < 22 || (major === 22 && minor < 13)) {
    console.error(
      `[GatherGate] Node.js >= 22.13.0 is required (detected v${process.versions.node}; Node 24+ recommended).`
    );
    process.exit(1);
  }
}

checkNodeVersion();

const { runCli } = await import("./cli.js");
const exitCode = await runCli(process.argv.slice(2));
if (exitCode !== 0) {
  // Let Node's event loop drain undici/fetch handles cleanly before exiting.
  process.exitCode = exitCode;
}
