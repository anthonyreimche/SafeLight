As more and more photo editors turn to AI, I find it hard to find a good replacement that doesn't expose your photos to train its AI. This is why I have begun this pet project — to create an alternative editing software that is easy to pick up and does not expose your art.
There are many other alternatives, but they are tailored for very different workflows to mine and I am sure many others will agree.

#Safelight is privacy-first, GPU-accelerated, open-source photo editing for every photographer.
If you'd like to help make this software possible, feel free to help!

- Zero cost, zero subscription
- Fully offline, no cloud dependency
- No telemetry or data collection of any kind
 - First-class multi-window/multi-monitor workflow
- Open preset and plugin format
- [In development] Lightroom catalog import
- Open source

#What I’ve done
- Native GPU rendering
##Image Library
- Photo library with grid and list view
- Collection support
- Rating (0–5), color code (6–9), and pick(P) / reject(X) / unflag (U) support
- Library sort tools
- Single file and folder import support
##Develop Environment
- Undo/Redo support
- Edit reset button
- Metadata viewer
- Basic white balance, exposure, clarity, vibrance, tone curve support
- Basic HSL/Color support 
- Basic preset support
- Hold shift or widen slider panel for fine adjustment, double-click to reset value
- Limited crop functionality
##Loupe Viewer
- Snappy zoom and pan functionality
- Native detachable window support for dual screen culling
##Export Settings
- batch JPG, PNG, and WebP export
- Limited output resolution clamping

#To Do
- Make detachable windows re-attachable
- Histogram viewer and control
- Full traditional crop functionality with guides, level (CTRL+drag), and constrain to image option support
- Transform and warp image crop / geometry and perspective tools
- RGB single channel tone curve support
- Color grading wheels
- Image sharpen / denoise support (WASM-based)
- Lens correction profiles
- Vignette and grain effects
- Color, BW, and HDR support
- Image masking and touchup removal / cloning support
- Red eye correction
- Image compare / “open in new unsynced loupe tab” support
- HDR / focus stacking and photo merge support
- Batch editing functionality
- AI masking via ONNX.js (Select Subject, Sky)
- Electron wrapper for deeper OS file access
- Mobile-responsive Loupe view
- Open preset and plugin standard
- Lightroom catalog import (sql.js)
