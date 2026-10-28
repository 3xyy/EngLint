import { cleanup, fireEvent, render } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Button, DiffPreview, IconButton, Pill, Segmented, Switch, TypeLabel } from '../../src/shared/ui/controls';
import { CheckIcon } from '../../src/shared/ui/icons';

afterEach(cleanup);

describe('DiffPreview', () => {
  it('shows the context, the original struck and the replacement inserted', () => {
    const { container } = render(<DiffPreview before="Last week I " original="has" replacement="have" after=" a cat." />);
    expect(container.querySelector('del')!.textContent).toBe('has');
    expect(container.querySelector('ins')!.textContent).toBe('have');
    expect(container.textContent).toBe('Last week I hashave a cat.');
  });

  it('keeps at most 6 words of context on each side and marks the cut with an ellipsis', () => {
    const { container } = render(
      <DiffPreview
        before="one two three four five six seven eight "
        original="nine"
        replacement="9"
        after=" ten eleven twelve thirteen fourteen fifteen sixteen."
      />,
    );
    expect(container.textContent).toBe('…three four five six seven eight nine9 ten eleven twelve thirteen fourteen fifteen…');
  });

  it('keeps exactly 6 words of context whole, with no ellipsis', () => {
    const { container } = render(<DiffPreview before="a b c d e f " original="g" replacement="G" after=" h i j k l m" />);
    expect(container.textContent).toBe('a b c d e f gG h i j k l m');
  });

  it('a deletion shows only the struck original; a note marks the original without striking it', () => {
    const del = render(<DiffPreview before="It is " original="very " replacement="" after="unique." />);
    expect(del.container.querySelector('del')!.textContent).toBe('very ');
    expect(del.container.querySelector('ins')).toBeNull();
    cleanup();
    const note = render(<DiffPreview before="The plan is " original="very unique" replacement={null} after="." />);
    expect(note.container.querySelector('del')).toBeNull();
    expect(note.container.querySelector('ins')).toBeNull();
    expect(note.container.querySelector('mark')!.textContent).toBe('very unique');
  });

  it('page text in every part shows as literal text, never as markup', () => {
    const { container } = render(<DiffPreview before="<b>a</b> " original="<img src=x>" replacement="<i>y</i>" after=" <script>z</script>" />);
    expect(container.querySelector('b, img, i, script')).toBeNull();
    expect(container.textContent).toBe('<b>a</b> <img src=x><i>y</i> <script>z</script>');
  });
});

function SwitchHarness({ disabled = false }: { disabled?: boolean }) {
  const [on, setOn] = useState(false);
  return <Switch checked={on} onChange={setOn} disabled={disabled} aria-label="Check this site" />;
}

describe('Switch', () => {
  it('is a switch whose click toggles aria-checked', () => {
    const { getByRole } = render(<SwitchHarness />);
    const sw = getByRole('switch', { name: 'Check this site' });
    expect(sw.getAttribute('aria-checked')).toBe('false');
    fireEvent.click(sw);
    expect(sw.getAttribute('aria-checked')).toBe('true');
    fireEvent.click(sw);
    expect(sw.getAttribute('aria-checked')).toBe('false');
  });

  it('is a focusable button that Space and Enter toggle; other keys do nothing', () => {
    const { getByRole } = render(<SwitchHarness />);
    const sw = getByRole('switch');
    expect(sw.localName).toBe('button');
    sw.focus();
    expect(document.activeElement).toBe(sw);
    fireEvent.keyDown(sw, { key: ' ' });
    expect(sw.getAttribute('aria-checked')).toBe('true');
    fireEvent.keyDown(sw, { key: 'Enter' });
    expect(sw.getAttribute('aria-checked')).toBe('false');
    fireEvent.keyDown(sw, { key: 'a' });
    fireEvent.keyDown(sw, { key: ' ', repeat: true }); // a held key toggles once, on its first press
    expect(sw.getAttribute('aria-checked')).toBe('false');
  });

  it('a disabled switch ignores clicks and keys', () => {
    const { getByRole } = render(<SwitchHarness disabled />);
    const sw = getByRole('switch');
    fireEvent.click(sw);
    fireEvent.keyDown(sw, { key: ' ' });
    expect(sw.getAttribute('aria-checked')).toBe('false');
  });

  it('a mixed switch reads off (a switch has no mixed state) and is marked for its half-way look; a click turns it on', () => {
    const onChange = vi.fn();
    const { getByRole, rerender } = render(<Switch checked={false} mixed onChange={onChange} aria-label="Engagement" />);
    const sw = getByRole('switch', { name: 'Engagement' });
    expect(sw.getAttribute('aria-checked')).toBe('false');
    expect(sw.hasAttribute('data-mixed')).toBe(true);
    fireEvent.click(sw);
    expect(onChange).toHaveBeenCalledWith(true);
    rerender(<Switch checked onChange={onChange} aria-label="Engagement" />);
    expect(sw.hasAttribute('data-mixed')).toBe(false);
  });
});

const MODES = [
  { value: 'essay', label: 'Essay' },
  { value: 'standard', label: 'Standard' },
  { value: 'casual', label: 'Casual' },
] as const;

function SegmentedHarness({ as }: { as?: 'radio' | 'tab' }) {
  const [mode, setMode] = useState<(typeof MODES)[number]['value']>('standard');
  return <Segmented label="Mode" options={MODES} value={mode} onChange={setMode} as={as} />;
}

describe('Segmented', () => {
  it('is a radio group: one radio checked, and only it in the tab order', () => {
    const { getByRole, getAllByRole } = render(<SegmentedHarness />);
    expect(getByRole('radiogroup', { name: 'Mode' })).toBeTruthy();
    expect(getAllByRole('radio').map((r) => [r.textContent, r.getAttribute('aria-checked'), r.tabIndex])).toEqual([
      ['Essay', 'false', -1], ['Standard', 'true', 0], ['Casual', 'false', -1],
    ]);
  });

  it('a click selects', () => {
    const { getByRole } = render(<SegmentedHarness />);
    fireEvent.click(getByRole('radio', { name: 'Essay' }));
    expect(getByRole('radio', { name: 'Essay' }).getAttribute('aria-checked')).toBe('true');
    expect(getByRole('radio', { name: 'Standard' }).getAttribute('aria-checked')).toBe('false');
  });

  it('arrow keys move the selection and the focus, wrapping at the ends; Home and End jump', () => {
    const { getByRole } = render(<SegmentedHarness />);
    const radio = (name: string) => getByRole('radio', { name });
    const press = (key: string) => fireEvent.keyDown(document.activeElement!, { key });
    const at = () => [document.activeElement?.textContent, getByRole('radio', { checked: true }).textContent];
    radio('Standard').focus();
    press('ArrowRight');
    expect(at()).toEqual(['Casual', 'Casual']);
    press('ArrowRight');
    expect(at()).toEqual(['Essay', 'Essay']);
    press('ArrowLeft');
    expect(at()).toEqual(['Casual', 'Casual']);
    press('ArrowUp');
    expect(at()).toEqual(['Standard', 'Standard']);
    press('ArrowDown');
    expect(at()).toEqual(['Casual', 'Casual']);
    press('Home');
    expect(at()).toEqual(['Essay', 'Essay']);
    press('End');
    expect(at()).toEqual(['Casual', 'Casual']);
    press('x');
    expect(at()).toEqual(['Casual', 'Casual']);
  });

  it('as tabs: a tablist whose tabs carry aria-selected and the panel they control; Left and Right move, Up and Down do not', () => {
    const change = vi.fn();
    const { getByRole } = render(
      <Segmented
        as="tab"
        label="Panel sections"
        options={[{ value: 'issues', label: 'Issues', id: 'tab-issues', controls: 'pane-issues' }, { value: 'tools', label: 'Tools', id: 'tab-tools', controls: 'pane-tools' }]}
        value="tools"
        onChange={change}
      />,
    );
    expect(getByRole('tablist', { name: 'Panel sections' })).toBeTruthy();
    const tools = getByRole('tab', { name: 'Tools' });
    expect([tools.id, tools.getAttribute('aria-controls'), tools.getAttribute('aria-selected')]).toEqual(['tab-tools', 'pane-tools', 'true']);
    expect(getByRole('tab', { name: 'Issues' }).getAttribute('aria-selected')).toBe('false');
    expect(tools.hasAttribute('aria-checked')).toBe(false);
    fireEvent.keyDown(tools, { key: 'ArrowDown' });
    expect(change).not.toHaveBeenCalled();
    fireEvent.keyDown(tools, { key: 'ArrowRight' });
    expect(change).toHaveBeenCalledWith('issues');
    expect(document.activeElement).toBe(getByRole('tab', { name: 'Issues' }));
  });

  it('a value not among the options still leaves the first option in the tab order', () => {
    const { getAllByRole } = render(<Segmented label="Mode" options={MODES} value={'other' as never} onChange={() => {}} />);
    expect(getAllByRole('radio').map((r) => r.tabIndex)).toEqual([0, -1, -1]);
  });
});

describe('Button and IconButton', () => {
  it('a Button is type="button" with its variant, and passes its other props through', () => {
    const down = vi.fn();
    const { getByRole } = render(
      <Button variant="primary" onMouseDown={down}>
        Accept
      </Button>,
    );
    const b = getByRole('button', { name: 'Accept' });
    expect(b.getAttribute('type')).toBe('button');
    expect(b.className).toBe('el-btn el-btn-primary');
    fireEvent.mouseDown(b);
    expect(down).toHaveBeenCalledOnce();
  });

  it('an IconButton is named by its label, which is also its tooltip, and draws its icon hidden', () => {
    const click = vi.fn();
    const { getByRole } = render(<IconButton label="Accept" icon={<CheckIcon />} onClick={click} />);
    const b = getByRole('button', { name: 'Accept' });
    expect(b.getAttribute('aria-label')).toBe('Accept'); // the tooltip draws it (controls.css: attr(aria-label))
    expect(b.hasAttribute('title')).toBe(false); // a title would show and be announced a second time
    expect(b.getAttribute('data-tip')).toBe('top');
    expect(b.querySelector('svg')!.getAttribute('aria-hidden')).toBe('true');
    expect(b.textContent).toBe('');
    fireEvent.click(b);
    expect(click).toHaveBeenCalledOnce();
  });
});

describe('Pill and TypeLabel', () => {
  it('a Pill carries its tone', () => {
    const { getByText } = render(<Pill tone="ok">Up to date</Pill>);
    expect(getByText('Up to date').className).toBe('el-pill el-pill-ok');
  });

  it("a TypeLabel shows the issue's type with a dot in its family's colour", () => {
    const { container } = render(<TypeLabel issue={{ severity: 'suggestion', category: 'delivery', kind: 'generic_phrasing' }} />);
    expect(container.textContent).toBe('Generic phrasing · Say it plainly');
    const dot = container.querySelector('.el-dot')!;
    expect(dot.classList.contains('el-fam-generic')).toBe(true);
    expect(dot.getAttribute('aria-hidden')).toBe('true');
  });
});
