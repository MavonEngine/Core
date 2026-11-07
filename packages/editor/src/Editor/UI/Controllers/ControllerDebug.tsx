import type { GamepadButtonEvent, GamepadState } from '@mavonengine/core/GamepadManager'
import { useEffect, useState } from 'react'
import styles from './ControllerDebug.module.css'
import GamepadDiagram from './GamepadDiagram'
import { useGamepads } from './useGamepads'

interface LogEntry {
  id: number
  time: string
  text: string
}

const MAX_LOG = 12
let logId = 0

function useInputLog() {
  const manager = window.Game?.input?.gamepads
  const [log, setLog] = useState<LogEntry[]>([])

  useEffect(() => {
    if (!manager)
      return

    const push = (text: string) => {
      const time = new Date().toLocaleTimeString(undefined, { hour12: false })
      setLog(prev => [{ id: ++logId, time, text }, ...prev].slice(0, MAX_LOG))
    }

    const onDown = ({ gamepad, button }: GamepadButtonEvent) => push(`#${gamepad.index} ${gamepad.buttonLabel(button)} down`)
    const onUp = ({ gamepad, button }: GamepadButtonEvent) => push(`#${gamepad.index} ${gamepad.buttonLabel(button)} up`)
    const onConnected = (gamepad: GamepadState) => push(`#${gamepad.index} connected: ${gamepad.id}`)
    const onDisconnected = (gamepad: GamepadState) => push(`#${gamepad.index} disconnected`)

    manager.on('buttondown', onDown)
    manager.on('buttonup', onUp)
    manager.on('connected', onConnected)
    manager.on('disconnected', onDisconnected)

    return () => {
      manager.off('buttondown', onDown)
      manager.off('buttonup', onUp)
      manager.off('connected', onConnected)
      manager.off('disconnected', onDisconnected)
    }
  }, [manager])

  return log
}

function Bar({ value, centered = false }: { value: number, centered?: boolean }) {
  const style = centered
    ? { left: `${50 + Math.min(0, value) * 50}%`, width: `${Math.abs(value) * 50}%` }
    : { left: 0, width: `${value * 100}%` }

  return (
    <span className={styles.bar}>
      {centered && <span className={styles.barCenter} />}
      <span className={styles.barFill} style={style} />
    </span>
  )
}

function ControllerCard({ gamepad }: { gamepad: GamepadState }) {
  const manager = window.Game.input.gamepads
  const [rumbleFailed, setRumbleFailed] = useState(false)

  const rumble = async () => {
    setRumbleFailed(!await manager.vibrate(gamepad.index, { duration: 300, strongMagnitude: 0.8, weakMagnitude: 0.8 }))
  }

  return (
    <section className={styles.card}>
      <header className={styles.cardHeader}>
        <span className={styles.badge}>{gamepad.type}</span>
        <span className={styles.gamepadId} title={gamepad.id}>{gamepad.id}</span>
        <span className={styles.meta}>
          #
          {gamepad.index}
        </span>
        <button className={styles.button} onClick={rumble} title={rumbleFailed ? 'Vibration is not supported by this controller or browser' : 'Test vibration'}>
          {rumbleFailed ? 'No rumble' : 'Rumble'}
        </button>
      </header>

      {gamepad.mapping !== 'standard' && (
        <div className={styles.warning}>
          Non-standard mapping: the diagram may not match the physical buttons. Use the raw values below.
        </div>
      )}

      <GamepadDiagram gamepad={gamepad} deadzone={manager.stickDeadzone} />

      <div className={styles.sticks}>
        <span>
          L (
          {gamepad.leftStick.x.toFixed(2)}
          ,
          {' '}
          {gamepad.leftStick.y.toFixed(2)}
          )
        </span>
        <span>
          R (
          {gamepad.rightStick.x.toFixed(2)}
          ,
          {' '}
          {gamepad.rightStick.y.toFixed(2)}
          )
        </span>
      </div>

      <div className={styles.sectionTitle}>Axes (raw)</div>
      <div className={styles.rows}>
        {gamepad.axes.map((value, i) => (
          <div key={i} className={styles.row}>
            <span className={styles.rowLabel}>{i}</span>
            <Bar value={value} centered />
            <span className={styles.rowValue}>{value.toFixed(3)}</span>
          </div>
        ))}
      </div>

      <div className={styles.sectionTitle}>Buttons</div>
      <div className={styles.rows}>
        {gamepad.buttonValues.map((value, i) => (
          <div key={i} className={`${styles.row}${gamepad.isPressed(i) ? ` ${styles.rowPressed}` : ''}`}>
            <span className={styles.rowLabel}>
              {i}
              {' '}
              {gamepad.buttonLabel(i)}
            </span>
            <Bar value={value} />
            <span className={styles.rowValue}>{value.toFixed(2)}</span>
          </div>
        ))}
      </div>
    </section>
  )
}

export default function ControllerDebug() {
  const gamepads = useGamepads(true)
  const log = useInputLog()
  const supported = typeof navigator !== 'undefined' && typeof navigator.getGamepads === 'function'

  return (
    <div className={styles.root}>
      {!supported && <div className={styles.empty}>This browser does not support the Gamepad API.</div>}

      {supported && gamepads.length === 0 && (
        <div className={styles.empty}>
          No controller detected.
          <br />
          Connect a controller and press any button on it. Browsers only expose a controller after a button press while the page has focus.
        </div>
      )}

      {gamepads.map(gamepad => <ControllerCard key={`${gamepad.index}:${gamepad.id}`} gamepad={gamepad} />)}

      <div className={styles.sectionTitle}>Event log</div>
      <div className={styles.log}>
        {log.length === 0 && <div className={styles.logEmpty}>No events yet</div>}
        {log.map(entry => (
          <div key={entry.id} className={styles.logEntry}>
            <span className={styles.logTime}>{entry.time}</span>
            {entry.text}
          </div>
        ))}
      </div>
    </div>
  )
}
