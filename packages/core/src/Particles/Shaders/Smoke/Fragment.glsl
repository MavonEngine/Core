uniform sampler2D uTexture;
varying float vAlpha;

void main()
{
    vec4 texColor = texture2D(uTexture, gl_PointCoord);
    gl_FragColor = vec4(texColor.rgb, texColor.a * vAlpha); 
}