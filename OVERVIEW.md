Usage brings token usage, API cost estimates and subscription limits into a dedicated Paseo page. Adapted from [T3 Code](https://github.com/pingdotgg/t3code), it reads provider history directly and includes sessions created outside Paseo.

Compare Codex, Claude Code, Grok Build, OpenCode, Antigravity, Pi and Cursor across the past 24 hours or 7, 30 and 90 days. Charts, provider filters and model breakdowns show processed tokens, cached input, output, cache savings and recorded speed. Select a model to inspect its usage and pricing. Costs are API-equivalent estimates; subscription billing can differ.

Open Usage from the sidebar or the Open Usage command. Local history is read from provider session logs and conversation databases on the selected Paseo host. Use the host menu's History sources settings to add account homes or custom provider directories. Missing or deleted history cannot be reconstructed, and unreadable or incomplete sources are flagged on the page.

Cursor history requires a saved Cursor CLI login. The plugin reads that login on the host and uses it to request account-wide usage from cursor.com, including usage from other machines. On macOS, Keychain access must be enabled explicitly in History sources and may prompt for permission. Credentials remain on the host apart from authenticating requests to Cursor; they are never returned to the Usage page or saved in plugin preferences. Local conversation contents are not uploaded.

Model prices are downloaded from LiteLLM on GitHub and cached on the host for 12 hours. Model prices settings let you override USD prices per million tokens and map model names. Usage without a known price is marked Unpriced; incomplete estimates are labelled partial. Preferences, custom prices and source paths are stored per host in Paseo.

The Limits view shows the plans, quota windows, balances and reset times exposed by Paseo's public provider API. Available information depends on the providers and accounts signed in on the host. Paseo may cache these readings for up to five minutes, so checking again can return the same values.

This version targets Paseo 0.12.0. GitHub installation requires VitePlus (`vp`) in the daemon's PATH. OpenCode and Antigravity history also require the host's built-in SQLite support; other history sources remain usable when it is unavailable.
