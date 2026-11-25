"""Canvas storage, compilation cache, and CLI check."""
from __future__ import annotations

import asyncio
import json
import re
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import agentsdock_canvas as canvas  # noqa: E402

VALID_SOURCE = (
    "import { H1, Stack, Text, useCanvasState } from '@zed/canvas';\n"
    "export default function Report() {\n"
    "  const [count, setCount] = useCanvasState('count', 1);\n"
    "  return <Stack><H1>Demo</H1><Text>{count}</Text></Stack>;\n"
    "}\n"
)

needs_node = unittest.skipIf(shutil.which("node") is None, "node is not installed")

CANVAS_IMPORTING_MARKDOWN = (
    "import { Markdown, Stack } from '@zed/canvas';\n"
    "export default function Report() { return <Stack><Markdown source={'# Title\\n\\nBody with **bold**.'} /></Stack>; }\n"
)
MARKDOWN_DOCUMENT = (
    "# 回退诊断\n\n"
    "先看 **RMS** 与 `rank`，公式 $\\|x\\|_2/\\sqrt{d}$ 见 [EDM2](https://arxiv.org/abs/2312.02696)。\n\n"
    "- 第一步\n  - 子项 1\n  - 子项 2\n- 第二步\n\n"
    "```python\nprint(1)\n```\n\n"
    "| 指标 | 值 | 单位 |\n|:--|--:|:-:|\n| update RMS | 0.2 | 1 |\n\n"
    "> 引用一行\n\n"
    "$$\nL = a N^{-b}\n$$\n\n---\n\n结束。\n"
)
MARKDOWN_EDGE_CASES = {
    "loose_list": "- a\n\n- b\n\n- c\n",
    "year": "In the year\n2024. The model\n",
    "fence": "```python title=x\nprint(1)\n```\nafter\n",
    "sharp": "# F# and C#\n",
    "nested_fence": "````markdown\n```\ninner\n```\n````\n",
    "dollars": "costs \\$5 and $10 in snake_case_name\n",
    "bold_italic": "***both*** and *one* end\n",
    "pipe_rule": "a | b\n---\n",
}
# The bundle registers window/document listeners at load; these stubs let node run it without a DOM.
NODE_DOM_STUB = """
function element() { return { style: {}, dataset: {}, children: [], setAttribute() {}, removeAttribute() {}, getAttribute() { return null },
  appendChild(child) { this.children.push(child); return child }, removeChild() {}, addEventListener() {}, removeEventListener() {},
  querySelectorAll() { return [] }, querySelector() { return null }, closest() { return null },
  getBoundingClientRect() { return { x: 0, y: 0, width: 0, height: 0 } }, textContent: '', innerHTML: '', classList: { add() {}, remove() {} } } }
globalThis.window = globalThis; globalThis.addEventListener = () => {};
globalThis.document = { ...element(), documentElement: element(), head: element(), body: element(), createElement: element,
  createTextNode(text) { return { textContent: text } }, getElementById() { return element() } };
"""


class CanvasTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp_path = Path(self.enterContext(tempfile.TemporaryDirectory()))

    def test_session_dir_rejects_bad_ids(self) -> None:
        with self.assertRaises(ValueError):
            canvas.session_dir(self.tmp_path, "../escape")
        with self.assertRaises(ValueError):
            canvas.canvas_path(self.tmp_path, "../x")
        with self.assertRaises(ValueError):
            canvas.canvas_path(self.tmp_path, "bad name")

    def test_canvas_path_accepts_consecutive_dots(self) -> None:
        assert canvas.canvas_path(self.tmp_path, "q3..final") == self.tmp_path / "q3..final.canvas.tsx"

    def test_ensure_session_dir_copies_agent_files(self) -> None:
        directory = canvas.ensure_session_dir(self.tmp_path, "sess_1")
        assert directory == self.tmp_path / "canvases" / "sess_1"
        assert (directory / "AUTHORING.md").is_file()
        assert (directory / "sdk.d.ts").is_file()

    def test_state_round_trip_and_size_limit(self) -> None:
        path = self.tmp_path / "demo.canvas.tsx"
        path.write_text(VALID_SOURCE)
        assert canvas.read_state(path) == {}
        canvas.write_state(path, {"count": 3})
        assert canvas.read_state(path) == {"count": 3}
        with self.assertRaises(ValueError):
            canvas.write_state(path, {"blob": "x" * (canvas.MAX_STATE_BYTES + 1)})

    def test_list_canvases_ignores_other_files(self) -> None:
        (self.tmp_path / "a.canvas.tsx").write_text(VALID_SOURCE)
        (self.tmp_path / "a.canvas.data.json").write_text("{}")
        (self.tmp_path / ".a.canvas.build.json").write_text("{}")
        (self.tmp_path / "notes.md").write_text("x")
        names = [item["name"] for item in canvas.list_canvases(self.tmp_path)]
        assert names == ["a"]

    @needs_node
    def test_build_compiles_and_reuses_cache(self) -> None:
        path = self.tmp_path / "demo.canvas.tsx"
        path.write_text(VALID_SOURCE)
        first = canvas.build(path)
        assert first["diagnostics"] is None
        assert "CanvasModule" in first["javascript"]
        # Clients download the bundle over remote links; a source map would carry the source a second time.
        assert "sourceMappingURL" not in first["javascript"]
        assert first["runtime_version"] == canvas.runtime_version()
        cache = json.loads(canvas.build_cache_path(path).read_text())
        assert cache["source_sha256"]

        # Unchanged source must not invoke the compiler again.
        with patch.object(canvas, "compile_source", lambda *_a, **_k: self.fail("compiler re-run for unchanged source")):
            second = canvas.build(path)
        assert second["javascript"] == first["javascript"]

    @needs_node
    def test_compiler_preserves_multibyte_unicode_in_large_source(self) -> None:
        label = "中文标签" * 20000
        source = (
            "import { Text } from '@zed/canvas';\n"
            f"export default function Report() {{ return <Text>{{{json.dumps(label, ensure_ascii=False)}}}</Text>; }}\n"
        )
        javascript, diagnostics, ran = canvas.compile_source(source)
        self.assertTrue(ran)
        self.assertIsNone(diagnostics)
        self.assertEqual(javascript.lower().count("\\ufffd"), 0)
        self.assertEqual(javascript.lower().count("\\u4e2d\\u6587\\u6807\\u7b7e"), 20000)

    @needs_node
    def test_build_compiles_a_source_above_the_former_2_mib_limit(self) -> None:
        records = json.dumps([{"label": "动作质量", "note": "x" * 200, "id": index} for index in range(9000)], ensure_ascii=False)
        path = self.tmp_path / "report.canvas.tsx"
        path.write_text(VALID_SOURCE + f"export const records = {records};\n")
        # The former limit refused a source this size.
        assert 2 * 1024 * 1024 < path.stat().st_size < canvas.MAX_SOURCE_BYTES

        built = canvas.build(path)

        assert built["diagnostics"] is None
        assert "CanvasModule" in built["javascript"]

    def test_check_cli_reports_a_source_the_viewer_refuses(self) -> None:
        path = self.tmp_path / "huge.canvas.tsx"
        path.write_text(VALID_SOURCE + "// " + "x" * canvas.MAX_SOURCE_BYTES + "\n")
        completed = subprocess.run(
            [sys.executable, str(Path(canvas.__file__)), "check", str(path)],
            capture_output=True, text=True, check=False,
        )
        assert completed.returncode == 1
        assert canvas.SOURCE_TOO_LARGE in completed.stdout
        with self.assertRaises(ValueError):
            canvas.build(path)

        # Reading as text turns CRLF into LF; the file on disk is what the viewer measures.
        path.write_bytes(b"\r\n" * (canvas.MAX_SOURCE_BYTES // 2 + 1))
        completed = subprocess.run(
            [sys.executable, str(Path(canvas.__file__)), "check", str(path)],
            capture_output=True, text=True, check=False,
        )
        assert completed.returncode == 1 and canvas.SOURCE_TOO_LARGE in completed.stdout

    def test_prompt_names_why_canvas_is_unavailable(self) -> None:
        with patch.object(canvas, "node_binary", lambda: None):
            section = canvas.prompt_section(self.tmp_path, "sess_1")
        assert "Canvas is unavailable on this server" in section and "`node`" in section
        assert "tell them it is unavailable and why" in section

    def test_build_does_not_cache_transient_compile_failures(self) -> None:
        path = self.tmp_path / "demo.canvas.tsx"
        path.write_text(VALID_SOURCE)
        cache_file = canvas.build_cache_path(path)

        # node missing from PATH.
        with patch.object(canvas, "node_binary", lambda: None):
            result = canvas.build(path)
        assert result["javascript"] == "" and "node" in result["diagnostics"]
        assert not cache_file.exists()

        # node present but the compiler timed out.
        self.enterContext(patch.object(canvas, "node_binary", lambda: "/fake/node"))

        def timed_out(*_a, **_k):
            raise subprocess.TimeoutExpired("node", 1)

        with patch.object(canvas.subprocess, "run", timed_out):
            assert "timed out" in canvas.build(path)["diagnostics"]
        assert not cache_file.exists()

        # No room for the file the compiler reads the source from.
        with patch.object(canvas.tempfile, "TemporaryFile", side_effect=OSError(28, "No space left on device")):
            assert "No space left on device" in canvas.build(path)["diagnostics"]
        assert not cache_file.exists()

        # node died (signal) instead of finishing.
        with patch.object(canvas.subprocess, "run", lambda *_a, **_k: subprocess.CompletedProcess(["node"], -9, b"", b"")):
            assert canvas.build(path)["diagnostics"] == "Canvas compiler failed."
        assert not cache_file.exists()

        # A real verdict (exit 1 = compile errors) is cached.
        with patch.object(canvas.subprocess, "run", lambda *_a, **_k: subprocess.CompletedProcess(["node"], 1, b"", b"boom")):
            assert canvas.build(path)["diagnostics"] == "boom"
        assert json.loads(cache_file.read_text())["diagnostics"] == "boom"

    def test_compiler_reads_the_source_from_a_file(self) -> None:
        seen: list[bytes] = []

        def compiled(_command, **options):
            seen.append(options["stdin"].read())
            return subprocess.CompletedProcess(["node"], 0, b"compiled", b"")

        with patch.object(canvas, "node_binary", lambda: "/fake/node"), patch.object(canvas.subprocess, "run", compiled):
            assert canvas.compile_source("源码 source") == ("compiled", None, True)
        assert seen == ["源码 source".encode("utf-8")]

    @needs_node
    def test_check_cli_reports_forbidden_imports(self) -> None:
        path = self.tmp_path / "bad.canvas.tsx"
        path.write_text("import x from 'lodash';\nexport default function R() { return null }\n")
        completed = subprocess.run(
            [sys.executable, str(Path(canvas.__file__)), "check", str(path)],
            capture_output=True, text=True, check=False,
        )
        assert completed.returncode == 1
        assert "Unsupported Canvas import" in completed.stdout + completed.stderr

        path.write_text(VALID_SOURCE)
        completed = subprocess.run(
            [sys.executable, str(Path(canvas.__file__)), "check", str(path)],
            capture_output=True, text=True, check=False,
        )
        assert completed.returncode == 0, completed.stdout + completed.stderr
        assert completed.stdout.startswith("OK:")


    def test_runtime_version_follows_the_runtime_files(self) -> None:
        version = canvas.runtime_version()
        assert version and len(version) == 64
        runtime = self.tmp_path / "runtime"
        shutil.copytree(canvas.RUNTIME_DIR, runtime, ignore=shutil.ignore_patterns("esbuild", "typescript", "types"))
        with patch.object(canvas, "RUNTIME_DIR", runtime):
            canvas.runtime_version.cache_clear()
            assert canvas.runtime_version() == version
            (runtime / "markdown.js").write_bytes(b"// changed\n")
            canvas.runtime_version.cache_clear()
            assert canvas.runtime_version() != version
        canvas.runtime_version.cache_clear()

    @needs_node
    def test_canvas_importing_markdown_compiles_and_the_served_vendor_js_installs_it(self) -> None:
        javascript, diagnostics, ran = canvas.compile_source(CANVAS_IMPORTING_MARKDOWN)
        assert ran and diagnostics is None, diagnostics
        assert '"Markdown"' in javascript
        served = canvas.runtime_asset_bytes("vendor.js")
        assert served.startswith((canvas.RUNTIME_DIR / "vendor.js").read_bytes())
        assert (canvas.RUNTIME_DIR / "katex.js").read_bytes() in served
        assert served.endswith((canvas.RUNTIME_DIR / "markdown.js").read_bytes())
        assert canvas.runtime_asset_bytes("shell.html") == (canvas.RUNTIME_DIR / "shell.html").read_bytes()
        # WebKit before 16.4 rejects lookbehind at parse time, which would stop the whole bundle.
        assert not re.search(rb"\(\?<[=!]", served)
        # The served bytes run as one script, as the page loads them. module, exports and define
        # are shadowed as undefined (node -e defines the first two), so KaTeX's UMD wrapper sets
        # globalThis.katex for markdown.js.
        bundle = self.tmp_path / "served.js"
        bundle.write_bytes(served)
        script = NODE_DOM_STUB + f"new Function('module', 'exports', 'define', require('fs').readFileSync({json.dumps(str(bundle))}, 'utf8'))(); console.log(typeof globalThis.__zedCanvasModules['@zed/canvas'].Markdown, typeof globalThis.katex.renderToString);"
        completed = subprocess.run(["node", "-e", script], capture_output=True, text=True, check=False)
        assert completed.returncode == 0 and completed.stdout.strip() == "function function", completed.stdout + completed.stderr

    @needs_node
    def test_usage_bar_draws_a_total_below_its_segments_sum_as_a_full_bar(self) -> None:
        # A real report's total, estimated with float math, was 1 byte below the bytes that arrived; the SDK's bar threw
        # and the whole Canvas showed only that error.
        bundle = self.tmp_path / "served.js"
        bundle.write_bytes(canvas.runtime_asset_bytes("vendor.js"))
        script = NODE_DOM_STUB + f"""
new Function('module', 'exports', 'define', require('fs').readFileSync({json.dumps(str(bundle))}, 'utf8'))();
const React = globalThis.__zedCanvasModules.react;
const sdk = globalThis.__zedCanvasModules['@zed/canvas'];
// The only hook the bar calls is useHostTheme's useSyncExternalStore.
React.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE.H = {{ useSyncExternalStore: (subscribe, snapshot) => snapshot() }};
// updateTheme writes CSS variables; the DOM stub has no style.setProperty.
document.documentElement.style.setProperty = () => {{}};
globalThis.__zedCanvasHost.updateTheme({{ background: '#fff', foreground: '#111', muted: '#666', border: '#ddd', accent: '#06c', kind: 'light' }});
const widths = props => {{
  try {{
    // Call the components as React would, down to the SDK's Stack: the first element with a children array.
    let node = React.createElement(sdk.UsageBar, props);
    while (!Array.isArray(node.props.children)) node = node.type(node.props);
    return node.props.children[0].props.children.map(segment => parseFloat(segment.props.style.width));
  }} catch (error) {{ return error.message; }}
}};
const segments = [{{ label: 'sent', value: 600 }}, {{ label: 'queued', value: 401 }}];
console.log(JSON.stringify({{
  short: widths({{ segments, total: 1000 }}),
  larger: widths({{ segments, total: 2002 }}),
  omitted: widths({{ segments }}),
  negative: widths({{ segments: [{{ label: 'x', value: -1 }}], total: 10 }}),
  infinite: widths({{ segments, total: Infinity }}),
}}));
"""
        completed = subprocess.run(["node", "-e", script], capture_output=True, text=True, check=False)
        assert completed.returncode == 0, completed.stdout + completed.stderr
        result = json.loads(completed.stdout)
        full = [600 / 1001 * 100, 401 / 1001 * 100]
        assert result["short"] == result["omitted"] == full, result
        assert result["larger"] == [600 / 2002 * 100, 401 / 2002 * 100], result
        # A negative or non-finite value is still an authoring error, as in PieChart.
        assert result["negative"] == result["infinite"] == "Usage bar values must be finite and non-negative.", result

    @needs_node
    def test_markdown_parses_and_renders_each_block_kind_with_the_bundled_react(self) -> None:
        script = NODE_DOM_STUB + f"""
require({json.dumps(str(canvas.RUNTIME_DIR / 'vendor.js'))});
const markdown = require({json.dumps(str(canvas.RUNTIME_DIR / 'markdown.js'))});
const React = globalThis.__zedCanvasModules.react;
const theme = {{ text: {{ primary: '#111', secondary: '#666', link: '#06c' }}, stroke: {{ primary: '#ccc', secondary: '#ddd' }} }};
const blocks = markdown.parseMarkdown({json.dumps(MARKDOWN_DOCUMENT)});
const tree = markdown.renderMarkdown(React, theme, blocks);
const outline = node => typeof node === 'string' ? node : Array.isArray(node) ? node.map(outline)
  : node == null ? null : {{ tag: node.type, children: React.Children.toArray(node.props.children).map(outline) }};
const edge = Object.fromEntries(Object.entries({json.dumps(MARKDOWN_EDGE_CASES)}).map(([name, text]) => [name, markdown.parseMarkdown(text)]));
console.log(JSON.stringify({{ blocks, outline: outline(tree).children, edge }}));
"""
        completed = subprocess.run(["node", "-e", script], capture_output=True, text=True, check=False)
        assert completed.returncode == 0, completed.stdout + completed.stderr
        result = json.loads(completed.stdout)
        blocks = result["blocks"]
        assert [block["type"] for block in blocks] == ["heading", "paragraph", "list", "code", "table", "quote", "math", "rule", "paragraph"]
        assert [node["type"] for node in blocks[1]["inlines"]] == ["text", "strong", "text", "code", "text", "math", "text", "link", "text"]
        assert blocks[1]["inlines"][7]["href"] == "https://arxiv.org/abs/2312.02696"
        assert [block["type"] for block in blocks[2]["items"][0]["blocks"]] == ["paragraph", "list"]
        assert len(blocks[2]["items"][0]["blocks"][1]["items"]) == 2
        assert blocks[3] == {"type": "code", "lang": "python", "text": "print(1)"}
        assert blocks[4]["align"] == ["left", "right", "center"] and len(blocks[4]["rows"]) == 1
        assert blocks[6]["text"] == "L = a N^{-b}"
        assert [node["tag"] for node in result["outline"]] == ["h1", "p", "ul", "pre", "div", "blockquote", "pre", "hr", "p"]
        paragraph = result["outline"][1]["children"]
        assert paragraph[1]["tag"] == "strong" and paragraph[3]["tag"] == "code" and paragraph[7]["tag"] == "a"
        assert result["outline"][2]["children"][0]["children"][1]["tag"] == "ul"

        edge = result["edge"]
        # Blank lines between items keep one list; a `1.` item interrupts a paragraph but "2024." does not.
        assert [block["type"] for block in edge["loose_list"]] == ["list"] and len(edge["loose_list"][0]["items"]) == 3
        assert [block["type"] for block in edge["year"]] == ["paragraph"]
        # An info string with more than a word still closes at the fence; the heading keeps "C#"; a four-backtick block can show ```.
        assert [block["type"] for block in edge["fence"]] == ["code", "paragraph"] and edge["fence"][0]["lang"] == "python"
        assert edge["sharp"][0]["inlines"] == [{"type": "text", "text": "F# and C#"}]
        assert edge["nested_fence"][0]["text"] == "```\ninner\n```"
        # Prose dollars, snake_case and bold italic; "a | b" above a rule is not a table.
        assert edge["dollars"][0]["inlines"] == [{"type": "text", "text": "costs $5 and $10 in snake_case_name"}]
        assert [node["type"] for node in edge["bold_italic"][0]["inlines"]] == ["strong", "text", "em", "text"]
        assert [block["type"] for block in edge["pipe_rule"]] == ["paragraph", "rule"]

    @needs_node
    def test_markdown_renders_formulas_as_mathml_and_keeps_tex_that_does_not_parse_as_source(self) -> None:
        source = "Exposure $r_i = S_i/D_i$ and $\\frac{a$ here.\n\n$$\nR_c \\approx 2.7\\,(D/N)^{0.24}\n$$"
        script = NODE_DOM_STUB + f"""
require({json.dumps(str(canvas.RUNTIME_DIR / 'vendor.js'))});
globalThis.katex = require({json.dumps(str(canvas.RUNTIME_DIR / 'katex.js'))});
const markdown = require({json.dumps(str(canvas.RUNTIME_DIR / 'markdown.js'))});
const React = globalThis.__zedCanvasModules.react;
const theme = {{ text: {{ primary: '#111', secondary: '#666', link: '#06c' }}, stroke: {{ primary: '#ccc', secondary: '#ddd' }} }};
const outline = node => typeof node === 'string' ? node
  : {{ tag: node.type, html: node.props.dangerouslySetInnerHTML && node.props.dangerouslySetInnerHTML.__html, children: React.Children.toArray(node.props.children).map(outline) }};
console.log(JSON.stringify(outline(markdown.renderMarkdown(React, theme, markdown.parseMarkdown({json.dumps(source)}))).children));
"""
        completed = subprocess.run(["node", "-e", script], capture_output=True, text=True, check=False)
        assert completed.returncode == 0, completed.stdout + completed.stderr
        paragraph, block = json.loads(completed.stdout)
        inline, broken = [node for node in paragraph["children"] if isinstance(node, dict)]
        assert inline["tag"] == "span" and inline["html"].startswith('<span class="katex"><math') and "<msub>" in inline["html"]
        # The hidden TeX copy is dropped: the hosts' outline and find would read it as text.
        assert "annotation" not in inline["html"] + block["html"]
        # KaTeX cannot parse it, so the reader still sees the TeX.
        assert broken == {"tag": "code", "children": ["\\frac{a"]}
        assert block["tag"] == "div" and '<math xmlns="http://www.w3.org/1998/Math/MathML" display="block">' in block["html"]

    @needs_node
    def test_markdown_renders_a_file_reference_span_as_a_link_for_a_host_that_opens_it(self) -> None:
        source = "`src/app.ts:12` `np.float32` `app.ts#L3` [`x.ts:4`](https://example.com)"
        script = NODE_DOM_STUB + f"""
require({json.dumps(str(canvas.RUNTIME_DIR / 'vendor.js'))});
const markdown = require({json.dumps(str(canvas.RUNTIME_DIR / 'markdown.js'))});
const React = globalThis.__zedCanvasModules.react;
const theme = {{ text: {{ primary: '#111', secondary: '#666', link: '#06c' }}, stroke: {{ primary: '#ccc', secondary: '#ddd' }} }};
const outline = node => typeof node === 'string' ? node
  : {{ tag: node.type, href: node.props.href, children: React.Children.toArray(node.props.children).map(outline) }};
const paragraph = () => outline(markdown.renderMarkdown(React, theme, markdown.parseMarkdown({json.dumps(source)}))).children[0].children;
const before = paragraph();
globalThis.__agentsdockOpensCodeReferences = true;
console.log(JSON.stringify({{ before, after: paragraph() }}));
"""
        completed = subprocess.run(["node", "-e", script], capture_output=True, text=True, check=False)
        assert completed.returncode == 0, completed.stdout + completed.stderr
        result = json.loads(completed.stdout)
        spans = {name: [node for node in nodes if node != " "] for name, nodes in result.items()}
        # Without the desktop bridge's flag (Android, older desktops) the spans stay code: a link there would do nothing.
        assert [node["tag"] for node in spans["before"]] == ["code", "code", "code", "a"]
        # A path or a line makes a span a link the desktop opens in Zed or its editor; inside a link it stays code.
        assert [(node["tag"], node.get("href")) for node in spans["after"]] == [
            ("a", "src/app.ts:12"), ("code", None), ("a", "app.ts#L3"), ("a", "https://example.com"),
        ]
        assert spans["after"][0]["children"][0]["tag"] == "code" and spans["after"][3]["children"][0]["tag"] == "code"

ANCHOR = {"canvas_id": "summary", "tag": "td", "text": "loss 2.41", "html": "<td>loss 2.41</td>"}


class CanvasCommentTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp_path = Path(self.enterContext(tempfile.TemporaryDirectory()))
        self.path = self.tmp_path / "report.canvas.tsx"
        self.path.write_text(VALID_SOURCE)

    def test_comments_round_trip_beside_the_canvas(self) -> None:
        assert canvas.read_comments(self.path) == []
        canvas.write_comments(self.path, [{"id": "cmt_1", "messages": []}])
        assert (self.tmp_path / "report.canvas.comments.json").is_file()
        assert canvas.read_comments(self.path) == [{"id": "cmt_1", "messages": []}]
        # The comments file is not a canvas.
        assert [item["name"] for item in canvas.list_canvases(self.tmp_path)] == ["report"]

    def test_anchor_and_message_validation(self) -> None:
        assert canvas.comment_anchor({**ANCHOR, "text": "x" * 900})["text"] == "x" * 400
        assert canvas.comment_anchor({"canvas_id": None, "tag": "div"})["canvas_id"] is None
        for bad in ({"canvas_id": "a", "tag": "<script>"}, {"tag": "div", "canvas_id": ""}, "div"):
            with self.assertRaises(ValueError):
                canvas.comment_anchor(bad)
        assert canvas.comment_message({"mode": "ask", "body": " why? ", "revision": 7}) == ("ask", "why?", 7)
        for bad in ({"mode": "fix", "body": "x", "revision": 1}, {"mode": "ask", "body": "  ", "revision": 1}, {"mode": "ask", "body": "x", "revision": True}):
            with self.assertRaises(ValueError):
                canvas.comment_message(bad)

    def test_prompt_keeps_questions_from_editing(self) -> None:
        ask, ask_display = canvas.comment_prompt(self.path, 7, canvas.comment_anchor(ANCHOR), "ask", "为什么这么高？", follow_up=False)
        assert "question" in ask and "do not modify the canvas" in ask
        assert 'data-canvas-id="summary"' in ask and "revision 7" in ask and "Question: 为什么这么高？" in ask
        assert ask_display == "Canvas question on report · summary · loss 2.41: 为什么这么高？"
        edit, edit_display = canvas.comment_prompt(self.path, 7, canvas.comment_anchor({"canvas_id": None, "tag": "h1", "text": "Title"}), "edit", "make it shorter", follow_up=True)
        assert "Change the canvas file" in edit and "do not modify" not in edit
        assert "continues an earlier comment thread" in edit
        assert edit_display == "Canvas edit on report · <h1> Title: make it shorter"

    def test_resolve_replies_follows_queue_start_and_finish(self) -> None:
        def message(turn):
            return {"id": "m", "turn": turn, "reply": {"status": "queued"}}
        queued = message({"run_id": None, "queued_id": "q1"})
        running = message({"run_id": "run_b", "queued_id": None})
        stopped = message({"run_id": "run_c", "queued_id": None})
        cancelled = message({"run_id": None, "queued_id": "q2"})
        done = {"id": "m", "turn": {"run_id": "run_z"}, "reply": {"status": "done", "text": "kept"}}
        threads = [{"messages": [queued, running, stopped, cancelled, done]}]
        events = [
            {"type": "turn_started", "run_id": "run_b"},
            {"type": "turn_started", "run_id": "run_a", "queued_id": "q1"},
            {"type": "turn_finished", "run_id": "run_a", "exit_code": 0, "result_text": "Because the 1B run", "ts": "t1"},
            {"type": "turn_started", "run_id": "run_c"},
            {"type": "turn_stopped", "run_id": "run_c", "ts": "t2"},
            {"type": "turn_unqueued", "queued_id": "q2", "ts": "t3"},
            {"type": "turn_finished", "run_id": "run_z", "exit_code": 0, "result_text": "never read"},
        ]
        assert canvas.resolve_replies(threads, iter(events)) is True
        assert queued["turn"]["run_id"] == "run_a"
        assert queued["reply"] == {"status": "done", "text": "Because the 1B run", "finished_at": "t1"}
        assert running["reply"] == {"status": "running"}
        assert stopped["reply"]["status"] == "stopped"
        assert cancelled["reply"]["status"] == "cancelled"
        assert done["reply"]["text"] == "kept"
        # Nothing unfinished: the event log is not read at all.
        assert canvas.resolve_replies([{"messages": [done]}], iter(())) is False

    def test_failed_turn_and_long_answer(self) -> None:
        failing = {"turn": {"run_id": "r"}, "reply": None}
        canvas.resolve_replies([{"messages": [failing]}], [{"type": "turn_finished", "run_id": "r", "exit_code": 1, "result_text": "x" * (canvas.MAX_REPLY_CHARS + 5)}])
        assert failing["reply"]["status"] == "failed"
        assert len(failing["reply"]["text"]) == canvas.MAX_REPLY_CHARS

    def test_a_comments_timeline_text_is_recovered_from_the_prompt_its_agent_was_sent(self) -> None:
        anchors = (canvas.comment_anchor({**ANCHOR, "html": "<td>loss\n2.41</td>"}),
                   canvas.comment_anchor({"canvas_id": None, "tag": "h1", "text": ""}))
        for anchor in anchors:
            for mode, body, follow_up in (("ask", "为什么这么高？\nand the second line", False), ("edit", "make it shorter", True)):
                prompt, display = canvas.comment_prompt(self.path, 7, anchor, mode, body, follow_up=follow_up)
                assert canvas.comment_display_from_prompt(prompt) == display
                # An edit request in a thread follows the thread's earlier exchanges.
                assert canvas.comment_display_from_prompt(canvas.with_earlier_exchanges(prompt, [("why?", "Because.")])) == display
                # A message that quotes the prompt is the user's own text.
                assert canvas.comment_display_from_prompt("why so long?\n\n" + prompt) is None
        # Text that only begins like a comment is no comment.
        assert canvas.comment_display_from_prompt("Canvas comment (question) on a.canvas.tsx at revision 7.\nSelected element: <td>") is None
        assert canvas.comment_display_from_prompt("why is the loss so high?") is None
        # 0.4 MB of headers without an instruction took 5 s before the HTML was bounded.
        headers = "Canvas comment (question) on a at revision 1.\nSelected element: <td> (no data-canvas-id)\nElement HTML: x\n" * 4000
        started = time.monotonic()
        assert canvas.comment_display_from_prompt(headers) is None and canvas.comment_display_from_prompt(canvas.EARLIER_QUESTION + "\n" + headers) is None
        assert time.monotonic() - started < 2

    def test_a_turn_gets_the_threads_earlier_exchanges_before_its_prompt(self) -> None:
        assert canvas.with_earlier_exchanges("Request: fix it", []) == "Request: fix it"
        prompt = canvas.with_earlier_exchanges("Request: fix it", [("why?", "x" * (canvas.MAX_REPLY_CHARS + 5))])
        assert prompt.startswith("Earlier question in this comment thread:\nwhy?\n\nIts answer:\n" + "x" * canvas.MAX_REPLY_CHARS + "\n")
        assert prompt.endswith("\nRequest: fix it")

    def test_side_chat_reply_maps_each_exchange_status(self) -> None:
        assert canvas.side_chat_reply({"status": "running"}) == {"status": "running"}
        answered = {"status": "completed", "answer": "x" * (canvas.MAX_REPLY_CHARS + 5), "updated_at": "t1"}
        assert canvas.side_chat_reply(answered) == {"status": "done", "text": "x" * canvas.MAX_REPLY_CHARS, "finished_at": "t1"}
        assert canvas.side_chat_reply({"status": "cancelled", "updated_at": "t2"}) == {"status": "cancelled", "text": "", "finished_at": "t2"}
        # The server stopped during the answer.
        assert canvas.side_chat_reply({"status": "interrupted", "error": "side_question_interrupted", "updated_at": "t3"})["status"] == "stopped"
        failed = canvas.side_chat_reply({"status": "failed", "error": "side_question_http_503", "updated_at": "t4"})
        assert failed["status"] == "failed" and "side_question_http_503" in failed["text"]
        # The side chat's state is gone: the message does not stay running.
        assert canvas.side_chat_reply(None)["status"] == "failed"

    def test_save_source_refuses_a_stale_revision(self) -> None:
        revision = self.path.stat().st_mtime_ns
        with self.assertRaises(canvas.RevisionConflict) as caught:
            # A millisecond older: a real concurrent save, not rounding.
            canvas.save_source(self.path, "// mine", revision - 1_000_000)
        assert caught.exception.revision == revision
        assert self.path.read_text() == VALID_SOURCE
        # A JavaScript client echoes the revision as the nearest double: still the same revision.
        canvas.save_source(self.path, "// mine", int(json.loads(json.dumps(float(revision)))))
        assert self.path.read_text() == "// mine"
        with self.assertRaises(ValueError):
            canvas.save_source(self.path, "x" * (canvas.MAX_SOURCE_BYTES + 1), self.path.stat().st_mtime_ns)


class CanvasCommentRouteTests(unittest.TestCase):
    def setUp(self) -> None:
        from fastapi import FastAPI, HTTPException
        from fastapi.testclient import TestClient

        self.state_dir = Path(self.enterContext(tempfile.TemporaryDirectory()))
        directory = canvas.session_dir(self.state_dir, "sess_1")
        directory.mkdir(parents=True)
        self.path = directory / "report.canvas.tsx"
        self.path.write_text(VALID_SOURCE)
        self.events: list[dict] = []
        self.turns: list[tuple] = []
        self.refuse = False

        async def start_turn(session_id, prompt, display_prompt, capabilities):
            if self.refuse:
                raise HTTPException(status_code=409, detail="chat is archived")
            self.turns.append((session_id, prompt, display_prompt, capabilities))
            return {"queued": True, "queued_id": "q1"} if len(self.turns) == 1 else {"run_id": f"run_{len(self.turns)}"}

        app = FastAPI()
        canvas.register_canvas_routes(
            app, state_dir=self.state_dir, session_exists=lambda session_id: session_id == "sess_1",
            session_events=lambda session_id: iter(self.events), start_turn=start_turn,
        )
        self.client = TestClient(app)
        self.base = "/api/sessions/sess_1/canvases/report"

    def test_the_runtime_script_is_gzipped_for_a_client_that_accepts_it(self) -> None:
        plain = self.client.get("/api/canvas-runtime/vendor.js", headers={"Accept-Encoding": "identity"})
        packed = self.client.get("/api/canvas-runtime/vendor.js", headers={"Accept-Encoding": "gzip, br"})
        assert "content-encoding" not in plain.headers and plain.content == canvas.runtime_asset_bytes("vendor.js")
        # The client decodes the body; the wire carried the compressed bytes.
        assert packed.headers["content-encoding"] == "gzip" and packed.content == plain.content
        assert int(packed.headers["content-length"]) < len(plain.content) / 2
        assert packed.headers["vary"] == "Accept-Encoding"

    @needs_node
    def test_the_built_canvas_is_gzipped_for_a_client_that_accepts_it(self) -> None:
        plain = self.client.get(self.base, headers={"Accept-Encoding": "identity"})
        packed = self.client.get(self.base, headers={"Accept-Encoding": "gzip, br"})
        assert plain.status_code == 200 and "content-encoding" not in plain.headers
        assert "CanvasModule" in plain.json()["javascript"]
        # The client decodes the body; the wire carried the compressed bytes.
        assert packed.headers["content-encoding"] == "gzip" and packed.json() == plain.json()
        assert int(packed.headers["content-length"]) < len(plain.content) / 2
        saved = self.client.put(f"{self.base}/source", headers={"Accept-Encoding": "gzip"},
                                json={"source": VALID_SOURCE, "base_revision": plain.json()["revision"]})
        assert saved.status_code == 200 and saved.headers["content-encoding"] == "gzip"
        assert saved.json()["javascript"] == plain.json()["javascript"]

    @needs_node
    def test_a_client_reads_the_record_without_its_source_and_the_source_on_its_own(self) -> None:
        full = self.client.get(self.base).json()
        without_source = self.client.get(self.base, params={"source": "false"}).json()
        assert without_source == {key: value for key, value in full.items() if key != "source"}
        assert full["source"] == VALID_SOURCE and full["size"] == self.path.stat().st_size
        # The source read does not compile.
        with patch.object(canvas, "compile_source", lambda *_a, **_k: self.fail("compiled for a source read")):
            self.path.write_text(VALID_SOURCE + "// edited\n")
            source = self.client.get(f"{self.base}/source", headers={"Accept-Encoding": "gzip"})
        assert source.json() == {"source": VALID_SOURCE + "// edited\n", "revision": self.path.stat().st_mtime_ns}
        assert source.headers["content-encoding"] == "gzip"

    def test_thread_lifecycle(self) -> None:
        response = self.client.post(f"{self.base}/comments", json={"anchor": ANCHOR, "mode": "ask", "body": "why?", "revision": 5, "client_capabilities": ["claude_sdk_interactive_v1"]})
        assert response.status_code == 200, response.text
        thread = response.json()["thread"]
        assert thread["status"] == "open" and thread["anchor"]["canvas_id"] == "summary"
        assert thread["messages"][0]["turn"] == {"run_id": None, "queued_id": "q1"}
        assert thread["messages"][0]["reply"] == {"status": "queued"}
        session_id, prompt, display_prompt, capabilities = self.turns[0]
        assert session_id == "sess_1" and "Question: why?" in prompt and display_prompt.endswith("summary · loss 2.41: why?")
        assert capabilities == ["claude_sdk_interactive_v1"]

        self.events[:] = [
            {"type": "turn_started", "run_id": "run_9", "queued_id": "q1"},
            {"type": "turn_finished", "run_id": "run_9", "exit_code": 0, "result_text": "Because.", "ts": "t"},
        ]
        listed = self.client.get(f"{self.base}/comments").json()["threads"]
        assert listed[0]["messages"][0]["reply"] == {"status": "done", "text": "Because.", "finished_at": "t"}
        # Stored: the answer survives the event log going away (rewind, compaction).
        self.events.clear()
        assert self.client.get(f"{self.base}/comments").json()["threads"][0]["messages"][0]["reply"]["text"] == "Because."

        resolved = self.client.patch(f"{self.base}/comments/{thread['id']}", json={"status": "resolved"}).json()["thread"]
        assert resolved["status"] == "resolved"
        followed = self.client.post(f"{self.base}/comments/{thread['id']}/messages", json={"mode": "edit", "body": "fix it", "revision": 6}).json()["thread"]
        assert followed["status"] == "open" and len(followed["messages"]) == 2
        assert "continues an earlier comment thread" in self.turns[1][1]
        assert followed["messages"][1]["turn"]["run_id"] == "run_2"

        assert self.client.delete(f"{self.base}/comments/{thread['id']}").status_code == 200
        assert self.client.get(f"{self.base}/comments").json()["threads"] == []

    def test_refused_turn_stores_nothing_and_bad_input_is_rejected(self) -> None:
        self.refuse = True
        response = self.client.post(f"{self.base}/comments", json={"anchor": ANCHOR, "mode": "ask", "body": "why?", "revision": 5})
        assert response.status_code == 409
        assert self.client.get(f"{self.base}/comments").json()["threads"] == []
        self.refuse = False
        assert self.client.post(f"{self.base}/comments", json={"anchor": ANCHOR, "mode": "rewrite", "body": "x", "revision": 5}).status_code == 400
        assert self.client.post(f"{self.base}/comments", json={"anchor": {"tag": "<b>"}, "mode": "ask", "body": "x", "revision": 5}).status_code == 400
        assert self.client.patch(f"{self.base}/comments/cmt_missing", json={"status": "resolved"}).status_code == 404
        assert self.turns == []

    def test_source_save_detects_a_concurrent_edit(self) -> None:
        revision = self.path.stat().st_mtime_ns
        with patch.object(canvas, "build", lambda path: {"source": path.read_text(), "revision": path.stat().st_mtime_ns}):
            conflict = self.client.put(f"{self.base}/source", json={"source": "// mine", "base_revision": revision - 1_000_000})
            assert conflict.status_code == 409 and "changed since it was opened" in conflict.json()["detail"]
            saved = self.client.put(f"{self.base}/source", json={"source": "// mine", "base_revision": revision})
        assert saved.status_code == 200 and saved.json()["source"] == "// mine"
        assert self.client.put(f"{self.base}/source", json={"source": 3, "base_revision": revision}).status_code == 400


class CanvasCommentSideChatTests(unittest.IsolatedAsyncioTestCase):
    """Canvas questions through the real side chat store, with a fake Codex fork that answers when released."""

    async def asyncSetUp(self) -> None:
        import httpx
        from fastapi import FastAPI

        import side_questions as side

        self.state_dir = Path(self.enterContext(tempfile.TemporaryDirectory()))
        directory = canvas.session_dir(self.state_dir, "sess_1")
        directory.mkdir(parents=True)
        self.path = directory / "report.canvas.tsx"
        self.path.write_text(VALID_SOURCE)
        self.turns: list[str] = []
        self.asked: list[tuple[str, list]] = []
        self.release: dict[str, asyncio.Event] = {}
        self.stopped: list[str] = []
        self.closed = 0
        self.notices: list[str] = []
        self.available = lambda: True
        test = self

        class Fork:
            async def ask(self, question, *, history, on_step):
                assert on_step is None  # nothing shows a comment's steps
                body = question.rsplit("Question: ", 1)[1]
                test.asked.append((body, history))
                try:
                    await test.release.setdefault(body, asyncio.Event()).wait()
                except asyncio.CancelledError:
                    test.stopped.append(body)
                    raise
                return {"answer": "answer to " + body, "backend": "codex", "context_note": "native"}

            async def close(self):
                test.closed += 1

        async def factory(session, **options):
            return Fork()

        async def notify(session_id, event):
            self.notices.append(session_id)

        async def start_turn(session_id, prompt, display_prompt, capabilities):
            self.turns.append(prompt)
            return {"run_id": f"run_{len(self.turns)}"}

        self.runtime = side.SideQuestions(comment_storage_path=self.state_dir / "comments.sqlite3", comment_factory=factory,
                                           comment_notify=notify)
        self.addAsyncCleanup(self.runtime.close)
        app = FastAPI()
        canvas.register_canvas_routes(
            app, state_dir=self.state_dir, session_exists=lambda session_id: session_id == "sess_1",
            session_events=lambda session_id: iter(()), start_turn=start_turn,
            side_chats=self.runtime.comment_chats, side_chat_available=lambda session_id, prompt: self.available(),
        )
        self.client = httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test")
        self.addAsyncCleanup(self.client.aclose)
        self.base = "/api/sessions/sess_1/canvases/report"

    async def comment(self, body: str, *, thread: str | None = None, **fields):
        url = f"{self.base}/comments/{thread}/messages" if thread else f"{self.base}/comments"
        return await self.client.post(url, json={"anchor": ANCHOR, "mode": "ask", "body": body, "revision": 5, "side_chat": True, **fields})

    async def replies(self) -> list[list[dict]]:
        threads = (await self.client.get(f"{self.base}/comments")).json()["threads"]
        return [[message["reply"] for message in thread["messages"]] for thread in threads]

    async def until(self, reached) -> None:
        for _ in range(500):
            if reached():
                return
            await asyncio.sleep(0.01)
        self.fail("condition not reached in 5 s")

    async def test_questions_of_two_threads_run_at_the_same_time_beside_the_chat(self) -> None:
        first = (await self.comment("why?")).json()["thread"]
        await self.comment("how?")
        assert first["messages"][0]["turn"] is None and first["messages"][0]["side_chat"] is True
        assert first["messages"][0]["reply"] == {"status": "running"}
        # Both forks hold their question before either answers; the chat got no turn.
        await self.until(lambda: len(self.asked) == 2)
        assert self.turns == [] and self.runtime.active_session_ids() == {"sess_1"}
        assert await self.replies() == [[{"status": "running"}], [{"status": "running"}]]
        self.release["how?"].set()
        await self.until(lambda: self.closed == 1)
        answered = await self.replies()
        assert answered[0] == [{"status": "running"}]
        assert (answered[1][0]["status"], answered[1][0]["text"]) == ("done", "answer to how?")
        self.release["why?"].set()
        # Each thread's fork ends with its answer, and each change told the chat's clients.
        await self.until(lambda: self.closed == 2)
        assert self.runtime.active_session_ids() == set() and set(self.notices) == {"sess_1"} and len(self.notices) >= 4
        assert [reply[0]["status"] for reply in await self.replies()] == ["done", "done"]
        # Stored beside the canvas: the answers outlive the side chats.
        self.runtime.delete_history("sess_1")
        assert [reply[0]["text"] for reply in await self.replies()] == ["answer to why?", "answer to how?"]

    async def test_a_follow_up_is_refused_while_the_thread_answers_then_continues_its_side_chat(self) -> None:
        thread = (await self.comment("why?")).json()["thread"]["id"]
        await self.until(lambda: len(self.asked) == 1)
        busy = await self.comment("and then?", thread=thread)
        assert busy.status_code == 409 and busy.json()["detail"].startswith("This thread is still answering")
        self.release["why?"].set()
        await self.until(lambda: self.closed == 1)
        followed = await self.comment("and then?", thread=thread)
        assert followed.status_code == 200 and len(followed.json()["thread"]["messages"]) == 2
        await self.until(lambda: len(self.asked) == 2)
        body, history = self.asked[1]
        # The handle is offered the thread's earlier exchange, and no other thread's.
        assert body == "and then?" and [item["response"] for item in history] == ["answer to why?"]
        assert "Question: why?" in history[0]["question"]
        self.release["and then?"].set()
        await self.until(lambda: self.closed == 2)
        assert [reply["status"] for reply in (await self.replies())[0]] == ["done", "done"]
        # The chat saw neither exchange: an edit request in the thread tells it both.
        assert (await self.comment("do that", thread=thread, mode="edit")).status_code == 200
        assert self.turns[0].startswith(
            "Earlier question in this comment thread:\nwhy?\n\nIts answer:\nanswer to why?\n\n"
            "Earlier question in this comment thread:\nand then?\n\nIts answer:\nanswer to and then?\n\nCanvas comment (edit request)")
        # That turn told the chat: the thread's next edit request does not repeat them.
        assert (await self.comment("and that", thread=thread, mode="edit")).status_code == 200
        assert self.turns[1].startswith("Canvas comment (edit request)")

    async def test_an_edit_or_a_client_or_provider_without_side_chats_starts_a_chat_turn(self) -> None:
        edit = (await self.comment("fix it", mode="edit")).json()["thread"]["messages"][0]
        assert edit["turn"] == {"run_id": "run_1", "queued_id": None} and "side_chat" not in edit
        # A client that does not refresh on the side chat's notice.
        await self.comment("why?", side_chat=False)
        # A chat that no copy can answer for, such as one whose native conversation has not started.
        self.available = lambda: False
        await self.comment("how?")
        assert len(self.turns) == 3 and self.asked == [] and self.notices == []
        assert not any(prompt.startswith("Earlier question") for prompt in self.turns)

    async def test_a_question_admitted_while_its_thread_is_deleted_is_stopped(self) -> None:
        thread = (await self.comment("why?")).json()["thread"]["id"]
        self.release["why?"].set()
        await self.until(lambda: self.closed == 1)
        # The delete lands after the follow-up read the thread and before its question is stored:
        # the availability check runs between the two, and here it empties the comments file.
        self.available = lambda: canvas.write_comments(self.path, []) or True
        assert (await self.comment("and then?", thread=thread)).status_code == 404
        # The question is stopped before or after the fork received it.
        await self.until(lambda: self.runtime.active_session_ids() == set())
        assert self.asked[1:] in ([], [("and then?", self.asked[-1][1])]) and self.stopped in ([], ["and then?"])
        assert (await self.replies()) == []

    async def test_deleting_a_thread_stops_its_running_answer(self) -> None:
        thread = (await self.comment("why?")).json()["thread"]["id"]
        other = (await self.comment("how?")).json()["thread"]["id"]
        await self.until(lambda: len(self.asked) == 2)
        assert (await self.client.delete(f"{self.base}/comments/{thread}")).status_code == 200
        # The stopped answer and the cleared side chat each close the fork.
        assert self.stopped == ["why?"] and self.closed == 2
        threads = (await self.client.get(f"{self.base}/comments")).json()["threads"]
        assert [(item["id"], item["messages"][0]["reply"]) for item in threads] == [(other, {"status": "running"})]


if __name__ == "__main__":
    unittest.main()
