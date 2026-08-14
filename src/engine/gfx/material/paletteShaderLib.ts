import * as THREE from 'three';
export const paletteShaderLib = {
    uniforms: {
        palette: { type: "t", value: null },
        paletteOffsetCount: { value: [0, 1] },
        extraLight: { value: new THREE.Vector3(0, 0, 0) },
    },
    instanceParsVertex: `
#ifdef INSTANCE_TRANSFORM
    attribute float instancePaletteOffset;
    varying float vInstancePaletteOffset;
    attribute vec3 instanceExtraLight;
    varying vec3 vInstanceExtraLight;
#endif
#ifdef INSTANCE_OPACITY
    attribute float instanceOpacity;
    varying float vInstanceOpacity;
#endif
`,
    instanceVertex: `
  #ifdef INSTANCE_TRANSFORM
    vInstancePaletteOffset = instancePaletteOffset;
    vInstanceExtraLight = instanceExtraLight;
  #endif
  #ifdef INSTANCE_OPACITY
    vInstanceOpacity = instanceOpacity;
  #endif
`,
    paletteColorParsVertex: `
#ifdef VERTEX_PALETTE_OFFSET
    attribute float vertexPaletteOffset;
    varying float vVertexPaletteOffset;
#endif
`,
    paletteColorVertex: `
  #ifdef VERTEX_PALETTE_OFFSET
    vVertexPaletteOffset = vertexPaletteOffset;
  #endif
`,
    paletteColorParsFrag: `
uniform sampler2D palette;
#ifdef VERTEX_PALETTE_OFFSET
    varying float vVertexPaletteOffset;
#endif
uniform vec2 paletteOffsetCount;
uniform vec3 extraLight;

#ifdef INSTANCE_TRANSFORM
varying float vInstancePaletteOffset;
varying vec3 vInstanceExtraLight;
#endif

#ifdef INSTANCE_OPACITY
varying float vInstanceOpacity;
#endif
`,
    paletteColorFrag: `
  float paletteColorIndex;

  #ifdef USE_MAP
  #ifdef USE_RED_INDEX
  paletteColorIndex = sampledDiffuseColor.r;
  #else
  paletteColorIndex = sampledDiffuseColor.a;
  #endif
  #endif

  #ifdef USE_COLOR
  paletteColorIndex = vColor.r;
  #endif

  #ifdef INSTANCE_TRANSFORM
  diffuseColor = texture2D(palette, vec2(paletteColorIndex, (vInstancePaletteOffset + 0.5) / paletteOffsetCount.y));
  #elif defined(VERTEX_PALETTE_OFFSET)
  diffuseColor = texture2D(palette, vec2(paletteColorIndex, (vVertexPaletteOffset + 0.5) / paletteOffsetCount.y));
  #else
  diffuseColor = texture2D(palette, vec2(paletteColorIndex, (paletteOffsetCount.x + 0.5) / paletteOffsetCount.y));
  #endif

  #ifdef INSTANCE_OPACITY
  diffuseColor.a *= vInstanceOpacity * opacity;
  #else
  diffuseColor.a *= opacity;
  #endif
  diffuseColor = clamp(diffuseColor, 0.0, 1.0);
`,
    paletteBasicLightFragment: `
  #ifdef INSTANCE_TRANSFORM
  diffuseColor.rgb += vInstanceExtraLight.rgb * diffuseColor.rgb;
  #else
  diffuseColor.rgb += extraLight.rgb * diffuseColor.rgb;
  #endif

  diffuseColor = clamp(diffuseColor, 0.0, 1.0);
`,
    paletteFullLightFragment: `
  #ifdef INSTANCE_TRANSFORM
  vec3 extraIrradiance = vInstanceExtraLight.rgb;
  #else
  vec3 extraIrradiance = extraLight.rgb;
  #endif

  reflectedLight.directDiffuse *= PI;
  reflectedLight.directSpecular *= PI;
  reflectedLight.indirectDiffuse *= PI;

  #if ( NUM_DIR_LIGHTS > 0 ) && defined( RE_Direct )
    #pragma unroll_loop_start
    for ( int i = 0; i < NUM_DIR_LIGHTS; i ++ ) {
      directLight.direction = directionalLights[ i ].direction;
      directLight.color = extraIrradiance * PI;
      directLight.visible = true;
      RE_Direct( directLight, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight );
    }
    #pragma unroll_loop_end
  #endif

  #if defined( RE_IndirectDiffuse )
  RE_IndirectDiffuse( extraIrradiance, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight );
  #endif
`,
    vertexColorMultParsVertex: `
#ifdef USE_VERTEX_COLOR_MULT
attribute vec4 vertexColorMult;
varying vec4 vVertexColorMult;
#endif
`,
    vertexColorMultVertex: `
  #ifdef USE_VERTEX_COLOR_MULT
  vVertexColorMult = vertexColorMult;
  #endif
`,
    vertexColorMultParsFrag: `
#ifdef USE_VERTEX_COLOR_MULT
varying vec4 vVertexColorMult;
#endif
`,
    vertexColorMultFrag: `
  #ifdef USE_VERTEX_COLOR_MULT
  diffuseColor.rgba *= vVertexColorMult.rgba;
  #endif
`,
};
