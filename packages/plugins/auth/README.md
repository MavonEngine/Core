# @mavonengine/auth

A [MavonEngine](https://mavonengine.com) plugin that gives a multiplayer game player accounts. Players register and log in with a username and password, and the game server only lets clients connect with a session that works. Every connection then has a stable identity, the same account id on every reconnect, so mutes, scores and saves can be kept per player instead of per connection.

```sh
npx @mavonengine/cli install @mavonengine/sqlite
npx @mavonengine/cli install @mavonengine/auth
```

It keeps its accounts in the server's database, so it needs a database plugin such as [`@mavonengine/sqlite`](../sqlite). Without one it turns every client away with 503 and says so in the log.

## What it does

- **Accounts** with a username and password, and optionally an email. Usernames are 3 to 32 letters, digits, `_`, `.` or `-`, unique regardless of case. Passwords are at least 8 characters and stored as scrypt hashes, built into Node, so there is nothing native to install.
- **Email**: optional, unique regardless of case. The player sees it in its own account (`register`, `login`, `/me`), admins in the account list; the game's identity of a connection never has it. With the mail plugin, a link to confirm it is mailed to it. See [Email](#email).
- **Sessions**: logging in gives the browser a random token. The server only keeps its sha256 hash, so a leaked database holds no tokens that work. A session lasts 30 days from when it was last used.
- **Connection check**: the game connects with the session, and the server turns a client away before it gets a player: 401 without a session that works, 403 for a disabled account. A client that gets in has `{ id, name, session }` as its identity, `session` being a short, non-secret key that tells the account's sessions apart.
- **Guests**, when you turn them on: a player can start playing without signing up, as a guest account of their own. Guests connect alongside registered players, keep the same account while their browser keeps the session, and keep it for good when they register. See [Guests](#guests).
- **Forgotten passwords**: with the mail plugin, a player resets theirs with a link mailed to their email. See [Email](#email).
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
| `guests` | `false` | Let players play as guests, see [Guests](#guests) |
| `guestDays` | `30` | How long a guest session lasts without being used. Once it ran out, the guest account is deleted |
| `guestsPerHour` | `20` | Guest accounts one address may make per hour |
| `devGuests` | `false` | Let clients without any session in, without an identity, when `NODE_ENV` isn't `production`. Handy to open the editor without logging in. A production server never does. Not the same as `guests`, whose guests have accounts |
| `loginAttempts` | `10` | Failed logins per address and username before they are refused for a while |
| `loginWindowMinutes` | `15` | How long those failed logins count |
| `verifyEmail` | `true` | Mail a link to confirm an email when an account gets one |
| `verifyUrl` | the plugin's page | The game's own page for confirming, with `{token}`, see [Email](#email) |
| `resetUrl` | the plugin's page | The game's own page for a new password, with `{token}` |
| `resetsPerHour` | `5` | Password resets one address may ask for per hour |

The rate limit tells addresses apart by `req.ip`. Behind a reverse proxy, set Express's `trust proxy` in the server's `onHttp()` so that is the player's address and not the proxy's.

## Email

With [`@mavonengine/mail`](../mail), accounts' emails are confirmed and forgotten passwords reset with links mailed to them. The mails go out in the mail plugin's [layout](../mail#layout). Without the mail plugin, nothing is mailed, and the routes that need it answer 503.

```sh
npx @mavonengine/cli install @mavonengine/mail
```

- **Confirming:** an account that registers with an email, or changes it, gets a link that works for 24 hours. The link opens a page that asks before confirming, because mail scanners open links in mails. `emailVerified` in the player's own account, and `emailVerifiedAt` for admins and other plugins, say whether it was. A new email isn't confirmed, and links mailed before stop working.
- **Resetting:** `requestPasswordReset(email)` mails a link that works for 60 minutes, once, to the account with that email. It answers the same whether an account has that email or not, and before looking, so it doesn't tell which emails have accounts. The link opens a page for the new password. Setting it logs the account out everywhere, closes its game connections, and confirms the email, as the link proved it is the player's. Changing the password, or asking again, makes the link stop working. Accounts that log in through another service, guests and disabled accounts get no link.
- **Limits:** one email gets at most 3 mails of each kind an hour, however many ask, so nobody can fill an inbox through the game. One address may ask for `resetsPerHour` resets.
- **Links** go to the game's address, `appUrl` at the top of `mavonengine.json` (or `MAVONENGINE_APP_URL`), which a production server needs: links are never built from the address a request names, which whoever sends it chooses. In development the request's own address is used.

```json
{
  "appUrl": "https://mygame.com",
  "appName": "My Game",
  "plugins": {
    "@mavonengine/auth": {}
  }
}
```

The links open the plugin's own pages, which work in any game. A game with pages of its own points the links there, with `{token}` where the token goes, and sends the token on from them:

```json
{ "verifyUrl": "https://mygame.com/verify?token={token}", "resetUrl": "https://mygame.com/reset?token={token}" }
```

```ts
import { resetPassword, verifyEmail } from '@mavonengine/auth/client'

const token = new URLSearchParams(location.search).get('token')!
await verifyEmail(token) // on the verify page
await resetPassword(token, newPassword) // on the reset page: logs this browser in
```

## Guests

With `"guests": true`, players can play without signing up and alongside those who did:

```ts
import { checkSession, playAsGuest } from '@mavonengine/auth/client'

const account = await checkSession() ?? await playAsGuest()
joinServer()
```

- `playAsGuest()` makes a guest account, named like `Guest-4821`, and logs the browser in to it. A guest connects like any player, with `guest: true` in its identity, so the game can tell: `if (player.identity?.guest) …` to leave guests off the leaderboard, say.
- A guest has an account id like everyone else, so mutes, scores and saves keyed on `identity.id` work for guests too, and last across reconnects.
- `register(username, password)` from a guest's browser turns the guest account into a full one: same id, so the guest keeps everything the game kept for it. So does a [login plugin](#login-plugins) with `linkTo` the guest's account.
- A guest account only lasts as long as its session: `guestDays` without playing, clearing the browser's storage, or `logout()`. After that nobody can log in to it, and it is deleted. Tell guests to register to keep their progress, e.g. when `currentAccount()?.guest` is true.
- Disabling a guest account stops that account only: whoever it was can make another guest. `guestsPerHour` limits how many one address makes. For a game where bans must hold, leave guests off.

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

- `register(username, password, email?)`, `login(username, password)` and `playAsGuest()` resolve with the account (`{ id, name, email }`, and `guest: true` for a guest) and keep the session in `localStorage`. They reject with an `AuthRequestError` carrying the server's `status` and message.
- `logout()` forgets the session, on the server too when it can be reached. The server closes the game connection made with that session; the player's other devices stay in the game.
- `changePassword(current, password)` changes it and logs out every other device, closing their game connections.
- `changeEmail(email)` changes the email (`null` takes it away) and mails a link to confirm it. `resendVerification()` mails a new one.
- `requestPasswordReset(email)` mails a link to reset the password. Say "if an account has this email, we mailed it a link", as the answer is the same either way.
- `verifyEmail(token)` and `resetPassword(token, password)` are for games with pages of their own, see [Email](#email).
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

Other plugins get the same as `ctx.plugin('@mavonengine/auth')`, which is undefined when the project has no auth plugin, so they can do without accounts: `await ctx.plugin('@mavonengine/auth')?.account(id)`.

## Routes

| Route | |
| --- | --- |
| `POST /api/auth/register` | `{ username, password, email? }` → 201 `{ token, account, expiresAt }`. Sent with a guest's session, that guest account becomes this one. 409 for a taken name or email, 400 for one that can't be used, 403 with `registration` off |
| `POST /api/auth/guest` | With `guests` on: makes a guest account and logs it in, 201 `{ token, account, expiresAt }`. 403 with guests off, 429 after `guestsPerHour` from one address |
| `POST /api/auth/login` | `{ username, password }` → `{ token, account, expiresAt }`. 401 wrong username or password, 403 disabled, 429 too many tries (with `Retry-After`) |
| `POST /api/auth/logout` | Ends the session sent as `Authorization: Bearer <token>`, and closes the game connections made with it. 204 |
| `GET /api/auth/me` | `{ account }` of the session, 401 without one |
| `POST /api/auth/password` | `{ current, password }`, with the session. Every other session of the account ends. 204 |
| `POST /api/auth/email` | `{ email }`, or `null`, with the session. Mails a link to confirm a new one. `{ account }`, 409 for a taken email or a guest |
| `POST /api/auth/verify-email/send` | With the session: mails a new confirmation link. 202, 409 without an email or when it is confirmed, 429 after too many |
| `GET /api/auth/verify-email?token=` | The page a confirmation link opens |
| `POST /api/auth/verify-email` | `{ token }` → `{ account }`, confirmed. No session needed. 400 for a link that doesn't work any more |
| `POST /api/auth/forgot-password` | `{ email }` → 202, whether an account has it or not. 429 after `resetsPerHour` from one address |
| `GET /api/auth/reset-password?token=` | The page a reset link opens |
| `POST /api/auth/reset-password` | `{ token, password }` → `{ token, account, expiresAt }`, logged in, every other session ended. 400 for a link that doesn't work or a password that can't be used |

The routes that mail answer 503 without a mail plugin, and in production without the game's `appUrl` in `mavonengine.json`.

The admin routes ask for the server's admin token (`Authorization: Bearer <admin token>`) like every admin route of the server, and without one only answer on the server's own machine:

| Route | |
| --- | --- |
| `GET /api/auth/accounts` | `{ accounts, total }`, newest first, with `?limit=` and `?offset=`. Each with `email`, `emailVerifiedAt`, `lastLoginAt`, `guest`, `providers` and live `sessions`, never a password hash |
| `POST /api/auth/accounts/:id/disable` | It can't log in or connect, its sessions end, its connections close |
| `POST /api/auth/accounts/:id/enable` | It can log in again |
| `DELETE /api/auth/accounts/:id/sessions` | Logs it out everywhere and closes its connections. `{ ended }` |

The tables are `auth_accounts`, `auth_identities`, `auth_sessions` and `auth_tokens` (mailed links, by the hash of their token only), and show in the dashboard's Database tab.

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

`signIn(provider, externalId, profile, options)` logs in the account linked to that user, and makes one the first time the user is seen. A `profile.email` is kept on an account that has none, unless another account has it; pass `emailVerified: true` when the provider checked it. With `{ linkTo: accountId }`, a user seen the first time is linked to that account instead, so a player who has a password can log in with Discord too. It rejects with an `AuthError`: 403 for a disabled account, 409 when the user is already linked to another account.

A login plugin has no `authorize()` of its own: this plugin stays the one that checks connections, whichever way the player logged in.
