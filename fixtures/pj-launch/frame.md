# FRAME.MD — Design Spec (fixture · portugaljewels.com)

> Fixture do step `design` (V4-1 fixture mode). Na V4-2 este ficheiro é
> produzido pelo agente frame-designer com as skills hyperframes-creative.

## Brand
- Nome: Portugal Jewels
- Tagline: "Um modo de ser"
- Fundação: 1955 · "Feito à mão em Portugal"
- Fonte: Poppins (400/700, italic 400/700) — vendada em `assets/fonts/`

## Palette (de capture/extracted/tokens.json)
- Ink: `#0a0a0a` (fundo base)
- Paper: `#ffffff` (tipografia)
- End-card gradient: `#1a1a2e → #16213e → #0f3460`

## Format
- 1080×1920 (9:16 portrait) · 15s · 30fps
- Safe zones: padding horizontal 72px; texto nunca abaixo de y=1720

## Caption skin
- Overlay de leitura: `.dark-overlay` rgba(0,0,0,0.35) sobre imagens claras
- Labels de produto com gradiente transparente→preto 70%
- Grain de filme (opacity 0.04) persistente — `#film-finish`

## Editable ids (click-to-edit)
`s1-brand` · `s1-tagline` · `s2-heading` · `s3-heading` · `s4-brand` · `s4-cta`
