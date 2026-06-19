// XMP sidecar file support for interoperability with other photo tools.
// Implements reading and writing of XMP metadata to .xmp files alongside
// original images (DSC_0012.NEF → DSC_0012.xmp, DSC_0012.JPG → DSC_0012_jpg.xmp).
//
// Moved verbatim out of the app core (was src/catalog/xmp.ts) so XMP support is
// an optional, installable extension. Only the type-import path changed.

import type {
  CatalogPhoto,
  ColorLabel,
  FlagStatus,
  DevelopParams,
  EditState,
} from "./safelight";

// ── Sidecar filename generation ─────────────────────────────────────────────

/** Generate XMP sidecar filename following Adobe/Lightroom conventions.
 *  - DSC_0012.NEF → DSC_0012.xmp
 *  - DSC_0012.JPG → DSC_0012_jpg.xmp (for RAW+JPEG pairs)
 */
export function getXmpSidecarName(imageFilename: string): string {
  const dot = imageFilename.lastIndexOf(".");
  if (dot === -1) return `${imageFilename}.xmp`;
  const base = imageFilename.slice(0, dot);
  const ext = imageFilename.slice(dot + 1).toLowerCase();
  // For non-RAW extensions, append _ext to distinguish from RAW sidecar
  const isRaw = /^(nef|cr2|cr3|crw|dng|arw|orf|raf|rw2|pef|srw|3fr|dcr|erf|kdc|mos|raw|nrw)$/i.test(ext);
  if (isRaw) {
    return `${base}.xmp`;
  }
  return `${base}_${ext}.xmp`;
}

// ── XMP namespaces ──────────────────────────────────────────────────────────

const NAMESPACES = {
  rdf: "http://www.w3.org/1999/02/22-rdf-syntax-ns#",
  xmp: "http://ns.adobe.com/xap/1.0/",
  dc: "http://purl.org/dc/elements/1.1/",
  photoshop: "http://ns.adobe.com/photoshop/1.0/",
  lr: "http://ns.adobe.com/lightroom/1.0/",
  safelight: "http://ns.safelight.app/1.0/",
} as const;

// ── XMP Data Interface ───────────────────────────────────────────────────────

export interface XmpMetadata {
  rating?: number;        // xmp:Rating (0-5)
  label?: ColorLabel;     // xmp:Label (Red/Yellow/Green/Blue/Purple)
  flag?: FlagStatus;      // photoshop:Urgency or custom pick/reject
  keywords?: string[];    // dc:subject
  hierarchicalKeywords?: string[]; // lr:hierarchicalSubject
  editParams?: DevelopParams; // safelight: namespace for full round-tripping
}

// ── XMP Parsing ─────────────────────────────────────────────────────────────

/** Parse XMP XML and extract metadata fields. */
export function parseXmp(xmpXml: string): XmpMetadata {
  const result: XmpMetadata = {};

  // Parse rating: <xmp:Rating>3</xmp:Rating>
  const ratingMatch = xmpXml.match(/<xmp:Rating>(\d)<\/xmp:Rating>/);
  if (ratingMatch) {
    const rating = parseInt(ratingMatch[1], 10);
    if (rating >= 0 && rating <= 5) result.rating = rating;
  }

  // Parse label: <xmp:Label>Red</xmp:Label>
  const labelMatch = xmpXml.match(/<xmp:Label>([^<]+)<\/xmp:Label>/);
  if (labelMatch) {
    const label = labelMatch[1].toLowerCase() as ColorLabel;
    if (["none", "red", "yellow", "green", "blue", "purple"].includes(label)) {
      result.label = label;
    }
  }

  // Parse flag from photoshop:Urgency (1=high/pick, 8=low/reject) or custom fields
  const urgencyMatch = xmpXml.match(/<photoshop:Urgency>(\d)<\/photoshop:Urgency>/);
  if (urgencyMatch) {
    const urgency = parseInt(urgencyMatch[1], 10);
    if (urgency === 1) result.flag = "pick";
    else if (urgency === 8) result.flag = "reject";
  }
  // Also check for custom pick/reject fields
  const pickMatch = xmpXml.match(/<xmp:PickFlag>(true|1)<\/xmp:PickFlag>/i);
  const rejectMatch = xmpXml.match(/<xmp:RejectFlag>(true|1)<\/xmp:RejectFlag>/i);
  if (rejectMatch) result.flag = "reject";
  else if (pickMatch) result.flag = "pick";

  // Parse keywords from dc:subject bag
  const subjectMatch = xmpXml.match(/<dc:subject>\s*<rdf:Bag>([\s\S]*?)<\/rdf:Bag>\s*<\/dc:subject>/);
  if (subjectMatch) {
    const bagContent = subjectMatch[1];
    const keywords: string[] = [];
    const liRegex = /<rdf:li>([^<]+)<\/rdf:li>/g;
    let liMatch;
    while ((liMatch = liRegex.exec(bagContent)) !== null) {
      keywords.push(liMatch[1]);
    }
    if (keywords.length > 0) result.keywords = keywords;
  }

  // Parse hierarchical keywords from lr:hierarchicalSubject
  const hierMatch = xmpXml.match(/<lr:hierarchicalSubject>\s*<rdf:Bag>([\s\S]*?)<\/rdf:Bag>\s*<\/lr:hierarchicalSubject>/);
  if (hierMatch) {
    const bagContent = hierMatch[1];
    const keywords: string[] = [];
    const liRegex = /<rdf:li>([^<]+)<\/rdf:li>/g;
    let liMatch;
    while ((liMatch = liRegex.exec(bagContent)) !== null) {
      keywords.push(liMatch[1]);
    }
    if (keywords.length > 0) result.hierarchicalKeywords = keywords;
  }

  return result;
}

// ── XMP Generation ─────────────────────────────────────────────────────────

/** Generate XMP XML from Safelight metadata and optional edit params. */
export function generateXmp(
  photo: CatalogPhoto,
  editState?: EditState,
  options?: { includePrivateNamespace?: boolean }
): string {
  const lines: string[] = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<x:xmpmeta xmlns:x="adobe:ns:meta/">',
    '  <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">',
    '    <rdf:Description',
  ];

  // Add namespace declarations
  lines.push(`      xmlns:xmp="${NAMESPACES.xmp}"`);
  lines.push(`      xmlns:dc="${NAMESPACES.dc}"`);
  lines.push(`      xmlns:photoshop="${NAMESPACES.photoshop}"`);
  lines.push(`      xmlns:lr="${NAMESPACES.lr}"`);
  if (options?.includePrivateNamespace) {
    lines.push(`      xmlns:safelight="${NAMESPACES.safelight}"`);
  }
  lines.push('      rdf:about="">');

  // Rating
  if (photo.rating > 0) {
    lines.push(`      <xmp:Rating>${photo.rating}</xmp:Rating>`);
  }

  // Label (convert "none" to empty, others to Title Case)
  if (photo.colorLabel && photo.colorLabel !== "none") {
    const labelTitle = photo.colorLabel.charAt(0).toUpperCase() + photo.colorLabel.slice(1);
    lines.push(`      <xmp:Label>${escapeXml(labelTitle)}</xmp:Label>`);
  }

  // Flag - use photoshop:Urgency (1=pick/high, 8=reject/low)
  if (photo.flag === "pick") {
    lines.push('      <photoshop:Urgency>1</photoshop:Urgency>');
  } else if (photo.flag === "reject") {
    lines.push('      <photoshop:Urgency>8</photoshop:Urgency>');
  }

  // Keywords
  if (photo.keywords.length > 0) {
    lines.push('      <dc:subject>');
    lines.push('        <rdf:Bag>');
    for (const kw of photo.keywords) {
      lines.push(`          <rdf:li>${escapeXml(kw)}</rdf:li>`);
    }
    lines.push('        </rdf:Bag>');
    lines.push('      </dc:subject>');
  }

  // Hierarchical keywords (flatten hierarchy for now)
  if (photo.keywords.length > 0) {
    lines.push('      <lr:hierarchicalSubject>');
    lines.push('        <rdf:Bag>');
    for (const kw of photo.keywords) {
      lines.push(`          <rdf:li>${escapeXml(kw)}</rdf:li>`);
    }
    lines.push('        </rdf:Bag>');
    lines.push('      </lr:hierarchicalSubject>');
  }

  // Private Safelight namespace for edit params (round-tripping)
  if (options?.includePrivateNamespace && editState) {
    const currentEdit = editState.stack[editState.currentIndex];
    if (currentEdit) {
      // Serialize develop params as JSON in the XMP
      const paramsJson = JSON.stringify(currentEdit.params);
      lines.push(`      <safelight:DevelopParams>${escapeXml(paramsJson)}</safelight:DevelopParams>`);
      lines.push(`      <safelight:EditHistory>${escapeXml(JSON.stringify(editState.stack.map(s => ({ timestamp: s.timestamp, label: s.label }))))}</safelight:EditHistory>`);
    }
  }

  lines.push('    </rdf:Description>');
  lines.push('  </rdf:RDF>');
  lines.push('</x:xmpmeta>');

  return lines.join('\n');
}

/** Escape special XML characters. */
function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// ── File I/O Helpers ────────────────────────────────────────────────────────

/** Read XMP sidecar file for a given image file. Returns null if not found. */
export async function readXmpSidecar(
  parentDir: FileSystemDirectoryHandle,
  imageFilename: string
): Promise<XmpMetadata | null> {
  const xmpName = getXmpSidecarName(imageFilename);
  try {
    const handle = await parentDir.getFileHandle(xmpName);
    const file = await handle.getFile();
    const xml = await file.text();
    return parseXmp(xml);
  } catch {
    return null;
  }
}

/** Write XMP sidecar file next to the original image. */
export async function writeXmpSidecar(
  parentDir: FileSystemDirectoryHandle,
  imageFilename: string,
  photo: CatalogPhoto,
  editState?: EditState,
  options?: { includePrivateNamespace?: boolean }
): Promise<void> {
  const xmpName = getXmpSidecarName(imageFilename);
  const xmpXml = generateXmp(photo, editState, options);

  const handle = await parentDir.getFileHandle(xmpName, { create: true });
  const writable = await handle.createWritable();
  await writable.write(xmpXml);
  await writable.close();
}

/** Delete XMP sidecar file (used when removing photos). */
export async function deleteXmpSidecar(
  parentDir: FileSystemDirectoryHandle,
  imageFilename: string
): Promise<void> {
  const xmpName = getXmpSidecarName(imageFilename);
  try {
    await parentDir.removeEntry(xmpName);
  } catch {
    // Ignore errors (file may not exist)
  }
}

// ── Import Helpers ───────────────────────────────────────────────────────────

/** Build the CatalogPhoto field overrides for an imported XMP (only fields
 *  actually present in the sidecar), to be merged onto the photo record. */
export function xmpToPhotoOverrides(xmp: XmpMetadata): Partial<CatalogPhoto> {
  const updated: Partial<CatalogPhoto> = {};
  if (xmp.rating !== undefined) updated.rating = xmp.rating;
  if (xmp.label !== undefined) updated.colorLabel = xmp.label;
  if (xmp.flag !== undefined) updated.flag = xmp.flag;
  if (xmp.keywords !== undefined && xmp.keywords.length > 0) updated.keywords = xmp.keywords;
  return updated;
}

/** Apply XMP metadata to a CatalogPhoto (non-destructive: only sets if present). */
export function applyXmpToPhoto(photo: CatalogPhoto, xmp: XmpMetadata): CatalogPhoto {
  return { ...photo, ...xmpToPhotoOverrides(xmp) };
}
