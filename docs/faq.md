# FAQ

Frequently asked questions about SafeLight.

## General

### What is SafeLight?

SafeLight is a privacy-first, GPU-accelerated, open-source photo editing application. It runs entirely in your browser with no cloud dependencies, no telemetry, and no data collection.

### Is SafeLight free?

Yes, SafeLight is completely free and open source. There are no subscriptions or hidden costs.

### Does SafeLight work offline?

Yes, SafeLight is designed to work fully offline. Once loaded, it doesn't require an internet connection for any functionality.

### What browsers are supported?

SafeLight requires a modern browser with WebGL2 support:
- Chrome/Edge 56+
- Firefox 51+
- Safari 15+

### Does SafeLight collect my data?

No. SafeLight is privacy-first by design. All your photos and edits stay on your computer. No data is sent to any server.

## Features

### Can I import Lightroom catalogs?

Lightroom catalog import is planned for a future release using sql.js.

### Does SafeLight support RAW files?

Yes, Safelight supports 8-bit RAW files. 16-bit RAW file support is planned for a future release.

### Can I use presets?

Yes, SafeLight supports saving and applying presets. An open preset and plugin standard is also planned.

### Does SafeLight support batch editing?

Batch editing functionality is planned for a future release.

### Can I use AI features?

AI masking via ONNX.js (Select Subject, Sky) is planned for a future release.

## Technical

### Why does SafeLight need file system permissions?

SafeLight uses the File System Access API to directly access your photos for editing. This allows for better performance and the ability to save edits back to original files (in future versions).

### What happens if I don't grant file permissions?

SafeLight will fall back to traditional file input methods, but you may need to re-import photos after each browser session.

### How are edits stored?

Edits are stored in IndexedDB in your browser. They are associated with the original photos via their file handles.

### Will my edits persist after closing the browser?

Yes, edits are stored persistently in IndexedDB. However, you may need to re-grant file system permissions when you reopen the browser.

### Can I use SafeLight on mobile?

A mobile-responsive Loupe view is planned. Currently, SafeLight is optimized for desktop use.

### How does multi-window support work?

SafeLight uses the BroadcastChannel API to synchronize state across detached windows. This allows you to have different modules open in separate windows on multiple monitors.

## Troubleshooting

### WebGL2 not supported error

This error means your browser or graphics driver doesn't support WebGL2. Try:
- Updating your graphics drivers
- Using a different browser (Chrome/Edge recommended)
- Checking if hardware acceleration is enabled in your browser

### Photos not loading after browser restart

This is likely due to file system permissions expiring. Click the "Reconnect" button in the UI to re-grant permissions to your photo folders.

### Performance is slow

SafeLight uses GPU acceleration, but performance depends on your graphics hardware. Try:
- Closing other browser tabs
- Ensuring hardware acceleration is enabled
- Reducing the number of photos in your catalog

### Export fails

Ensure you have write permissions to the destination folder. Some browsers may restrict file system access in certain contexts.

## Privacy and Security

### Are my photos uploaded anywhere?

No. All photo processing happens locally in your browser using WebGL2. No images are sent to any server.

### Can SafeLight access my other files?

SafeLight can only access files you explicitly grant permission to via the File System Access API. It cannot access your entire file system.

### Is my edit history private?

Yes, all edit history is stored locally in your browser's IndexedDB.

## Future Development

### What features are coming soon?

Based on the project roadmap, planned features include:
- Color grading wheels
- Image sharpen/denoise (WASM-based)
- Lens correction profiles
- Vignette and grain effects
- Color, BW, and HDR support
- Image masking and touchup tools
- Red eye correction
- Image compare functionality
- HDR/focus stacking
- Batch editing
- AI masking
- Electron wrapper for desktop app
- Mobile support
- Open preset/plugin standard
- Lightroom catalog import

### How can I request a feature?

Open an issue on GitHub with your feature request. Contributions are also welcome!
