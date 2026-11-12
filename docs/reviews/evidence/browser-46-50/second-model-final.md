| Model | Variant | Success | Wall ms, all attempts | Model requests | Input tokens | Output tokens | Cache read tokens | Cost USD |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| codex/gpt-6.1-sol | candidate | 9/9 | 191642 | 29 | 0.670M (670014) | 0.002M (2341) | 0.403M (402816) | unknown |

| Model | Variant | Provider cache state | Requests | Input tokens | Cache read tokens |
| --- | --- | --- | ---: | ---: | ---: |
| codex/gpt-6.1-sol | candidate | zero-cache-read-reported | 10 | 0.204M (203830) | 0.000M (0) |
| codex/gpt-6.1-sol | candidate | cache-read-reported | 19 | 0.466M (466184) | 0.403M (402816) |

Provider cache state is observed, not proof of a cold provider cache.

Descriptive observations. Keep all failures. No speedup/significance claim from one repeat or unknown load/pricing.
