import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const datasets = JSON.parse(readFileSync(
  new URL("../validation/datasets.json", import.meta.url),
  "utf8",
));
const calibration = JSON.parse(readFileSync(
  new URL("../validation/calibration-results.json", import.meta.url),
  "utf8",
));

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const requiredScenarios = new Set([
  "portrait",
  "sky",
  "foliage",
  "mixed-light",
  "night",
  "high-contrast",
  "neutral",
]);
const coveredScenarios = new Set();
const ids = new Set();
for (const entry of datasets.entries) {
  assert(entry.id && !ids.has(entry.id), `Invalid or duplicate dataset id: ${entry.id}`);
  assert(entry.license, `Dataset ${entry.id} is missing a license`);
  assert(typeof entry.redistributable === "boolean", `Dataset ${entry.id} lacks redistribution status`);
  ids.add(entry.id);
  entry.scenarios?.forEach((scenario) => coveredScenarios.add(scenario));
}
for (const scenario of requiredScenarios) {
  assert(coveredScenarios.has(scenario), `Validation matrix is missing ${scenario}`);
}

for (const [id, brand] of Object.entries(calibration.brands)) {
  assert(Number.isInteger(brand.qualifiedGroups), `${id} group count must be an integer`);
  assert(brand.qualifiedGroups >= 0, `${id} group count cannot be negative`);
  const calibrated = brand.qualifiedGroups >= calibration.minimumQualifiedGroups;
  assert(
    calibrated === (brand.status === "calibrated"),
    `${id} calibration label does not match its qualified group count`,
  );
}

let tracked = [];
try {
  tracked = execFileSync("git", ["ls-files"], { encoding: "utf8" })
    .split(/\r?\n/)
    .filter(Boolean);
} catch {
  // The same manifest validation also works in source archives without Git.
}
const forbidden = tracked.filter((file) => (
  file.startsWith("qa-private/")
  || /\.(raf|3fr|fff|dng|nef|nrw|arw|cr2|cr3|rw2|orf|pef|srw|iiq)$/i.test(file)
));
assert(!forbidden.length, `Private or RAW files are tracked: ${forbidden.join(", ")}`);

console.log("Dataset and calibration policy verification passed", {
  licensedEntries: datasets.entries.length,
  scenarios: [...coveredScenarios],
  calibration: Object.fromEntries(
    Object.entries(calibration.brands).map(([id, brand]) => [
      id,
      `${brand.qualifiedGroups}/${calibration.minimumQualifiedGroups} ${brand.status}`,
    ]),
  ),
});
