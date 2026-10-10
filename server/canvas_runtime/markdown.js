/* Markdown for Canvas reports.
 *
 * The SDK bundle (vendor.js) has no source in this repository, so this
 * component is plain JavaScript appended to the served vendor.js
 * (/api/canvas-runtime/vendor.js). It takes React and the SDK from the
 * `__zedCanvasModules` global the bundle sets. Under node (tests) it also
 * exports parseMarkdown and renderMarkdown.
 *
 * Supported: `#` headings, paragraphs, ordered and unordered lists (nested by
 * indentation), backtick-fenced code, GFM tables, block quotes, horizontal
 * rules, inline code, bold, italic, links and bare URLs. `$…$` and `$$…$$` are
 * shown as TeX source (no math renderer is bundled); a literal dollar sign is
 * written `\$`. No lookbehind assertions: a regex syntax error here would stop
 * the whole bundle on WebKit before 16.4.
 */
(function () {
  'use strict';

  // The info string's first word is the language; the rest ("title=x") is ignored.
  var FENCE = /^(\s*)(`{3,})\s*(\S*)[^`]*$/;
  var HEADING = /^(#{1,6})\s+(.*?)(?:\s+#+)?\s*$/;
  var RULE = /^\s*([-*_])(?:\s*\1){2,}\s*$/;
  var QUOTE = /^\s*>\s?(.*)$/;
  var LIST_ITEM = /^(\s*)([-*+]|\d{1,9}\.)\s+(.*)$/;
  // Only these may interrupt a paragraph (CommonMark): "2024. The model" stays prose.
  var PARAGRAPH_LIST_ITEM = /^\s*([-*+]|1\.)\s+/;
  var TABLE_DIVIDER = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;
  var MATH_FENCE = /^\s*\$\$\s*$/;
  var MATH_LINE = /^\s*\$\$(.+?)\$\$\s*$/;
  // Alternatives in priority order; group numbers are read in parseInlines.
  var INLINE_SOURCE = [
    /(\\[\\`*_{}\[\]()#+\-.!$>|])/, // 1 escape
    /(`+)([\s\S]*?)\2/, // 2, 3 code span
    /\$\$([^$]+?)\$\$/, // 4 $$…$$ inside a line
    /\$([^$\s](?:[^$\n]*[^$\s])?)\$(?![0-9])/, // 5 $…$
    /\*\*\*([^*\n]+?)\*\*\*/, // 6 bold italic
    /\*\*([\s\S]+?)\*\*/, // 7 strong
    /\*([^*\n]+?)\*/, // 8 em
    /_([^_\n]+?)_(?![A-Za-z0-9])/, // 9 em; the character before it is checked in parseInlines
    /!?\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/, // 10, 11 link (an image becomes a link to its source)
    /(https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"])/, // 12 bare URL
  ].map(function (part) { return part.source; }).join('|');

  function leadingSpaces(line) { return line.length - line.replace(/^\s+/, '').length; }

  function splitRow(line) {
    var text = line.trim();
    if (text.charAt(0) === '|') text = text.slice(1);
    if (text.slice(-1) === '|' && text.slice(-2) !== '\\|') text = text.slice(0, -1);
    var cells = [];
    var current = '';
    for (var k = 0; k < text.length; k++) {
      var ch = text.charAt(k);
      if (ch === '\\' && text.charAt(k + 1) === '|') { current += '|'; k++; }
      else if (ch === '|') { cells.push(current.trim()); current = ''; }
      else current += ch;
    }
    cells.push(current.trim());
    return cells;
  }

  // GFM: the divider must have as many cells as the header, so "a | b" above "---" is prose and a rule.
  function startsTable(lines, i) {
    return lines[i].indexOf('|') >= 0 && i + 1 < lines.length && TABLE_DIVIDER.test(lines[i + 1])
      && splitRow(lines[i + 1]).length === splitRow(lines[i]).length;
  }

  function interruptsParagraph(lines, i) {
    var line = lines[i];
    return HEADING.test(line) || FENCE.test(line) || RULE.test(line) || QUOTE.test(line)
      || PARAGRAPH_LIST_ITEM.test(line) || MATH_FENCE.test(line) || MATH_LINE.test(line) || startsTable(lines, i);
  }

  function parseInlines(text) {
    var pattern = new RegExp(INLINE_SOURCE, 'g'); // fresh per call: nested parses must not share lastIndex
    var out = [];
    var last = 0;
    var match;
    function pushText(value) {
      if (!value) return;
      var previous = out[out.length - 1];
      if (previous && previous.type === 'text') previous.text += value;
      else out.push({ type: 'text', text: value });
    }
    while ((match = pattern.exec(text))) {
      pushText(text.slice(last, match.index).replace(/\n/g, ' '));
      last = pattern.lastIndex;
      if (match[1]) pushText(match[1].charAt(1));
      else if (match[2]) out.push({ type: 'code', text: match[3].trim() });
      else if (match[4] != null) out.push({ type: 'math', text: match[4].trim() });
      else if (match[5] != null) out.push({ type: 'math', text: match[5].trim() });
      else if (match[6] != null) out.push({ type: 'strong', inlines: [{ type: 'em', inlines: parseInlines(match[6]) }] });
      else if (match[7] != null) out.push({ type: 'strong', inlines: parseInlines(match[7]) });
      else if (match[8] != null) out.push({ type: 'em', inlines: parseInlines(match[8]) });
      else if (match[9] != null) {
        if (/[A-Za-z0-9]/.test(text.charAt(match.index - 1))) {
          // snake_case_name: an underscore inside a word is text, not emphasis.
          pushText('_');
          last = pattern.lastIndex = match.index + 1;
          continue;
        }
        out.push({ type: 'em', inlines: parseInlines(match[9]) });
      }
      else if (match[10] != null) out.push({ type: 'link', href: match[11], inlines: parseInlines(match[10]) });
      else if (match[12]) out.push({ type: 'link', href: match[12], inlines: [{ type: 'text', text: match[12] }] });
    }
    pushText(text.slice(last).replace(/\n/g, ' '));
    return out;
  }

  function parseBlocks(lines) {
    var blocks = [];
    var i = 0;
    var match;
    while (i < lines.length) {
      var line = lines[i];
      if (!line.trim()) { i++; continue; }
      if ((match = FENCE.exec(line))) {
        // A closing fence is at least as long as the opening one, so a ```` block can show ``` inside.
        var closing = new RegExp('^\\s*`{' + match[2].length + ',}\\s*$');
        var code = [];
        i++;
        while (i < lines.length && !closing.test(lines[i])) { code.push(lines[i]); i++; }
        i++;
        blocks.push({ type: 'code', lang: match[3], text: code.join('\n') });
        continue;
      }
      if (MATH_FENCE.test(line)) {
        var math = [];
        i++;
        while (i < lines.length && !MATH_FENCE.test(lines[i])) { math.push(lines[i]); i++; }
        i++;
        blocks.push({ type: 'math', text: math.join('\n').trim() });
        continue;
      }
      if ((match = MATH_LINE.exec(line))) { blocks.push({ type: 'math', text: match[1].trim() }); i++; continue; }
      if ((match = HEADING.exec(line))) { blocks.push({ type: 'heading', level: match[1].length, inlines: parseInlines(match[2]) }); i++; continue; }
      if (RULE.test(line)) { blocks.push({ type: 'rule' }); i++; continue; }
      if (QUOTE.test(line)) {
        var quoted = [];
        while (i < lines.length && QUOTE.test(lines[i])) { quoted.push(QUOTE.exec(lines[i])[1]); i++; }
        blocks.push({ type: 'quote', blocks: parseBlocks(quoted) });
        continue;
      }
      if (startsTable(lines, i)) {
        var header = splitRow(line);
        var align = splitRow(lines[i + 1]).map(function (cell) {
          var left = cell.charAt(0) === ':';
          var right = cell.slice(-1) === ':';
          return left && right ? 'center' : right ? 'right' : 'left';
        });
        i += 2;
        var rows = [];
        while (i < lines.length && lines[i].trim() && lines[i].indexOf('|') >= 0) { rows.push(splitRow(lines[i]).map(parseInlines)); i++; }
        blocks.push({ type: 'table', header: header.map(parseInlines), align: align, rows: rows });
        continue;
      }
      if ((match = LIST_ITEM.exec(line))) {
        var ordered = /\d/.test(match[2]);
        var indent = match[1].length;
        var items = [];
        while (i < lines.length) {
          // Blank lines between items keep one list (models write them often).
          var k = i;
          while (k < lines.length && !lines[k].trim()) k++;
          var item = k < lines.length ? LIST_ITEM.exec(lines[k]) : null;
          if (!item || /\d/.test(item[2]) !== ordered || item[1].length !== indent) break;
          i = k + 1;
          var contentIndent = item[1].length + item[2].length + 1;
          var content = [item[3]];
          while (i < lines.length) {
            var next = lines[i];
            if (!next.trim()) {
              // A blank line ends the item unless the next text is indented into it.
              var j = i + 1;
              while (j < lines.length && !lines[j].trim()) j++;
              if (j < lines.length && leadingSpaces(lines[j]) >= contentIndent) { content.push(''); i++; continue; }
              break;
            }
            if (leadingSpaces(next) >= contentIndent) { content.push(next.slice(contentIndent)); i++; continue; }
            if (LIST_ITEM.test(next) || interruptsParagraph(lines, i)) break;
            content.push(next.trim()); // an unindented line that starts no block continues the item's paragraph
            i++;
          }
          items.push({ blocks: parseBlocks(content) });
        }
        blocks.push({ type: 'list', ordered: ordered, start: ordered ? parseInt(match[2], 10) : 1, items: items });
        continue;
      }
      var paragraph = [line.trim()];
      i++;
      while (i < lines.length && lines[i].trim() && !interruptsParagraph(lines, i)) { paragraph.push(lines[i].trim()); i++; }
      blocks.push({ type: 'paragraph', inlines: parseInlines(paragraph.join('\n')) });
    }
    return blocks;
  }

  function parseMarkdown(source) {
    return parseBlocks(String(source).replace(/\r\n?/g, '\n').split('\n'));
  }

  // Styles follow the SDK's Text, H1-H3, Code, Table and Divider; tables take
  // their borders and padding from the shell page's CSS like the SDK Table.
  function renderMarkdown(React, theme, blocks) {
    var h = React.createElement;
    var mono = 'ui-monospace, SFMono-Regular, Menlo, monospace';
    var body = { fontSize: 14, lineHeight: 1.6, color: theme.text.primary };
    var headingSizes = { 1: { fontSize: 24, lineHeight: '30px' }, 2: { fontSize: 18, lineHeight: '24px' }, 3: { fontSize: 16, lineHeight: '22px' } };
    var codeSpan = { fontFamily: mono, fontSize: 12, padding: '1px 4px', border: '1px solid ' + theme.stroke.secondary, borderRadius: 3 };
    var codeBlock = { margin: 0, padding: 12, fontFamily: mono, fontSize: 12, lineHeight: 1.5, border: '1px solid ' + theme.stroke.secondary, borderRadius: 6, overflowX: 'auto', color: theme.text.primary };

    function renderInlines(nodes, keyPrefix) {
      return nodes.map(function (node, index) {
        var key = keyPrefix + index;
        switch (node.type) {
          case 'text': return node.text;
          case 'code': return h('code', { key: key, style: codeSpan }, node.text);
          case 'math': return h('code', { key: key, style: codeSpan }, node.text);
          case 'strong': return h('strong', { key: key }, renderInlines(node.inlines, key + '.'));
          case 'em': return h('em', { key: key }, renderInlines(node.inlines, key + '.'));
          case 'link': return h('a', { key: key, href: node.href, style: { color: theme.text.link } }, renderInlines(node.inlines, key + '.'));
        }
      });
    }

    function renderBlocks(nodes, keyPrefix) {
      return nodes.map(function (node, index) {
        var key = keyPrefix + index;
        switch (node.type) {
          case 'heading': {
            var size = headingSizes[node.level] || { fontSize: 14, lineHeight: '20px' };
            return h('h' + node.level, { key: key, style: { fontSize: size.fontSize, lineHeight: size.lineHeight, fontWeight: 600, margin: 0, color: theme.text.primary } }, renderInlines(node.inlines, key + '.'));
          }
          case 'paragraph':
            return h('p', { key: key, style: Object.assign({ margin: 0 }, body) }, renderInlines(node.inlines, key + '.'));
          case 'code':
            return h('pre', { key: key, style: codeBlock }, h('code', { style: { fontFamily: 'inherit' } }, node.text));
          case 'math':
            return h('pre', { key: key, style: codeBlock }, node.text);
          case 'quote':
            return h('blockquote', { key: key, style: { margin: 0, padding: '2px 12px', borderLeft: '3px solid ' + theme.stroke.primary, color: theme.text.secondary, display: 'flex', flexDirection: 'column', gap: 8 } }, renderBlocks(node.blocks, key + '.'));
          case 'rule':
            return h('hr', { key: key, style: { border: 0, borderTop: '1px solid ' + theme.stroke.primary, width: '100%', margin: '8px 0' } });
          case 'list':
            return h(node.ordered ? 'ol' : 'ul', { key: key, start: node.ordered && node.start !== 1 ? node.start : undefined, style: Object.assign({ margin: 0, paddingLeft: 24, display: 'flex', flexDirection: 'column', gap: 4 }, body) },
              node.items.map(function (item, itemIndex) {
                return h('li', { key: itemIndex }, renderBlocks(item.blocks, key + '.' + itemIndex + '.'));
              }));
          case 'table':
            return h('div', { key: key, style: { overflowX: 'auto' } }, h('table', null,
              h('thead', null, h('tr', null, node.header.map(function (cell, column) {
                return h('th', { key: column, style: { textAlign: node.align[column] || 'left', fontSize: 12, color: theme.text.secondary } }, renderInlines(cell, key + 'h' + column + '.'));
              }))),
              h('tbody', null, node.rows.map(function (row, rowIndex) {
                return h('tr', { key: rowIndex }, row.map(function (cell, column) {
                  return h('td', { key: column, style: { textAlign: node.align[column] || 'left', fontVariantNumeric: 'tabular-nums' } }, renderInlines(cell, key + rowIndex + '.' + column + '.'));
                }));
              }))));
        }
      });
    }

    return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 12 } }, renderBlocks(blocks, 'b'));
  }

  var modules = globalThis.__zedCanvasModules;
  if (modules && modules.react && modules['@zed/canvas']) {
    var React = modules.react;
    var sdk = modules['@zed/canvas'];
    sdk.Markdown = function Markdown(props) {
      var theme = sdk.useHostTheme();
      var blocks = React.useMemo(function () { return parseMarkdown(props.source); }, [props.source]);
      return renderMarkdown(React, theme, blocks);
    };
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = { parseMarkdown: parseMarkdown, renderMarkdown: renderMarkdown };
})();
