---
"nansen-cli": patch
---

Stop accepting and listing the chains the Nansen API retired on 2026-11-25 (algorand, aptos, bitlayer, chiliz, gravity, katana, plasma, sonic, stacks, ton, viction): research commands now reject them before sending a request. mantra, citrea and stellar stay accepted on the endpoints that still serve them.
