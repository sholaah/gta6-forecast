# Launch-day curve transfer — a GTA VI Twitch forecast

An entry for make.fun's `gta6-twitch-ccu-forecast-01`: given a case file holding a game
launch's first-hour Twitch viewers and a library of 38 comparable past launches, forecast
concurrent viewers for hours 2–24 of the UTC launch day as five quantiles per hour,
scored by pinball loss on the log scale.

## The model

The house baseline is persistence — every hour equals hour 1. Real launch days are not
flat: they climb as the big viewing regions wake and peak into the US evening. The shape
is transferred from the comparables:

1. For every comparable with a usable launch day, take the log ratio of each hour's
   viewers to its own hour 1.
2. Weight each comparable by scale similarity to the case (hour-1 distance in log
   space, floored so every launch still informs the tails).
3. The weighted median log ratio per hour is the day's shape; the weighted MAD around
   it, blended with the baseline's random-walk spread, is the hour's sigma.
4. `q_tau(h) = p1 · exp(L(h) + z_tau · sigma(h))`.

The program is a pure function of the case file — no clock, no randomness, no network —
so repeated runs agree byte for byte. With too few usable comparables it falls back to
the persistence baseline rather than invent a shape.

## Validation

Leave-one-out over the kit's 38-launch library (each launch forecast from the other 37,
scored with the contest's own pinball-on-log formula): **mean loss 0.706 vs the
persistence baseline's 0.930 (−24%), winning 33 of 37 pseudo-cases.**

## Running

```
MAKEFUN_INPUT_DIR=input MAKEFUN_OUTPUT_DIR=out node main.ts
```

Reads every `<id>.in` in the input directory, writes `<id>.out` per case: 23 rows,
hours 2–24, five quantiles (0.05, 0.25, 0.5, 0.75, 0.95) each.

## License

MIT — see `LICENSE`.
