---
"nansen-cli": patch
---

Fix `consumeSSEStream` silently dropping the final SSE event when the stream closes without a trailing blank line (e.g. a `finish` event carrying `conversation_id`, or a trailing `delta` chunk).
