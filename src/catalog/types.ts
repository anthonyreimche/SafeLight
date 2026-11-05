// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The catalogue model, split by concern; this file keeps the one import path.
// photo: the photo record and EXIF. develop-params: the shape of an edit.
// defaults: the untouched edit. normalize: stored data back into shape.
// process-version: which rendering generation an edit belongs to.

export type {
  CatalogPhoto,
  StoredPhoto,
  LoadedPreview,
  ColorLabel,
  FlagStatus,
  ExifData,
  EditState,
  EditSnapshot,
  SortField,
  SortDirection,
  ViewMode,
  ModuleId,
  AppModule,
} from "./photo";
export {
  storedPhoto,
  mergeStoredPhoto,
} from "./photo";
export type {
  CurvePoint,
  ToneCurveChannel,
  ToneCurves,
  CropRect,
  HSLChannel,
  HSLBand,
  HSLValues,
  HSLAdjustments,
  TransformParams,
  UprightMode,
  GuidedLine,
  ColorGradingRange,
  ColorGradingParams,
  VignetteParams,
  GrainParams,
  MaskAdjustments,
  MaskType,
  BrushDab,
  LinearMaskGeo,
  RadialMaskGeo,
  BrushMaskGeo,
  LumRangeGeo,
  ColorRangeGeo,
  MaskComponentKind,
  MaskComponentMode,
  MaskComponent,
  Mask,
  RetouchSpot,
  DevelopParams,
} from "./develop-params";
export {
  TONE_CURVE_CHANNELS,
  HSL_CHANNELS,
  LEGACY_MASK_PANELS,
  DEFAULT_MASK_PANELS,
  MAX_MASKS,
  MAX_RETOUCH,
  MAX_BRUSH_MASKS,
  MAX_MASK_COMPONENTS,
  assignDevelopParam,
} from "./develop-params";
export {
  defaultMaskAdjustments,
  defaultLumRange,
  DEFAULT_TRANSFORM,
  DEFAULT_TONE_CURVE,
  defaultToneCurves,
  isDefaultToneCurves,
  isDefaultHSL,
  maskHasDisplayAdjustments,
  DEFAULT_CROP,
  defaultColorGrading,
  defaultHSL,
  DEFAULT_VIGNETTE,
  DEFAULT_GRAIN,
  NEUTRAL_TEMPERATURE_K,
  DEFAULT_DEVELOP_PARAMS,
} from "./defaults";
export {
  normalizeParams,
  freshParams,
} from "./normalize";
export {
  LEGACY_PROCESS_VERSION,
  CURRENT_PROCESS_VERSION,
  UPDATE_PROCESSING_LABEL,
  normalizeProcessVersion,
  withoutProcessVersion,
  usesOlderProcessing,
  usesSignedOutput,
} from "./process-version";
