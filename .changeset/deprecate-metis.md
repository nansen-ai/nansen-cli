---
"nansen-cli": patch
---

Drop `metis` from the `profiler first-funder` endpoint's accepted chains, completing the removal of the chains the product is deprecating (the other eleven — algorand, aptos, bitlayer, chiliz, gravity, katana, plasma, sonic, stacks, ton and viction — were already retired on 2026-11-25). `--chain metis` on that endpoint is now rejected locally before a request is sent.
