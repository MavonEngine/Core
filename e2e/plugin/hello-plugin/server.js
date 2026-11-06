let ticks = 0

export default {
  name: 'Hello',
  setup(ctx) {
    ctx.logger.info(`hello-plugin setup, options ${JSON.stringify(ctx.options)}`)
  },
  tick() {
    ticks++
  },
  http(app) {
    app.get('/api/hello', (_req, res) => res.json({ hello: 'world', ticks }))
  },
}
