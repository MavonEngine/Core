import type winston from 'winston'
import os from 'node:os'
import process from 'node:process'

interface CpuStats {
  timestamp: number
  cpuPercentage: number
}

export default class CpuTracker {
  private lastCpuUsage = process.cpuUsage()
  private lastSystemCpuInfo = this.getSystemCpuInfo()
  private history: CpuStats[] = []

  private logger: winston.Logger

  constructor(logger: winston.Logger) {
    this.logger = logger
  }

  log() {
    const cpuStats = this.getCpuStats()

    this.logger.info(`CPU Usage - User: ${cpuStats.userCPU.toFixed(2)} ms, System: ${cpuStats.systemCPU.toFixed(2)} ms, Total 1s: ${cpuStats.avg1s}%, Total 10s: ${cpuStats.avg10s}%, Total 1m: ${cpuStats.avg60s}%`)
  }

  private getCpuStats() {
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

    const cpuPercentage = (totalUsedCPU / maxPossibleCpuTime) * 100
    const roundedCpuPercentage = Number.parseFloat(cpuPercentage.toFixed(2))

    // Update history and clean up old entries
    this.history.push({ timestamp: now, cpuPercentage: roundedCpuPercentage })
    this.cleanupHistory(now)

    return {
      userCPU,
      systemCPU,
      totalUsedCPU,
      cpuPercentage: roundedCpuPercentage,
      avg1s: this.getAverage(now, 1000),
      avg10s: this.getAverage(now, 10000),
      avg60s: this.getAverage(now, 60000),
    }
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
    this.history = this.history.filter(stat => stat.timestamp >= oneMinuteAgo)
  }

  private getAverage(now: number, duration: number): number {
    const fromTime = now - duration
    const relevantStats = this.history.filter(stat => stat.timestamp >= fromTime)
    if (relevantStats.length === 0)
      return 0

    const sum = relevantStats.reduce((acc, stat) => acc + stat.cpuPercentage, 0)
    return Number.parseFloat((sum / relevantStats.length).toFixed(2))
  }
}
