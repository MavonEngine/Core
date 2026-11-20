/**
 * A game's plugin that notifies players: POST /api/e2e/reward/:account gives the account coins and tells it, kept
 * for later and by mail. It only uses what ctx gives it, like a plugin installed into a project: the notifications
 * plugin through ctx.plugin(), without importing anything.
 */
class Reward {
  static notificationType = 'Reward'

  constructor(coins) {
    this.coins = coins
  }

  via() {
    return ['database', 'mail']
  }

  toDatabase() {
    return { coins: this.coins }
  }

  toMail() {
    return { subject: `You got ${this.coins} coins`, text: `Spend them well, they're yours.` }
  }
}

const account = id => ({ notifiableType: 'account', notifiableId: () => id })

export default {
  name: 'Rewards',
  http(app, ctx) {
    app.post('/api/e2e/reward/:account', async (req, res) => {
      const notifications = ctx.plugin('@mavonengine/notifications')
      if (!notifications)
        return res.status(503).json({ error: 'no notifications plugin' })
      await notifications.send(account(req.params.account), new Reward(50))
      res.json({ stored: await notifications.stored(account(req.params.account)) })
    })
  },
}
