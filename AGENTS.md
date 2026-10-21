# Project instructions

- Never commit or push without explicit user approval. Present the changes and proposed commit message first.
- Use fff first for file discovery and content searches in this repository. Fall back to shell searches only if unavailable, failing, or unable to cover the scope.
- This is the standalone Paseo Usage plugin. Keep client components in `client/`, backend code in `server/`, and RPC contracts in `shared/`.
- Use the installed Paseo SDK types as the implementation contract. The checked target is Paseo 0.12.0; verify before claiming newer compatibility.
- Use pnpm through VitePlus: `vp install`, `vp run`, `vp check`, and `vp fmt`.
- Historical usage must come directly from provider-owned logs/databases or Cursor’s account usage API. Never introduce a dependency on T3 Code caches, databases, settings, or usage data.
- Keep credentials, transcripts, personal log fixtures, and machine-specific usage reports out of the repository. Tests use synthetic records.
- Preserve upstream attribution and license notices in THIRD_PARTY_NOTICES.md.
- Report static checks, daemon loading, and desktop interaction as separate evidence.
