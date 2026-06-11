# Getting Started

SafeLight is a modular image editing software that combines professional imaging tools with the customizability and modularity of modern IDEs. Designed for photographers who want full control over their workflow, SafeLight lets you customize every aspect of your editing experience through extensions, themes, and dockable panels—all while keeping your data private and offline.

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

- **Modular Architecture**: SafeLight is built as an extensible platform where every panel, tool, and interface element can be customized or replaced through extensions
- **Modules**: SafeLight is organized into four main modules:
  - **Library**: Photo management, organization, and culling
  - **Develop**: Image editing with GPU-accelerated adjustments
  - **Loupe**: Detailed viewing with zoom and pan
  - **Export**: Batch export functionality

- **IDE-like Customization**: Dockable panels, persistent layouts, keyboard shortcuts, and theming let you tailor the interface to your workflow
- **Multi-Window Workflow**: Modules can be detached into separate windows for multi-monitor workflows
- **Extension System**: Install extensions from GitHub repos to add new features, replace existing panels, or customize the interface
- **Privacy-First**: All data stays local. No cloud sync, no telemetry, no data collection

## Navigation

- Use the module switcher in the sidebar to move between Library, Develop, Loupe, and Export
- Keyboard shortcuts are available for common operations (see User Guide for details)
- Photos can be selected by clicking, Shift+click for range selection, or Ctrl+click for multi-selection

## Customizing Your Workflow

SafeLight's modular architecture lets you customize your editing experience:

- **Install Extensions**: Use View → Extensions to install community-built extensions from GitHub repos
- **Customize Panels**: Dock, undock, and rearrange panels to create your ideal workspace
- **Apply Themes**: Change the visual appearance with custom themes
- **Create Extensions**: Build your own extensions to add new features or replace existing ones (see Extensions documentation)

## Next Steps

- Read the [User Guide](user-guide.md) for detailed feature documentation
- Explore the [Extensions](extensions.md) documentation to learn about building and installing extensions
- Check the [Architecture](architecture.md) documentation for technical details
- Review the [API Documentation](api-documentation.md) for extension development reference
