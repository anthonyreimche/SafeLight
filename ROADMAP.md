# Roadmap

Because everything in Safelight is an extension, planned work falls into two tracks:

- **Core** features are critical to a photo workflow and ship built in, as pre-installed extensions you can disable.
- **Extensions** are advanced or process-heavy tools that ship as separate, optional packages — install them from another repo only if you need them, so the base app stays lean.

This is a direction, not a contract. Priorities shift with what the community builds and asks for. Want something moved up, or want to build it yourself? Open an issue or see [Contributing](docs/dev/contributing.md).

## Core (built-in)

**Develop**
- B&W and HDR editing support

**Library and organization**
- Virtual copies — multiple edit versions of one photo without duplicating the file
- Collections and smart collections — virtual groupings independent of folder structure
- Hierarchical keywording (flat keyword tagging already ships)
- IPTC/XMP metadata editing — copyright, caption, creator, rights fields (XMP sidecar read/write already ships via the XMP Tools extension)

**Export and output**
- Input color profile support — assign and convert ICC profiles on import (output-side ICC export already ships)

**Platform**
- Mobile-responsive viewing

## Planned as extensions

**Develop**
- Flat field and dark frame correction — subtract fixed-pattern sensor noise and lens illumination falloff
- Focus mask overlay — highlight in-focus areas in the develop canvas

**Library and organization**
- Photo stacking — collapse burst/similar shots into a single stack
- Duplicate photo detection — find visually similar or hash-identical photos
- Face detection and tagging
- Map module — GPS/geolocation-based photo browsing and tagging

**Export and output**
- Soft proofing — simulate paper or screen output using ICC profiles
- Web gallery / publish services — generate HTML galleries or push to Flickr, SmugMug, etc.

**AI features** (ONNX.js models, downloaded on demand)
- AI masking (Select Subject, Sky)
- AI sky replacement
- AI object removal / content-aware fill
- AI portrait enhancement — skin, eyes, and portrait retouching
- HDR / focus stacking and photo merge

**Platform and integration**
- Lightroom catalog import (sql.js)
- Tethered shooting — live capture from camera via USB/WiFi
