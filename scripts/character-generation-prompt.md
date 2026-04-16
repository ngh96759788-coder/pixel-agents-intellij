# Pixel Agent Character Sprite Sheet — Generation Prompt

> 이 파일을 GPT 이미지 생성에 그대로 붙여넣으세요.
> `[CHARACTER CONCEPT]` 부분만 캐릭터별로 교체합니다.

---

## PROMPT START

Generate a **single pixel art sprite sheet** as a PNG image.

---

### 1. IMAGE SPECIFICATIONS (NON-NEGOTIABLE)

| Property | Value |
|----------|-------|
| **Image size** | exactly **168 × 96 pixels** |
| **Grid** | 7 columns × 3 rows |
| **Cell size** | 24 × 32 pixels per cell |
| **Background** | fully transparent (alpha = 0) |
| **Color mode** | RGBA |
| **Output scale** | 1:1 pixel resolution. NOT upscaled. The final PNG MUST be 168×96 |

**If you cannot output 168×96 directly**, output at exactly **1344×768** (8× scale) using only solid-color 8×8 blocks — NO smoothing between blocks.

---

### 2. ANTI-ALIASING — STRICTLY FORBIDDEN

This is **retro pixel art**. Every pixel must be a single flat color.

**BANNED:**
- Sub-pixel smoothing
- Gradient transitions between colors
- Semi-transparent pixels (alpha must be 0 or 255, nothing between)
- Intermediate "blending" colors at edges
- Soft shadows or glow effects

**REQUIRED:**
- Hard 1px stair-step edges (jagged is correct)
- Color boundaries are a single pixel wide
- Maximum ~12-15 distinct colors in the entire sheet
- Every visible pixel: alpha = 255 (fully opaque)
- Every empty pixel: alpha = 0 (fully transparent)

**Visual rule:**
```
WRONG (anti-aliased):  ██▓▒░░
RIGHT (pixel art):     ████
                           ████
```

---

### 3. CHARACTER CONSTRAINTS

| Property | Value |
|----------|-------|
| **Proportions** | chibi — head ≈ 40% of height |
| **Character height** | occupies rows 4–30 of each 32px cell (top 4px + bottom 2px = empty padding) |
| **Character width** | 12–18 pixels wide, horizontally centered in 24px cell |
| **Outline** | 1px dark outline on ALL edges of silhouette (single dark color) |
| **Interior** | 2–3 tones per color region (highlight / base / shadow). No gradients |
| **Consistency** | silhouette, head size, body width IDENTICAL across all 21 frames. Only limbs + accessories change |

---

### 4. GRID LAYOUT — 7 COLUMNS × 3 ROWS (21 CELLS TOTAL)

**Every cell must contain the character. No empty cells.**

#### Rows (directions)

| Row | Position | Direction | View |
|-----|----------|-----------|------|
| 0 | top | **FRONT** | facing toward camera (looking down) |
| 1 | middle | **BACK** | facing away from camera (looking up) |
| 2 | bottom | **RIGHT SIDE** | facing right (profile view) |

#### Columns (animation frames)

| Col | Animation | Description |
|-----|-----------|-------------|
| 0 | **Walk 1** | right leg forward (1–2px step) |
| 1 | **Walk 2** | standing neutral (both legs together) — also used as idle |
| 2 | **Walk 3** | left leg forward (1–2px step, mirror of col 0) |
| 3 | **Type/Work 1** | seated posture, arms forward, working on device/tool. Frame 1 |
| 4 | **Type/Work 2** | same as col 3 but hands shifted 1px (typing motion). Frame 2 |
| 5 | **Read/Tool 1** | standing, holding tool or reading. Active effect visible. Frame 1 |
| 6 | **Read/Tool 2** | same as col 5 but effect shifted 1px (spark/glow position change). Frame 2 |

#### Animation rules
- **Walk (cols 0–2)**: only legs move (1–2px). Arms may counter-swing 1px. Head/body static
- **Type (cols 3–4)**: legs slightly bent (seated). Arms extend forward. Small device/effect in front of hands. 1px difference between frames
- **Read/Tool (cols 5–6)**: standing pose. Tool or object held. Active effect (spark, glow, etc.) at 2–4 pixels. Effect position shifts between frames

---

### 5. PIXEL ALIGNMENT — CRITICAL

- Characters must NOT bleed across cell boundaries
- Each 24×32 cell is a self-contained frame
- Cell boundaries at: x = 0, 24, 48, 72, 96, 120, 144 / y = 0, 32, 64
- No pixel may exist outside its cell boundary
- All 21 cells must be populated

---

### 6. COLOR RULES

- **Outline**: single darkest color, 1px wide on all external edges
- **Body fill**: 2–3 tones (highlight, base, shadow)
- **Eyes/face**: max 3 colors. Highlight is 1px only
- **Effects** (spark, glow): 2 colors max (bright + medium). Clearly distinct from body colors
- **Total palette**: ≤ 15 unique colors across entire sheet
- **Forbidden colors**: pure white (#FFFFFF) for character pixels — use #E0E0E8 or similar for highlights

---

### 7. [CHARACTER CONCEPT]

> ⬇️ 이 섹션만 캐릭터별로 교체합니다.
> 첨부된 이미지가 있을 경우, 아래 지침을 따르세요.

#### 이미지 첨부 시 (기존 캐릭터 기반 생성)

**첨부된 이미지를 분석하여** 다음을 유지하세요:
- 캐릭터의 **실루엣, 비율, 포즈 구조**를 그대로 재현
- 이미지에서 추출한 **색상 팔레트** (주요 5~8색) 사용
- **머리 크기 대 몸 비율**, **팔다리 길이**, **디테일 밀도** 동일하게
- 이미지의 **악세사리/장비 형태** 유지 (헤드셋, 도구, 이펙트 등)

**하지 말 것:**
- 첨부 이미지를 "영감"만 받고 새로 디자인하지 마세요
- 인간형이 아닌 캐릭터를 인간형으로 바꾸지 마세요
- 색상을 임의로 변경하지 마세요

**절차:**
1. 첨부 이미지의 idle 프레임 (col 1, row 0) 실루엣 분석
2. 해당 실루엣을 기반으로 21개 프레임 생성
3. 각 프레임에서 첨부 이미지와 동일한 위치에 동일한 디테일 배치

#### 이미지 미첨부 시 (새 캐릭터)

**[캐릭터 컨셉을 여기에 작성]**
- 외형 특징 (체형, 의상, 색상 등)
- 머리/얼굴 특징
- 악세사리나 특이사항
- **Type frames (cols 3–4)**: 타이핑/작업 시 사용하는 도구/장치 설명
- **Tool frames (cols 5–6)**: 읽기/도구 사용 시 들고 있는 도구 + 이펙트 설명

---

### 8. REFERENCE DIMENSIONS

```
Full image: 168 × 96 px

Cell grid:
┌──────┬──────┬──────┬──────┬──────┬──────┬──────┐
│ 0,0  │ 1,0  │ 2,0  │ 3,0  │ 4,0  │ 5,0  │ 6,0  │  Row 0: FRONT (y: 0–31)
│24×32 │24×32 │24×32 │24×32 │24×32 │24×32 │24×32 │
├──────┼──────┼──────┼──────┼──────┼──────┼──────┤
│ 0,1  │ 1,1  │ 2,1  │ 3,1  │ 4,1  │ 5,1  │ 6,1  │  Row 1: BACK (y: 32–63)
│24×32 │24×32 │24×32 │24×32 │24×32 │24×32 │24×32 │
├──────┼──────┼──────┼──────┼──────┼──────┼──────┤
│ 0,2  │ 1,2  │ 2,2  │ 3,2  │ 4,2  │ 5,2  │ 6,2  │  Row 2: RIGHT (y: 64–95)
│24×32 │24×32 │24×32 │24×32 │24×32 │24×32 │24×32 │
└──────┴──────┴──────┴──────┴──────┴──────┴──────┘

Character occupies: y=4 to y=30 within each cell (26px tall)
                    x=3 to x=20 approx (centered, 12-18px wide)
```

---

### 9. QUALITY CHECKLIST (self-verify before outputting)

- [ ] Image is exactly 168×96 (or 1344×768 at 8×)
- [ ] 21 cells, all populated with character
- [ ] NO anti-aliasing — zoom in and check every edge
- [ ] NO semi-transparent pixels
- [ ] Background is fully transparent
- [ ] Character silhouette consistent across all frames
- [ ] Walk frames show clear leg movement
- [ ] Type frames show device/tool in front
- [ ] Tool frames show distinct effect (spark/glow)
- [ ] 3 rows = front, back, right side
- [ ] Color count ≤ 15
- [ ] No pixel bleeds across cell boundaries

---

## PROMPT END
