// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Process version 1, frozen beside v1-reference-shader.ts: the bindings, NR flag
// and prepass layout b1f5ec5's builder (moved verbatim into stage-injection.ts)
// derived for the fixtures, plus both vertex shaders. Generated once, never edited.

export const V1_VERTEX_SHADER = `#version 300 es
in vec2 aPos;
in vec2 aUv;
out vec2 vUv;
void main() {
  // Flip V here rather than via UNPACK_FLIP_Y_WEBGL. That pixelStore flag is
  // silently ignored for ImageBitmap uploads in some browsers, which left the
  // develop preview upside-down. Our source bitmaps are always top-down, so a
  // deterministic flip in the shader is correct on every browser.
  vUv = vec2(aUv.x, 1.0 - aUv.y);
  gl_Position = vec4(aPos, 0.0, 1.0);
}
`;

export const V1_PASS_VERTEX_SHADER = `#version 300 es
in vec2 aPos;
in vec2 aUv;
out vec2 vUv;
void main() {
  vUv = aUv;
  gl_Position = vec4(aPos, 0.0, 1.0);
}
`;

export interface V1Binding {
  qualifiedKey: string;
  glslName: string;
  glslType: string;
  default: number | number[] | boolean;
}

export interface V1StageMeta {
  bindings: V1Binding[];
  textureBindings: { qualifiedKey: string; glslName: string; kind: string }[];
  hasNoiseReduction: boolean;
  prepass: {
    stageId: string;
    resultUniform: string;
    passes: { iterations: number; bindings: V1Binding[] }[];
  }[];
}

export const V1_STAGE_META: Record<string, V1StageMeta> = {
  "builtin": {
    "bindings": [
      {
        "qualifiedKey": "builtin.denoise.vstScale",
        "glslName": "u_6zr4_vstScale",
        "glslType": "float",
        "default": 600
      },
      {
        "qualifiedKey": "builtin.denoise.lumAmount",
        "glslName": "u_6zr4_lumAmount",
        "glslType": "float",
        "default": 0
      },
      {
        "qualifiedKey": "builtin.denoise.lumDetail",
        "glslName": "u_6zr4_lumDetail",
        "glslType": "float",
        "default": 50
      },
      {
        "qualifiedKey": "builtin.denoise.lumContrast",
        "glslName": "u_6zr4_lumContrast",
        "glslType": "float",
        "default": 0
      },
      {
        "qualifiedKey": "builtin.denoise.lumShadows",
        "glslName": "u_6zr4_lumShadows",
        "glslType": "float",
        "default": 0
      },
      {
        "qualifiedKey": "builtin.denoise.lumHighlights",
        "glslName": "u_6zr4_lumHighlights",
        "glslType": "float",
        "default": 0
      },
      {
        "qualifiedKey": "builtin.denoise.colAmount",
        "glslName": "u_6zr4_colAmount",
        "glslType": "float",
        "default": 0
      },
      {
        "qualifiedKey": "builtin.denoise.colDetail",
        "glslName": "u_6zr4_colDetail",
        "glslType": "float",
        "default": 50
      },
      {
        "qualifiedKey": "builtin.denoise.colSmooth",
        "glslName": "u_6zr4_colSmooth",
        "glslType": "float",
        "default": 50
      }
    ],
    "textureBindings": [],
    "hasNoiseReduction": true,
    "prepass": [
      {
        "stageId": "builtin.denoise",
        "resultUniform": "u_6zr4_stageResult",
        "passes": [
          {
            "iterations": 1,
            "bindings": [
              {
                "qualifiedKey": "builtin.denoise.vstScale",
                "glslName": "u_6zr4_vstScale",
                "glslType": "float",
                "default": 600
              }
            ]
          },
          {
            "iterations": 5,
            "bindings": [
              {
                "qualifiedKey": "builtin.denoise.vstScale",
                "glslName": "u_6zr4_vstScale",
                "glslType": "float",
                "default": 600
              },
              {
                "qualifiedKey": "builtin.denoise.lumAmount",
                "glslName": "u_6zr4_lumAmount",
                "glslType": "float",
                "default": 0
              },
              {
                "qualifiedKey": "builtin.denoise.lumDetail",
                "glslName": "u_6zr4_lumDetail",
                "glslType": "float",
                "default": 50
              },
              {
                "qualifiedKey": "builtin.denoise.lumContrast",
                "glslName": "u_6zr4_lumContrast",
                "glslType": "float",
                "default": 0
              },
              {
                "qualifiedKey": "builtin.denoise.lumShadows",
                "glslName": "u_6zr4_lumShadows",
                "glslType": "float",
                "default": 0
              },
              {
                "qualifiedKey": "builtin.denoise.lumHighlights",
                "glslName": "u_6zr4_lumHighlights",
                "glslType": "float",
                "default": 0
              },
              {
                "qualifiedKey": "builtin.denoise.colAmount",
                "glslName": "u_6zr4_colAmount",
                "glslType": "float",
                "default": 0
              },
              {
                "qualifiedKey": "builtin.denoise.colDetail",
                "glslName": "u_6zr4_colDetail",
                "glslType": "float",
                "default": 50
              },
              {
                "qualifiedKey": "builtin.denoise.colSmooth",
                "glslName": "u_6zr4_colSmooth",
                "glslType": "float",
                "default": 50
              }
            ]
          },
          {
            "iterations": 1,
            "bindings": [
              {
                "qualifiedKey": "builtin.denoise.vstScale",
                "glslName": "u_6zr4_vstScale",
                "glslType": "float",
                "default": 600
              }
            ]
          }
        ]
      }
    ]
  },
  "legacyExtensions": {
    "bindings": [
      {
        "qualifiedKey": "legacy.warp.warpAmount",
        "glslName": "u_yac9_warpAmount",
        "glslType": "float",
        "default": 0
      },
      {
        "qualifiedKey": "legacy.fringe.fringeAmount",
        "glslName": "u_1ixp_fringeAmount",
        "glslType": "float",
        "default": 0
      },
      {
        "qualifiedKey": "legacy.smooth.smoothAmount",
        "glslName": "u_1p0n_smoothAmount",
        "glslType": "float",
        "default": 0
      },
      {
        "qualifiedKey": "legacy.smooth.smoothRadius",
        "glslName": "u_1p0n_smoothRadius",
        "glslType": "float",
        "default": 1
      },
      {
        "qualifiedKey": "legacy.local.localGain",
        "glslName": "u_1wb6_localGain",
        "glslType": "float",
        "default": 0
      },
      {
        "qualifiedKey": "legacy.film.filmAmount",
        "glslName": "u_ya1k_filmAmount",
        "glslType": "float",
        "default": 0
      },
      {
        "qualifiedKey": "legacy.tint.tintColor",
        "glslName": "u_yaai_tintColor",
        "glslType": "vec3",
        "default": [
          1,
          1,
          1
        ]
      },
      {
        "qualifiedKey": "legacy.tint.tintAmount",
        "glslName": "u_yaai_tintAmount",
        "glslType": "float",
        "default": 0
      },
      {
        "qualifiedKey": "legacy.glow.glowAmount",
        "glslName": "u_ya29_glowAmount",
        "glslType": "float",
        "default": 0
      },
      {
        "qualifiedKey": "legacy.mono.monoOn",
        "glslName": "u_ya66_monoOn",
        "glslType": "bool",
        "default": false
      }
    ],
    "textureBindings": [
      {
        "qualifiedKey": "legacy.local.localCov",
        "glslName": "u_1wb6_localCov",
        "kind": "coverage"
      },
      {
        "qualifiedKey": "legacy.film.filmLut",
        "glslName": "u_ya1k_filmLut",
        "kind": "lut"
      }
    ],
    "hasNoiseReduction": true,
    "prepass": [
      {
        "stageId": "legacy.fringe",
        "resultUniform": "u_1ixp_stageResult",
        "passes": [
          {
            "iterations": 1,
            "bindings": []
          }
        ]
      },
      {
        "stageId": "legacy.smooth",
        "resultUniform": "u_1p0n_stageResult",
        "passes": [
          {
            "iterations": 2,
            "bindings": [
              {
                "qualifiedKey": "legacy.smooth.smoothRadius",
                "glslName": "u_1p0n_smoothRadius",
                "glslType": "float",
                "default": 1
              }
            ]
          }
        ]
      }
    ]
  }
};
