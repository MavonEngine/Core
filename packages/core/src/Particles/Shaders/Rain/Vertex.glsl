uniform float uTime;
uniform vec3 uCameraPosition;

void main()
{
    // Reset position to top if they are outside the screen
    vec3 pos = position;
    pos.y = pos.y - uTime * 7.0;
    pos.y = mod(pos.y + 20.0, 20.0) - 10.0;

    // If has been reset we should also update it to reflect camera position so it moves with the camera 
    // Implement only when its at at the top

    // Position
    vec4 modelPosition = modelMatrix * vec4(position, 1.0);
    vec4 viewPosition = viewMatrix * modelPosition;
    vec4 projectedPosition = projectionMatrix * viewPosition;

    gl_Position = projectionMatrix * modelViewMatrix * vec4(pos, 1.0);
    
    // Size
    gl_PointSize = 2.0;
}