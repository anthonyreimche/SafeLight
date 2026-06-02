# Contributing

Thank you for your interest in contributing to SafeLight! This document provides guidelines for contributing to the project.

## Development Setup

1. Fork the repository
2. Clone your fork: `git clone https://github.com/yourusername/SafeLight.git`
3. Navigate to the project directory: `cd SafeLight`
4. Install dependencies: `npm install`
5. Start the development server: `npm run dev`

## Code Style

- Use TypeScript for all new code
- Follow existing code conventions and patterns
- Use meaningful variable and function names
- Add comments for complex logic
- Keep functions focused and small

## Project Structure

- `src/catalog/` - Photo catalog and metadata handling
- `src/modules/` - Feature modules (library, develop, loupe, export)
- `src/state/` - Zustand state stores
- `src/rendering/` - WebGL rendering pipeline
- `src/ui/` - Shared UI components
- `src/hooks/` - Custom React hooks

## Adding Features

When adding new features:

1. Create a new branch: `git checkout -b feature/your-feature-name`
2. Implement the feature following existing patterns
3. Add appropriate TypeScript types
4. Test thoroughly
5. Update documentation if needed
6. Submit a pull request

## Bug Fixes

When fixing bugs:

1. Create a new branch: `git checkout -b fix/bug-description`
2. Identify the root cause
3. Implement the fix
4. Test the fix
5. Submit a pull request with a description of the bug and fix

## Testing

- Test your changes in multiple browsers (Chrome, Firefox, Edge, Safari)
- Test with different image formats and sizes
- Test keyboard shortcuts
- Test multi-window functionality if relevant

## Commit Messages

Use clear, descriptive commit messages:
- `feat: add new feature description`
- `fix: fix bug description`
- `docs: update documentation`
- `refactor: refactor code for clarity`

## Pull Requests

1. Describe what your PR does
2. Reference any related issues
3. Include screenshots for UI changes
4. Ensure all tests pass
5. Request review from maintainers

## Areas for Contribution

Based on the project roadmap, here are areas where help is needed:

- Color grading wheels
- Image sharpen/denoise support (WASM-based)
- Lens correction profiles
- Vignette and grain effects
- Color, BW, and HDR support
- Image masking and touchup removal/cloning
- Red eye correction
- Image compare functionality
- HDR/focus stacking and photo merge
- Batch editing functionality
- AI masking via ONNX.js (Select Subject, Sky)
- Electron wrapper for deeper OS file access
- Mobile-responsive Loupe view
- Open preset and plugin standard
- Lightroom catalog import (sql.js)

## Questions

Feel free to open an issue for questions or discussion about potential contributions.
