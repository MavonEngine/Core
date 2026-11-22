/**
 * The admin panel's stylesheet. Kept in code rather than a .css file next to it, because game servers bundle the
 * engine (e.g. with tsup), and a file read relative to this module would then be looked for next to the bundle.
 *
 * The colors are those of the mavonengine CLI dashboard's dark theme, and pages can use the same custom properties
 * and the .adm-* helpers.
 */
export const ADMIN_CSS = `:root {
  --background: #05070a;
  --surface: #0a0e14;
  --surface-raised: #111821;
  --border: #243040;
  --foreground: #c6d0db;
  --muted: #8394a8;
  --primary: #58a6ff;
  --info: #56d4dd;
  --success: #5fff87;
  --warning: #ffd75f;
  --danger: #ff6b6b;
  --mono: ui-monospace, SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace;
  --sidebar-width: 15rem;
  color-scheme: dark;
}

* {
  box-sizing: border-box;
}

html,
body {
  height: 100%;
}

body.adm {
  margin: 0;
  display: flex;
  flex-direction: column;
  background: var(--background);
  color: var(--foreground);
  font: 13px/1.45 var(--mono);
}

[hidden] {
  display: none !important;
}

.adm a {
  color: var(--primary);
}

.adm-shell {
  display: flex;
  flex: 1;
  min-height: 0;
}

/* ---------------------------------------------------------------- Sidebar */

.adm-sidebar {
  display: flex;
  flex-direction: column;
  flex: none;
  width: var(--sidebar-width);
  border-right: 1px solid var(--border);
  background: var(--surface);
  overflow-y: auto;
}

.adm-brand {
  display: flex;
  flex-direction: column;
  padding: 1rem 1.1rem 0.9rem;
  border-bottom: 1px solid var(--border);
  text-decoration: none;
}

.adm-brand-name {
  color: var(--primary);
  font-weight: 700;
}

.adm-brand-app {
  color: var(--muted);
  font-size: 12px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.adm-group {
  padding: 0.9rem 0.6rem 0.2rem;
}

.adm-group-label {
  margin: 0 0 0.35rem;
  padding: 0 0.5rem;
  color: var(--muted);
  font-size: 11px;
  font-weight: 400;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.adm-nav,
.adm-subnav {
  margin: 0;
  padding: 0;
  list-style: none;
}

.adm .adm-link {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  padding: 0.4rem 0.5rem;
  border-radius: 5px;
  color: var(--foreground);
  text-decoration: none;
}

.adm .adm-link:hover {
  background: var(--surface-raised);
}

.adm .adm-link[aria-current='page'] {
  background: var(--surface-raised);
  color: var(--primary);
}

.adm-icon {
  flex: none;
  width: 16px;
  height: 16px;
  fill: none;
  stroke: currentColor;
  stroke-width: 2;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.adm-icon-letter {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 1px solid currentColor;
  border-radius: 4px;
  font-size: 10px;
  font-weight: 700;
}

.adm-subnav {
  margin: 0.15rem 0 0.3rem 1.05rem;
  padding-left: 0.85rem;
  border-left: 1px solid var(--border);
}

.adm .adm-subnav a {
  display: block;
  padding: 0.25rem 0.5rem;
  border-radius: 4px;
  color: var(--muted);
  text-decoration: none;
}

.adm .adm-subnav a:hover {
  color: var(--foreground);
}

.adm .adm-subnav a[aria-current='page'] {
  color: var(--primary);
}

/* ---------------------------------------------------------------- Main area */

.adm-main {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-width: 0;
  min-height: 0;
}

.adm-topbar {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  min-height: 2.9rem;
  padding: 0 1rem;
  border-bottom: 1px solid var(--border);
}

.adm-title {
  margin: 0;
  font-size: 14px;
  font-weight: 700;
}

.adm-menu {
  display: none;
  padding: 0.3rem;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: none;
  color: var(--foreground);
  cursor: pointer;
}

.adm-content {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
  overflow: auto;
}

.adm-backdrop {
  display: none;
}

/* ---------------------------------------------------------------- Helpers for pages */

.adm-page {
  display: flex;
  flex-direction: column;
  gap: 1rem;
  padding: 1rem;
}

.adm-muted {
  color: var(--muted);
}

.adm-cards {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(9rem, 1fr));
  gap: 1rem;
}

.adm-card {
  min-width: 0;
  overflow-wrap: anywhere;
  padding: 0.75rem 1rem;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--surface);
}

.adm-card h2 {
  margin: 0 0 0.4rem;
  color: var(--muted);
  font-size: 12px;
  font-weight: 400;
}

.adm-stat {
  font-size: 20px;
  font-weight: 700;
}

.adm .adm-card-link {
  display: block;
  color: var(--foreground);
  text-decoration: none;
}

.adm .adm-card-link:hover {
  border-color: var(--primary);
}

.adm-table-wrap {
  overflow-x: auto;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--surface);
}

.adm-table {
  width: 100%;
  border-collapse: collapse;
}

.adm-table th {
  position: sticky;
  top: 0;
  padding: 0.45rem 0.75rem;
  border-bottom: 1px solid var(--border);
  background: var(--surface);
  color: var(--muted);
  font-weight: 400;
  text-align: left;
  white-space: nowrap;
}

.adm-table td {
  padding: 0.35rem 0.75rem;
  border-bottom: 1px solid var(--border);
  vertical-align: top;
}

.adm-table tr:last-child td {
  border-bottom: none;
}

.adm-badge {
  display: inline-block;
  padding: 0 0.4rem;
  border: 1px solid currentColor;
  border-radius: 3px;
  font-size: 11px;
}

.adm-success {
  color: var(--success);
}

.adm-warning {
  color: var(--warning);
}

.adm-danger {
  color: var(--danger);
}

.adm-toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.5rem;
}

.adm-toolbar .adm-spacer {
  flex: 1;
}

.adm-input {
  min-width: 14rem;
  padding: 0.4rem 0.6rem;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: var(--background);
  color: var(--foreground);
  font: inherit;
}

.adm-input:focus {
  outline: none;
  border-color: var(--primary);
}

.adm-button,
.adm a.adm-button {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
  padding: 0.3rem 0.7rem;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: var(--surface-raised);
  color: var(--foreground);
  font: inherit;
  text-decoration: none;
  white-space: nowrap;
  cursor: pointer;
}

.adm-button:hover {
  border-color: var(--primary);
}

.adm-button-primary {
  border-color: var(--primary);
  color: var(--primary);
}

.adm-button-danger {
  color: var(--danger);
}

.adm-button-danger:hover {
  border-color: var(--danger);
}

.adm-button[disabled],
.adm a.adm-button[aria-disabled='true'] {
  opacity: 0.4;
  pointer-events: none;
}

/* A form that is only a button, e.g. in a table row */
.adm-inline-form {
  display: inline;
  margin: 0;
}

.adm-actions {
  display: flex;
  gap: 0.35rem;
}

.adm-nowrap {
  white-space: nowrap;
}

.adm-small {
  font-size: 11px;
}

.adm-notice {
  margin: 0;
  padding: 0.5rem 0.75rem;
  border: 1px solid var(--border);
  border-left: 3px solid var(--primary);
  border-radius: 4px;
  background: var(--surface);
}

.adm-notice.adm-danger {
  border-left-color: var(--danger);
}

.adm-pager {
  display: flex;
  align-items: center;
  gap: 0.75rem;
}

/* Key and value pairs: <dl class="adm-values"><dt>Name</dt><dd>Value</dd></dl> */
.adm-values {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 0.3rem 1rem;
  margin: 0;
}

.adm-values dt {
  color: var(--muted);
}

.adm-values dd {
  margin: 0;
  text-align: right;
  overflow-wrap: anywhere;
}

/* Cards side by side, as many as fit */
.adm-sections {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(17rem, 1fr));
  gap: 1rem;
  align-items: start;
}

.adm-sections .adm-card {
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
}

.adm-section-title {
  margin: 0.5rem 0 0;
  color: var(--muted);
  font-size: 11px;
  font-weight: 400;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

/* A whole tool in the content area, e.g. a dev inbox: <iframe class="adm-frame" src="…"> */
.adm-frame {
  flex: 1;
  width: 100%;
  min-height: 0;
  border: 0;
  background: var(--background);
}

/* ---------------------------------------------------------------- Small screens */

@media (max-width: 800px) {
  .adm-menu {
    display: inline-flex;
  }

  .adm-sidebar {
    position: fixed;
    inset: 0 auto 0 0;
    z-index: 20;
    transform: translateX(-100%);
    transition: transform 0.15s ease;
  }

  .adm-sidebar.open {
    transform: none;
  }

  .adm-backdrop {
    display: block;
    position: fixed;
    inset: 0;
    z-index: 10;
    background: rgb(0 0 0 / 50%);
  }
}
`
