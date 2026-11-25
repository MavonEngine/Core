const SCOPE = '@mavonengine/'
const NOT_NAME_CHARS = /[^a-z0-9]+/g
const EDGE_UNDERSCORES = /^_+|_+$/g
const LEADING_DIGIT = /^\d/
const TABLE_NAME = /^[a-z\d]\w*$/i

/**
 * The prefix of a plugin's tables, from its package name: `@mavonengine/chat` → `chat`, `@acme/chat` → `acme_chat`,
 * `my-plugin` → `my_plugin`. Only lowercase letters, digits and underscores, so it is a valid name in any database.
 */
export function tablePrefix(pkg: string): string {
  const name = pkg.startsWith(SCOPE)
    ? pkg.slice(SCOPE.length)
    : pkg
  const prefix = name
    .toLowerCase()
    .replace(NOT_NAME_CHARS, '_')
    .replace(EDGE_UNDERSCORES, '')

  if (!prefix)
    throw new Error(`Package name ${JSON.stringify(pkg)} gives no table prefix`)

  return LEADING_DIGIT.test(prefix)
    ? `p_${prefix}`
    : prefix
}

/** The name of a plugin's table in the database: `tableName('@mavonengine/chat', 'mutes')` → `chat_mutes` */
export function tableName(pkg: string, name: string): string {
  if (!TABLE_NAME.test(name))
    throw new Error(`Table name ${JSON.stringify(name)} may only have letters, digits and underscores, and must start with a letter or digit`)

  return `${tablePrefix(pkg)}_${name}`
}

/** Where the engine records which of a plugin's migrations ran. Two underscores, so no `table()` of the plugin can be it */
export function migrationsTableName(pkg: string): string {
  return `${tablePrefix(pkg)}__migrations`
}
