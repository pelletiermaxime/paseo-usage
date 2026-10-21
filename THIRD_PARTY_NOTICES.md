# Third-party notices

The Usage layout and adapted Codex, Claude, and pricing parsers are based on [T3 Code](https://github.com/pingdotgg/t3code), revision e64766c56ac6fc1678e6107052feb0047a35337f.

Additional Grok, Pi, OpenCode, Antigravity, and Cursor history readers are adapted from revision **8a9d0e0dd553c5b0bd943ddfd9741d6bab0e486f**:

- `packages/provider-grok/src/server/usage.ts` and its synthetic tests → `server/grok.ts`, `tests/grok.test.ts`.
- `packages/provider-pi/src/server/usage.ts` → `server/pi.ts`.
- `packages/provider-opencode/src/server/usage.ts` → `server/opencode.ts`.
- `apps/server/src/provider/Drivers/AntigravityUsage.ts` and `antigravityUsageReader.ts` → `server/antigravity.ts`, provider discovery in `server/history.ts`.
- `packages/provider-cursor/src/server/accountUsage.ts`, `CursorUsageAccounts.ts`, and `CursorKeychain.ts` → `server/cursor.ts`.

The port replaces upstream Effect services and T3-specific discovery/cache dependencies with standalone Node.js readers and the Paseo SDK. It preserves the upstream MIT notice below and uses no T3 Code runtime, stored usage, or private state.

MIT License

Copyright (c) 2026 T3 Tools Inc.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

Model-price data downloaded at runtime (not bundled): [LiteLLM](https://github.com/BerriAI/litellm/blob/main/model_prices_and_context_window.json). LiteLLM is MIT licensed, copyright (c) 2023 Berri AI.

MIT License

Copyright (c) 2023 Berri AI

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
