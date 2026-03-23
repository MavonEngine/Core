import BaseWorld from '../../World/BaseWorld'
import Player from '../Entities/Player'

export default class ServerWorld extends BaseWorld {
  get players(): Player[] {
    return Array.from(this.entities.items.values()).filter(
      (e): e is Player => e instanceof Player,
    )
  }
}
