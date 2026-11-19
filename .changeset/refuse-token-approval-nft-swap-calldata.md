---
"nansen-cli": patch
---

`trade execute` now refuses an EVM swap or bridge transaction whose outer call is a token approval or NFT transfer method (`increaseAllowance`, `increaseApproval`, `setApprovalForAll`, ERC-721/1155 `safeTransferFrom`/`safeBatchTransferFrom`) or a direct Permit2 `transferFrom`/`approve`, before signing. A routed swap never makes these calls directly.
