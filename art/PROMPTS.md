# Дөл ба Дусал — зургийн промптууд

Зурагнуудаа `client/assets/` хавтас руу доорх нэрээр хийгээрэй (эсвэл чатаар өгөөрэй, би байрлуулна).
Тоглоом зураггүй ч ажиллана — код өөрөө зурдаг. Зураг ирэхээр автоматаар солигдоно.

Бүх промптод нийтлэг хэв маяг (style) — эхэнд нь хамт хуулаарай:

> **STYLE:** cute stylized 2D game art, clean vector-like shapes with soft painterly shading, bold readable silhouette, warm rim light, Mongolian folk-art inspired details (traditional "ulzii" knot and meander "alkhan khee" patterns, coral and turquoise accents), original character design, no text, no watermark.

---

## 1. Дөл (галын сүнс) — `hero-dul.png`
Тунгалаг (transparent) дэвсгэр, 512×512, дүр голдоо, хөлөө доод хэсэгт.

```
STYLE + A small round fire spirit hero named Dul, full body, facing right in a 3/4 view, standing pose. Body is a chubby teardrop of living flame, orange-to-yellow gradient, glowing core. Big friendly dark eyes, small confident smile. Wears a tiny traditional Mongolian pointed fur hat (toortsog) made of darker red flame with a gold ulzii knot emblem, and a short red deel-style collar sash with a coral bead. Little stubby arms and feet. Flame tips flicker upward from the head. Transparent background, centered, feet touching the bottom of the frame, no shadow on the ground.
```

## 2. Дусал (усны сүнс) — `hero-dusal.png`
Тунгалаг дэвсгэр, 512×512, Дөлтэй **ижил хэмжээ, ижил байрлал**.

```
STYLE + A small round water spirit hero named Dusal, full body, facing right in a 3/4 view, standing pose, same proportions as a chubby teardrop-shaped mascot. Body is clear living water, turquoise-to-deep-blue gradient with bright highlights and tiny bubbles inside. Big friendly dark eyes, gentle smile. A curl of water on top like a ponytail, a small turquoise (oyu) stone hair ornament in a silver ulzii setting, and a short blue deel-style collar sash. Little stubby arms and feet. Transparent background, centered, feet touching the bottom of the frame, no shadow on the ground.
```

## 3. Арын зураг (агуй сүм) — `bg-cave.png`
1920×1080 (16:9), дүргүй. Голд нь харанхуй, тайван — тоглоом дээр нь зурагдана.

```
STYLE + Wide panoramic background of an ancient underground Mongolian temple cave at night, seen from the side like a 2D platformer backdrop. Deep indigo and blue-violet stone, carved pillars and arches decorated with faded gold meander patterns and ulzii knots, faint glowing turquoise crystals in the walls, distant warm orange lantern glow on the left and cool blue water glow on the right. Low contrast and darker in the middle so foreground game objects stay readable, soft atmospheric depth, no characters, no platforms in the foreground, no text.
```

## 4. Чулуун хана (давтагдах текстур) — `tile-stone.png`
256×256, **seamless / tileable**.

```
STYLE + Seamless tileable texture of carved dark indigo stone blocks for a 2D platformer wall, square blocks with subtle chisel marks, a thin worn gold meander-pattern border along the top edge of each block, slight variation between blocks, top-down orthographic flat view, even lighting, no perspective, tileable on all four sides.
```

## 5. Лого — `logo.png`
Тунгалаг дэвсгэр, 1200×500.

```
STYLE + Game title logo that reads "Дөл ба Дусал" in bold rounded Mongolian Cyrillic letters, the word "Дөл" glowing in fire orange and gold with small flames, the word "Дусал" in flowing turquoise water with droplets, a small gold ulzii knot between them as the "ба". Playful, chunky, high readability, transparent background.
```
(Зураг үүсгэгч кирилл үсгийг буруу бичвэл лого-г би кодоор бичнэ — тэгвэл үсэггүй хувилбар хэрэгтэй: доорх 6-г ашиглана.)

## 6. Апп дүрс (icon) — `icon.png`
1024×1024, дөрвөлжин.

```
STYLE + App icon: the round fire spirit (orange flame mascot with a tiny pointed Mongolian fur hat) and the round water spirit (turquoise water mascot with a turquoise stone hair ornament) side by side, cheek to cheek, happy, in front of a dark indigo stone arch with a gold ulzii knot, glowing orange light on the left, blue light on the right. Square composition, centered, bold and readable at small sizes, no text.
```

---

### Яагаад тоглоом доторх хөдөлгөөнийг кодоор хийх вэ
Зураг үүсгэгч олон фрэймтэй (гүйх, үсрэх) sprite sheet-ийг тогтвортой гаргаж чаддаггүй. Тиймээс 1, 2-ын нэг зогсож буй зургийг код сунгаж, шахаж, хазайлгаж хөдөлгөнө (үсрэх, буух, гүйх), дээрээс нь гал/усны бөөмс (particle) нэмнэ.
