// The notation subset: three tables, and NO_GLYPH, the symbols the font
// refuses.

/** SUPERSCRIPTS is what ^ can raise. Digits are complete; letters are
 * complete except q, which Unicode leaves out. */
export const SUPERSCRIPTS = new Map<string, string>(
  Object.entries({
    "0": "⁰",
    "1": "¹",
    "2": "²",
    "3": "³",
    "4": "⁴",
    "5": "⁵",
    "6": "⁶",
    "7": "⁷",
    "8": "⁸",
    "9": "⁹",

    a: "ᵃ",
    b: "ᵇ",
    c: "ᶜ",
    d: "ᵈ",
    e: "ᵉ",
    f: "ᶠ",
    g: "ᵍ",
    h: "ʰ",
    i: "ⁱ",
    j: "ʲ",
    k: "ᵏ",
    l: "ˡ",
    m: "ᵐ",
    n: "ⁿ",
    o: "ᵒ",
    p: "ᵖ",
    r: "ʳ",
    s: "ˢ",
    t: "ᵗ",
    u: "ᵘ",
    v: "ᵛ",
    w: "ʷ",
    x: "ˣ",
    y: "ʸ",
    z: "ᶻ",

    // Arithmetic inside a limit: \sum^{n+1} raises the plus and the n.
    "+": "⁺",
    "-": "⁻",
    "=": "⁼",
    "(": "⁽",
    ")": "⁾",
  }),
);

/** SUBSCRIPTS is what _ can lower. Only these twelve letters have a subscript
 * form; b, c, d, f, g, h, q, r, s, u, v, w, y and z are refused. */
export const SUBSCRIPTS = new Map<string, string>(
  Object.entries({
    "0": "₀",
    "1": "₁",
    "2": "₂",
    "3": "₃",
    "4": "₄",
    "5": "₅",
    "6": "₆",
    "7": "₇",
    "8": "₈",
    "9": "₉",

    a: "ₐ",
    e: "ₑ",
    i: "ᵢ",
    j: "ⱼ",
    k: "ₖ",
    l: "ₗ",
    m: "ₘ",
    n: "ₙ",
    o: "ₒ",
    p: "ₚ",
    t: "ₜ",
    x: "ₓ",

    // \sum_{i=1} lowers all three of i, = and 1.
    "+": "₊",
    "-": "₋",
    "=": "₌",
    "(": "₍",
    ")": "₎",
  }),
);

/** SYMBOLS is what a backslash name draws. \frac is absent: it takes two
 * groups and is read in `command`. */
export const SYMBOLS = new Map<string, string>(
  Object.entries({
    alpha: "α",
    beta: "β",
    gamma: "γ",
    delta: "δ",
    epsilon: "ε",
    zeta: "ζ",
    eta: "η",
    theta: "θ",
    iota: "ι",
    kappa: "κ",
    lambda: "λ",
    mu: "μ",
    nu: "ν",
    xi: "ξ",
    pi: "π",
    rho: "ρ",
    sigma: "σ",
    tau: "τ",
    upsilon: "υ",
    phi: "φ",
    chi: "χ",
    psi: "ψ",
    omega: "ω",

    Gamma: "Γ",
    Delta: "Δ",
    Theta: "Θ",
    Lambda: "Λ",
    Xi: "Ξ",
    Pi: "Π",
    Sigma: "Σ",
    Upsilon: "Υ",
    Phi: "Φ",
    Psi: "Ψ",
    Omega: "Ω",

    pm: "±",
    times: "×",
    div: "÷",
  }),
);

/**
 * NO_GLYPH is the symbols the Go build's font test refused: Fyne v2.8.1's
 * Noto Sans lacks the Mathematical Operators block. A person who types one is
 * told why it is refused.
 *
 * TODO: a browser draws all seven, so this refusal is probably wrong in
 * Electron. The list is kept until the subset is widened on purpose.
 */
export const NO_GLYPH = new Map<string, string>(
  Object.entries({
    sqrt: "√", // U+221A
    sum: "∑", // U+2211
    int: "∫", // U+222B
    infty: "∞", // U+221E
    ne: "≠", // U+2260
    le: "≤", // U+2264
    ge: "≥", // U+2265
  }),
);
