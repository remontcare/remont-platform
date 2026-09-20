# Product photos (optional local fallback)

Normally product photos aate hain **API se** — admin panel se upload ki hui
Cloudinary images (`images[]`). Ye folder sirf un products ke liye hai jinke
paas API mein abhi koi photo nahi hai.

**API data hamesha jeetta hai.** Yahan ki file tabhi dikhti hai jab product ke
`images[]` aur `imageUrl` dono khaali hon.

- **Format**: `.webp`
- **Size**: 1600×1600 (1:1), 150KB se kam
- **Background**: pura white — slot `object-fit: contain` hai, product kabhi
  crop nahi hota, poora dikhta hai.

## Expected file names

| File | Product |
|---|---|
| `split-ac.webp` | Split AC |
| `water-purifier.webp` | RO + UV water purifier |
| `ceiling-fan.webp` | Ceiling fan |
| `led-batten.webp` | LED batten tube light |
| `modular-switch.webp` | Modular switch plate |
| `basin-mixer.webp` | Basin mixer tap |
| `cpvc-pipe.webp` | CPVC pipe |
| `gas-stove.webp` | 3-burner gas stove |
| `exterior-paint.webp` | Exterior paint bucket |
| `cordless-drill.webp` | Cordless drill |

## Kaise jodein

`index.html` ke `RemontMedia.assets` map mein ek line:

```js
var assets = {
  '1-5-ton-3-star-split-ac': 'assets/products/split-ac.webp',
};
```

Left side product ke naam ka auto-slug hai, right side file ka path.

## Photo priority

1. `images[0]` — API/Cloudinary (normal case)
2. `img` / `imageUrl` — wahi data doosre column naam se
3. Is folder ki file
4. Card ka purana emoji, ek chhoti fallback tile mein

Product photo load na ho to card khali nahi hota.
