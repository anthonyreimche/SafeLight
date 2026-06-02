# Getting Started

SafeLight is a privacy-first, GPU-accelerated, open-source photo editing application designed for photographers who want full control over their images without cloud dependencies or data collection.

## Quick Start

1. **Install dependencies**: Run `npm install` to install all required packages
2. **Start development server**: Run `npm run dev` to launch the application
3. **Open in browser**: Navigate to the local development server URL (typically `http://localhost:5173`)

## First Steps

1. **Import Photos**: Use the Library module to import photos from your computer. SafeLight supports single file and folder imports.
2. **Organize**: Use collections, ratings (0-5), color labels, and pick/reject flags to organize your photo library.
3. **Edit**: Switch to the Develop module to adjust exposure, contrast, tone curves, HSL, and crop/transform your images.
4. **Export**: Use the Export module to batch export your edited photos in JPG, PNG, or WebP formats.

## Key Concepts

- **Modules**: SafeLight is organized into four main modules:
  - **Library**: Photo management, organization, and culling
  - **Develop**: Image editing with GPU-accelerated adjustments
  - **Loupe**: Detailed viewing with zoom and pan
  - **Export**: Batch export functionality

- **Multi-Window Workflow**: Modules can be detached into separate windows for multi-monitor workflows

- **Privacy-First**: All data stays local. No cloud sync, no telemetry, no data collection

## Navigation

- Use the module switcher in the sidebar to move between Library, Develop, Loupe, and Export
- Keyboard shortcuts are available for common operations (see User Guide for details)
- Photos can be selected by clicking, Shift+click for range selection, or Ctrl+click for multi-selection
