import { useEffect, useRef } from 'react'
import { Panel } from 'react-resizable-panels'
import styles from './CanvasPanel.module.css'
import CanvasToolbar from './CanvasToolbar'

export default () => {
  const canvasRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    /**
     * Move the game canvas into this panel
     */
    canvasRef.current?.appendChild(window.Game.canvas)

    const canvas = window.Game.canvas

    /**
     * https://github.com/mrdoob/three.js/pull/26973
     *
     * Dispatch the pointercancel event so the camera doesnt get stuck dragging
     */
    const handlePointerLeave = () => {
      canvas.dispatchEvent(new PointerEvent('pointercancel', { bubbles: true }))
    }
    canvas.addEventListener('pointerleave', handlePointerLeave)
    return () => canvas.removeEventListener('pointerleave', handlePointerLeave)
  })

  const handleResize = () => {
    if (!canvasRef.current)
      return

    const { clientWidth, clientHeight } = canvasRef.current
    window.Game.sizes.setSize(clientWidth, clientHeight)
  }

  return (
    <Panel id="canvas" onResize={handleResize}>
      <div className={styles.wrapper}>
        <CanvasToolbar />
        <div ref={canvasRef} className={styles.canvas} />
      </div>
    </Panel>
  )
}
