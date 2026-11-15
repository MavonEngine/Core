/**
 * The smallest auth plugin: lets `Bearer good` in as alice, turns `Bearer banned` away with 403,
 * throws on `Bearer boom` and refuses everything else.
 */
export default {
  name: 'Token auth',
  authorize(authorization) {
    if (authorization === 'Bearer good')
      return { id: 'acc-1', name: 'alice' }
    if (authorization === 'Bearer banned')
      return 403
    if (authorization === 'Bearer boom')
      throw new Error('boom')
    return false
  },
}
