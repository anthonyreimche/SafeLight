// Tests for Lightroom (.xmp) preset parsing.
// Run with: node --experimental-strip-types src/lightroom-import.test.ts

import { parseLightroomXmp } from "./lightroom-import.ts";

let failures = 0;
function check(name: string, cond: boolean) {
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    console.log(`  ✗ ${name}`);
    failures++;
  }
}

// 1 — attribute form (how Lightroom usually writes presets)
function testAttributeForm() {
  console.log("Testing attribute-form crs: parsing...");
  const xml = `<?xml version="1.0"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
  <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
    <rdf:Description xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/"
      crs:Exposure2012="+1.50"
      crs:Contrast2012="+25"
      crs:Highlights2012="-40"
      crs:Saturation="-100"
      crs:Temperature="5500"
      crs:Sharpness="60">
      <crs:Name><rdf:Alt><rdf:li xml:lang="x-default">B&amp;W Punch</rdf:li></rdf:Alt></crs:Name>
    </rdf:Description>
  </rdf:RDF>
</x:xmpmeta>`;
  const r = parseLightroomXmp(xml);
  check("returns a result", r != null);
  if (!r) return;
  check("exposure 1.5", r.params.exposure === 1.5);
  check("contrast 25", r.params.contrast === 25);
  check("highlights -40", r.params.highlights === -40);
  check("saturation -100", r.params.saturation === -100);
  check("temperature 5500", r.params.temperature === 5500);
  check("sharpening 60", r.params.sharpening === 60);
  check("preset name from crs:Name", r.name === "B&W Punch");
  console.log("");
}

// 2 — element form + HSL + tone curve
function testElementFormHslCurve() {
  console.log("Testing element-form + HSL + tone curve...");
  const xml = `<?xml version="1.0"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
  <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
    <rdf:Description xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/">
      <crs:Exposure2012>-0.25</crs:Exposure2012>
      <crs:SaturationAdjustmentRed>-80</crs:SaturationAdjustmentRed>
      <crs:SaturationAdjustmentAqua>+30</crs:SaturationAdjustmentAqua>
      <crs:LuminanceAdjustmentBlue>-15</crs:LuminanceAdjustmentBlue>
      <crs:ToneCurvePV2012>
        <rdf:Seq>
          <rdf:li>0, 0</rdf:li>
          <rdf:li>128, 150</rdf:li>
          <rdf:li>255, 255</rdf:li>
        </rdf:Seq>
      </crs:ToneCurvePV2012>
    </rdf:Description>
  </rdf:RDF>
</x:xmpmeta>`;
  const r = parseLightroomXmp(xml);
  check("returns a result", r != null);
  if (!r) return;
  check("exposure -0.25 (element form)", r.params.exposure === -0.25);
  check("HSL red sat -80", r.params.hsl?.saturation.red === -80);
  check("HSL aqua sat +30", r.params.hsl?.saturation.aqua === 30);
  check("HSL blue luminance -15", r.params.hsl?.luminance.blue === -15);
  check("HSL untouched channel stays 0", r.params.hsl?.saturation.green === 0);
  const rgb = r.params.toneCurve?.rgb;
  check("tone curve has 3 points", rgb?.length === 3);
  check("curve x normalized to 0..1", rgb?.[1].x === 128 / 255);
  check("curve y normalized to 0..1", rgb?.[1].y === 150 / 255);
  check("untouched red channel is identity", r.params.toneCurve?.red.length === 2);
  console.log("");
}

// 3 — non-XMP / no crs content → null
function testNonXmp() {
  console.log("Testing non-preset input...");
  check("plain text → null", parseLightroomXmp("not xml at all") === null);
  check(
    "xmp without crs → null",
    parseLightroomXmp('<x:xmpmeta><rdf:Description xmlns:dc="..."/></x:xmpmeta>') === null,
  );
  console.log("");
}

console.log("=== Lightroom Import Tests ===\n");
testAttributeForm();
testElementFormHslCurve();
testNonXmp();

console.log("=========================");
if (failures === 0) {
  console.log("✓ All tests passed!");
} else {
  console.log(`✗ ${failures} checks failed`);
  process.exitCode = 1;
}
