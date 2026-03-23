uniform vec3 uDepthColor;
uniform vec3 uSurfaceColor;
uniform float uColorOffset;
uniform float uColorMultiplier;

uniform vec3 uSunDirection;
uniform float uSunReflectionStrength;

varying float vElevation;
varying vec3 vWorldPosition;

void main()
{
    float mixStrength = (vElevation + uColorOffset) * uColorMultiplier;

    vec3 color = mix(uDepthColor, uSurfaceColor, mixStrength);

    // Sun reflection
    vec3 normal = normalize(cross(dFdx(vWorldPosition), dFdy(vWorldPosition)));
    vec3 viewDir = normalize(cameraPosition - vWorldPosition);
    vec3 sunDir = normalize(uSunDirection);

    // Specular highlight (Blinn-Phong)
    vec3 halfDir = normalize(sunDir + viewDir);
    float spec = pow(max(dot(normal, halfDir), 0.0), 128.0);

    // Fresnel - stronger reflections at grazing angles
    float fresnel = pow(1.0 - max(dot(normal, viewDir), 0.0), 3.0);

    vec3 sunColor = vec3(1.0, 0.95, 0.8);
    color += sunColor * spec * (0.5 + fresnel * 0.5) * uSunReflectionStrength;

    gl_FragColor = vec4(color, 0.9);

    #include <colorspace_fragment>
}
