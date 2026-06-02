# User Guide

This guide covers how to use SafeLight for photo management and editing.

## Library Module

The Library module is your photo management hub for importing, organizing, and culling photos.

### Importing Photos

- **Single File**: Click the import button and select individual photos
- **Folder Import**: Select a folder to import all supported images within it
- **File System Access**: SafeLight uses the File System Access API for direct access to your photos

### Viewing Photos

- **Grid View**: Default view showing photo thumbnails in a grid
- **List View**: Alternative view showing photos in a list with metadata
- **Sort Options**: Sort by date imported, date created, filename, or rating

### Organizing Photos

#### Ratings
Rate photos from 0-5 stars using the rating controls or keyboard shortcuts.

#### Color Labels
Apply color labels (red, yellow, green, blue, purple) to categorize photos.

#### Flags
- **Pick (P)**: Mark photos as keepers
- **Reject (X)**: Mark photos for deletion
- **Unflag (U)**: Remove flag status

#### Collections
- Create collections to group photos
- Add/remove photos from collections
- Smart collections with criteria (rating, color label, flag, keyword, camera, date)

### Culling Workflow

1. Import photos into the library
2. Use the Loupe viewer for detailed inspection
3. Apply pick/reject flags to cull photos
4. Use ratings to further categorize
5. Create collections for organized groups

### Metadata Panel

View EXIF metadata including:
- Camera make and model
- Lens information
- Focal length
- Aperture
- Shutter speed
- ISO
- Date/time original

## Develop Module

The Develop module provides GPU-accelerated image editing tools.

### Basic Adjustments

- **Exposure**: Adjust overall brightness
- **Contrast**: Adjust the difference between light and dark areas
- **Highlights**: Recover detail in bright areas
- **Shadows**: Recover detail in dark areas
- **Whites**: Set the white point
- **Blacks**: Set the black point
- **Texture**: Enhance or reduce fine details
- **Clarity**: Add local contrast
- **Dehaze**: Reduce atmospheric haze
- **Vibrance**: Boost saturation of muted colors
- **Saturation**: Adjust overall color intensity

### White Balance

- **Temperature**: Adjust color temperature (2000K-50000K, 6500K is neutral)
- **Tint**: Adjust green/magenta tint

### Tone Curve

- **RGB Curve**: Master curve applied to all channels
- **Red/Green/Blue Curves**: Individual channel adjustments
- Add points by clicking on the curve
- Drag points to adjust
- Double-click to reset a point

### HSL Adjustments

Adjust hue, saturation, and luminance for 8 color ranges:
- Red, Orange, Yellow, Green, Aqua, Blue, Purple, Magenta

### Crop and Transform

#### Crop
- Drag crop handles to adjust the crop area
- Hold Shift for fine adjustment
- Double-click a handle to reset
- Use crop guides (rule of thirds, golden ratio, etc.)
- Constrain to aspect ratio
- Constrain to image bounds

#### Transform
- **Straighten**: Rotate image (-45° to +45°)
- **Perspective**: Correct vertical and horizontal keystone
- **Aspect**: Adjust horizontal vs vertical stretch
- **Scale**: Zoom in/out
- **Offset**: Pan the image

### History

- **Undo**: Ctrl+Z to undo the last edit
- **Redo**: Ctrl+Y or Ctrl+Shift+Z to redo
- **Reset**: Reset all adjustments to default

### Presets

- Save current adjustments as a preset
- Apply presets to photos
- Presets include all edit parameters

## Loupe Module

The Loupe module provides detailed viewing for culling and inspection.

### Viewing

- **Zoom**: Scroll to zoom in/out
- **Pan**: Click and drag to pan
- **Fit to Screen**: Double-click to fit image to screen

### Multi-Monitor Support

- Detach the Loupe module to a separate window
- Use multiple monitors for efficient culling
- Synchronized selection across windows

## Export Module

The Export module handles batch export of edited photos.

### Export Settings

- **Format**: JPG, PNG, or WebP
- **Resolution**: Limit output resolution (optional)
- **Batch Export**: Export multiple selected photos at once

### Export Process

1. Select photos to export in the Library
2. Switch to Export module
3. Choose format and resolution settings
4. Click export and select destination folder

## Keyboard Shortcuts

### Library
- **Arrow Keys**: Navigate between photos
- **Space**: Quick preview in Loupe
- **P**: Flag as pick
- **X**: Flag as reject
- **U**: Unflag
- **0-5**: Set rating
- **Delete**: Remove selected photos

### Develop
- **Ctrl+Z**: Undo
- **Ctrl+Y**: Redo
- **Ctrl+R**: Reset adjustments
- **Shift**: Fine adjustment mode
- **Double-click slider**: Reset to default

### General
- **Ctrl+1-4**: Switch between modules (Library, Develop, Loupe, Export)
- **Ctrl+A**: Select all
- **Ctrl+D**: Deselect all
- **Escape**: Close dialogs or exit crop mode
