package notation

// The subset, as three tables and a list of what did not make it.
//
// It is small because Unicode's small forms are small, not because anyone chose
// to stop here: there is no subscript b, so x_b has nothing to draw and is
// refused instead. Every rune below is checked against Fyne's bundled font by
// TestEveryRuneTheTablesCanEmitHasAGlyphInTheBundledFont. That test, not the
// design note, is what the subset is pinned to — a codepoint existing is not the
// same as the font shipping a glyph for it, and a rune the font rejects has to
// come out of the table rather than reach a cell as an empty box.

// superscripts is what ^ can raise. Digits are complete, letters are complete
// but for q, which has no superscript codepoint at all.
var superscripts = map[rune]rune{
	'0': '⁰', '1': '¹', '2': '²', '3': '³', '4': '⁴',
	'5': '⁵', '6': '⁶', '7': '⁷', '8': '⁸', '9': '⁹',

	'a': 'ᵃ', 'b': 'ᵇ', 'c': 'ᶜ', 'd': 'ᵈ', 'e': 'ᵉ',
	'f': 'ᶠ', 'g': 'ᵍ', 'h': 'ʰ', 'i': 'ⁱ', 'j': 'ʲ',
	'k': 'ᵏ', 'l': 'ˡ', 'm': 'ᵐ', 'n': 'ⁿ', 'o': 'ᵒ',
	'p': 'ᵖ', 'r': 'ʳ', 's': 'ˢ', 't': 'ᵗ', 'u': 'ᵘ',
	'v': 'ᵛ', 'w': 'ʷ', 'x': 'ˣ', 'y': 'ʸ', 'z': 'ᶻ',

	// The arithmetic a limit is written with: \sum^{n+1} has to raise the plus
	// as well as the n, or the exponent is drawn at two different sizes.
	'+': '⁺', '-': '⁻', '=': '⁼', '(': '⁽', ')': '⁾',
}

// subscripts is what _ can lower, and it is the real gap in the subset: only
// these eleven letters have a subscript form, so b, c, d, f, g, q, r, s, u, v,
// w, y and z are refused. This is the measured set from M3 rather than every
// codepoint Unicode has, which is why h is absent too.
var subscripts = map[rune]rune{
	'0': '₀', '1': '₁', '2': '₂', '3': '₃', '4': '₄',
	'5': '₅', '6': '₆', '7': '₇', '8': '₈', '9': '₉',

	'a': 'ₐ', 'e': 'ₑ', 'i': 'ᵢ', 'j': 'ⱼ', 'k': 'ₖ',
	'l': 'ₗ', 'm': 'ₘ', 'n': 'ₙ', 'o': 'ₒ', 'p': 'ₚ',
	't': 'ₜ', 'x': 'ₓ',

	// \sum_{i=1} lowers all three of i, = and 1.
	'+': '₊', '-': '₋', '=': '₌', '(': '₍', ')': '₎',
}

// symbols is what a backslash name draws. Greek is by name because that is
// what a person types.
//
// \frac is absent on purpose: it takes two groups, so it is read in command
// rather than looked up here.
var symbols = map[string]rune{
	"alpha": 'α', "beta": 'β', "gamma": 'γ', "delta": 'δ',
	"epsilon": 'ε', "zeta": 'ζ', "eta": 'η', "theta": 'θ',
	"iota": 'ι', "kappa": 'κ', "lambda": 'λ', "mu": 'μ',
	"nu": 'ν', "xi": 'ξ', "pi": 'π', "rho": 'ρ',
	"sigma": 'σ', "tau": 'τ', "upsilon": 'υ', "phi": 'φ',
	"chi": 'χ', "psi": 'ψ', "omega": 'ω',

	"Gamma": 'Γ', "Delta": 'Δ', "Theta": 'Θ', "Lambda": 'Λ',
	"Xi": 'Ξ', "Pi": 'Π', "Sigma": 'Σ', "Upsilon": 'Υ',
	"Phi": 'Φ', "Psi": 'Ψ', "Omega": 'Ω',

	"pm": '±', "times": '×', "div": '÷',
}

// noGlyph is what the font test threw out, kept by name so a person who types
// one is told what happened rather than told it is not a symbol.
//
// The design note claimed "every operator and Greek letter tested is present",
// and for Unicode it is. Fyne v2.8.1 bundles a 3,246-glyph Noto Sans with the
// Latin, Greek and Cyrillic blocks and none of Mathematical Operators
// (U+2200–22FF), and neither of the two fallbacks it composes with — the symbol
// font and the emoji font — carries them either. Whether one of these draws on
// any given machine then depends on what fonts that machine happens to have
// installed, which is not something a subset can be pinned to: uno would show
// √ on the author's desktop and an empty box on the reader's.
//
// So they are refused at authoring time, which is the promise this package
// makes. Losing \sum and \sqrt costs the subset real notation, and the honest
// alternative — bundling a math font — is a decision about what uno ships, not
// one this package can make on its own. If a later Fyne bundles a font that has
// them, the font test fails on this table and says to move them up.
var noGlyph = map[string]rune{
	"sqrt":  '√', // U+221A
	"sum":   '∑', // U+2211
	"int":   '∫', // U+222B
	"infty": '∞', // U+221E
	"ne":    '≠', // U+2260
	"le":    '≤', // U+2264
	"ge":    '≥', // U+2265
}
