uniform float uBigWavesElevation;
uniform vec2 uBigWavesFrequency;
uniform float uBigWavesSpeed;

uniform float uTime;

uniform vec3 uSurfaceColor;
uniform vec3 uDepthColor;

#define MAX_PUSH_POINTS 150

uniform vec3 pushPositions[MAX_PUSH_POINTS];
uniform float pushRadii[MAX_PUSH_POINTS];

varying float vElevation;
varying vec3 vWorldPosition;

#include ../../Shaders/Vertex/ClassicPerlin3DNoise;

float computeRipple(vec3 worldPos) {
    float totalRipple = 0.0;

    for (int i = 0; i < MAX_PUSH_POINTS; i++) {
        float dist = distance(worldPos.xz, pushPositions[i].xz);
        float influence = smoothstep(pushRadii[i], 0.0, dist);

        // Expanding ring ripple pattern
        float ripple = sin(dist * 8.0 - uTime * 4.0) * influence;
        totalRipple += ripple;
    }

    return totalRipple;
}

void main()
{
    vec4 modelPosition = modelMatrix * vec4(position, 1.0);

    float elevation = sin(modelPosition.x * uBigWavesFrequency.x + uTime * uBigWavesSpeed) *
                      sin(modelPosition.z * uBigWavesFrequency.y + uTime * uBigWavesSpeed) *
                      uBigWavesElevation;

    for (float i = 1.0; i <= 4.0; i++){
        elevation -= abs(cnoise(vec3(modelPosition.xz * 3.0 * i, uTime * 0.2)) * 0.15 / i);
    }

    // Player ripples
    elevation += computeRipple(modelPosition.xyz) * 0.2;

    modelPosition.y += elevation;

    vec4 viewPosition = viewMatrix * modelPosition;
    vec4 projectedPosition = projectionMatrix * viewPosition;

    gl_Position = projectedPosition;

    // Varyings
    vElevation = elevation;
    vWorldPosition = modelPosition.xyz;
}