# @mavonengine/chat

A [MavonEngine](https://mavonengine.com) plugin that adds text chat to a multiplayer game. It puts a chat box in the bottom left corner of the game, passes what players type to each other over the game's own connection, and gives the server the usual protections: a length limit, a rate limit, mutes and an admin API.

```sh
npx @mavonengine/cli install @mavonengine/chat
```

Restart the game server, and press `Enter` in the game to type.

## What it does

- **Chat box**: a message log and an input, built with plain DOM so it works whatever your UI is made with. `Enter` starts typing and sends, `Escape` leaves. While you type, the keys don't reach the game.
- **Server side checks**: what a player sends is cleaned up (control characters and line breaks become spaces), limited in length and limited in rate. A message that is not passed on gets the sender a notice saying why.
- **Proximity chat**: with a `range`, only players that close to the sender hear a message.
- **Join and leave notices**: "Ada joined", "Ada left", by the name the game gave the player.
- **History**: a client that connects is sent the recent messages.
- **Mutes and announcements**: through the admin API, see below.
- **Hooks for your game**: callbacks that change, drop, answer or redirect messages on the server, and listeners for messages, notices and the history in the browser. See [In your game](#in-your-game).
- **Restylable**: a corner to sit in, colours as CSS custom properties, and plain class names for the rest. See [Styling](#styling).

Messages are always shown as text, never as HTML, on the server and in the browser.

## Options

Set them under the plugin in `mavonengine.json`. All are optional.

```json
{
  "plugins": {
    "@mavonengine/chat": {
      "options": {
        "maxLength": 200,
        "rateLimit": { "messages": 5, "perSeconds": 10 },
        "history": 50,
        "range": 0,
        "announce": true
      }
    }
  }
}
```

| Option | Default | |
|---|---|---|
| `maxLength` | `200` | Longest message, in characters. Also the limit of the input |
| `rateLimit` | `5` per `10` s | How many messages a player may send within how many seconds |
| `history` | `50` | Recent messages sent to a client that connects. `0` for none |
| `range` | `0` | How far a message is heard, in world units. `0` means everyone hears it. With a range no history is sent, since it could have been said out of earshot |
| `announce` | `true` | Say so in the chat when a player joins or leaves |
| `path` | `/api/chat` | URL path of the admin API |
| `openKey` | `Enter` | Key that starts typing |
| `placeholder` | `Press Enter to chat` | Shown in the empty input |
| `position` | `bottom-left` | Corner the chat box sits in: `bottom-left`, `bottom-right`, `top-left` or `top-right` |
| `maxMessages` | `100` | Lines the chat box keeps |
| `ui` | `true` | `false` leaves the chat box out, for a game that shows the chat itself, see [In the browser](#in-the-browser) |

## Names

A player is called by its `displayName` when the game set one with `setDisplayName()`, else by its `name` field, else by its id. The join notice waits up to two seconds for the game to name a new player.

## In your game

The game listens in on the chat and has its say in it through `chat()`, on the server and in the browser. Every function that registers a callback returns a function that removes it again.

### On the server

```ts
import { chat } from '@mavonengine/chat/server'

const hooks = chat(server)
```

Call it any time, also before `server.start()`: what you register applies once the plugin runs.

**`hooks.intercept(callback)`** has a say in every message a player sends, before it goes out. It runs after the chat's own checks (mute, length, rate limit) and gets the cleaned up text and the sender. What it returns decides what happens:

| Returns | The message |
|---|---|
| nothing | goes out as it is |
| `false` | is dropped, and nobody is told |
| a string | goes out with that text instead |
| `{ text?, to? }` | goes out with that text, and with `to` only to those player ids and its sender. It is then left out of the history |

```ts
// A word filter
hooks.intercept(message => message.text.replace(/\bdarn\b/gi, '****'))

// A command: answer the sender alone and send nothing
hooks.intercept((message, tools) => {
  if (message.text !== '/roll')
    return
  tools.reply(`You rolled ${1 + Math.floor(Math.random() * 6)}`)
  return false
})

// A whisper: /w <player id> <text>
hooks.intercept((message) => {
  const whisper = /^\/w (\S+) (.+)$/.exec(message.text)
  if (whisper)
    return { text: whisper[2], to: [whisper[1]] }
})
```

`tools.reply(text)` tells the sender something nobody else sees, and `tools.player` is the sender's entity. Interceptors run in the order they were added. One that throws drops the message and logs the error, so a bug in a filter doesn't let through what it was meant to stop.

**`hooks.onMessage(callback)`** is told every message after it went out, also those of the server itself (`message.from` is `null`), with the ids of the players who got it:

```ts
hooks.onMessage((message, { recipients }) => {
  database.saveChat(message.from?.id ?? null, message.text, recipients)
})
```

**`hooks.announce(text)`**, **`hooks.mute(playerId, minutes?)`** and **`hooks.unmute(playerId)`** do what the admin API does, and **`hooks.room`** is the chat itself, with its history, mutes and options.

### In the browser

```ts
import { chat } from '@mavonengine/chat/client'

const talk = chat(game)

// Every message as it is said, e.g. for a bubble over the player who spoke
talk.onMessage((message) => {
  if (message.from)
    world.entities.items.get(message.from.id)?.showChatBubble(message.text)
})

// What the server says to this player alone, like "you are sending messages too fast"
talk.onNotice(text => hud.toast(text))

// The recent messages, sent when the game connects
talk.onHistory(messages => myChat.fill(messages))

// Say something as the player. False while the game isn't connected
talk.send('gg')
```

The same three arrive as events on the game, for code that would rather listen there: `chat:message`, `chat:notice` and `chat:history`.

**The chat box** is `talk.box`: add lines of your own with `box.add(message)` and `box.notice(text)`, or take it off screen with `box.hide()` and `box.show()`.

**Your own chat UI**: set `"ui": false` in the plugin's options and build it on `onMessage`, `onNotice`, `onHistory` and `send`. You get everything the built-in box gets.

## Styling

- **Where it sits**: `"position"` in the options, one of `bottom-left` (default), `bottom-right`, `top-left` and `top-right`.
- **Colours**: CSS custom properties on `.mavonengine-chat`. Set them in your own stylesheet:

```css
.mavonengine-chat {
  --chat-bg: rgb(20 10 30 / 80%);
  --chat-bg-idle: rgb(20 10 30 / 40%);
  --chat-text: #fff;
  --chat-muted: #b8a9c9;
  --chat-accent: #c77dff;
  --chat-border: rgb(255 255 255 / 20%);
}
```

- **Everything else**: the box is plain DOM with global class names, so your CSS can restyle any part of it: `.mavonengine-chat` (the box), `.mavonengine-chat-log`, `.mavonengine-chat-input`, `.mavonengine-chat-name`, `.mavonengine-chat-system` (what the server says) and `.mavonengine-chat-notice`. The box has the class `open` while it is being typed in.

## Admin API

| | |
|---|---|
| `GET /api/chat/messages` | The recent messages |
| `POST /api/chat/messages` | Announce something: `{ "text": "Server restarts in 5 minutes" }` |
| `GET /api/chat/mutes` | The players that are muted |
| `POST /api/chat/mutes` | Mute a player: `{ "playerId": "…", "minutes": 10 }`. Without `minutes` until it is lifted |
| `DELETE /api/chat/mutes/:playerId` | Unmute a player |

The API is guarded by the game server's admin token, the same one as every other admin route of the server: set `MAVONENGINE_ADMIN_TOKEN` (or `adminToken` in the server's options) and send it as `Authorization: Bearer <token>`. Without one the API only answers requests from localhost. The chat has no token of its own.

```sh
curl -X POST localhost:8050/api/chat/mutes -d '{ "playerId": "abc123", "minutes": 10 }'
curl -X POST https://game.example.com/api/chat/mutes -H "Authorization: Bearer $MAVONENGINE_ADMIN_TOKEN" -d '{ "playerId": "abc123" }'
```

Player ids are the ones `mavonengine dashboard` lists on its Players tab.

## Limits

- A player is known by the id of its connection. A muted player that connects again has a new id and is no longer muted. Lasting mutes need accounts, which the engine doesn't have yet.
- There is one conversation, with no built-in channels or private messages. A game can add them with `intercept`, which can send a message to some players only, but the chat box has no tabs to show them apart.
- Interceptors are synchronous: a check that has to wait for something, like a moderation service, isn't supported.
- Nothing is stored. The history and the mutes are gone when the server restarts. `onMessage` on the server is the place to save messages yourself.
