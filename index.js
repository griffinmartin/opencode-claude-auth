// OpenCode 2 resolves a configured plugin directory by looking for ./server.*
// first, then ./index.*. Re-export the dual V1/V2 entrypoint so a local checkout
// can be configured directly, e.g. plugins: ["file:///path/to/opencode-claude-auth"].
export { default } from "./opencode-claude-auth.js"
