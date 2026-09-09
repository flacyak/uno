// The subset, as three tables and a list of what did not make it.
//
// It is small because Unicode's small forms are small, not because anyone chose
// to stop here: there is no subscript b, so x_b has nothing to draw and is
// refused instead.

/** superscripts is what ^ can raise. Digits are complete; letters are complete
 * but for q, which has no superscript codepoint at all. */
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

    // The arithmetic a limit is written with: \sum^{n+1} has to raise the plus
    // as well as the n, or the exponent is drawn at two different sizes.
    "+": "⁺",
    "-": "⁻",
    "=": "⁼",
    "(": "⁽",
    ")": "⁾",
  }),
);

/** subscripts is what _ can lower, and it is the real gap in the subset: only
 * these twelve letters have a subscript form, so b, c, d, f, g, h, q, r, s, u,
 * v, w, y and z are refused. */
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

/** symbols is what a backslash name draws. Greek is by name because that is
 * what a person types.
 *
 * \frac is absent on purpose: it takes two groups, so it is read in `command`
 * rather than looked up here. */
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
 * NO_GLYPH is what the Go build's font test threw out, kept by name so a person
 * who types one is told what happened rather than told it is not a symbol.
 *
 * TODO: this list is a measurement, and in TypeScript it is measuring nothing.
 *
 * Fyne v2.8.1 bundles a Noto Sans with no Mathematical Operators block, so on
 * the desktop these seven have codepoints and no glyphs, and uno would draw a
 * square on the reader's machine where the author saw a symbol. Refusing them
 * at authoring time is the honest answer to that.
 *
 * A browser will draw all seven. So the refusal is very probably wrong in
 * Electron and removing it is very probably an improvement -- but what uno's
 * notation subset *is* is a product decision, and quietly widening the language
 * while translating it would hide that decision inside a port. The list comes
 * across unchanged until somebody decides on purpose.
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
