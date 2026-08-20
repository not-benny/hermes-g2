# Calorie-Burn Estimator (HR-based)

**Status: shipped.** Hermes estimates daily calorie burn from heart rate, because the
R1 ring's own calories value is not decodable yet.

---

## Why estimate instead of read the ring

- There is no `RING_HEALTH_CMD` calories metric to query.
- The activity record does carry candidate `f1` / `f2` fields, but they are **unvalidated**
  (no ground-truth correlation), so we do not trust them as calories.
- Rather than surface a number we cannot verify, calories is **ESTIMATED from heart rate**.
- The ring's own decoded calories stays a **separate open research item**: it needs
  Even-DB ground-truth correlation (same approach as sleep) before we can decode it.

## Method: Keytel et al. (2005)

HR-based energy-expenditure regression. kcal per minute:

```
male   = (-55.0969 + 0.6309*HR + 0.1988*weightKg + 0.2017*age) / 4.184
female = (-20.4022 + 0.4472*HR - 0.1263*weightKg + 0.074*age)  / 4.184
```

- Result is clamped to `>= 0`.
- Daily estimate = sum over each tracked hour of `kcalPerMinute(hourAvgHR) * 60`.
- So the estimate **grows through the day** as hourly HR samples accumulate.

## Profile

- Inputs: weight (kg), age, sex.
- Persisted in `ApplicationSettings` under key **`health.profile.v1`**.
- Defaults to a generic adult (**75 kg / 30 / male**) until set in
  phone **Settings > Health profile**.

## Limitations

- Keytel is validated mainly for **exercise HR (~74-150 bpm)**; at rest it is rough.
- It approximates **total** energy expenditure at that HR, not strictly "active" calories.
- The card labels the value **"kcal *"** to flag it as an estimate.

## Files

- `app/health/calories.ts` - pure calculation, tested.
- `app/native/calorie-profile.ts` - persisted weight/age/sex profile.
- `app/apps/health/health-app.ts` - kcal tile on the glasses card.
- `app/phone-ui/health-profile-page.ts` / `health-profile-view-model.ts` - profile input UI.
