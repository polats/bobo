/** Tweak panel: sliders, segmented choices and actions bound to plain objects. */
export class Panel {
  readonly el: HTMLElement;

  constructor(parent: HTMLElement) {
    this.el = document.createElement('div');
    this.el.className = 'panel';
    this.el.hidden = true;
    parent.appendChild(this.el);
  }

  toggle(open = this.el.hidden) {
    this.el.hidden = !open;
  }

  heading(text: string) {
    const h = document.createElement('h3');
    h.textContent = text;
    this.el.appendChild(h);
  }

  slider<T extends Record<string, unknown>>(
    obj: T,
    key: keyof T & string,
    opts: { label?: string; min: number; max: number; step?: number; onChange?: (v: number) => void },
  ) {
    const row = this.row();
    const label = document.createElement('label');
    const out = document.createElement('output');
    label.textContent = opts.label ?? key;
    label.appendChild(out);
    const input = document.createElement('input');
    input.type = 'range';
    input.min = String(opts.min);
    input.max = String(opts.max);
    input.step = String(opts.step ?? (opts.max - opts.min) / 100);
    input.value = String(obj[key]);
    const show = () => (out.textContent = formatNumber(Number(obj[key])));
    input.addEventListener('input', () => {
      (obj as Record<string, unknown>)[key] = Number(input.value);
      show();
      opts.onChange?.(Number(input.value));
    });
    show();
    row.append(label, input);
  }

  choice<V extends string>(label: string, options: { value: V; label: string }[], current: V, onPick: (v: V) => void) {
    const row = this.row();
    const l = document.createElement('label');
    l.textContent = label;
    const seg = document.createElement('div');
    seg.className = 'seg';
    const buttons = options.map((o) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = o.label;
      b.setAttribute('aria-pressed', String(o.value === current));
      b.addEventListener('click', () => {
        buttons.forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
        onPick(o.value);
      });
      return b;
    });
    seg.append(...buttons);
    row.append(l, seg);
  }

  toggleSwitch<T extends Record<string, unknown>>(obj: T, key: keyof T & string, label: string, onChange?: (v: boolean) => void) {
    this.choice(label, [{ value: 'on', label: 'On' }, { value: 'off', label: 'Off' }], obj[key] ? 'on' : 'off', (v) => {
      (obj as Record<string, unknown>)[key] = v === 'on';
      onChange?.(v === 'on');
    });
  }

  links(items: { title: string; url: string; note?: string }[]) {
    const row = this.row();
    const list = document.createElement('ul');
    list.className = 'refs';
    for (const it of items) {
      const li = document.createElement('li');
      const a = document.createElement('a');
      a.href = it.url;
      a.target = '_blank';
      a.rel = 'noopener';
      a.textContent = it.title;
      li.appendChild(a);
      if (it.note) {
        const n = document.createElement('span');
        n.textContent = it.note;
        li.appendChild(n);
      }
      list.appendChild(li);
    }
    row.appendChild(list);
  }

  action(label: string, fn: () => void) {
    const row = this.row();
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'action';
    b.textContent = label;
    b.addEventListener('click', fn);
    row.appendChild(b);
  }

  private row() {
    const row = document.createElement('div');
    row.className = 'row';
    this.el.appendChild(row);
    return row;
  }
}

function formatNumber(v: number) {
  if (Number.isInteger(v)) return String(v);
  return Math.abs(v) >= 10 ? v.toFixed(1) : v.toFixed(2);
}
