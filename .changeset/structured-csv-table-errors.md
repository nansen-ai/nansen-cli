---
"nansen-cli": patch
---

`--table` and `--format csv` error output now includes the error `code`, HTTP `status`, and `details` instead of only the message. CSV errors are emitted as a header row plus one record; table errors keep the leading `Error:` line and add one `key: value` line per field.
