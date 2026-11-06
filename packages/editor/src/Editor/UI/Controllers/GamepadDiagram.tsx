import type { GamepadState, GamepadType } from '@mavonengine/core/GamepadManager'
import type { Vector2 } from 'three'
import { GamepadButton } from '@mavonengine/core/GamepadManager'
import styles from './ControllerDebug.module.css'

type Point = [number, number]

interface Layout {
  leftStick: Point
  rightStick: Point
  dpad: Point
  face: Point
}

const OFFSET_LAYOUT: Layout = { leftStick: [70, 78], dpad: [110, 128], rightStick: [190, 128], face: [230, 78] }
const SYMMETRIC_LAYOUT: Layout = { dpad: [70, 78], leftStick: [110, 128], rightStick: [190, 128], face: [230, 78] }

const LAYOUTS: Record<GamepadType, Layout> = {
  xbox: OFFSET_LAYOUT,
  nintendo: OFFSET_LAYOUT,
  generic: OFFSET_LAYOUT,
  playstation: SYMMETRIC_LAYOUT,
}

// South, East, West, North
const FACE_LABELS: Record<GamepadType, [string, string, string, string]> = {
  xbox: ['A', 'B', 'X', 'Y'],
  playstation: ['✕', '○', '□', '△'],
  nintendo: ['B', 'A', 'Y', 'X'],
  generic: ['1', '2', '3', '4'],
}

const STICK_RADIUS = 24

function cls(pressed: boolean) {
  return pressed ? `${styles.part} ${styles.pressed}` : styles.part
}

function Stick({ at, raw, processed, deadzone, pressed }: { at: Point, raw: [number, number], processed: Vector2, deadzone: number, pressed: boolean }) {
  const [cx, cy] = at
  return (
    <g>
      <circle cx={cx} cy={cy} r={STICK_RADIUS} className={cls(pressed)} />
      <circle cx={cx} cy={cy} r={STICK_RADIUS * deadzone} className={styles.deadzone} />
      <circle cx={cx + raw[0] * STICK_RADIUS} cy={cy + raw[1] * STICK_RADIUS} r={3} className={styles.rawDot} />
      <circle cx={cx + processed.x * STICK_RADIUS} cy={cy - processed.y * STICK_RADIUS} r={6} className={styles.stickDot} />
    </g>
  )
}

function Trigger({ x, value, pressed, label }: { x: number, value: number, pressed: boolean, label: string }) {
  return (
    <g>
      <rect x={x} y={4} width={60} height={8} rx={2} className={styles.part} />
      <rect x={x} y={4} width={60 * value} height={8} rx={2} className={pressed ? styles.fillPressed : styles.fill} />
      <text x={x + 30} y={11} className={styles.tinyLabel}>{label}</text>
    </g>
  )
}

export default function GamepadDiagram({ gamepad, deadzone }: { gamepad: GamepadState, deadzone: number }) {
  const layout = LAYOUTS[gamepad.type]
  const faceLabels = FACE_LABELS[gamepad.type]
  const p = (button: number) => gamepad.isPressed(button)
  const axis = (i: number) => gamepad.axes[i] ?? 0

  const [dx, dy] = layout.dpad
  const [fx, fy] = layout.face

  const dpad: [number, Point][] = [
    [GamepadButton.DPadUp, [0, -13]],
    [GamepadButton.DPadDown, [0, 13]],
    [GamepadButton.DPadLeft, [-13, 0]],
    [GamepadButton.DPadRight, [13, 0]],
  ]

  const face: [number, Point, string][] = [
    [GamepadButton.South, [0, 18], faceLabels[0]],
    [GamepadButton.East, [18, 0], faceLabels[1]],
    [GamepadButton.West, [-18, 0], faceLabels[2]],
    [GamepadButton.North, [0, -18], faceLabels[3]],
  ]

  return (
    <svg viewBox="0 0 300 170" className={styles.diagram} role="img" aria-label={`${gamepad.type} controller state`}>
      <rect x={20} y={38} width={260} height={128} rx={50} className={styles.body} />

      <Trigger x={40} value={gamepad.value(GamepadButton.LeftTrigger)} pressed={p(GamepadButton.LeftTrigger)} label={gamepad.buttonLabel(GamepadButton.LeftTrigger)} />
      <Trigger x={200} value={gamepad.value(GamepadButton.RightTrigger)} pressed={p(GamepadButton.RightTrigger)} label={gamepad.buttonLabel(GamepadButton.RightTrigger)} />

      <rect x={40} y={18} width={60} height={12} rx={4} className={cls(p(GamepadButton.LeftBumper))} />
      <text x={70} y={27} className={styles.tinyLabel}>{gamepad.buttonLabel(GamepadButton.LeftBumper)}</text>
      <rect x={200} y={18} width={60} height={12} rx={4} className={cls(p(GamepadButton.RightBumper))} />
      <text x={230} y={27} className={styles.tinyLabel}>{gamepad.buttonLabel(GamepadButton.RightBumper)}</text>

      <circle cx={125} cy={62} r={6} className={cls(p(GamepadButton.Select))} />
      <circle cx={150} cy={82} r={8} className={cls(p(GamepadButton.Home))} />
      <circle cx={175} cy={62} r={6} className={cls(p(GamepadButton.Start))} />

      <Stick at={layout.leftStick} raw={[axis(0), axis(1)]} processed={gamepad.leftStick} deadzone={deadzone} pressed={p(GamepadButton.LeftStick)} />
      <Stick at={layout.rightStick} raw={[axis(2), axis(3)]} processed={gamepad.rightStick} deadzone={deadzone} pressed={p(GamepadButton.RightStick)} />

      {dpad.map(([button, [ox, oy]]) => (
        <rect key={button} x={dx + ox - 6} y={dy + oy - 6} width={12} height={12} rx={2} className={cls(p(button))} />
      ))}

      {face.map(([button, [ox, oy], label]) => (
        <g key={button}>
          <circle cx={fx + ox} cy={fy + oy} r={8} className={cls(p(button))} />
          <text x={fx + ox} y={fy + oy + 3} className={styles.faceLabel}>{label}</text>
        </g>
      ))}
    </svg>
  )
}
