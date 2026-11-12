| Model | Variant | Success | Wall ms, all attempts | Model requests | Input tokens | Output tokens | Cache read tokens | Cost USD |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| opendesign/deepseek-v4.1-flash-eco | baseline | 6/8 | 529564 | 81 | unknown | unknown | unknown | unknown |
| opendesign/deepseek-v4.1-flash-eco | candidate | 7/8 | 166782 | 26 | 0.594M (594386) | 0.005M (5436) | 0.430M (430464) | unknown |

| Model | Variant | Provider cache state | Requests | Input tokens | Cache read tokens |
| --- | --- | --- | ---: | ---: | ---: |
| opendesign/deepseek-v4.1-flash-eco | baseline | zero-cache-read-reported | 7 | 0.136M (136147) | 0.000M (0) |
| opendesign/deepseek-v4.1-flash-eco | baseline | cache-read-reported | 73 | 1.807M (1807455) | 1.761M (1761408) |
| opendesign/deepseek-v4.1-flash-eco | baseline | unknown | 1 | unknown | unknown |
| opendesign/deepseek-v4.1-flash-eco | candidate | zero-cache-read-reported | 6 | 0.120M (120056) | 0.000M (0) |
| opendesign/deepseek-v4.1-flash-eco | candidate | cache-read-reported | 20 | 0.474M (474330) | 0.430M (430464) |

Provider cache state is observed, not proof of a cold provider cache.

Descriptive observations. Keep all failures. No speedup/significance claim from one repeat or unknown load/pricing.
