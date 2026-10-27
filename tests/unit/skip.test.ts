import { beforeEach, describe, expect, it } from 'vitest';
import { isCheckableField, isGenericHostExcluded } from '../../src/content/skip';

function mk(html: string): Element {
  document.body.innerHTML = html;
  return document.body.querySelector('#t')!;
}

describe('isCheckableField', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });
  it('textarea is checkable', () => {
    expect(isCheckableField(mk('<textarea id="t"></textarea>'))).toBe(true);
  });
  it('readonly or disabled textarea is not', () => {
    expect(isCheckableField(mk('<textarea id="t" readonly></textarea>'))).toBe(false);
    expect(isCheckableField(mk('<textarea id="t" disabled></textarea>'))).toBe(false);
  });
  it('inputs are never checkable', () => {
    expect(isCheckableField(mk('<input id="t" type="text">'))).toBe(false);
    expect(isCheckableField(mk('<input id="t" type="password">'))).toBe(false);
  });
  it('an input inside a contenteditable region is still not checkable', () => {
    expect(isCheckableField(mk('<div contenteditable="true"><input id="t" type="text"></div>'))).toBe(false);
  });
  it('contenteditable="false" nested in an editable region is not checkable', () => {
    expect(isCheckableField(mk('<div contenteditable="true"><div id="t" contenteditable="false"></div></div>'))).toBe(false);
  });
  it('cc-* and one-time-code autocomplete are skipped', () => {
    expect(isCheckableField(mk('<textarea id="t" autocomplete="cc-number"></textarea>'))).toBe(false);
    expect(isCheckableField(mk('<textarea id="t" autocomplete="one-time-code"></textarea>'))).toBe(false);
    expect(isCheckableField(mk('<textarea id="t" autocomplete="off"></textarea>'))).toBe(true);
  });
  it('autocomplete is read token by token', () => {
    expect(isCheckableField(mk('<textarea id="t" autocomplete="billing cc-number"></textarea>'))).toBe(false);
    expect(isCheckableField(mk('<textarea id="t" autocomplete="section-a  shipping\tcc-exp"></textarea>'))).toBe(false);
    expect(isCheckableField(mk('<textarea id="t" autocomplete="section-login one-time-code"></textarea>'))).toBe(false);
    expect(isCheckableField(mk('<textarea id="t" autocomplete="shipping street-address"></textarea>'))).toBe(true);
  });
  it('contenteditable div is checkable', () => {
    expect(isCheckableField(mk('<div id="t" contenteditable></div>'))).toBe(true);
    expect(isCheckableField(mk('<div id="t" contenteditable="true"></div>'))).toBe(true);
    expect(isCheckableField(mk('<div id="t" contenteditable="plaintext-only"></div>'))).toBe(true);
  });
  it('plain div and contenteditable="false" are not', () => {
    expect(isCheckableField(mk('<div id="t"></div>'))).toBe(false);
    expect(isCheckableField(mk('<div id="t" contenteditable="false"></div>'))).toBe(false);
  });
  it('child inside contenteditable="false" is not', () => {
    expect(isCheckableField(mk('<div contenteditable="false"><div id="t"></div></div>'))).toBe(false);
    expect(isCheckableField(mk('<div contenteditable="false"><textarea id="t"></textarea></div>'))).toBe(false);
  });
  it('nearest explicit contenteditable wins', () => {
    expect(isCheckableField(mk('<div contenteditable="false"><div contenteditable="true"><p id="t"></p></div></div>'))).toBe(true);
    expect(isCheckableField(mk('<div contenteditable="true"><p id="t"></p></div>'))).toBe(true);
  });
  it('data-englint="off" on element or ancestor skips', () => {
    expect(isCheckableField(mk('<textarea id="t" data-englint="off"></textarea>'))).toBe(false);
    expect(isCheckableField(mk('<div data-englint="off"><textarea id="t"></textarea></div>'))).toBe(false);
    expect(isCheckableField(mk('<div data-englint="off"><div id="t" contenteditable></div></div>'))).toBe(false);
  });
});

describe('isCheckableField: code editors and opt-outs', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });
  // Editors set these to turn off the browser's or Grammarly's own checking, not to mark secrets.
  it('a Gmail-like contenteditable with spellcheck=false IS checked', () => {
    // Recorded live in Gmail compose: the body carries spellcheck="false" on itself.
    expect(
      isCheckableField(
        mk('<div id="t" contenteditable="true" role="textbox" aria-label="Message Body" aria-multiline="true" spellcheck="false"></div>'),
      ),
    ).toBe(true);
    expect(isCheckableField(mk('<div spellcheck="false"><textarea id="t"></textarea></div>'))).toBe(true);
    expect(isCheckableField(mk('<textarea id="t" spellcheck="false"></textarea>'))).toBe(true);
  });
  it('a Quill root with data-gramm=false IS checked', () => {
    // Quill sets data-gramm="false" on every editor root (quill/core/quill.js).
    expect(
      isCheckableField(
        mk('<div class="ql-container"><div id="t" class="ql-editor" data-gramm="false" contenteditable="true" data-placeholder="Compose…"></div></div>'),
      ),
    ).toBe(true);
    expect(isCheckableField(mk('<div id="t" contenteditable="true" data-gramm_editor="false"></div>'))).toBe(true);
    expect(isCheckableField(mk('<section data-gramm="false"><textarea id="t"></textarea></section>'))).toBe(true);
  });
  it('data-enable-grammarly="false" on the field or an ancestor skips it (an explicit opt-out)', () => {
    expect(isCheckableField(mk('<textarea id="t" data-enable-grammarly="false"></textarea>'))).toBe(false);
    expect(isCheckableField(mk('<div id="t" contenteditable data-enable-grammarly="False"></div>'))).toBe(false);
    expect(isCheckableField(mk('<section data-enable-grammarly="false"><div><textarea id="t"></textarea></div></section>'))).toBe(false);
    expect(isCheckableField(mk('<textarea id="t" data-enable-grammarly="true"></textarea>'))).toBe(true);
  });
  it('Monaco, CodeMirror 5 and 6, and Ace editors are skipped', () => {
    // Monaco, CodeMirror 5 and Ace type into a hidden textarea inside the editor.
    expect(isCheckableField(mk('<div class="monaco-editor"><div><textarea id="t" class="inputarea"></textarea></div></div>'))).toBe(false);
    expect(isCheckableField(mk('<div class="CodeMirror"><div><textarea id="t"></textarea></div></div>'))).toBe(false);
    expect(isCheckableField(mk('<div class="ace_editor"><textarea id="t" class="ace_text-input"></textarea></div>'))).toBe(false);
    // CodeMirror 6 is a contenteditable .cm-content inside .cm-editor.
    expect(isCheckableField(mk('<div class="cm-editor"><div class="cm-scroller"><div id="t" class="cm-content" contenteditable="true"></div></div></div>'))).toBe(false);
    expect(isCheckableField(mk('<div id="t" class="cm-content" contenteditable="true"></div>'))).toBe(false);
    expect(isCheckableField(mk('<div class="cm-editor"><div class="cm-panels"><div id="t" contenteditable="true"></div></div></div>'))).toBe(false);
    expect(isCheckableField(mk('<div class="codemirror-ish"><textarea id="t"></textarea></div>'))).toBe(true); // only the real class names
  });
  it('a field labelled or roled as code, a terminal or a console is skipped', () => {
    expect(isCheckableField(mk('<div id="t" contenteditable aria-label="Code editor"></div>'))).toBe(false);
    expect(isCheckableField(mk('<textarea id="t" aria-label="Terminal input"></textarea>'))).toBe(false);
    expect(isCheckableField(mk('<div id="t" contenteditable aria-label="JavaScript console"></div>'))).toBe(false);
    expect(isCheckableField(mk('<div id="t" contenteditable role="code"></div>'))).toBe(false);
    expect(isCheckableField(mk('<div id="t" contenteditable role="textbox" aria-label="Message body"></div>'))).toBe(true);
    expect(isCheckableField(mk('<div id="t" contenteditable aria-label="Decode your thoughts"></div>'))).toBe(true); // whole words only
  });
});

describe('isGenericHostExcluded', () => {
  it('excludes docs.google.com and subdomains only', () => {
    expect(isGenericHostExcluded('docs.google.com')).toBe(true);
    expect(isGenericHostExcluded('x.docs.google.com')).toBe(true);
    expect(isGenericHostExcluded('mail.google.com')).toBe(false);
    expect(isGenericHostExcluded('notdocs.google.com')).toBe(false);
  });
});
