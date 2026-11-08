import type { CubeTexture, Texture } from 'three'
import { useEffect, useRef, useState } from 'react'
import AssetStats from './AssetStats'
import styles from './TextureViewer.module.css'

export type RawImage = HTMLImageElement | HTMLCanvasElement | ImageBitmap

function isCubeTexture<HTMLImageElement>(t: Texture<RawImage> | CubeTexture<HTMLImageElement>): t is CubeTexture<HTMLImageElement> {
  return Array.isArray(t.image)
}

function imageToUrl(img: RawImage): string {
  if (img instanceof HTMLImageElement)
    return img.src
  if (img instanceof HTMLCanvasElement)
    return img.toDataURL()
  if (typeof ImageBitmap !== 'undefined' && img instanceof ImageBitmap) {
    const canvas = document.createElement('canvas')
    canvas.width = img.width
    canvas.height = img.height
    canvas.getContext('2d')?.drawImage(img, 0, 0)
    return canvas.toDataURL()
  }
  return ''
}

export function getTextureUrl(texture: Texture<RawImage> | CubeTexture<HTMLImageElement>): string {
  const img = isCubeTexture<HTMLImageElement>(texture) ? texture.image[0] : texture.image
  return img ? imageToUrl(img) : ''
}

function formatWrap(wrap: number): string {
  const modes: Record<number, string> = { 1000: 'Repeat', 1001: 'Clamp', 1002: 'Mirror' }
  return modes[wrap] ?? String(wrap)
}

function formatColorSpace(cs: string): string {
  if (cs === 'srgb')
    return 'sRGB'
  if (cs === '')
    return 'Linear'
  return cs
}

// Three.js CubeTexture<HTMLImageElement> face order: +X, -X, +Y, -Y, +Z, -Z
// Cross layout (4 cols × 3 rows):
//   .   +Y  .   .
//  -X   +Z  +X  -Z
//   .   -Y  .   .
const CUBE_FACES: Array<{ label: string, faceIndex: number } | null> = [
  null, // [0,0]
  { label: '+Y', faceIndex: 2 }, // [0,1]
  null, // [0,2]
  null, // [0,3]
  { label: '-X', faceIndex: 1 }, // [1,0]
  { label: '+Z', faceIndex: 4 }, // [1,1]
  { label: '+X', faceIndex: 0 }, // [1,2]
  { label: '-Z', faceIndex: 5 }, // [1,3]
  null, // [2,0]
  { label: '-Y', faceIndex: 3 }, // [2,1]
  null, // [2,2]
  null, // [2,3]
]

export default ({ texture }: { texture: Texture<RawImage> | CubeTexture<HTMLImageElement> }) => {
  const isCube = isCubeTexture<HTMLImageElement>(texture)
  const img = isCubeTexture<HTMLImageElement>(texture) ? texture.image[0] : texture.image
  const width = img?.width ?? 0
  const height = img?.height ?? 0

  const faces = isCube ? 6 : 1
  const memoryMb = width && height ? (width * height * 4 * faces) / (1024 * 1024) : 0

  const wrapperRef = useRef<HTMLDivElement>(null)
  const isDragging = useRef(false)
  const lastPos = useRef({ x: 0, y: 0 })
  const [transform, setTransform] = useState({ scale: 1, x: 0, y: 0 })

  useEffect(() => {
    const el = wrapperRef.current
    if (!el)
      return

    function onWheel(e: WheelEvent) {
      e.preventDefault()
      const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15
      const rect = el!.getBoundingClientRect()
      const cx = e.clientX - rect.left
      const cy = e.clientY - rect.top
      setTransform((prev) => {
        const newScale = Math.max(0.5, Math.min(20, prev.scale * factor))
        const ratio = newScale / prev.scale
        return { scale: newScale, x: cx - (cx - prev.x) * ratio, y: cy - (cy - prev.y) * ratio }
      })
    }

    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])

  function onPointerDown(e: React.PointerEvent) {
    isDragging.current = true
    lastPos.current = { x: e.clientX, y: e.clientY }
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    ;(e.currentTarget as HTMLElement).style.cursor = 'grabbing'
  }

  function onPointerMove(e: React.PointerEvent) {
    if (!isDragging.current)
      return
    const dx = e.clientX - lastPos.current.x
    const dy = e.clientY - lastPos.current.y
    lastPos.current = { x: e.clientX, y: e.clientY }
    setTransform(prev => ({ ...prev, x: prev.x + dx, y: prev.y + dy }))
  }

  function onPointerUp(e: React.PointerEvent) {
    isDragging.current = false
    ;(e.currentTarget as HTMLElement).style.cursor = 'grab'
  }

  function resetZoom() {
    setTransform({ scale: 1, x: 0, y: 0 })
  }

  const isTransformed = transform.scale !== 1 || transform.x !== 0 || transform.y !== 0

  return (
    <div className={styles.viewer}>
      <div
        ref={wrapperRef}
        className={styles.imageWrapper}
        style={{ cursor: 'grab' }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onDoubleClick={resetZoom}
      >
        <div
          className={styles.zoomInner}
          style={{ transform: `translate(${transform.x}px, ${transform.y}px) scale(${transform.scale})` }}
        >
          {isCubeTexture<HTMLImageElement>(texture)
            ? (
                <div className={styles.cubeCross}>
                  {CUBE_FACES.map((face, i) =>
                    face
                      ? (
                          <div key={i} className={styles.cubeFace}>
                            <img src={imageToUrl(texture.image[face.faceIndex])} alt={face.label} />
                            <span className={styles.faceLabel}>{face.label}</span>
                          </div>
                        )
                      : <div key={i} className={styles.cubeEmpty} />,
                  )}
                </div>
              )
            : texture.image
              ? <img className={styles.image} src={imageToUrl(texture.image)} alt="" />
              : <span className={styles.noPreview}>No preview</span>}
        </div>
        {isTransformed && (
          <button
            className={styles.zoomReset}
            onClick={resetZoom}
            onDoubleClick={e => e.stopPropagation()}
          >
            {Math.round(transform.scale * 100)}
            %
          </button>
        )}
      </div>
      <AssetStats stats={[
        { label: 'Size', value: `${width} × ${height}` },
        { label: 'Memory', value: memoryMb >= 0.1 ? `${memoryMb.toFixed(2)} MB` : `${(memoryMb * 1024).toFixed(2)} KB` },
        { label: 'Color Space', value: formatColorSpace(texture.colorSpace) },
        { label: 'Wrap S', value: formatWrap(texture.wrapS) },
        { label: 'Wrap T', value: formatWrap(texture.wrapT) },
        ...(isCube ? [{ label: 'Type', value: 'Cube' }] : []),
      ]}
      />
    </div>
  )
}
