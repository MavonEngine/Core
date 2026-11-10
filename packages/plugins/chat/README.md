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
| `adminToken` | | Token the admin API asks for. Also `MAVONENGINE_CHAT_ADMIN_TOKEN` |
| `openKey` | `Enter` | Key that starts typing |
| `placeholder` | `Press Enter to chat` | Shown in the empty input |
| `maxMessages` | `100` | Lines the chat box keeps |
| `ui` | `true` | `false` leaves the chat box out, for a game that shows the chat itself |

## Names

A player is called by its `displayName` when the game set one with `setDisplayName()`, else by its `name` field, else by its id. The join notice waits up to two seconds for the game to name a new player.

## In your game

Every message reaches the game as an event, for example to show a bubble over the player who spoke:

```ts
import type { ChatMessage } from '@mavonengine/chat/protocol'

game.on('chat:message', (message: ChatMessage) => {
  if (message.from)
    world.entities.items.get(message.from.id)?.showChatBubble(message.text)
})
```

To build your own chat UI, set `"ui": false` and use the same event to show messages and `sendChat()` to send them. On the server, `announce(ctx, text)` says something to everyone as the server, and `chatRoom(ctx)` is the chat itself, with `mute()` and `unmute()`.

The colours of the chat box are CSS custom properties on `.mavonengine-chat`: `--chat-bg`, `--chat-bg-idle`, `--chat-text`, `--chat-muted`, `--chat-accent` and `--chat-border`.

## Admin API

| | |
|---|---|
| `GET /api/chat/messages` | The recent messages |
| `POST /api/chat/messages` | Announce something: `{ "text": "Server restarts in 5 minutes" }` |
| `GET /api/chat/mutes` | The players that are muted |
| `POST /api/chat/mutes` | Mute a player: `{ "playerId": "…", "minutes": 10 }`. Without `minutes` until it is lifted |
| `DELETE /api/chat/mutes/:playerId` | Unmute a player |

Without an `adminToken` the API only answers requests from localhost. With one, it wants `Authorization: Bearer <token>` from everyone.

```sh
curl -X POST localhost:8050/api/chat/mutes -d '{ "playerId": "abc123", "minutes": 10 }'
```

Player ids are the ones `mavonengine dashboard` lists on its Players tab.

## Limits

- A player is known by the id of its connection. A muted player that connects again has a new id and is no longer muted. Lasting mutes need accounts, which the engine doesn't have yet.
- There is one conversation: no channels or private messages.
- Nothing is stored. The history and the mutes are gone when the server restarts.
