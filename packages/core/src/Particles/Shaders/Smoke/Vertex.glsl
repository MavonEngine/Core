uniform float uTime;
attribute float aScale;
attribute float aAlpha;
varying float vAlpha;

void main()
{
    vAlpha = aAlpha;

    // Reset position to top if they are outside the screen
    vec3 pos = position;

    // If has been reset we should also update it to reflect camera position so it moves with the camera 
    // Implement only when its at at the top

    // Position
    vec4 modelPosition = modelMatrix * vec4(position, 1.0);
    vec4 viewPosition = viewMatrix * modelPosition;
    vec4 projectedPosition = projectionMatrix * viewPosition;

    gl_Position = projectionMatrix * modelViewMatrix * vec4(pos, 1.0);
    
    // Size
    gl_PointSize = aScale * 40.0;
}