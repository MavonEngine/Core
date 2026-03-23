varying vec2 vUv;

uniform float uTime;

attribute vec3 offset;
attribute float rotationAngle;
attribute float instanceScale;
attribute float randomLean; 

#define MAX_PUSH_POINTS 150

uniform vec3 pushPositions[MAX_PUSH_POINTS];
uniform float pushRadii[MAX_PUSH_POINTS];

uint murmurHash12(uvec2 src) {
  const uint M = 0x5bd1e995u;
  uint h = 1190494759u;
  src *= M; src ^= src>>24u; src *= M;
  h *= M; h ^= src.x; h *= M; h ^= src.y;
  h ^= h>>13u; h *= M; h ^= h>>15u;
  return h;
}

float computePushInfluence(vec3 worldPos) {
    float totalInfluence = 0.0;

    for (int i = 0; i < MAX_PUSH_POINTS; i++) {
        float dist = distance(worldPos.xz, pushPositions[i].xz);
        float influence = smoothstep(pushRadii[i], 0.0, dist);
        totalInfluence = max(totalInfluence, influence); // or sum for additive influence
    }

    return totalInfluence;
}

// 1 output, 2 inputs
float hash12(vec2 src) {
  uint h = murmurHash12(floatBitsToUint(src));
  return uintBitsToFloat(h & 0x007fffffu | 0x3f800000u) - 1.0;
}

float noise12(vec2 p) {
  vec2 i = floor(p);

  vec2 f = fract(p);
  vec2 u = smoothstep(vec2(0.0), vec2(1.0), f);

	float val = mix( mix( hash12( i + vec2(0.0, 0.0) ), 
                        hash12( i + vec2(1.0, 0.0) ), u.x),
                   mix( hash12( i + vec2(0.0, 1.0) ), 
                        hash12( i + vec2(1.0, 1.0) ), u.x), u.y);
  return val * 2.0 - 1.0;
}


void main() {
    vUv = uv;

    float PI = 3.14159265;

    // Local transformation: scale blade by instanceScale
    vec3 centered = position;
    centered.y *= instanceScale;

    // Compute wind direction from noise
    float windSpeed = 1.0;
    float windStrength = noise12(offset.xz * 0.4 + vec2(uTime * windSpeed));
    float windAngle = windStrength * 0.3 * PI;

    vec2 windDir = vec2(cos(windAngle), sin(windAngle));

    float leanFactor = centered.y;

    // Push down influence
    vec3 worldInstancePos = (modelMatrix * vec4(offset, 1.0)).xyz;
    float pushInfluence = computePushInfluence(worldInstancePos);

    // Apply wind + random lean + push
    // Apply bending that increases with height
    float heightBendFactor = pow(centered.y, 1.5); // or use `centered.y * centered.y` for similar effect
    float bendAmount = (randomLean + windDir.x) * heightBendFactor * 0.8;
    float pushBend = pushInfluence * leanFactor * 1.0; // Adjust strength

    centered.x += bendAmount;
    centered.z += windDir.y * leanFactor * 0.2;
    centered.y -= pushBend; // Push downward

    // Rotate and transform
    float c = cos(rotationAngle);
    float s = sin(rotationAngle);
    mat3 rotationY = mat3(
        c, 0.0, s,
        0.0, 1.0, 0.0,
        -s, 0.0, c
    );

    vec3 transformed = rotationY * centered + offset;

    vec4 modelPosition = modelMatrix * vec4(transformed, 1.0);
    vec4 viewPosition = viewMatrix * modelPosition;
    gl_Position = projectionMatrix * viewPosition;
}