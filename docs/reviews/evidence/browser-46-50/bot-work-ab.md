| Model | Variant | Success | Wall ms, all attempts | Model requests | Input tokens | Output tokens | Cache read tokens | Cost USD |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| opendesign/deepseek-v4.1-flash-eco | baseline | 1/1 | 44600 | 7 | 0.128M (128365) | 0.002M (2229) | 0.101M (101248) | unknown |
| opendesign/deepseek-v4.1-flash-eco | candidate | 1/1 | 39019 | 6 | 0.112M (112052) | 0.002M (2087) | 0.083M (83328) | unknown |

| Model | Variant | Provider cache state | Requests | Input tokens | Cache read tokens |
| --- | --- | --- | ---: | ---: | ---: |
| opendesign/deepseek-v4.1-flash-eco | baseline | zero-cache-read-reported | 1 | 0.019M (19010) | 0.000M (0) |
| opendesign/deepseek-v4.1-flash-eco | baseline | cache-read-reported | 6 | 0.109M (109355) | 0.101M (101248) |
| opendesign/deepseek-v4.1-flash-eco | candidate | zero-cache-read-reported | 1 | 0.020M (19582) | 0.000M (0) |
| opendesign/deepseek-v4.1-flash-eco | candidate | cache-read-reported | 5 | 0.092M (92470) | 0.083M (83328) |

Provider cache state is observed, not proof of a cold provider cache.

Descriptive observations. Keep all failures. No speedup/significance claim from one repeat or unknown load/pricing.
