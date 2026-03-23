varying vec2 vUv;

void main() {

    vec3 baseColor = vec3(0.05, 0.2, 0.01);
    vec3 tipColor = vec3(0.5, 0.5, 0.1);

    vec3 diffuseColor = mix(tipColor, baseColor, vUv.y);

    gl_FragColor = vec4(diffuseColor, 1.0);
}