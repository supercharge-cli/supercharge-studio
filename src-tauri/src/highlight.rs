//! Editor-grade syntax highlighting for code blocks and the file viewer.
//! TextMate-format grammars (the grammar family code editors use) run here in Rust, so the web
//! bundles carry no grammars. Scopes are resolved to token kinds with editor theme rules (most
//! specific selector wins), and the output is `<span class="tN">` HTML; colors come from the app theme.

use std::str::FromStr;
use std::sync::OnceLock;
use syntect::easy::HighlightLines;
use syntect::highlighting::{Color, FontStyle, ScopeSelectors, StyleModifier, Theme, ThemeItem, ThemeSettings};
use syntect::parsing::{SyntaxReference, SyntaxSet};
use syntect::util::LinesWithEndings;

/// Token kinds: the number is the CSS class `tN` (0 = plain text). Selectors follow editor themes.
const KINDS: &[(u8, &str)] = &[
    (1, "comment, punctuation.definition.comment"),
    (2, "string, markup.inline.raw, markup.raw, punctuation.definition.string"),
    (3, "constant.numeric"),
    (4, "keyword.control, keyword.other.import, keyword.other.use, keyword.control.import"),
    (5, "keyword, storage, storage.type, storage.modifier, keyword.operator.new, keyword.operator.expression, keyword.operator.word, keyword.operator.logical.python, keyword.other.fn"),
    (0, "keyword.operator, punctuation"),
    (6, "entity.name.function, support.function, variable.function, support.macro, meta.function-call.generic, variable.annotation, entity.name.function.decorator, meta.decorator variable.other"),
    (7, "entity.name.type, entity.name.class, entity.name.struct, entity.name.enum, entity.name.trait, entity.name.impl, entity.name.interface, entity.name.namespace, support.type, support.class, entity.other.inherited-class, storage.type.primitive, storage.type.numeric.go, storage.type.string.go"),
    (8, "variable, variable.parameter, variable.other, support.variable, meta.object-literal.key, support.type.property-name, meta.mapping.key string, entity.name.label, variable.other.member"),
    (9, "entity.name.tag, meta.tag.sgml, entity.name.section.group-title.ini"),
    (10, "entity.other.attribute-name, entity.other.attribute-name.class.css, entity.other.attribute-name.id.css, punctuation.definition.entity.css"),
    (11, "constant.language, constant.other, support.constant, variable.language, constant.character, keyword.other.unit, entity.other.keyframe-offset, constant.other.color punctuation.definition"),
    (12, "punctuation.definition.tag, meta.tag punctuation.separator"),
    (13, "markup.heading, entity.name.section.markdown, markup.heading punctuation.definition"),
    (14, "constant.character.escape, string.regexp, constant.other.placeholder"),
    (15, "invalid, invalid.illegal"),
    (16, "markup.bold"),
    (17, "markup.italic"),
    (18, "markup.underline.link, markup.link, string.other.link"),
    (19, "markup.inserted, punctuation.definition.inserted"),
    (20, "markup.deleted, punctuation.definition.deleted"),
];

fn kinds_theme() -> &'static Theme {
    static T: OnceLock<Theme> = OnceLock::new();
    T.get_or_init(|| Theme {
        name: Some("kinds".into()),
        author: None,
        settings: ThemeSettings { foreground: Some(Color { r: 0, g: 0, b: 0, a: 255 }), ..Default::default() },
        scopes: KINDS
            .iter()
            .map(|(k, sel)| ThemeItem {
                scope: ScopeSelectors::from_str(sel).expect("selector"),
                style: StyleModifier { foreground: Some(Color { r: *k, g: 0, b: 0, a: 255 }), background: None, font_style: Some(FontStyle::empty()) },
            })
            .collect(),
    })
}

/// Inline style per kind: a theme variable with the dark editor palette as fallback (light themes set the variables).
fn kind_style(k: u8) -> &'static str {
    match k {
        1 => "color:var(--h1,#6a9955);font-style:italic",
        2 => "color:var(--h2,#ce9178)",
        3 => "color:var(--h3,#b5cea8)",
        4 => "color:var(--h4,#c586c0)",
        5 | 9 => "color:var(--h5,#569cd6)",
        6 => "color:var(--h6,#dcdcaa)",
        7 => "color:var(--h7,#4ec9b0)",
        8 | 10 => "color:var(--h8,#9cdcfe)",
        11 => "color:var(--h11,#4fc1ff)",
        12 => "color:var(--muted)",
        13 => "color:var(--h5,#569cd6);font-weight:600",
        14 => "color:var(--h14,#d7ba7d)",
        15 | 20 => "color:var(--bad)",
        16 => "font-weight:700",
        17 => "font-style:italic",
        18 => "color:var(--h2,#ce9178);text-decoration:underline",
        19 => "color:var(--ok)",
        _ => "",
    }
}

fn escape(s: &str, out: &mut String) {
    for c in s.chars() {
        match c {
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '&' => out.push_str("&amp;"),
            '"' => out.push_str("&quot;"),
            _ => out.push(c),
        }
    }
}

fn syntaxes() -> &'static SyntaxSet {
    static SET: OnceLock<SyntaxSet> = OnceLock::new();
    SET.get_or_init(two_face::syntax::extra_newlines)
}

/// Common fence labels that are not grammar names or file extensions.
fn alias(lang: &str) -> &str {
    match lang {
        "ts" | "typescript" | "mts" | "cts" => "ts",
        "tsx" => "tsx",
        "js" | "javascript" | "node" | "mjs" | "cjs" => "js",
        "jsx" => "jsx",
        "sh" | "shell" | "bash" | "zsh" | "console" | "shellscript" => "sh",
        "py" | "python" | "python3" => "py",
        "rs" | "rust" => "rs",
        "golang" | "go" => "go",
        "md" | "markdown" => "md",
        "yml" | "yaml" => "yaml",
        "ps1" | "powershell" | "pwsh" => "ps1",
        "c++" | "cpp" => "cpp",
        "c#" | "cs" | "csharp" => "cs",
        "kt" | "kotlin" => "kt",
        "dockerfile" | "docker" => "Dockerfile",
        "html" | "htm" | "xhtml" | "vue" | "svelte" => "html",
        other => other,
    }
}

fn find(lang: &str) -> Option<&'static SyntaxReference> {
    let set = syntaxes();
    let l = lang.trim().trim_start_matches('.');
    if l.is_empty() || l == "text" || l == "txt" || l == "plain" {
        return None;
    }
    let low = l.to_ascii_lowercase();
    let a = alias(&low);
    set.find_syntax_by_extension(a).or_else(|| set.find_syntax_by_token(a)).or_else(|| set.find_syntax_by_extension(l))
}

/// Highlight `code` written in `lang` (a fence label, grammar name, extension or file name).
/// `None` when the language is unknown or the input is too large, so the caller shows plain text.
pub fn to_html(code: &str, lang: &str) -> Option<String> {
    if code.len() > 512 * 1024 {
        return None;
    }
    let by_name = lang.rsplit(['/', '\\']).next().unwrap_or(lang);
    let syntax = find(lang).or_else(|| by_name.rsplit_once('.').and_then(|(_, ext)| find(ext))).or_else(|| syntaxes().find_syntax_by_extension(by_name))?;
    let mut h = HighlightLines::new(syntax, kinds_theme());
    let mut out = String::with_capacity(code.len() * 2);
    let (mut cur, mut buf) = (0u8, String::new());
    let flush = |k: u8, buf: &mut String, out: &mut String| {
        if buf.is_empty() { return; }
        if k == 0 { escape(buf, out) } else { out.push_str(&format!("<span class=\"t{k}\" style=\"{}\">", kind_style(k))); escape(buf, out); out.push_str("</span>") }
        buf.clear();
    };
    for line in LinesWithEndings::from(code) {
        for (style, text) in h.highlight_line(line, syntaxes()).ok()? {
            let k = if text.trim().is_empty() { cur } else { style.foreground.r };
            if k != cur { flush(cur, &mut buf, &mut out); cur = k; }
            buf.push_str(text);
        }
    }
    flush(cur, &mut buf, &mut out);
    Some(out)
}

#[tauri::command]
pub async fn highlight_code(code: String, lang: String) -> Option<String> {
    tauri::async_runtime::spawn_blocking(move || to_html(&code, &lang)).await.ok().flatten()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn common_languages_get_real_scopes() {
        let cases = [
            ("ts", "const a: number = 1; // c", &["t5\">const", "t7\">number", "t3\">1", "t1\">// c"][..]),
            ("tsx", "export const A = () => <div className=\"x\" />;", &["t9\">div", "t10\">className", "t2\">&quot;x&quot;"]),
            ("js", "function f() { return 'x' }", &["t6\">f", "t4\">return", "t2\">'x'"]),
            ("rust", "fn main() { let x = 1u8; }", &["t5\">fn", "t6\">main", "t5\">let"]),
            ("python", "def f(x):\n    return \"s\"  # c\n", &["t5\">def", "t6\">f", "t4\">return", "t1\"># c"]),
            ("json", "{\"a\": [1, true, null]}", &["t3\">1", "t11\">true"]),
            ("bash", "for f in *.rs; do echo \"$f\"; done", &["t4\">for", "t6\">echo"]),
            ("css", ".a { color: #fff; }", &["t8\">color", "t11\">#fff"]),
            ("html", "<a href=\"/x\">y</a>", &["t9\">a", "t10\">href"]),
            ("go", "package main\nfunc main() {}\n", &["t5\">func", "t6\">main"]),
            ("md", "# Title\n\n`code` and **bold**\n", &["t13\"># Title", "t16\">bold"]),
            ("yaml", "a: 1\n", &["t9\">a", "t3\">1"]),
            ("toml", "[a]\nb = 1\n", &["t3\">1"]),
        ];
        for (lang, code, wants) in cases {
            let h = to_html(code, lang).unwrap_or_else(|| panic!("{lang}: no grammar"));
            let classes = strip_styles(&h);
            for want in wants {
                assert!(classes.contains(want), "{lang}: {want} missing in {classes}");
            }
            let stripped = strip_tags(&h).replace("&quot;", "\"").replace("&lt;", "<").replace("&gt;", ">").replace("&amp;", "&");
            assert_eq!(stripped, code, "{lang}: text must survive unchanged");
        }
    }

    fn strip_styles(s: &str) -> String {
        let mut out = String::new();
        let mut rest = s;
        while let Some(i) = rest.find(" style=\"") {
            out.push_str(&rest[..i]);
            let after = &rest[i + 8..];
            rest = &after[after.find('"').unwrap() + 1..];
        }
        out.push_str(rest);
        out
    }

    fn strip_tags(s: &str) -> String {
        let (mut out, mut tag) = (String::new(), false);
        for c in s.chars() {
            match c { '<' => tag = true, '>' if tag => tag = false, _ if !tag => out.push(c), _ => {} }
        }
        out
    }

    #[test]
    fn escapes_and_falls_back() {
        let h = to_html("let s = \"<script>\";", "js").unwrap();
        assert!(h.contains("&lt;script&gt;") && !h.contains("<script>"));
        assert!(to_html("x", "no-such-language").is_none());
        assert!(to_html("x", "text").is_none());
        assert!(to_html("fn a() {}", "src/main.rs").is_some(), "file paths pick the grammar by extension");
        assert!(to_html("FROM alpine", "Dockerfile").is_some());
    }
}

/// Regenerate the e2e fixtures: `HL_FIXTURES=../e2e/fixtures cargo test highlight_fixtures -- --ignored`.
#[cfg(test)]
#[test]
#[ignore]
fn highlight_fixtures() {
    let dir = std::env::var("HL_FIXTURES").expect("HL_FIXTURES");
    let samples = [
        ("ts", "import { readFile } from \"node:fs/promises\";\n\n/** Count lines in a file. */\nexport async function countLines(path: string): Promise<number> {\n  const text = await readFile(path, \"utf8\");\n  return text.split(\"\\n\").length; // trailing newline counts\n}\n"),
        ("rust", "use std::collections::HashMap;\n\n#[derive(Debug, Clone)]\npub struct Cache<'a> {\n    hits: HashMap<&'a str, u64>,\n}\n\nimpl<'a> Cache<'a> {\n    pub fn bump(&mut self, key: &'a str) -> u64 {\n        let n = self.hits.entry(key).or_insert(0);\n        *n += 1;\n        println!(\"{key}: {n}\");\n        *n\n    }\n}\n"),
        ("python", "import json\n\n@cache\ndef load(path: str, strict=True) -> dict:\n    \"\"\"Read a JSON file.\"\"\"\n    with open(path) as f:  # utf-8\n        return json.load(f) if strict else {}\n"),
        ("go", "func main() { fmt.Println(\"hi\", 42) }\n"),
    ];
    for (lang, code) in samples {
        std::fs::write(format!("{dir}/hl-{lang}.html"), to_html(code, lang).unwrap()).unwrap();
        std::fs::write(format!("{dir}/hl-{lang}.txt"), code).unwrap();
    }
}
