// Tests for XMP sidecar functionality.
// Run with: node --experimental-strip-types src/xmp.test.ts

import { parseXmp, generateXmp, getXmpSidecarName, applyXmpToPhoto } from "./xmp.ts";
import type { CatalogPhoto, ColorLabel, FlagStatus } from "./safelight";

// Test getXmpSidecarName
function testSidecarNames() {
  console.log("Testing sidecar name generation...");
  const tests = [
    { input: "DSC_0012.NEF", expected: "DSC_0012.xmp" },
    { input: "DSC_0012.JPG", expected: "DSC_0012_jpg.xmp" },
    { input: "IMG_1234.cr2", expected: "IMG_1234.xmp" },
    { input: "photo.dng", expected: "photo.xmp" },
    { input: "IMG_1234.jpg", expected: "IMG_1234_jpg.xmp" },
    { input: "no_extension", expected: "no_extension.xmp" },
  ];

  let passed = 0;
  for (const t of tests) {
    const result = getXmpSidecarName(t.input);
    if (result === t.expected) {
      console.log(`  ✓ ${t.input} → ${result}`);
      passed++;
    } else {
      console.log(`  ✗ ${t.input} → ${result} (expected ${t.expected})`);
    }
  }
  console.log(`  ${passed}/${tests.length} passed\n`);
  return passed === tests.length;
}

// Test parseXmp
function testParseXmp() {
  console.log("Testing XMP parsing...");

  const xmpXml = `<?xml version="1.0" encoding="UTF-8"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
  <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
    <rdf:Description
      xmlns:xmp="http://ns.adobe.com/xap/1.0/"
      xmlns:dc="http://purl.org/dc/elements/1.1/"
      xmlns:photoshop="http://ns.adobe.com/photoshop/1.0/"
      rdf:about="">
      <xmp:Rating>4</xmp:Rating>
      <xmp:Label>Red</xmp:Label>
      <photoshop:Urgency>1</photoshop:Urgency>
      <dc:subject>
        <rdf:Bag>
          <rdf:li>landscape</rdf:li>
          <rdf:li>sunset</rdf:li>
        </rdf:Bag>
      </dc:subject>
    </rdf:Description>
  </rdf:RDF>
</x:xmpmeta>`;

  const result = parseXmp(xmpXml);
  let passed = true;

  if (result.rating === 4) {
    console.log("  ✓ Rating parsed correctly");
  } else {
    console.log(`  ✗ Rating: ${result.rating} (expected 4)`);
    passed = false;
  }

  if (result.label === "red") {
    console.log("  ✓ Label parsed correctly");
  } else {
    console.log(`  ✗ Label: ${result.label} (expected red)`);
    passed = false;
  }

  if (result.flag === "pick") {
    console.log("  ✓ Flag parsed correctly");
  } else {
    console.log(`  ✗ Flag: ${result.flag} (expected pick)`);
    passed = false;
  }

  if (result.keywords?.length === 2 && result.keywords[0] === "landscape") {
    console.log("  ✓ Keywords parsed correctly");
  } else {
    console.log(`  ✗ Keywords: ${JSON.stringify(result.keywords)}`);
    passed = false;
  }

  console.log(passed ? "  All parsing tests passed\n" : "  Some parsing tests failed\n");
  return passed;
}

// Test generateXmp
function testGenerateXmp() {
  console.log("Testing XMP generation...");

  const photo: CatalogPhoto = {
    id: "test-123",
    filename: "DSC_0012.NEF",
    directoryHandle: null,
    fileHandle: null,
    rating: 3,
    colorLabel: "blue" as ColorLabel,
    flag: "pick" as FlagStatus,
    keywords: ["portrait", "studio"],
  };

  const xmp = generateXmp(photo);
  let passed = true;

  if (xmp.includes("<xmp:Rating>3</xmp:Rating>")) {
    console.log("  ✓ Rating generated correctly");
  } else {
    console.log("  ✗ Rating not found in generated XMP");
    passed = false;
  }

  if (xmp.includes("<xmp:Label>Blue</xmp:Label>")) {
    console.log("  ✓ Label generated correctly");
  } else {
    console.log("  ✗ Label not found in generated XMP");
    passed = false;
  }

  if (xmp.includes("<photoshop:Urgency>1</photoshop:Urgency>")) {
    console.log("  ✓ Pick flag generated correctly");
  } else {
    console.log("  ✗ Pick flag not found in generated XMP");
    passed = false;
  }

  if (xmp.includes("<rdf:li>portrait</rdf:li>") && xmp.includes("<rdf:li>studio</rdf:li>")) {
    console.log("  ✓ Keywords generated correctly");
  } else {
    console.log("  ✗ Keywords not found in generated XMP");
    passed = false;
  }

  console.log(passed ? "  All generation tests passed\n" : "  Some generation tests failed\n");
  return passed;
}

// Test reject flag
function testRejectFlag() {
  console.log("Testing reject flag...");

  const xmpXml = `<?xml version="1.0" encoding="UTF-8"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
  <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
    <rdf:Description xmlns:photoshop="http://ns.adobe.com/photoshop/1.0/" rdf:about="">
      <photoshop:Urgency>8</photoshop:Urgency>
    </rdf:Description>
  </rdf:RDF>
</x:xmpmeta>`;

  const result = parseXmp(xmpXml);
  if (result.flag === "reject") {
    console.log("  ✓ Reject flag parsed correctly\n");
    return true;
  } else {
    console.log(`  ✗ Flag: ${result.flag} (expected reject)\n`);
    return false;
  }
}

// Test round-trip
function testRoundTrip() {
  console.log("Testing round-trip (parse → generate → parse)...");

  const photo: CatalogPhoto = {
    id: "test-456",
    filename: "IMG_5678.jpg",
    directoryHandle: null,
    fileHandle: null,
    rating: 5,
    colorLabel: "purple" as ColorLabel,
    flag: "none" as FlagStatus,
    keywords: ["nature", "macro", "flowers"],
  };

  // Generate XMP
  const xmp = generateXmp(photo);

  // Parse it back
  const parsed = parseXmp(xmp);

  // Apply to a new photo
  const basePhoto: CatalogPhoto = { ...photo, rating: 0, colorLabel: "none", flag: "none", keywords: [] };
  const updated = applyXmpToPhoto(basePhoto, parsed);

  let passed = true;

  if (updated.rating === 5) {
    console.log("  ✓ Rating round-tripped correctly");
  } else {
    console.log(`  ✗ Rating: ${updated.rating} (expected 5)`);
    passed = false;
  }

  if (updated.colorLabel === "purple") {
    console.log("  ✓ Label round-tripped correctly");
  } else {
    console.log(`  ✗ Label: ${updated.colorLabel} (expected purple)`);
    passed = false;
  }

  if (updated.keywords.length === 3 && updated.keywords.includes("nature")) {
    console.log("  ✓ Keywords round-tripped correctly");
  } else {
    console.log(`  ✗ Keywords: ${JSON.stringify(updated.keywords)}`);
    passed = false;
  }

  console.log(passed ? "  All round-trip tests passed\n" : "  Some round-trip tests failed\n");
  return passed;
}

// Run all tests
function runTests() {
  console.log("=== XMP Sidecar Tests ===\n");

  const results = [
    testSidecarNames(),
    testParseXmp(),
    testGenerateXmp(),
    testRejectFlag(),
    testRoundTrip(),
  ];

  const passed = results.filter((r) => r).length;
  const total = results.length;

  console.log("=========================");
  console.log(`Total: ${passed}/${total} test suites passed`);

  if (passed === total) {
    console.log("✓ All tests passed!");
  } else {
    console.log("✗ Some tests failed");
    process.exitCode = 1;
  }
  return passed === total;
}

runTests();
