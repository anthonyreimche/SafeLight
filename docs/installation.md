# Installation

SafeLight is a web-based application that runs locally in your browser. Follow these steps to set it up for development or production use.

## Prerequisites

- **Node.js**: Version 18 or higher
- **npm**: Comes with Node.js, or use yarn/pnpm as alternatives
- **Modern web browser**: Chrome, Firefox, Edge, or Safari with WebGL2 support

## Development Installation

1. **Clone the repository**:
   ```bash
   git clone https://github.com/yourusername/SafeLight.git
   cd SafeLight
   ```

2. **Install dependencies**:
   ```bash
   npm install
   ```

3. **Start the development server**:
   ```bash
   npm run dev
   ```

4. **Open in browser**: The development server will start at `http://localhost:5173` (or another port if 5173 is in use)

## Production Build

To create an optimized production build:

```bash
npm run build
```

This will:
- Compile TypeScript to JavaScript
- Bundle the application with Vite
- Generate optimized assets in the `dist/` directory

To preview the production build:

```bash
npm run preview
```

## Windows Quick Start

A `start.bat` script is provided for Windows users to quickly start the development server:

```batch
start.bat
```

## Browser Requirements

SafeLight requires WebGL2 support for GPU-accelerated image processing. Most modern browsers support this:

- **Chrome/Edge**: Version 56+
- **Firefox**: Version 51+
- **Safari**: Version 15+

## File System Access API

SafeLight uses the File System Access API for direct file access. This API is supported in:
- Chrome/Edge (desktop)
- Opera (desktop)

For browsers without File System Access API support, SafeLight falls back to traditional file input methods.

## Troubleshooting

### "WebGL2 not supported" error
Ensure your browser and graphics drivers support WebGL2. Try updating your graphics drivers or using a different browser.

### Port already in use
If port 5173 is in use, Vite will automatically try the next available port (5174, 5175, etc.).

### Permission errors
SafeLight requires file system permissions to access photos. Grant permissions when prompted by the browser.
