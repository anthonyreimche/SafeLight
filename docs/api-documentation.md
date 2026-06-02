# API Documentation

This document describes the internal APIs and data structures used in SafeLight.

## Core Types

### CatalogPhoto

Represents a photo in the catalog with metadata and file references.

```typescript
interface CatalogPhoto {
  id: string;
  filename: string;
  directoryHandle: FileSystemDirectoryHandle | null;
  fileHandle: FileSystemFileHandle | null;
  thumbnailBlob: Blob | null;
  thumbnailUrl: string | null;
  width: number;
  height: number;
  fileSize: number;
  mimeType: string;
  rating: number;
  colorLabel: ColorLabel;
  flag: FlagStatus;
  rotation: number;
  keywords: string[];
  dateCreated: number;
  dateImported: number;
  exif: ExifData;
}
```

### DevelopParams

Contains all editable parameters for image development.

```typescript
interface DevelopParams {
  exposure: number;
  contrast: number;
  highlights: number;
  shadows: number;
  whites: number;
  blacks: number;
  texture: number;
  clarity: number;
  dehaze: number;
  vibrance: number;
  saturation: number;
  temperature: number;
  tint: number;
  straighten: number;
  crop: CropRect;
  transform: TransformParams;
  toneCurve: ToneCurves;
  hsl: HSLAdjustments;
}
```

### Collection

Represents a photo collection (regular or smart).

```typescript
interface Collection {
  id: string;
  name: string;
  type: "regular" | "smart";
  photoIds: string[];
  criteria?: SmartCriteria;
  dateCreated: number;
}
```

## State Stores

### catalog-store

Manages the photo catalog state.

**State:**
- `photos: CatalogPhoto[]` - All photos in the catalog
- `collections: Collection[]` - All collections
- `selectedIds: Set<string>` - Currently selected photo IDs
- `activePhotoId: string | null` - Currently active photo
- `loading: boolean` - Loading state
- `needsReconnect: boolean` - Whether file access needs reconnection
- `reconnecting: boolean` - Reconnection in progress

**Actions:**
- `loadCatalog()` - Load catalog from IndexedDB
- `reconnectFiles()` - Re-request file access permissions
- `addPhotos(photos)` - Add new photos to catalog
- `removePhoto(id)` - Remove a photo
- `removePhotos(ids)` - Remove multiple photos
- `addCollection(name, photoIds)` - Create a new collection
- `deleteCollection(id)` - Delete a collection
- `addToCollection(id, photoIds)` - Add photos to collection
- `removeFromCollection(id, photoIds)` - Remove photos from collection
- `setRating(id, rating)` - Set photo rating
- `setColorLabel(id, label)` - Set color label
- `setFlag(id, flag)` - Set flag status
- `applyRating(ids, rating)` - Batch apply rating
- `applyColorLabel(ids, label)` - Batch apply color label
- `applyFlag(ids, flag)` - Batch apply flag
- `rotatePhotos(ids, deg)` - Rotate photos
- `select(id)` - Select a photo
- `selectRange(id, orderedIds)` - Select range of photos
- `toggleSelect(id)` - Toggle selection
- `selectAll()` - Select all photos
- `deselectAll()` - Deselect all
- `setActivePhoto(id)` - Set active photo

### develop-store

Manages image editing state and parameters.

**State:**
- `photoId: string | null` - Currently edited photo ID
- `params: DevelopParams` - Current edit parameters
- `history: EditSnapshot[]` - Edit history stack
- `historyIndex: number` - Current position in history
- `histogram: HistogramData | null` - Current histogram data
- `cropping: boolean` - Crop tool active
- `constrainCrop: boolean` - Constrain crop to image
- `cropAspect: number` - Locked crop aspect ratio
- `cropGuide: CropGuide` - Active crop guide overlay

**Actions:**
- `loadEdit(photoId)` - Load edit state for a photo
- `setParam(key, value)` - Set a single edit parameter
- `setToneCurve(channel, points)` - Set tone curve for a channel
- `setHslValue(band, channel, value)` - Set HSL adjustment
- `applyPreset(params)` - Apply a preset
- `commitEdit(label)` - Commit current state to history
- `undo()` - Undo last edit
- `redo()` - Redo undone edit
- `reset()` - Reset all parameters to default
- `canUndo()` - Check if undo is available
- `canRedo()` - Check if redo is available

### ui-store

Manages UI state and module navigation.

**State:**
- `activeModule: AppModule` - Currently active module
- `detached: Set<AppModule>` - Detached modules

**Actions:**
- `setModule(module)` - Switch to a module
- `toggleDetach(module)` - Toggle module detachment

## Rendering API

### WebGLRenderer

Main WebGL renderer for image processing.

```typescript
class WebGLRenderer {
  constructor(canvas: HTMLCanvasElement)
  setImage(bitmap: ImageBitmap, maxEdge?: number): void
  setParams(params: DevelopParams): void
  render(): void
  dispose(): void
}
```

**Methods:**
- `setImage()` - Upload image as WebGL texture
- `setParams()` - Update edit parameters and rebuild LUT
- `render()` - Render the image with current parameters
- `dispose()` - Clean up WebGL resources

## Catalog Database

### catalogDB

IndexedDB wrapper for persistent storage.

**Methods:**
- `getAllPhotos()` - Retrieve all photos
- `putPhoto(photo)` - Store a photo
- `putPhotos(photos)` - Store multiple photos
- `deletePhoto(id)` - Delete a photo
- `getAllCollections()` - Retrieve all collections
- `putCollection(collection)` - Store a collection
- `deleteCollection(id)` - Delete a collection
- `getEditState(photoId)` - Retrieve edit state for a photo
- `putEditState(editState)` - Store edit state

## Utility Functions

### Image Processing

- `rotateBlob(blob, deg)` - Rotate an image blob
- `normalizeRotation(deg)` - Normalize rotation to 0/90/180/270
- `buildRGBCurveLUT(curves)` - Build tone curve lookup table

### Transform Math

- `buildInverseTransform(straighten, transform, aspect)` - Build inverse transform matrix
- `mat3Apply(matrix, x, y)` - Apply 3x3 matrix to point
- `mat3ColumnMajor(matrix)` - Convert matrix to column-major order

### Crop Math

- `computeCropForAspect(targetRatio, imageAspect)` - Compute crop for aspect ratio
- `transformedViewCrop(forward, pad)` - Get crop enclosing transformed image
- `cropFitsImage(crop, inv)` - Check if crop fits within image
- `constrainCropToImage(start, target, mode, inv, forward, aspect, ratioLocked)` - Constrain crop to image bounds
- `fitLockedCrop(target, anchorX, anchorY, inv)` - Fit aspect-locked crop to image

## Broadcast API

Cross-window communication using BroadcastChannel.

**Message Types:**
- `catalog-change` - Catalog modifications
- `selection-change` - Selection changes
- `edit-update` - Edit parameter updates

**Usage:**
```typescript
broadcast({ type: "catalog-change", payload: { action: "add" } })
broadcast({ type: "selection-change", payload: { activePhotoId: "..." } })
broadcast({ type: "edit-update", payload: { photoId: "...", params: {...} } })
```
