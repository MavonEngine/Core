# @mavonengine/notifications

A [MavonEngine](https://mavonengine.com) plugin that notifies players, and anything else you make notifiable, in the game and by mail:

```ts
await player.notify(new LevelUp(5))
```

```sh
npx @mavonengine/cli install @mavonengine/notifications
```

`player.notify()` and `notify()` are part of the engine, so your game's code uses them without this plugin in its `package.json`. Without a notifications plugin they send nothing and say so in the server's log. With this plugin they reach the player.

## Writing a notification

A notification is a class. `via()` says which channels it goes to, and a `to<Channel>()` method what it says on each:

```ts
import { Notification } from '@mavonengine/notifications/server'

export class LevelUp extends Notification {
  constructor(private level: number) {
    super()
  }

  via() {
    return ['game', 'mail']
  }

  toGame() {
    return { level: this.level }
  }

  toMail() {
    return { subject: `Level ${this.level}!`, text: `Well played: you reached level ${this.level}.` }
  }
}
```

`via()` and every `to<Channel>()` get the recipient, so a notification can go to some recipients by mail and to others only in the game.

## Sending

```ts
import { account, notify } from '@mavonengine/core/Notifications/Notifiable'

await player.notify(new LevelUp(5)) // a connected player
await notify(account(accountId), new SeasonEnded()) // an account, connected or not
await notify([guildA, guildB], new WarDeclared()) // several at once
```

From a plugin, `ctx.plugin('@mavonengine/notifications')?.send(to, notification)` does the same.

- **A player is notified as its account.** The notification reaches every game the account has open, not only the connection `player` is. A player without an account (no auth plugin, or let in without one) has no id and is skipped.
- **It throws before reaching anyone** when the notification goes to a channel that doesn't exist, or to one it has no `to<Channel>()` for.
- **Resolves** once every channel has it: sent in the game, handed to the mail plugin, queued for a queued channel.

## Channels

### `game`

Sent over the game socket to every open connection of the recipient's account, right away. A player who isn't connected doesn't get it later. In the browser:

```ts
import { notifications } from '@mavonengine/notifications/client'

notifications(game).on(n => showToast(n.type, n.data))
notifications(game).onType<{ level: number }>('LevelUp', n => playFanfare(n.data.level))
```

Each notification also triggers the game event `notification`: `game.on('notification', n => …)`. It has the `id`, the `type` (the class name, or its static `notificationType`), what `toGame()` returned as `data`, and `sentAt`.

### `mail`

Sent through [`@mavonengine/mail`](../mail), which queues it, tries it again and keeps it among the failed jobs when it can't be sent. A notification with `queued = false` is mailed in the call.

An account's address comes from [`@mavonengine/auth`](../auth). Accounts without an email aren't mailed. Without the mail plugin, or without the auth plugin for accounts, the channel is skipped and the log says so once.

### Your own

```ts
ctx.plugin('@mavonengine/notifications')?.channel('discord', {
  queued: true,
  route: to => discordWebhookOf(to),
  async send(delivery) {
    await fetch(delivery.route as string, { method: 'POST', body: JSON.stringify(delivery.payload) })
  },
})
```

A notification goes to it with `'discord'` in `via()` and a `toDiscord()`. `route()` says where it goes for a recipient; undefined skips the channel for it. With `queued: true`, `send()` runs on the server's queue and is tried again when it throws.

## Making your own classes notifiable

Anything with a stable id can be notified: a guild, a team, a lobby. Extend `notifiable()` from the engine, which adds `notify()`:

```ts
import { notifiable } from '@mavonengine/core/Notifications/Notifiable'

class Guild extends notifiable(GuildRecord) {
  readonly notifiableType = 'guild'

  notifiableId() {
    return this.id
  }

  /** Where each channel goes for the guild: its members' games, its officers' inboxes */
  routeNotificationFor(channel: string) {
    if (channel === 'game')
      return this.memberAccountIds
    if (channel === 'mail')
      return this.officerEmails
  }
}

await guild.notify(new WarDeclared(enemy))
```

`notifiable()` without a class gives a base class of its own. A class that already extends something you can't change implements `Notifiable` itself, and `notify()` is one line: `return notify(this, notification)`.

`routeNotificationFor()` is optional, and wins over the channel's own route. Without it, `game` and `mail` only know accounts.

## Options

Set them under the plugin in `mavonengine.json`. All are optional.

| Option | Default | |
| --- | --- | --- |
| `verifiedEmailOnly` | `false` | Only mail accounts whose address was confirmed. The auth plugin can't confirm addresses yet, so turning this on mails nobody until it can |
| `tries` | `3` | How often a queued channel's delivery is tried |
| `backoffMs` | `[10000, 60000]` | How long to wait before trying again, in ms |

With more than one notifications plugin, `"notifications": "<package>"` in `mavonengine.json` picks the one `notify()` uses.

## Not yet

A `database` channel, to keep notifications for players who weren't connected and show them later, with read and unread.
