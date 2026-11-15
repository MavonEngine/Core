# @mavonengine/auth

A [MavonEngine](https://mavonengine.com) plugin that gives a multiplayer game player accounts. Players register and log in with a username and password, and the game server only lets clients connect with a session that works. Every connection then has a stable identity, the same account id on every reconnect, so mutes, scores and saves can be kept per player instead of per connection.

```sh
npx @mavonengine/cli install @mavonengine/sqlite
npx @mavonengine/cli install @mavonengine/auth
```

It keeps its accounts in the server's database, so it needs a database plugin such as [`@mavonengine/sqlite`](../sqlite). Without one it turns every client away with 503 and says so in the log.

## What it does

- **Accounts** with a username and password. Usernames are 3 to 32 letters, digits, `_`, `.` or `-`, unique regardless of case. Passwords are at least 8 characters and stored as scrypt hashes, built into Node, so there is nothing native to install.
- **Sessions**: logging in gives the browser a random token. The server only keeps its sha256 hash, so a leaked database holds no tokens that work. A session lasts 30 days from when it was last used.
- **Connection check**: the game connects with the session, and the server turns a client away before it gets a player: 401 without a session that works, 403 for a disabled account. A client that gets in has `{ id, name }` as its identity.
- **Login rate limit**: after 10 failed logins from one address for one username, that is refused for 15 minutes. An unknown username takes as long to refuse as a wrong password, so the answer doesn't tell which names exist.
- **Admin API**: list accounts, disable them, log them out everywhere. Disabling or logging out closes the account's game connections right away.
- **Other ways to log in**: plugins such as a Discord or GitHub login use `auth(server).signIn()` to log a player in to the same kind of account, linked to one they already have if they like. See [Login plugins](#login-plugins).

## Options

Set them under the plugin in `mavonengine.json`. All are optional.

```json
{
  "plugins": {
    "@mavonengine/auth": {
      "options": {
        "sessionDays": 30,
        "registration": true,
        "devGuests": false
      }
    }
  }
}
```

| Option | Default | |
| --- | --- | --- |
| `path` | `/api/auth` | Where the routes are |
| `registration` | `true` | Whether players can make an account with a username and password. Off, only existing accounts and login plugins work |
| `sessionDays` | `30` | How long a session lasts without being used. Every use, connecting included, moves it on |
| `devGuests` | `false` | Let clients without a session in as guests, without an identity, when `NODE_ENV` isn't `production`. Handy to open the editor without logging in. A production server never does |
| `loginAttempts` | `10` | Failed logins per address and username before they are refused for a while |
| `loginWindowMinutes` | `15` | How long those failed logins count |

The rate limit tells addresses apart by `req.ip`. Behind a reverse proxy, set Express's `trust proxy` in the server's `onHttp()` so that is the player's address and not the proxy's.

## In your game

### In the browser

The plugin sends the session when the game connects. Log the player in before you make the `NetworkManager`, and make a new one to connect again after logging in or out:

```ts
import { AuthRequestError, checkSession, currentAccount, login, logout, register } from '@mavonengine/auth/client'

// On start: is the stored session still good?
const account = await checkSession()
if (account)
  joinServer()

async function onLoginForm(username: string, password: string) {
  try {
    await login(username, password)
    joinServer()
  }
  catch (err) {
    if (err instanceof AuthRequestError)
      showError(err.message) // "Wrong username or password", "Too many failed logins, …"
  }
}
```

- `register(username, password)` and `login(username, password)` resolve with the account (`{ id, name }`) and keep the session in `localStorage`. They reject with an `AuthRequestError` carrying the server's `status` and message.
- `logout()` forgets the session, on the server too when it can be reached.
- `changePassword(current, password)` changes it and logs out every other device.
- `currentAccount()` is the stored account, without asking the server. `checkSession()` asks, and forgets a session the server no longer knows.
- `window` gets a `mavonengine:auth` event (`AUTH_EVENT`) with the account, or `null`, whenever the player logs in or out.

When the server turns the connection away, the `NetworkManager` triggers `connectError` with the `status`: 401 means log in again.

### On the server

Core gives every plugin and the game the identity of a connection: `ctx.identity(channel)` in a plugin, `player.identity` in the game. Key what should outlast a connection on `identity.id`:

```ts
export default defineServerPlugin({
  onConnection(channel, player, ctx) {
    const id = ctx.identity(channel)?.id
    if (id)
      loadSave(id)
  },
})
```

`auth(server)` from `@mavonengine/auth/server` looks after the accounts from the game's code:

```ts
import { auth } from '@mavonengine/auth/server'

await auth(server).disable(accountId) // can't log in or connect, its connections close
await auth(server).enable(accountId)
await auth(server).endSessions(accountId) // logged out everywhere, its connections close
const account = await auth(server).account(accountId)
```

## Routes

| Route | |
| --- | --- |
| `POST /api/auth/register` | `{ username, password }` → 201 `{ token, account, expiresAt }`. 409 for a taken name, 400 for one that can't be used, 403 with `registration` off |
| `POST /api/auth/login` | `{ username, password }` → `{ token, account, expiresAt }`. 401 wrong username or password, 403 disabled, 429 too many tries (with `Retry-After`) |
| `POST /api/auth/logout` | Ends the session sent as `Authorization: Bearer <token>`. 204 |
| `GET /api/auth/me` | `{ account }` of the session, 401 without one |
| `POST /api/auth/password` | `{ current, password }`, with the session. Every other session of the account ends. 204 |

The admin routes ask for the server's admin token (`Authorization: Bearer <admin token>`) like every admin route of the server, and without one only answer on the server's own machine:

| Route | |
| --- | --- |
| `GET /api/auth/accounts` | `{ accounts, total }`, newest first, with `?limit=` and `?offset=`. Each with `providers` and live `sessions`, never a password hash |
| `POST /api/auth/accounts/:id/disable` | It can't log in or connect, its sessions end, its connections close |
| `POST /api/auth/accounts/:id/enable` | It can log in again |
| `DELETE /api/auth/accounts/:id/sessions` | Logs it out everywhere and closes its connections. `{ ended }` |

The tables are `auth_accounts`, `auth_identities` and `auth_sessions`, and show in the dashboard's Database tab.

## Login plugins

A login through another service is a plugin of its own that does the service's part, such as the OAuth redirect, and then hands the user to this plugin:

```ts
import { auth } from '@mavonengine/auth/server'

app.get('/api/auth/discord/callback', async (req, res) => {
  const user = await discordUserFor(String(req.query.code))
  const session = await auth(ctx.server).signIn('discord', user.id, { name: user.username })
  // Hand session.token to the page, which keeps it like login() does
})
```

`signIn(provider, externalId, profile, options)` logs in the account linked to that user, and makes one the first time the user is seen. With `{ linkTo: accountId }`, a user seen the first time is linked to that account instead, so a player who has a password can log in with Discord too. It rejects with an `AuthError`: 403 for a disabled account, 409 when the user is already linked to another account.

A login plugin has no `authorize()` of its own: this plugin stays the one that checks connections, whichever way the player logged in.
