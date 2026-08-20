import assert from "node:assert/strict";
import { xmpPreset } from "../src/xmpPreset.js";

const preset = xmpPreset({
  temperature: -5,
  tint: 7,
  exposure: 0.35,
  curves: {
    master: [{ x: 0, y: 4 }, { x: 255, y: 250 }],
  },
}, 'Color & "Light"');

assert.match(preset, /crs:WhiteBalance="As Shot"/);
assert.match(preset, /crs:IncrementalTemperature="-5"/);
assert.match(preset, /crs:IncrementalTint="7"/);
assert.doesNotMatch(preset, /\scrs:Temperature=/);
assert.doesNotMatch(preset, /\scrs:Tint=/);
assert.match(preset, /crs:Name="Color &amp; &quot;Light&quot;"/);
assert.match(preset, /<rdf:li>0, 4<\/rdf:li>/);
assert.match(preset, /<crs:ToneCurvePV2012Blue><rdf:Seq><rdf:li>0, 0<\/rdf:li><rdf:li>255, 255<\/rdf:li>/);

const clamped = xmpPreset({ temperature: -4000, tint: 4000 }, "clamped");
assert.match(clamped, /crs:IncrementalTemperature="-100"/);
assert.match(clamped, /crs:IncrementalTint="100"/);

console.log("XMP preset verification passed.");
