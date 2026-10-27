import type winston from 'winston'
import os from 'node:os'
import process from 'node:process'

export interface CpuHistoryEntry {
  timestamp: number
  cpuPercentage: number
}

export interface CpuStats {
  timestamp: number
  /** ms of user CPU time since the previous sample */
  userCPU: number
  /** ms of system CPU time since the previous sample */
  systemCPU: number
  totalUsedCPU: number
  /** Percentage of a single core used since the previous sample */
  cpuPercentage: number
  avg1s: number
  avg10s: number
  avg60s: number
}

export default class CpuTracker {
  private lastCpuUsage = process.cpuUsage()
  private lastSystemCpuInfo = this.getSystemCpuInfo()
  private _history: CpuHistoryEntry[] = []
  private _latest?: CpuStats

  private logger: winston.Logger

  constructor(logger: winston.Logger) {
    this.logger = logger
  }

  get history(): readonly CpuHistoryEntry[] {
    return this._history
  }

  get latest(): CpuStats | undefined {
    return this._latest
  }

  /**
   * Logs the most recent sample, taking one first if none exists yet.
   * Does not take a new sample so it can't skew a sampling interval running alongside it.
   */
  log() {
    const cpuStats = this._latest ?? this.sample()

    this.logger.info(`CPU Usage - User: ${cpuStats.userCPU.toFixed(2)} ms, System: ${cpuStats.systemCPU.toFixed(2)} ms, Total 1s: ${cpuStats.avg1s}%, Total 10s: ${cpuStats.avg10s}%, Total 1m: ${cpuStats.avg60s}%`)
  }

  /**
   * Measure CPU usage since the previous sample and add it to the history.
   */
  sample(): CpuStats {
    const now = Date.now()

    const currentCpuUsage = process.cpuUsage(this.lastCpuUsage)
    this.lastCpuUsage = process.cpuUsage()

    const userCPU = currentCpuUsage.user / 1000 // in ms
    const systemCPU = currentCpuUsage.system / 1000 // in ms
    const totalUsedCPU = userCPU + systemCPU

    const currentSystemCpu = this.getSystemCpuInfo()
    const totalSystemDelta = currentSystemCpu.total - this.lastSystemCpuInfo.total
    this.lastSystemCpuInfo = currentSystemCpu

    const cpuCount = os.cpus().length
    const maxPossibleCpuTime = totalSystemDelta / cpuCount

    // os.cpus() times only tick every few ms, so two samples close together can have no delta
    const cpuPercentage = maxPossibleCpuTime > 0 ? (totalUsedCPU / maxPossibleCpuTime) * 100 : 0
    const roundedCpuPercentage = Number.parseFloat(cpuPercentage.toFixed(2))

    // Update history and clean up old entries
    this._history.push({ timestamp: now, cpuPercentage: roundedCpuPercentage })
    this.cleanupHistory(now)

    this._latest = {
      timestamp: now,
      userCPU,
      systemCPU,
      totalUsedCPU,
      cpuPercentage: roundedCpuPercentage,
      avg1s: this.getAverage(now, 1000),
      avg10s: this.getAverage(now, 10000),
      avg60s: this.getAverage(now, 60000),
    }

    return this._latest
  }

  private getSystemCpuInfo() {
    const cpus = os.cpus()

    let user = 0
    let nice = 0
    let sys = 0
    let idle = 0
    let irq = 0

    for (const cpu of cpus) {
      user += cpu.times.user
      nice += cpu.times.nice
      sys += cpu.times.sys
      idle += cpu.times.idle
      irq += cpu.times.irq
    }

    return { user, nice, sys, idle, irq, total: user + nice + sys + idle + irq }
  }

  private cleanupHistory(now: number) {
    const oneMinuteAgo = now - 60000
    this._history = this._history.filter(stat => stat.timestamp >= oneMinuteAgo)
  }

  private getAverage(now: number, duration: number): number {
    const fromTime = now - duration
    const relevantStats = this._history.filter(stat => stat.timestamp >= fromTime)
    if (relevantStats.length === 0)
      return 0

    const sum = relevantStats.reduce((acc, stat) => acc + stat.cpuPercentage, 0)
    return Number.parseFloat((sum / relevantStats.length).toFixed(2))
  }
}
