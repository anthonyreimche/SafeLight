# User Guide

This guide covers how to use SafeLight for photo management and editing. SafeLight's modular architecture lets you customize your workflow through extensions, dockable panels, and themes—just like customizing an IDE.

## Library Module
<img width="2275" height="1454" alt="image" src="https://github.com/user-attachments/assets/c9a7f9fc-b6c3-4bd9-a028-f798a891215d" />

The Library module is your photo management hub for importing, organizing, and culling photos.

### Importing Photos
<img width="283" height="66" alt="image" src="https://github.com/user-attachments/assets/fa475c4b-bb9b-4290-abcb-d0f81b9c7358" />

- **Single File**: Click the import button and select individual photos
- **Folder Import**: Select a folder to import all supported images within it
- **File System Access**: SafeLight uses the File System Access API for direct access to your photos

### Viewing Photos
<img width="567" height="268" alt="image" src="https://github.com/user-attachments/assets/db8a567a-6694-4bd5-a252-1086f277a9ed" />

- **Grid View**: Default view showing photo thumbnails in a grid
- **List View**: Alternative view showing photos in a list with metadata
- **Sort Options**: Sort by date imported, date created, filename, or rating

### Organizing Photos

#### Ratings
<img width="330" height="327" alt="image" src="https://github.com/user-attachments/assets/0529096a-ab58-4247-9d41-ef25d48e3505" />

Rate photos from 0-5 stars using the rating controls or keyboard shortcuts.

#### Color Labels
<img width="341" height="335" alt="image" src="https://github.com/user-attachments/assets/759e8b5e-2ff9-4b6c-aa85-f1502074e1d7" />

Apply color labels (6: red, 7: yellow, 8: green, 9: blue) to categorize photos.

#### Flags
<img width="999" height="342" alt="image" src="https://github.com/user-attachments/assets/394f1cab-eb15-4e5b-b0e7-513ac947be88" />

- **Pick (P)**: Mark photos as keepers
- **Reject (X)**: Mark photos for deletion
- **Unflag (U)**: Remove flag status

#### Collections
<img width="387" height="287" alt="image" src="https://github.com/user-attachments/assets/10b92e92-ea7e-41f3-bd49-935b940d6482" />

- Create collections to group photos
- Add/remove photos from collections
<img width="386" height="491" alt="image" src="https://github.com/user-attachments/assets/73809993-4a2f-4efc-8eb6-b21a5e9bd164" />

- Filter images with criteria (rating, color label, flag, keyword, camera, date)

### Culling Workflow

1. Import photos into the library
2. Use the Loupe viewer for detailed inspection
3. Apply pick/reject flags to cull photos
4. Use ratings to further categorize
5. Create collections for organized groups

### Metadata Panel
<img width="547" height="391" alt="image" src="https://github.com/user-attachments/assets/c1b6d6a5-1917-4707-9c66-afe8e2f65b81" />

View EXIF metadata including:
- Camera make and model
- Lens information
- Focal length
- Aperture
- Shutter speed
- ISO
- Date/time original

## Develop Module
<img width="2275" height="1454" alt="image" src="https://github.com/user-attachments/assets/9fba0647-de33-4e50-bd65-b7e3a52b712c" />

The Develop module provides GPU-accelerated image editing tools.

### Basic Adjustments
<img width="524" height="508" alt="image" src="https://github.com/user-attachments/assets/173a7a27-60e2-4c37-b8b4-0adf9cbe4979" />

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

- Hold Shift for fine adjustment
- Double-click a handle to reset

### White Balance
<img width="521" height="143" alt="image" src="https://github.com/user-attachments/assets/466359df-cfc9-4a30-82a4-2d95d8332ce7" />

- **Temperature**: Adjust color temperature (2000K-50000K, 6500K is neutral)
- **Tint**: Adjust green/magenta tint

### Tone Curve
<img width="527" height="671" alt="image" src="https://github.com/user-attachments/assets/641c688f-0c77-4515-bd43-0991f4ef4ccb" />
<img width="521" height="668" alt="image" src="https://github.com/user-attachments/assets/ebec53de-7225-4d37-8aa5-44a4ec232f23" />
<img width="525" height="668" alt="image" src="https://github.com/user-attachments/assets/510ee1df-3ea0-4282-b7b5-dcd4aae9a3d4" />
<img width="522" height="661" alt="image" src="https://github.com/user-attachments/assets/4b312721-eb63-4c19-9143-188e65e33642" />

- **RGB Curve**: Master curve applied to all channels
- **Red/Green/Blue Curves**: Individual channel adjustments
- Add points by clicking on the curve
- Drag points to adjust
- Double-click to reset a point

### HSL Adjustments
<img width="537" height="439" alt="image" src="https://github.com/user-attachments/assets/cabe2024-9294-498d-891d-3a380d82fbe8" />
<img width="537" height="438" alt="image" src="https://github.com/user-attachments/assets/65de52c9-38e3-4b27-b825-21b1d8d18913" />
<img width="547" height="439" alt="image" src="https://github.com/user-attachments/assets/38cfcb96-0cb4-4c4e-8eb7-5a4556417592" />

Adjust hue, saturation, and luminance for 8 color ranges:
- Red, Orange, Yellow, Green, Aqua, Blue, Purple, Magenta

### Crop and Transform
<img width="2275" height="1454" alt="image" src="https://github.com/user-attachments/assets/ce47f89b-4533-446a-bdda-029518978d44" />

#### Crop
<img width="522" height="524" alt="image" src="https://github.com/user-attachments/assets/024ff0e1-ad65-46fb-9c33-08c6d797d81e" />
<img width="516" height="577" alt="image" src="https://github.com/user-attachments/assets/f3d4a864-f660-4c71-a144-657da3a8b87f" />

- Drag crop handles to adjust the crop area
- Use crop guides (rule of thirds, golden ratio, etc.)
- Constrain to aspect ratio option
- Constrain to image bounds option

#### Transform
<img width="522" height="361" alt="image" src="https://github.com/user-attachments/assets/d4c99bd7-cfd8-4e78-b784-3d1dfc2b2e5a" />

- **Straighten**: Rotate image (-45° to +45°)
- **Perspective**: Correct vertical and horizontal keystone
- **Aspect**: Adjust horizontal vs vertical stretch
- **Scale**: Zoom in/out
- **Offset**: Pan the image

### History
<img width="507" height="46" alt="image" src="https://github.com/user-attachments/assets/a856ed94-4419-4879-bebb-5207bfed8d09" />

- **Undo**: Ctrl+Z to undo the last edit
- **Redo**: Ctrl+Y or Ctrl+Shift+Z to redo
- **Reset**: Reset all adjustments to default

### Presets
<img width="532" height="299" alt="image" src="https://github.com/user-attachments/assets/7a363d5d-bb22-48a8-a78f-716d3b6c4e90" />

- Save current adjustments as a preset
- Apply presets to photos
- Presets include all edit parameters

## Loupe Module
<img width="2275" height="1454" alt="image" src="https://github.com/user-attachments/assets/204fac2b-eb2e-43fe-937f-1a92b77881d4" />

The Loupe module provides detailed viewing for culling and inspection.

### Viewing
<img width="2449" height="1454" alt="image" src="https://github.com/user-attachments/assets/c8fdc6c2-a9fd-4c20-bf5b-0791deb0ba99" />

- **Zoom**: Scroll to zoom in/out
- **Pan**: Click and drag to pan
- **Fit to Screen**: Double-click to fit image to screen

### Multi-Monitor Support
<img width="3829" height="1025" alt="image" src="https://github.com/user-attachments/assets/e9ee2f31-108b-4e36-b318-a559d42bcc85" />

- Detach the Loupe module to a separate window
- Use multiple monitors for efficient culling
- Synchronized selection across windows

## Export Module

The Export module handles batch export of edited photos.

### Export Settings
<img width="1919" height="1027" alt="image" src="https://github.com/user-attachments/assets/d54e132b-fa58-416b-b599-899329cf882e" />

- **Format**: JPG, PNG, or WebP
- **Resolution**: Limit output resolution (optional)
- **Delivery**: Export multiple selected photos at once

### Export Process

1. Select photos to export in the Library
2. Switch to Export module
3. Choose format and resolution settings
4. Click export and select destination folder

## Keyboard Shortcuts

### Library
- **Arrow Keys**: Navigate between photos
- **P**: Flag as pick
- **X**: Flag as reject
- **U**: Unflag
- **0-5**: Set rating
- **6-9**: Set color
- **Delete**: Remove selected photos

### Develop
- **O**: Cycle through crop overlays
- **Arrow Keys**: Inrement slider value
- **Shift**: Fine adjustment mode
- **Double-click slider**: Reset to default

### General
- **G**: Switch between modules (Library)
- **D**: Switch between modules (Develop)
- **E**: Switch between modules (Loupe)
- **Tab**: Close / Open side panels
- **Escape**: Close dialogs or exit crop mode

## Customization and Extensions

SafeLight's modular architecture allows you to customize your editing experience just like customizing an IDE.

### Installing Extensions

1. Go to **View → Extensions**
2. Enter a GitHub repo URL (e.g., `owner/repo` or `owner/repo#branch`)
3. Click **Install**
4. The extension is downloaded and activated immediately—no restart required

Extensions can add new panels, replace existing ones, add themes, or provide new tools.

### Customizing the Interface

- **Dockable Panels**: Every panel can be docked, undocked, and rearranged
- **Persistent Layouts**: Your panel layouts are saved and restored between sessions
- **Themes**: Apply custom themes to change the visual appearance
- **Keyboard Shortcuts**: Customize shortcuts to match your workflow

### Building Extensions

SafeLight provides a comprehensive extension API that lets you:
- Register new panels that integrate with the editing workflow
- Replace existing panels with custom implementations
- Add custom themes with CSS variables
- Register slider icons and UI elements
- Access SafeLight's state stores and rendering pipeline

See the [Extensions documentation](extensions.md) for detailed information on building and publishing extensions.

### Panel Management

Every registered panel appears in the **View** menu and can:
- Float as a separate window
- Dock beside the canvas
- Be toggled on/off
- Have its position persisted per window

This IDE-like flexibility lets you create the perfect workspace for your specific editing needs.
