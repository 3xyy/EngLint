import { afterEach, describe, expect, it } from 'vitest';
import { buildTextMap } from '../../src/content/adapters/text-map';

function host(html: string): HTMLElement {
  const el = document.createElement('div');
  el.setAttribute('contenteditable', 'true');
  el.innerHTML = html;
  document.body.appendChild(el);
  return el;
}

/** The character `toDom(offset)` points at (or '' at the end of a node). */
function charAt(root: HTMLElement, offset: number): string {
  const { node, offset: at } = buildTextMap(root).toDom(offset);
  return node.data.charAt(at);
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('buildTextMap', () => {
  it('joins blocks with one newline and maps into inline elements', () => {
    const root = host('<p>Hi <b>there</b></p><p>Next</p>');
    const map = buildTextMap(root);
    expect(map.text).toBe('Hi there\nNext');
    const at = map.toDom(4);
    expect(at.node).toBe(root.querySelector('b')!.firstChild);
    expect(at.node.data).toBe('there');
    expect(at.offset).toBe(1);
  });

  it('table cells and the other block tags are block boundaries', () => {
    expect(buildTextMap(host('<table><tr><td>Name</td><td>Note</td></tr></table>')).text).toBe('Name\nNote');
    expect(buildTextMap(host('<table><tr><th>Head</th><th>Two</th></tr><tr><td>a</td></tr></table>')).text).toBe(
      'Head\nTwo\na',
    );
    expect(buildTextMap(host('<dl><dt>Term</dt><dd>Meaning</dd></dl>')).text).toBe('Term\nMeaning');
    expect(buildTextMap(host('<figure><span>Pic</span><figcaption>Caption</figcaption></figure>')).text).toBe('Pic\nCaption');
    expect(buildTextMap(host('Above<hr>Below')).text).toBe('Above\nBelow');
    expect(buildTextMap(host('<span>a</span><main>b</main><nav>c</nav><aside>d</aside>e')).text).toBe('a\nb\nc\nd\ne');
  });

  it('a cell boundary keeps offsets 1:1 with the DOM', () => {
    const root = host('<table><tr><td>Name</td><td>Note</td></tr></table>');
    const map = buildTextMap(root);
    const second = root.querySelectorAll('td')[1]!.firstChild;
    expect(map.toDom(5)).toEqual({ node: second, offset: 0 });
    expect(map.toOffset(second!, 2)).toBe(7);
  });

  it('<br> → \\n', () => {
    expect(buildTextMap(host('a<br>b')).text).toBe('a\nb');
    expect(buildTextMap(host('<div>a<br>b</div>')).text).toBe('a\nb');
    expect(buildTextMap(host('a<br><br>b')).text).toBe('a\n\nb'); // an empty line between
  });

  it('non-editable island skipped', () => {
    const root = host('<p>Hello <span contenteditable="false">@Ann</span> there</p>');
    const map = buildTextMap(root);
    expect(map.text).toBe('Hello  there');
    expect(map.toDom(7).node.data).toBe(' there');
    expect(map.toDom(7).offset).toBe(1);
  });

  it('a block island still separates the text around it', () => {
    expect(buildTextMap(host('a<div contenteditable="false">widget</div>b')).text).toBe('a\nb');
  });

  it('skips script, style and placeholder elements, but never the host itself', () => {
    const root = host(
      '<style>p{}</style><p>One</p><script>var x = 1;</script><p data-placeholder="Type here">Type here…</p><p>Two</p>',
    );
    expect(buildTextMap(root).text).toBe('One\nTwo');
    // Quill-style: the editor root carries the placeholder attribute for its whole life.
    root.setAttribute('data-placeholder', 'Compose…');
    expect(buildTextMap(root).text).toBe('One\nTwo');
  });

  it('block boundaries are never leading, trailing or doubled', () => {
    const cases: [string, string][] = [
      ['<p>a</p><p>b</p>', 'a\nb'],
      ['<div><p>a</p></div><p>b</p>', 'a\nb'],
      ['<ul><li>a</li><li>b</li></ul>', 'a\nb'],
      ['<h1>T</h1><blockquote>q</blockquote><pre>c</pre>', 'T\nq\nc'],
      ['<table><tr><td>a</td></tr><tr><td>b</td></tr></table>', 'a\nb'],
      ['<section>a</section><article>b</article><header>c</header><footer>d</footer>', 'a\nb\nc\nd'],
      ['abc<div>def</div>', 'abc\ndef'], // Chrome's plain contenteditable after Enter
      ['<p>a<br></p><p>b</p>', 'a\nb'], // trailing placeholder <br> merges with the block boundary
      ['<p>a</p><p><br></p><p>b</p>', 'a\n\nb'], // an empty paragraph is an empty line
      ['<div>a<br></div>', 'a'],
      ['<br><p>a</p>', 'a'],
      ['', ''],
    ];
    for (const [html, text] of cases) expect(buildTextMap(host(html)).text, html).toBe(text);
  });

  it('maps NBSP to a plain space in the text, keeping the nodes raw and offsets 1:1', () => {
    const map = buildTextMap(host('<p>a\u00a0b</p><pre>x\ny</pre>'));
    expect(map.text).toBe('a b\nx\ny');
    expect(map.segments[0]!.node.data).toBe('a\u00a0b');
    expect(map.toDom(2).node.data.charAt(map.toDom(2).offset)).toBe('b');
  });

  it('finds the right node after an emoji and an NBSP, in the same and a later paragraph', () => {
    const root = host('<p>😀 Hi\u00a0<i>there</i>, I has 👍🏽 a\u00a0cat.</p><p>Ok 🎉\u00a0<b>she</b> go\u00a0home.</p>');
    const map = buildTextMap(root);
    expect(map.text).toBe('😀 Hi there, I has 👍🏽 a cat.\nOk 🎉 she go home.');
    for (const word of ['has', 'a cat', 'go home']) {
      const at = map.text.indexOf(word);
      const start = map.toDom(at);
      const end = map.toDom(at + word.length, 'before');
      expect(start.node, word).toBe(end.node);
      expect(start.node.data.slice(start.offset, end.offset).replace(/\u00a0/g, ' '), word).toBe(word);
    }
  });

  it('keeps CRLF inside <pre> and maps offsets after it', () => {
    const root = host('<pre>line one\r\nI has a cat\r\nend</pre>');
    const map = buildTextMap(root);
    expect(map.text).toBe('line one\r\nI has a cat\r\nend');
    const at = map.text.indexOf('has');
    expect(map.toDom(at).offset).toBe(root.querySelector('pre')!.firstChild!.textContent!.indexOf('has'));
  });

  it('round-trips every offset of a larger document', () => {
    const parts: string[] = [];
    for (let i = 0; i < 120; i++) {
      parts.push(
        i % 3 === 0 ? `<p>Line ${i} <b>bold ${i}</b> tail</p>` : i % 3 === 1 ? `<div>x${i}<br>y${i}</div>` : `<li>item ${i}</li>`,
      );
    }
    const root = host(parts.join(''));
    const map = buildTextMap(root);
    for (let i = 0; i < map.text.length; i++) {
      if (map.text[i] === '\n') continue;
      const { node, offset } = map.toDom(i);
      expect(node.data.charAt(offset), `offset ${i}`).toBe(map.text[i]);
      expect(map.toOffset(node, offset), `offset ${i}`).toBe(i);
    }
    // An element point before a block's first text maps to that text's offset.
    for (const el of root.querySelectorAll('p, div, li')) {
      const first = el.firstChild as Text;
      expect(map.toOffset(el, 0)).toBe(map.toOffset(first, 0));
    }
  });

  it('segmentsIn lists only the segments overlapping a span', () => {
    const map = buildTextMap(host('<p>Hi <b>there</b></p><p>Next</p>'));
    expect(map.segmentsIn(1, 5).map((s) => s.node.data)).toEqual(['Hi ', 'there']);
    expect(map.segmentsIn(3, 8).map((s) => s.node.data)).toEqual(['there']);
    expect(map.segmentsIn(8, 9)).toEqual([]); // just the newline
    expect(map.segmentsIn(9, 13).map((s) => s.node.data)).toEqual(['Next']);
  });

  it('maps every character to the text node that holds it', () => {
    const root = host('<p>Hi <b>there</b></p><p>Ne<i>x</i>t</p>');
    const map = buildTextMap(root);
    for (let i = 0; i < map.text.length; i++) {
      if (map.text[i] === '\n') continue;
      expect(charAt(root, i), `offset ${i}`).toBe(map.text[i]);
    }
  });

  it('an offset on a synthetic newline maps to the end of the text before it', () => {
    const root = host('<p>Hi</p><p>Next</p>');
    const at = buildTextMap(root).toDom(2);
    expect(at.node.data).toBe('Hi');
    expect(at.offset).toBe(2);
    const next = buildTextMap(root).toDom(3);
    expect(next.node.data).toBe('Next');
    expect(next.offset).toBe(0);
  });

  it('the end of the text maps to the end of the last text node', () => {
    const at = buildTextMap(host('<p>Hi</p><p>Next</p>')).toDom(7);
    expect(at.node.data).toBe('Next');
    expect(at.offset).toBe(4);
  });

  it("'before' affinity keeps a range end inside the text it closes", () => {
    const root = host('<p>Hi <b>there</b></p>');
    const map = buildTextMap(root);
    expect(map.toDom(3).node.data).toBe('there'); // the character at 3 is "t"
    const end = map.toDom(3, 'before');
    expect(end.node.data).toBe('Hi ');
    expect(end.offset).toBe(3);
  });

  it('skips empty text nodes', () => {
    const root = host('<p>ab</p>');
    root.querySelector('p')!.prepend(document.createTextNode(''));
    const map = buildTextMap(root);
    expect(map.text).toBe('ab');
    expect(map.toDom(0).node.data).toBe('ab');
    expect(map.segments).toHaveLength(1);
  });

  it('lists the text segments in order with their offsets', () => {
    const map = buildTextMap(host('<p>Hi <b>there</b></p><p>Next</p>'));
    expect(map.segments.map((s) => [s.node.data, s.start, s.end])).toEqual([
      ['Hi ', 0, 3],
      ['there', 3, 8],
      ['Next', 9, 13],
    ]);
  });

  it('toOffset maps DOM points back to text offsets', () => {
    const root = host('<p>Hi <b>there</b></p><p>Next</p>');
    const map = buildTextMap(root);
    const [p1, p2] = root.querySelectorAll('p');
    expect(map.toOffset(root.querySelector('b')!.firstChild!, 2)).toBe(5);
    expect(map.toOffset(p2!.firstChild!, 4)).toBe(13);
    expect(map.toOffset(p2!, 0)).toBe(9); // before "Next"
    expect(map.toOffset(p1!, 0)).toBe(0);
    expect(map.toOffset(root, root.childNodes.length)).toBe(13); // after everything
    expect(map.toOffset(document.body, 0)).toBeNull(); // outside the host
  });

  it('toDom throws on a host with no text', () => {
    expect(() => buildTextMap(host('<p><br></p>')).toDom(0)).toThrow(RangeError);
  });
});
