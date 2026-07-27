import { spawnSync } from "node:child_process";

const scripts = [
  "verify:auth",
  "verify:semantic",
  "verify:lighting",
  "verify:highlight",
  "verify:color-management",
  "verify:lut",
  "verify:texture",
  "verify:color",
  "verify:basic",
  "verify:curve",
  "verify:quality",
  "verify:datasets",
  "verify:regression",
  "verify:performance",
  "build",
  "verify:bundle",
  "verify:browser",
];
const windows = process.platform === "win32";
const command = windows ? process.env.ComSpec || "cmd.exe" : "npm";

for (const script of scripts) {
  console.log(`\n[quality-gate] ${script}`);
  const args = windows
    ? ["/d", "/s", "/c", "npm.cmd", "run", script]
    : ["run", script];
  const result = spawnSync(command, args, {
    cwd: new URL("..", import.meta.url),
    stdio: "inherit",
  });
  if (result.status !== 0) process.exit(result.status || 1);
}

console.log("\nColor Engine 4 quality gate passed.");
