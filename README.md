# SafeLight

SafeLight is a modular image editing software that combines professional imaging tools with the customizability and modularity of modern IDEs to create a powerful, personalized editing workflow backed by an open-source community.

## Vision

SafeLight reimagines photo editing as an extensible platform where photographers can customize their workflow just like developers customize their IDEs. With a plugin architecture that lets you replace or supplement any panel, theme the interface, and add new tools, SafeLight adapts to your unique creative process.

## Core Features

- **Modular Architecture**: Every panel, tool, and interface element is an extension that can be customized or replaced
- **Professional Imaging Tools**: GPU-accelerated editing with tone curves, HSL adjustments, crop/transform, masking, and more
- **IDE-like Customization**: Dockable panels, persistent layouts, keyboard shortcuts, and theming
- **Privacy-First**: Zero cost, zero subscription, fully offline with no telemetry or data collection
- **Multi-Window Workflow**: First-class multi-monitor support with detachable modules
- **Open Extension System**: Install extensions from GitHub repos to add new features or replace existing ones
- **Open Source**: Community-driven development with transparent code

# Progress
## Image Library
<img width="1919" height="1027" alt="image" src="https://github.com/user-attachments/assets/ecdf475d-7273-4f77-87cb-1baca63bf765" />
<img width="1919" height="1027" alt="image" src="https://github.com/user-attachments/assets/f7caffb5-5708-45d2-b1c1-0c972d94d68b" />

- Photo library with grid and list view
- Collection support
- Rating (0–5), color code (6–9), and pick(P) / reject(X) / unflag (U) support
- Library sort tools
- Single file and folder import support
- Full and single channel Histogram viewer
- Metadata viewer

## Develop Environment
<img width="1919" height="1027" alt="image" src="https://github.com/user-attachments/assets/410708b2-44d5-4891-93b0-2fdaa95e4a30" />
<img width="1919" height="1027" alt="image" src="https://github.com/user-attachments/assets/f5f36602-1076-446c-9098-1f5d24f881ad" />

- Undo/Redo support
- Edit reset button
- Histogram control
- White balance sliders
- Full and single-channel RGB tone curve support
- Basic HSL/Color support 
- Basic preset support
- Hold shift or widen slider panel for fine adjustment, double-click to reset value
- Full traditional crop functionality with guides, level (CTRL+drag), and constrain to image option support
- Transform and warp image crop / geometry and perspective tools
- Image sharpen / denoise support
- Color grading wheels
- Lens correction profiles
- Vignette and grain effects
- Image masking and touchup removal / cloning support

## Loupe Viewer
<img width="1919" height="1027" alt="image" src="https://github.com/user-attachments/assets/668808bb-f7a4-4707-841a-1d9b0f582406" />
<img width="3829" height="1025" alt="image" src="https://github.com/user-attachments/assets/e9ee2f31-108b-4e36-b318-a559d42bcc85" />

- Snappy zoom and pan functionality
- Native detachable window support for multi-screen culling

## Export Settings
<img width="1919" height="1027" alt="image" src="https://github.com/user-attachments/assets/d54e132b-fa58-416b-b599-899329cf882e" />

- batch JPG, PNG, and WebP export
- Limited output resolution clamping

# Roadmap

## Planned Features
- Red eye correction
- Image compare support
- Color, BW, and HDR image support
- HDR / focus stacking and photo merge support
- Batch editing functionality
- AI masking via ONNX.js (Select Subject, Sky)
- Lightroom catalog import (sql.js)
- Mobile-responsive Loupe view

## Extension Ecosystem
- Extension marketplace and discovery
- Extension templates and scaffolding tools
- API documentation for extension developers
- Community-contributed extensions library

# Getting Started

See [docs/getting-started.md](docs/getting-started.md) for installation and first steps.

# Documentation

- [Getting Started](docs/getting-started.md) - Installation and quick start guide
- [User Guide](docs/user-guide.md) - Complete feature documentation
- [Extensions](docs/extensions.md) - Build and install extensions
- [Architecture](docs/architecture.md) - Technical architecture overview
- [API Documentation](docs/api-documentation.md) - Extension API reference
- [Contributing](docs/contributing.md) - Development guidelines

# Contributing

SafeLight is open source and community-driven. We welcome contributions in the form of:
- Bug reports and feature requests
- Code contributions
- Extension development
- Documentation improvements
- Community support

See [docs/contributing.md](docs/contributing.md) for guidelines.
